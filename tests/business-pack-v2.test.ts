import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { loadBusinessOperations } from '../src/business-packs/loader.js';
import { StateStore } from '../src/config/store.js';
import { createMysqlMcpApplication, type MysqlMcpApplication } from '../src/mcp/server.js';
import { loadWorkspaceContext } from '../src/workspace/context.js';

const roots: string[] = [];
function root(): string { const value = mkdtempSync(join(tmpdir(), 'mysql-agent-v2-')); roots.push(value); return value; }

function fixture(): { root: string; stateHome: string; descriptor: string; packs: string } {
  const project = root();
  const stateHome = join(project, 'state');
  const descriptor = join(project, '.mysql-agent', 'workspace.yml');
  const packs = join(project, '.mysql-agent', 'business-packs');
  mkdirSync(join(packs, 'sample', 'sql'), { recursive: true });
  mkdirSync(join(packs, 'sample', 'scripts'), { recursive: true });
  writeFileSync(descriptor, `
schema_version: mysql-agent/workspace/1
workspace_id: v2-test
label: V2 Test
runtime_mode: workspace
default_datasource: autoserver
default_environment: test
environments:
  test:
    datasource_bindings:
      autoserver: auto-test
      proofline: proof-test
  prod:
    datasource_bindings:
      autoserver: auto-prod
    access_mode: read_only
    expose_as_explicit_tool: true
business_pack_paths: [./business-packs]
audit_retention_days: 30
`);
  writeFileSync(join(packs, 'sample', 'pack.yml'), `
schema_version: mysql-agent/business-pack/2
pack_id: sample-v2
version: 2.0.0
operations:
  - id: order.find
    kind: sql
    domain: order
    name: find
    title: 查订单
    description: 查询订单。
    use_when: 已知订单号。
    datasource: autoserver
    environments: [test, prod]
    mode: read
    input:
      id: { type: string, min_length: 1, max_length: 64 }
    sql_file: sql/find.sql
    max_rows: 1
  - id: proof.find
    kind: sql
    domain: proof
    name: find
    title: 查凭据
    description: 查询凭据。
    use_when: 已知订单号。
    datasource: proofline
    environments: [test]
    mode: read
    input:
      id: { type: string, min_length: 1, max_length: 64 }
    sql_file: sql/find.sql
    max_rows: 1
  - id: order.combine
    kind: script
    domain: order
    name: combine
    title: 联合诊断
    description: 组合订单与凭据结果。
    use_when: 需要一次诊断时。
    datasources: [autoserver, proofline]
    environments: [test, prod]
    mode: read
    exposure: direct
    input:
      id: { type: string, min_length: 1, max_length: 64 }
    script_file: scripts/combine.ts
    uses: [order.find, proof.find]
    timeout_ms: 3000
    max_result_bytes: 32768
`);
  writeFileSync(join(packs, 'sample', 'sql', 'find.sql'), 'SELECT :id AS id LIMIT 1');
  writeFileSync(join(packs, 'sample', 'scripts', 'combine.ts'), `
const input: { id: string } = await workflow.input();
const [order, proof] = await Promise.all([
  operations.call('order.find', input),
  operations.call('proof.find', input),
]);
return { order, proof };
`);
  const store = new StateStore(stateHome);
  for (const value of [
    { alias: 'auto-test', datasourceId: 'autoserver', environment: 'test' as const, ownerScope: 'workspace:v2-test', accessMode: 'read_write' as const },
    { alias: 'proof-test', datasourceId: 'proofline', environment: 'test' as const, ownerScope: 'workspace:v2-test', accessMode: 'read_write' as const },
    { alias: 'auto-prod', datasourceId: 'autoserver', environment: 'prod' as const, ownerScope: 'global', shareable: true, accessMode: 'read_only' as const },
  ]) store.addConnection({ ...value, host: 'localhost', username: 'agent', password: 'secret', database: value.alias });
  store.close();
  return { root: project, stateHome, descriptor, packs };
}

async function connect(application: MysqlMcpApplication): Promise<Client> {
  const client = new Client({ name: 'codex-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await application.server.connect(serverTransport); await client.connect(clientTransport); return client;
}

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('business pack v2', () => {
  it('resolves SQL and scripts per environment, keeps public ids stable, and reports disabled targets', () => {
    const state = fixture();
    const loaded = loadBusinessOperations(state.packs, { workspace: loadWorkspaceContext(state.descriptor) });
    expect(loaded.operations.map((item) => item.registrationId)).toEqual(['order.find@test', 'order.find@prod', 'proof.find@test', 'order.combine@test']);
    expect(loaded.operations.map((item) => item.id)).toEqual(['order.find', 'order.find', 'proof.find', 'order.combine']);
    expect(loaded.disabledOperations).toEqual([expect.objectContaining({ id: 'order.combine', environment: 'prod', code: 'WORKSPACE_BUSINESS_BINDING_MISSING' })]);
    expect(loaded.operations.find((item) => item.kind === 'script')).toEqual(expect.objectContaining({
      datasourceIds: ['autoserver', 'proofline'], uses: ['order.find', 'proof.find'], connection: 'auto-test',
    }));
  });

  it('registers and executes a script as one MCP root with two child SQL spans and child-linked audits', async () => {
    const state = fixture();
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async (request) => {
      expect(request.traceContext?.parentSpanId).not.toBeNull();
      app.store.recordAudit({
        executionId: `${request.businessOperationId}-${Math.random()}`, occurredAt: new Date().toISOString(), clientName: 'test',
        connectionAlias: request.connection, workspaceId: request.workspaceId, datasourceId: request.datasourceId,
        environment: request.environment, traceId: request.traceContext?.traceId, spanId: request.traceContext?.spanId,
        runId: request.traceContext?.runId, businessOperationId: request.businessOperationId ?? null,
        businessPackId: request.businessPackId ?? null, businessPackVersion: request.businessPackVersion ?? null,
        businessOperationHash: request.businessOperationHash ?? null, statementKind: 'select', sqlHash: 'test', durationMs: 1,
        rowCount: 1, affectedRows: null, attemptCount: 1, writeOutcome: 'not_applicable', status: 'ok', errorCategory: null, mysqlErrorCode: null,
      });
      return { schema_version: 'mysql-agent/result/1', status: 'ok', kind: 'query', connection: request.connection, rows: [{ id: 'A1' }], row_count: 1 };
    };
    const client = await connect(app);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toContain('business__order__combine');
    expect(tools.map((tool) => tool.name)).not.toContain('business__prod__order__combine');
    expect(JSON.stringify(tools.find((tool) => tool.name === 'business__order__combine')!.inputSchema)).not.toMatch(/connection|datasource|environment/);
    const validation = await client.callTool({ name: 'workspace_validate', arguments: {} });
    expect(validation.structuredContent).toEqual(expect.objectContaining({
      disabled_business_operations: [expect.objectContaining({ id: 'order.combine', environment: 'prod' })],
    }));
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(expect.objectContaining({
      run_id: expect.any(String), trace_id: expect.any(String), datasource_ids: ['autoserver', 'proofline'],
      business_pack_id: 'sample-v2', business_pack_version: '2.0.0',
      business_operation_hash: expect.stringMatching(/^sha256:/), script_hash: expect.stringMatching(/^sha256:/),
    }));
    const runId = String((response.structuredContent as Record<string, unknown>).run_id);
    const runs = app.store.searchExecutionRuns({ workspaceId: 'v2-test', runId, limit: 10 });
    expect(runs.records).toHaveLength(1);
    expect(runs.records[0]).toEqual(expect.objectContaining({ operationId: 'order.combine', operationKind: 'script', scriptHash: expect.stringMatching(/^sha256:/) }));
    const spans = app.store.listExecutionSpans('v2-test', runId);
    expect(spans).toHaveLength(3);
    const children = spans.filter((span) => span.parentSpanId !== null);
    expect(children.map((span) => span.operationId).sort()).toEqual(['order.find', 'proof.find']);
    expect(new Set(children.map((span) => span.traceId))).toEqual(new Set([runs.records[0]!.traceId]));
    const audit = app.store.searchAudit({ workspaceId: 'v2-test', limit: 10 }).records;
    expect(audit).toHaveLength(2);
    expect(new Set(audit.map((item) => item.spanId))).toEqual(new Set(children.map((item) => item.spanId)));
    await client.close(); await app.close();
  });

  it('rejects undeclared dynamic calls and redacts host errors', async () => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      const input = await workflow.input();
      return operations.call('secret.operation', input);
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'TOP-SECRET' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(JSON.stringify(response)).not.toContain('TOP-SECRET');
    await client.close(); await app.close();
  });

  it('rejects a dependency whose datasource was not declared by the script', () => {
    const state = fixture();
    const packPath = join(state.packs, 'sample', 'pack.yml');
    writeFileSync(packPath, readFileSync(packPath, 'utf8').replace('datasources: [autoserver, proofline]', 'datasource: autoserver'));
    let failure: unknown;
    try { loadBusinessOperations(state.packs, { workspace: loadWorkspaceContext(state.descriptor) }); }
    catch (error) { failure = error; }
    expect(failure).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_DATASOURCE_NOT_DECLARED' }));
  });

  it('fails a script when a captured connection revision changes before a child call', async () => {
    const state = fixture();
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    let queryCalls = 0;
    app.service.query = async (request) => { queryCalls += 1; return { status: 'ok', rows: [], row_count: 0, connection: request.connection }; };
    app.store.updateConnection({ alias: 'proof-test', description: 'changed after registry load' });
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(queryCalls).toBeLessThanOrEqual(1);
    await client.close(); await app.close();
  });

  it('rejects v2 outside paths and write dependencies during load', () => {
    const state = fixture();
    const outside = join(state.root, 'outside.ts');
    writeFileSync(outside, 'return true;');
    rmSync(join(state.packs, 'sample', 'scripts', 'combine.ts'));
    symlinkSync(outside, join(state.packs, 'sample', 'scripts', 'combine.ts'));
    expect(() => loadBusinessOperations(state.packs, { workspace: loadWorkspaceContext(state.descriptor) })).toThrow(/超出业务包目录/);

    rmSync(join(state.packs, 'sample', 'scripts', 'combine.ts'));
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), 'return true;');
    const packPath = join(state.packs, 'sample', 'pack.yml');
    writeFileSync(join(state.packs, 'sample', 'sql', 'find.sql'), 'UPDATE orders SET state = :state WHERE id = :id');
    writeFileSync(packPath, `
schema_version: mysql-agent/business-pack/2
pack_id: sample-v2
version: 2.0.0
operations:
  - id: order.update
    kind: sql
    domain: order
    name: update
    title: 更新订单
    description: 更新订单。
    use_when: 更新订单时。
    datasource: autoserver
    environments: [test]
    mode: update
    input:
      id: { type: string, min_length: 1, max_length: 64 }
      state: { type: string, min_length: 1, max_length: 64 }
    sql_file: sql/find.sql
    max_affected_rows: 1
  - id: order.combine
    kind: script
    domain: order
    name: combine
    title: 联合诊断
    description: 联合诊断。
    use_when: 诊断时。
    datasource: autoserver
    environments: [test]
    mode: read
    input: {}
    script_file: scripts/combine.ts
    uses: [order.update]
`);
    let failure: unknown;
    try { loadBusinessOperations(state.packs, { workspace: loadWorkspaceContext(state.descriptor) }); }
    catch (error) { failure = error; }
    expect(failure).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_DEPENDENCY_WRITE_FORBIDDEN' }));
    expect(() => loadBusinessOperations(state.packs)).toThrow();
  });
});
