import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineBusinessOperation } from '../src/business-queries/definition.js';
import { StateStore } from '../src/config/store.js';
import { createMysqlMcpApplication, type MysqlMcpApplication } from '../src/mcp/server.js';

const roots: string[] = [];

function fixture(): { root: string; home: string; descriptor: string } {
  const root = mkdtempSync(join(tmpdir(), 'mysql-agent-workspace-mcp-'));
  roots.push(root);
  const home = join(root, 'home');
  const descriptor = join(root, '.mysql-agent', 'workspace.yml');
  mkdirSync(join(root, '.mysql-agent'), { recursive: true });
  writeFileSync(descriptor, `
schema_version: mysql-agent/workspace/1
workspace_id: auto-server
label: AutoServer
runtime_mode: workspace
default_datasource: autoserver
default_environment: test
environments:
  test:
    datasource_bindings:
      autoserver: auto-dev
      proofline: proof-test
  staging:
    datasource_bindings: {}
    expose_as_explicit_tool: true
  prod:
    datasource_bindings:
      autoserver: auto-prod
    access_mode: read_only
    expose_as_explicit_tool: true
business_pack_paths: []
audit_retention_days: 30
`);
  const store = new StateStore(home);
  store.addConnection({
    alias: 'auto-dev', datasourceId: 'autoserver', environment: 'test', ownerScope: 'workspace:auto-server',
    host: 'localhost', username: 'agent', password: 'secret', database: 'auto_test', accessMode: 'read_write',
  });
  store.addConnection({
    alias: 'proof-test', datasourceId: 'proofline', environment: 'test', ownerScope: 'workspace:auto-server',
    host: 'localhost', username: 'agent', password: 'secret', database: 'proof_test', accessMode: 'read_write',
  });
  store.addConnection({
    alias: 'auto-prod', datasourceId: 'autoserver', environment: 'prod', ownerScope: 'global', shareable: true,
    host: 'localhost', username: 'reader', password: 'secret', database: 'auto_prod', accessMode: 'read_only',
  });
  store.addConnection({
    alias: 'shared-stage', datasourceId: 'shared', environment: 'staging', ownerScope: 'global', shareable: true,
    host: 'localhost', username: 'reader', password: 'secret', database: 'shared_stage', accessMode: 'read_only',
  });
  store.addConnection({
    alias: 'private-stage', datasourceId: 'private', environment: 'staging', ownerScope: 'global', shareable: false,
    host: 'localhost', username: 'reader', password: 'secret', database: 'private_stage', accessMode: 'read_only',
  });
  store.close();
  return { root, home, descriptor };
}

function operation(id: string, connection: string, domain = 'work_order') {
  return defineBusinessOperation({
    id, domain, name: 'find', title: '查询详情', description: '查询固定详情。', useWhen: '按编号查询时使用。',
    connection, mode: 'read', exposure: 'domain', input: z.object({ id: z.string().min(1) }),
    sql: 'SELECT :id AS id LIMIT 1', maxRows: 1,
  });
}

async function connect(application: MysqlMcpApplication): Promise<Client> {
  const client = new Client({ name: 'codex-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await application.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace MCP tool surface', () => {
  it('separates admin/global/workspace and binds names without physical aliases', async () => {
    const state = fixture();
    const admin = createMysqlMcpApplication({ stateHome: state.home, mode: 'admin' });
    const adminClient = await connect(admin);
    const adminNames = (await adminClient.listTools()).tools.map((tool) => tool.name);
    expect(adminNames).toEqual(['connection_add', 'connection_update', 'connection_list', 'connection_remove']);
    await adminClient.close();
    await admin.close();

    const workspace = createMysqlMcpApplication({
      stateHome: state.home, mode: 'workspace', workspacePath: state.descriptor,
      operations: [
        operation('work_order.find.auto-dev', 'auto-dev'),
        operation('work_order.find.auto-prod', 'auto-prod'),
        operation('proofline.find.proof-test', 'proof-test', 'proofline'),
      ],
    });
    const client = await connect(workspace);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'sql_query', 'schema_search', 'schema_describe', 'sql_execute',
      'sql_query__proofline', 'schema_search__proofline', 'sql_execute__proofline',
      'sql_query__prod', 'schema_search__prod', 'schema_describe__prod',
      'business__work_order__read', 'business__proofline__read', 'business__prod__work_order__read',
      'workspace_datasource_add', 'workspace_datasource_bind', 'workspace_datasource_list',
      'workspace_datasource_update', 'workspace_datasource_remove', 'workspace_validate',
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['connection_add', 'connection_list', 'sql_execute__prod']));
    for (const name of ['sql_query', 'sql_query__proofline', 'sql_query__prod', 'list_business_operations']) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(JSON.stringify(schema)).not.toContain('connection');
    }
    expect(names.filter((name) => name.includes('auto-dev') || name.includes('auto-prod'))).toEqual([]);

    workspace.service.query = async (request) => ({
      schema_version: 'mysql-agent/result/1', status: 'ok', kind: 'query', connection: request.connection,
      business_operation_id: request.businessOperationId ?? null, rows: [], row_count: 0,
    });
    const query = await client.callTool({ name: 'sql_query', arguments: { sql: 'SELECT 1 LIMIT 1' } });
    expect(query.structuredContent).toEqual(expect.objectContaining({ datasource_id: 'autoserver', environment: 'test' }));
    expect(query.structuredContent).not.toHaveProperty('connection');
    const business = await client.callTool({
      name: 'business__prod__work_order__read', arguments: { operation: 'find', input: { id: 'A1' } },
    });
    expect(business.structuredContent).toEqual(expect.objectContaining({ datasource_id: 'autoserver', environment: 'prod' }));
    const listed = await client.callTool({ name: 'list_business_operations', arguments: {} });
    expect(JSON.stringify(listed.structuredContent)).not.toContain('auto-dev');
    expect(JSON.stringify(listed.structuredContent)).not.toContain('auto-prod');
    await client.close();
    await workspace.close();
  });

  it('enforces ownership/shareability and manages workspace-owned datasources without saving passwords in YAML', async () => {
    const state = fixture();
    const application = createMysqlMcpApplication({ stateHome: state.home, mode: 'workspace', workspacePath: state.descriptor, operations: [] });
    const client = await connect(application);

    const unauthorized = await client.callTool({
      name: 'workspace_datasource_bind', arguments: { datasource_id: 'private', environment: 'staging', alias: 'private-stage' },
    });
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.structuredContent).toEqual(expect.objectContaining({ code: 'WORKSPACE_CONNECTION_NOT_AUTHORIZED' }));

    const bound = await client.callTool({
      name: 'workspace_datasource_bind', arguments: { datasource_id: 'shared', environment: 'staging', alias: 'shared-stage' },
    });
    expect(bound.isError).toBe(false);
    expect(bound.structuredContent).toEqual(expect.objectContaining({ reconnect_required: true }));

    const added = await client.callTool({
      name: 'workspace_datasource_add', arguments: {
        datasource_id: 'reporting', environment: 'staging', alias: 'report-stage', host: 'localhost',
        username: 'agent', password: 'workspace-secret', database: 'reporting', access_mode: 'read_write',
      },
    });
    expect(added.isError).toBe(false);
    expect(JSON.stringify(added.structuredContent)).not.toContain('workspace-secret');
    expect(readFileSync(state.descriptor, 'utf8')).not.toContain('workspace-secret');
    expect(application.store.requireConnection('report-stage')).toEqual(expect.objectContaining({
      ownerScope: 'workspace:auto-server', shareable: false, datasourceId: 'reporting', environment: 'staging',
    }));

    const updated = await client.callTool({
      name: 'workspace_datasource_update', arguments: { datasource_id: 'reporting', environment: 'staging', description: 'Reports' },
    });
    expect(updated.isError).toBe(false);
    expect(application.store.requireConnection('report-stage').description).toBe('Reports');

    const removed = await client.callTool({
      name: 'workspace_datasource_remove', arguments: { datasource_id: 'reporting', environment: 'staging' },
    });
    expect(removed.isError).toBe(false);
    expect(application.store.getConnection('report-stage')).not.toBeNull();

    const prodAdd = await client.callTool({
      name: 'workspace_datasource_add', arguments: {
        datasource_id: 'blocked', environment: 'prod', alias: 'blocked-prod', host: 'localhost',
        username: 'agent', password: 'secret', database: 'blocked',
      },
    });
    expect(prodAdd.isError).toBe(true);

    const list = await client.callTool({ name: 'workspace_datasource_list', arguments: {} });
    expect(JSON.stringify(list.structuredContent)).not.toContain('private-stage');
    expect(JSON.stringify(list.structuredContent)).not.toContain('workspace-secret');
    await client.close();
    await application.close();
  });

  it('compensates a new connection when the descriptor update fails', async () => {
    const state = fixture();
    const application = createMysqlMcpApplication({ stateHome: state.home, mode: 'workspace', workspacePath: state.descriptor, operations: [] });
    application.workspaceManager!.setBinding = () => { throw new Error('simulated rename failure'); };
    const client = await connect(application);
    const response = await client.callTool({
      name: 'workspace_datasource_add', arguments: {
        datasource_id: 'temp', environment: 'staging', alias: 'temp-stage', host: 'localhost',
        username: 'agent', password: 'secret', database: 'temp',
      },
    });
    expect(response.isError).toBe(true);
    expect(application.store.getConnection('temp-stage')).toBeNull();
    await client.close();
    await application.close();
  });
});
