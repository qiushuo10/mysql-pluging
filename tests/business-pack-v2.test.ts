import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { loadBusinessOperations, loadBusinessOperationsFromHomes } from '../src/business-packs/loader.js';
import { StateStore } from '../src/config/store.js';
import { PluginError } from '../src/errors.js';
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
      return {
        schema_version: 'mysql-agent/result/1', execution_id: 'internal-child-execution', status: 'ok', kind: 'query',
        connection: request.connection, database: 'secret_internal_database', rows: [{ id: 'A1' }], row_count: 1,
        columns: [{ name: 'id', database_type: 'VARCHAR' }], truncated: false, duration_ms: 1, attempt_count: 1,
      };
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
    expect(JSON.stringify(response.structuredContent)).not.toMatch(/auto-test|proof-test|secret_internal_database|internal-child-execution/);
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
    expect(response.structuredContent).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_OPERATION_NOT_ALLOWED' }));
    expect(JSON.stringify(response)).not.toContain('TOP-SECRET');
    await client.close(); await app.close();
  });

  it('does not expose the original host error when sandbox code catches it', async () => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      const input = await workflow.input();
      try {
        return await operations.call('order.find', input);
      } catch (error) {
        return { caught: String(error), message: error && error.message };
      }
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async () => {
      throw new PluginError({
        category: 'permission_error', code: 'READ_ONLY_CONNECTION',
        message: 'secret alias auto-test and database secret_internal_database',
      });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/auto-test|secret_internal_database|READ_ONLY_CONNECTION/);
    await client.close(); await app.close();
  });

  it.each([
    ['argument_error', 'INVALID_BUSINESS_PARAMETER_VALUE', false],
    ['permission_error', 'READ_ONLY_CONNECTION', false],
    ['timeout', 'MYSQL_QUERY_TIMEOUT', true],
  ] as const)('preserves safe host PluginError semantics for %s', async (category, code, retryable) => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      const input = await workflow.input();
      return operations.call('order.find', input);
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async () => {
      throw new PluginError({
        category, code, retryable, writeOutcome: 'not_applicable',
        message: 'secret alias auto-test and database secret_internal_database',
      });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ category, code, retryable }));
    expect(JSON.stringify(response)).not.toMatch(/auto-test|secret_internal_database/);
    await client.close(); await app.close();
  });

  it.each([
    ['argument_error', 'FIRST_CAUGHT', 'permission_error', 'SECOND_UNHANDLED'],
    ['permission_error', 'FIRST_CAUGHT', 'argument_error', 'SECOND_UNHANDLED'],
  ] as const)('does not misattribute a caught %s failure when a later %s failure escapes', async (firstCategory, firstCode, secondCategory, secondCode) => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      const input = await workflow.input();
      try { await operations.call('order.find', input); } catch {}
      return operations.call('proof.find', input);
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async (request) => {
      if (request.businessOperationId === 'order.find') {
        throw new PluginError({ category: firstCategory, code: firstCode, message: 'secret caught error' });
      }
      throw new PluginError({ category: secondCategory, code: secondCode, message: 'secret unhandled error' });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ category: 'internal_error', code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(JSON.stringify(response)).not.toMatch(/FIRST_CAUGHT|SECOND_UNHANDLED|secret caught|secret unhandled/);
    await client.close(); await app.close();
  });

  it.each([
    ['PluginError then ZodError', `
      const input = await workflow.input();
      try { await operations.call('order.find', input); } catch {}
      return operations.call('proof.find', { id: 123 });
    `],
    ['ZodError then PluginError', `
      const input = await workflow.input();
      try { await operations.call('order.find', { id: 123 }); } catch {}
      return operations.call('proof.find', input);
    `],
  ] as const)('does not restore a PluginError for mixed host failures: %s', async (_label, source) => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), source);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async () => {
      throw new PluginError({ category: 'permission_error', code: 'MIXED_PLUGIN_ERROR', message: 'mixed-plugin-secret' });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ category: 'internal_error', code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(JSON.stringify(response)).not.toMatch(/MIXED_PLUGIN_ERROR|mixed-plugin-secret|invalid_type/);
    await client.close(); await app.close();
  });

  it('keeps a single non-PluginError host failure generic', async () => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      return operations.call('order.find', { id: 123 });
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ category: 'internal_error', code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(JSON.stringify(response)).not.toMatch(/invalid_type|expected string|received number/);
    await client.close(); await app.close();
  });

  it('allows a script to catch mixed host failures and complete successfully', async () => {
    const state = fixture();
    writeFileSync(join(state.packs, 'sample', 'scripts', 'combine.ts'), `
      const input = await workflow.input();
      try { await operations.call('order.find', input); } catch {}
      try { await operations.call('proof.find', { id: 123 }); } catch {}
      return { recovered: true };
    `);
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async () => {
      throw new PluginError({ category: 'permission_error', code: 'CAUGHT_PLUGIN_ERROR', message: 'caught-plugin-secret' });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(expect.objectContaining({ output: { recovered: true } }));
    expect(JSON.stringify(response)).not.toMatch(/CAUGHT_PLUGIN_ERROR|caught-plugin-secret|invalid_type/);
    await client.close(); await app.close();
  });

  it('returns a generic error instead of guessing between concurrent host failures', async () => {
    const state = fixture();
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async (request) => {
      if (request.businessOperationId === 'order.find') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        throw new PluginError({ category: 'argument_error', code: 'FIRST_STEP_FAILED', message: 'secret first error' });
      }
      throw new PluginError({ category: 'permission_error', code: 'SECOND_STEP_FAILED', message: 'secret second error' });
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ category: 'internal_error', code: 'BUSINESS_SCRIPT_HOST_CALL_FAILED' }));
    expect(JSON.stringify(response)).not.toMatch(/FIRST_STEP_FAILED|SECOND_STEP_FAILED|secret first|secret second/);
    await client.close(); await app.close();
  });

  it('finishes every child span before a timeout root returns even when host work ignores abort', async () => {
    const state = fixture();
    const packPath = join(state.packs, 'sample', 'pack.yml');
    writeFileSync(packPath, readFileSync(packPath, 'utf8').replace('timeout_ms: 3000', 'timeout_ms: 100'));
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    let active = 0;
    let maximum = 0;
    const signals: AbortSignal[] = [];
    app.service.query = async (request) => {
      active += 1; maximum = Math.max(maximum, active); signals.push(request.requestSignal!);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
      active -= 1;
      return { status: 'ok', rows: [], row_count: 0 };
    };
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ code: 'BUSINESS_SCRIPT_TIMEOUT' }));
    const runId = String((response.structuredContent as Record<string, unknown>).run_id);
    expect(app.store.listExecutionSpans('v2-test', runId).every((span) => span.status !== 'running')).toBe(true);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(signals.every((item) => item.aborted)).toBe(true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    expect(active).toBe(0);
    expect(app.store.listExecutionSpans('v2-test', runId).every((span) => span.status !== 'running')).toBe(true);
    await client.close(); await app.close();
  });

  it('terminalizes child spans for host promises that never settle', async () => {
    const state = fixture();
    const packPath = join(state.packs, 'sample', 'pack.yml');
    writeFileSync(packPath, readFileSync(packPath, 'utf8').replace('timeout_ms: 3000', 'timeout_ms: 100'));
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    app.service.query = async () => new Promise<Record<string, unknown>>(() => undefined);
    const client = await connect(app);
    const response = await client.callTool({ name: 'business__order__combine', arguments: { id: 'A1' } });
    const runId = String((response.structuredContent as Record<string, unknown>).run_id);
    const spans = app.store.listExecutionSpans('v2-test', runId);
    expect(spans).toHaveLength(3);
    expect(spans.every((span) => span.status !== 'running')).toBe(true);
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
    expect(response.structuredContent).toEqual(expect.objectContaining({ category: 'permission_error', code: 'AUTH_TARGET_CHANGED' }));
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

  it('loads cross-path dependencies as one catalog and rejects global duplicates', async () => {
    const state = fixture();
    const homeA = join(state.root, '.mysql-agent', 'packs-a');
    const homeB = join(state.root, '.mysql-agent', 'packs-b');
    mkdirSync(join(homeA, 'a', 'sql'), { recursive: true });
    mkdirSync(join(homeB, 'b', 'scripts'), { recursive: true });
    writeFileSync(join(homeA, 'a', 'sql', 'find.sql'), 'SELECT :id AS id LIMIT 1');
    writeFileSync(join(homeA, 'a', 'pack.yml'), `
schema_version: mysql-agent/business-pack/2
pack_id: cross-a
version: 1.0.0
operations:
  - id: cross.find
    kind: sql
    domain: cross
    name: find
    title: Find
    description: Find one.
    use_when: Find one.
    datasource: autoserver
    environments: [test]
    mode: read
    input:
      id: { type: string, min_length: 1, max_length: 64 }
    sql_file: sql/find.sql
    max_rows: 1
`);
    writeFileSync(join(homeB, 'b', 'scripts', 'read.ts'), `
const input = await workflow.input();
return await operations.call('cross.find', input);
`);
    const scriptPack = (packId = 'cross-b') => `
schema_version: mysql-agent/business-pack/2
pack_id: ${packId}
version: 1.0.0
operations:
  - id: cross.diagnose
    kind: script
    domain: cross
    name: diagnose
    title: Read
    description: Read one.
    use_when: Read one.
    datasource: autoserver
    environments: [test]
    mode: read
    exposure: direct
    input:
      id: { type: string, min_length: 1, max_length: 64 }
    script_file: scripts/read.ts
    uses: [cross.find]
`;
    writeFileSync(join(homeB, 'b', 'pack.yml'), scriptPack());
    const workspace = loadWorkspaceContext(state.descriptor);
    const loaded = loadBusinessOperationsFromHomes([homeA, homeB], { workspace });
    expect(loaded.operations.map((item) => item.registrationId)).toEqual(['cross.find@test', 'cross.diagnose@test']);

    writeFileSync(join(homeB, 'b', 'pack.yml'), scriptPack('cross-a'));
    expect(() => loadBusinessOperationsFromHomes([homeA, homeB], { workspace })).toThrow(expect.objectContaining({ code: 'DUPLICATE_BUSINESS_PACK' }));

    writeFileSync(join(homeB, 'b', 'pack.yml'), readFileSync(join(homeA, 'a', 'pack.yml'), 'utf8').replace('pack_id: cross-a', 'pack_id: cross-c'));
    expect(() => loadBusinessOperationsFromHomes([homeA, homeB], { workspace })).toThrow(expect.objectContaining({ code: 'DUPLICATE_BUSINESS_OPERATION' }));

    writeFileSync(state.descriptor, readFileSync(state.descriptor, 'utf8').replace(
      'business_pack_paths: [./business-packs]',
      'business_pack_paths: [./packs-a, ./packs-b]',
    ));
    writeFileSync(join(homeB, 'b', 'pack.yml'), scriptPack());
    const app = createMysqlMcpApplication({ stateHome: state.stateHome, mode: 'workspace', workspacePath: state.descriptor });
    expect(app.businessRegistry.all().map((item) => item.registrationId)).toEqual(['cross.find@test', 'cross.diagnose@test']);
    await app.close();
  });
});
