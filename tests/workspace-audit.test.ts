import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { StateStore } from '../src/config/store.js';
import { createMysqlMcpApplication, type MysqlMcpApplication } from '../src/mcp/server.js';

const roots: string[] = [];

function descriptor(root: string, workspaceId: string, datasource: string, alias: string): string {
  const directory = join(root, workspaceId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'workspace.yml');
  writeFileSync(path, `
schema_version: mysql-agent/workspace/1
workspace_id: ${workspaceId}
label: ${workspaceId}
runtime_mode: workspace
default_datasource: ${datasource}
default_environment: test
environments:
  test:
    datasource_bindings: { ${datasource}: ${alias} }
business_pack_paths: []
audit_retention_days: 30
`);
  return path;
}

async function clientFor(application: MysqlMcpApplication): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await application.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace audit isolation', () => {
  it('forces history_search to the current workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mysql-agent-audit-workspaces-'));
    roots.push(root);
    const home = join(root, 'home');
    const store = new StateStore(home);
    store.addConnection({
      alias: 'one-test', datasourceId: 'one', environment: 'test', ownerScope: 'workspace:workspace-one',
      host: 'localhost', username: 'agent', password: 'secret', database: 'one',
    });
    store.addConnection({
      alias: 'two-test', datasourceId: 'two', environment: 'test', ownerScope: 'workspace:workspace-two',
      host: 'localhost', username: 'agent', password: 'secret', database: 'two',
    });
    const audit = (workspaceId: string, datasourceId: string, connectionAlias: string, executionId: string) => store.recordAudit({
      executionId, occurredAt: '2026-09-15T00:00:00.000Z', clientName: 'codex', connectionAlias,
      workspaceId, datasourceId, environment: 'test', businessOperationId: 'work_order.find', businessPackId: null,
      businessPackVersion: null, businessOperationHash: null, statementKind: 'select', sqlHash: 'hash',
      durationMs: 1, rowCount: 1, affectedRows: null, attemptCount: 1, writeOutcome: 'not_applicable',
      status: 'ok', errorCategory: null, mysqlErrorCode: null,
    });
    audit('workspace-one', 'one', 'one-test', '11111111-1111-4111-8111-111111111111');
    audit('workspace-two', 'two', 'two-test', '22222222-2222-4222-8222-222222222222');
    store.close();

    const one = createMysqlMcpApplication({
      stateHome: home, mode: 'workspace', workspacePath: descriptor(root, 'workspace-one', 'one', 'one-test'), operations: [],
    });
    const client = await clientFor(one);
    const tool = (await client.listTools()).tools.find((item) => item.name === 'history_search');
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('workspace_id');
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('connection');
    const history = await client.callTool({ name: 'history_search', arguments: { business_operation_id: 'work_order.find' } });
    expect(JSON.stringify(history.structuredContent)).toContain('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify(history.structuredContent)).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(JSON.stringify(history.structuredContent)).not.toContain('one-test');
    expect(history.structuredContent).toEqual(expect.objectContaining({
      records: [expect.objectContaining({
        business_operation_id: 'work_order.find', datasource_id: 'one', environment: 'test',
      })],
    }));
    await client.close();
    await one.close();
  });

  it('rejects the same workspace_id from a different root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mysql-agent-workspace-identity-'));
    roots.push(root);
    const home = join(root, 'home');
    const store = new StateStore(home);
    store.addConnection({
      alias: 'one-test', datasourceId: 'one', environment: 'test', ownerScope: 'workspace:stable-id',
      host: 'localhost', username: 'agent', password: 'secret', database: 'one',
    });
    store.close();
    const firstPath = descriptor(join(root, 'first-root'), 'stable-id', 'one', 'one-test');
    const secondPath = descriptor(join(root, 'second-root'), 'stable-id', 'one', 'one-test');
    const first = createMysqlMcpApplication({ stateHome: home, mode: 'workspace', workspacePath: firstPath, operations: [] });
    await first.close();
    const database = new DatabaseSync(join(home, 'state.db'));
    const identity = database.prepare('SELECT * FROM workspace_identities WHERE workspace_id = ?').get('stable-id') as Record<string, unknown>;
    expect(Object.keys(identity).sort()).toEqual(['created_at', 'last_seen_at', 'root_hash', 'workspace_id']);
    expect(identity.root_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain(firstPath);
    database.close();
    expect(() => createMysqlMcpApplication({
      stateHome: home, mode: 'workspace', workspacePath: secondPath, operations: [],
    })).toThrow(/已绑定到另一个 root/);
  });
});
