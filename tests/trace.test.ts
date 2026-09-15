import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineBusinessOperation } from '../src/business-queries/definition.js';
import { STATE_SCHEMA_VERSION } from '../src/constants.js';
import { StateStore } from '../src/config/store.js';
import { PluginError } from '../src/errors.js';
import { createMysqlMcpApplication, type MysqlMcpApplication } from '../src/mcp/server.js';
import { MysqlService } from '../src/mysql/service.js';
import type { ConnectionRuntimeRegistry } from '../src/mysql/runtime.js';
import { TraceRecorder, uuidV7 } from '../src/trace/recorder.js';
import type { ExecutionRunRecord } from '../src/types.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workspaceFixture(workspaceId = 'trace-one'): { root: string; home: string; descriptor: string } {
  const root = tempRoot('mysql-agent-trace-workspace-');
  const home = join(root, 'home');
  const descriptor = join(root, '.mysql-agent', 'workspace.yml');
  mkdirSync(join(root, '.mysql-agent'), { recursive: true });
  writeFileSync(descriptor, `
schema_version: mysql-agent/workspace/1
workspace_id: ${workspaceId}
label: Trace test
runtime_mode: workspace
default_datasource: autoserver
default_environment: test
environments:
  test:
    datasource_bindings: { autoserver: auto-test }
business_pack_paths: []
audit_retention_days: 30
`);
  const store = new StateStore(home);
  store.addConnection({
    alias: 'auto-test', datasourceId: 'autoserver', environment: 'test', ownerScope: `workspace:${workspaceId}`,
    host: 'localhost', username: 'agent', password: 'secret', database: 'auto_test', accessMode: 'read_write',
  });
  store.close();
  return { root, home, descriptor };
}

async function clientFor(application: MysqlMcpApplication): Promise<Client> {
  const client = new Client({ name: 'codex-trace-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await application.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function runRecord(overrides: Partial<ExecutionRunRecord>): ExecutionRunRecord {
  return {
    runId: uuidV7(), workspaceId: 'one', taskId: null, traceId: '1'.repeat(32), rootSpanId: '2'.repeat(16),
    operationId: 'work_order.find', operationKind: 'sql', datasourceIds: ['autoserver'], environment: 'test',
    connectionAliases: ['auto-test'], packId: null, packVersion: null, operationHash: null, scriptHash: null,
    startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:00:00.001Z', durationMs: 1,
    queueDurationMs: 0, status: 'ok', errorCategory: null, resultBytes: 10,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trace identities and storage', () => {
  it('generates monotonic RFC 9562 UUIDv7 IDs and W3C-sized non-zero trace IDs', () => {
    const timestamp = Date.now();
    const first = uuidV7(timestamp);
    const second = uuidV7(timestamp);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second > first).toBe(true);

    const store = new StateStore(join(tempRoot('mysql-agent-trace-ids-'), 'home'));
    const context = new TraceRecorder(store).startRoot({ workspaceId: 'one', operationId: 'sql_query', operationKind: 'generic_sql' });
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.traceId).not.toBe('0'.repeat(32));
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.spanId).not.toBe('0'.repeat(16));
    store.close();
  });

  it('links a nested SQL audit to its child span without creating another root', async () => {
    const home = join(tempRoot('mysql-agent-trace-child-'), 'home');
    const store = new StateStore(home);
    store.addConnection({ alias: 'auto-test', datasourceId: 'autoserver', environment: 'test', host: 'localhost', username: 'agent', password: '', database: 'auto_test' });
    const runtimes = {
      withRuntime: async () => ({
        value: { columns: [{ name: 'id', database_type: 'LONG' }], rows: [{ id: 1 }], rowCount: 1, truncated: false },
        attemptCount: 1,
      }),
      closeAll: async () => undefined,
    } as unknown as ConnectionRuntimeRegistry;
    const service = new MysqlService(store, runtimes);
    const recorder = new TraceRecorder(store);
    const root = recorder.startRoot({
      workspaceId: 'one', operationId: 'diagnose', operationKind: 'script', datasourceIds: ['autoserver'],
      environment: 'test', connectionAliases: ['auto-test'],
    });
    const child = recorder.startChild(root, {
      operationId: 'work_order.find', operationKind: 'sql', datasourceId: 'autoserver', environment: 'test',
      connectionAlias: 'auto-test', stepIndex: 1,
    });
    const value = await service.query({
      connection: 'auto-test', sql: 'SELECT 1 AS id LIMIT 1', workspaceId: 'one', datasourceId: 'autoserver',
      environment: 'test', businessOperationId: 'work_order.find', traceContext: child,
    });
    recorder.finishSpan(child, { status: 'ok', result: value });
    recorder.finishRoot(root, { status: 'ok', result: value });

    const found = store.searchExecutionRuns({ workspaceId: 'one', runId: root.runId, limit: 10 });
    expect(found.records).toHaveLength(1);
    const spans = store.listExecutionSpans('one', root.runId);
    expect(spans).toHaveLength(2);
    expect(spans[1]).toEqual(expect.objectContaining({ parentSpanId: root.spanId, traceId: root.traceId, operationId: 'work_order.find' }));
    const audit = store.searchAudit({ workspaceId: 'one', limit: 10 }).records[0]!;
    expect(audit).toEqual(expect.objectContaining({ traceId: root.traceId, runId: root.runId, spanId: child.spanId }));
    expect(JSON.stringify(found.records)).not.toContain('SELECT 1');
    await service.close();
  });

  it('migrates trace tables and audit links idempotently', () => {
    const home = join(tempRoot('mysql-agent-trace-migration-'), 'home');
    new StateStore(home).close();
    new StateStore(home).close();
    const database = new DatabaseSync(join(home, 'state.db'));
    expect((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(STATE_SCHEMA_VERSION);
    expect((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9').get() as { count: number }).count).toBe(1);
    const auditColumns = (database.prepare('PRAGMA table_info(execution_audit)').all() as Array<{ name: string }>).map((item) => item.name);
    expect(auditColumns).toEqual(expect.arrayContaining(['trace_id', 'span_id', 'run_id']));
    expect((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('execution_runs','execution_spans')").get() as { count: number }).count).toBe(2);
    database.close();
  });
});

describe('workspace trace tools', () => {
  it('records successful schema and SQL roots, and returns trace IDs without physical aliases', async () => {
    const fixture = workspaceFixture();
    const application = createMysqlMcpApplication({
      stateHome: fixture.home, mode: 'workspace', workspacePath: fixture.descriptor, operations: [],
      schemaLoader: async () => ({ tables: [], relations: [] }),
    });
    application.service.query = async () => ({ status: 'ok', kind: 'query', rows: [], row_count: 0, connection: 'auto-test' });
    const client = await clientFor(application);
    const query = await client.callTool({ name: 'sql_query', arguments: { sql: 'SELECT 1 LIMIT 1' } });
    const schema = await client.callTool({ name: 'schema_search', arguments: {} });
    for (const response of [query, schema]) {
      expect(response.structuredContent).toEqual(expect.objectContaining({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/), run_id: expect.stringMatching(/-7/) }));
      expect(JSON.stringify(response.structuredContent)).not.toContain('auto-test');
    }
    const traces = await client.callTool({ name: 'trace_search', arguments: {} });
    expect(traces.structuredContent).toEqual(expect.objectContaining({ record_count: 2 }));
    expect(JSON.stringify(traces.structuredContent)).not.toContain('auto-test');
    await client.close();
    await application.close();
  });

  it('records a fixed SQL business operation as one root and passes that root to SQL audit context', async () => {
    const fixture = workspaceFixture();
    const operation = defineBusinessOperation({
      id: 'work_order.find.auto-test', domain: 'work_order', name: 'find', title: 'Find',
      description: 'Find a work order.', useWhen: 'A number is provided.', connection: 'auto-test',
      mode: 'read', exposure: 'direct', input: z.object({ order_no: z.string().min(1) }),
      sql: 'SELECT :order_no AS order_no LIMIT 1', maxRows: 1, packId: 'autoserver', packVersion: '1.0.0', operationHash: 'hash',
    });
    const application = createMysqlMcpApplication({
      stateHome: fixture.home, mode: 'workspace', workspacePath: fixture.descriptor, operations: [operation],
    });
    let observedTrace: unknown;
    application.service.query = async (request) => {
      observedTrace = request.traceContext;
      return { status: 'ok', kind: 'query', rows: [], row_count: 0, connection: request.connection, business_operation_id: request.businessOperationId };
    };
    const client = await clientFor(application);
    const response = await client.callTool({ name: 'business__work_order__find', arguments: { order_no: 'WO-1' } });
    expect(response.structuredContent).toEqual(expect.objectContaining({ business_operation_id: 'work_order.find', trace_id: expect.any(String), run_id: expect.any(String) }));
    expect(observedTrace).toEqual(expect.objectContaining({ operationId: 'work_order.find', operationKind: 'sql' }));
    const traces = await client.callTool({ name: 'trace_search', arguments: { operation_id: 'work_order.find' } });
    expect(traces.structuredContent).toEqual(expect.objectContaining({ records: [expect.objectContaining({
      operation_id: 'work_order.find', operation_kind: 'sql', pack_id: 'autoserver', status: 'ok',
    })] }));
    await client.close();
    await application.close();
  });

  it('finishes error and cancellation roots and keeps workspace searches isolated', async () => {
    const one = workspaceFixture('trace-one');
    const application = createMysqlMcpApplication({ stateHome: one.home, mode: 'workspace', workspacePath: one.descriptor, operations: [] });
    const client = await clientFor(application);
    application.service.query = async () => { throw new Error('simulated failure'); };
    const failed = await client.callTool({ name: 'sql_query', arguments: { sql: 'SELECT 1 LIMIT 1' } });
    expect(failed.isError).toBe(true);
    application.service.query = async () => {
      throw new PluginError({ category: 'timeout', code: 'REQUEST_CANCELLED', message: 'cancelled' });
    };
    const cancelled = await client.callTool({ name: 'sql_query', arguments: { sql: 'SELECT 1 LIMIT 1' } });
    expect(cancelled.isError).toBe(true);
    const traces = await client.callTool({ name: 'trace_search', arguments: {} });
    const records = (traces.structuredContent as { records: Array<{ status: string }> }).records;
    expect(records.map((item) => item.status).sort()).toEqual(['cancelled', 'error']);

    const other = new TraceRecorder(application.store).startRoot({ workspaceId: 'trace-two', operationId: 'secret', operationKind: 'generic_sql' });
    new TraceRecorder(application.store).finishRoot(other, { status: 'ok', result: { hidden: true } });
    const isolated = await client.callTool({ name: 'trace_search', arguments: { operation_id: 'secret' } });
    expect(isolated.structuredContent).toEqual(expect.objectContaining({ record_count: 0 }));
    await client.close();
    await application.close();
  });

  it('filters searches and computes nearest-rank usage percentiles', async () => {
    const fixture = workspaceFixture('one');
    const application = createMysqlMcpApplication({ stateHome: fixture.home, mode: 'workspace', workspacePath: fixture.descriptor, operations: [] });
    for (const [index, duration] of [1, 2, 3, 4, 100].entries()) {
      application.store.createExecutionRun(runRecord({
        runId: uuidV7(), traceId: (index + 1).toString(16).repeat(32), rootSpanId: (index + 1).toString(16).repeat(16),
        durationMs: duration, status: index === 4 ? 'error' : 'ok', errorCategory: index === 4 ? 'sql_error' : null,
        resultBytes: duration, operationKind: index === 0 ? 'generic_sql' : 'sql',
      }));
    }
    application.store.createExecutionRun(runRecord({ workspaceId: 'two', runId: uuidV7(), traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16) }));
    const client = await clientFor(application);
    const filtered = await client.callTool({ name: 'trace_search', arguments: { operation_kind: 'generic_sql', datasource_id: 'autoserver', environment: 'test' } });
    expect(filtered.structuredContent).toEqual(expect.objectContaining({ record_count: 1 }));
    const usage = await client.callTool({ name: 'usage_summary', arguments: {} });
    expect(usage.structuredContent).toEqual(expect.objectContaining({ groups: [expect.objectContaining({
      group: 'all', count: 5, error_count: 1, p50_ms: 3, p95_ms: 100, p99_ms: 100, avg_ms: 22, result_bytes: 110,
    })] }));
    await client.close();
    await application.close();
  });

  it('paginates every run when 25 records share the same started_at', async () => {
    const fixture = workspaceFixture('one');
    const application = createMysqlMcpApplication({ stateHome: fixture.home, mode: 'workspace', workspacePath: fixture.descriptor, operations: [] });
    const startedAt = '2026-09-15T00:00:00.000Z';
    for (let index = 0; index < 25; index += 1) {
      application.store.createExecutionRun(runRecord({
        runId: uuidV7(), traceId: (index + 1).toString(16).padStart(32, '0'),
        rootSpanId: (index + 1).toString(16).padStart(16, '0'), operationId: `page.${index}`, startedAt,
      }));
    }
    const client = await clientFor(application);
    const first = await client.callTool({ name: 'trace_search', arguments: { limit: 20 } });
    const firstContent = first.structuredContent as { records: Array<{ run_id: string }>; next_cursor: string | null };
    expect(firstContent.records).toHaveLength(20);
    expect(firstContent.next_cursor).toEqual(expect.any(String));
    const second = await client.callTool({ name: 'trace_search', arguments: { limit: 20, cursor: firstContent.next_cursor } });
    const secondContent = second.structuredContent as { records: Array<{ run_id: string }>; next_cursor: string | null };
    expect(secondContent.records).toHaveLength(5);
    expect(secondContent.next_cursor).toBeNull();
    const ids = [...firstContent.records, ...secondContent.records].map((record) => record.run_id);
    expect(new Set(ids).size).toBe(25);
    await client.close();
    await application.close();
  });

  it('does not flip a successful business result when trace finalization fails', async () => {
    const fixture = workspaceFixture();
    const application = createMysqlMcpApplication({ stateHome: fixture.home, mode: 'workspace', workspacePath: fixture.descriptor, operations: [] });
    application.service.query = async () => ({ status: 'ok', kind: 'query', rows: [], row_count: 0, connection: 'auto-test' });
    application.store.finishExecutionRoot = () => { throw new Error('simulated trace finish failure'); };
    const client = await clientFor(application);
    const response = await client.callTool({ name: 'sql_query', arguments: { sql: 'SELECT 1 LIMIT 1' } });
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(expect.objectContaining({ status: 'ok', trace_id: expect.any(String), run_id: expect.any(String) }));
    await client.close();
    await application.close();
  });
});

describe('workspace trace retention', () => {
  it('deletes only expired runs and cascaded spans for the selected workspace', () => {
    const store = new StateStore(join(tempRoot('mysql-agent-trace-retention-'), 'home'));
    const recorder = new TraceRecorder(store);
    const oldOne = recorder.startRoot({ workspaceId: 'one', operationId: 'old-one', operationKind: 'sql' });
    recorder.finishRoot(oldOne, { status: 'ok', result: {} });
    const oldTwo = recorder.startRoot({ workspaceId: 'two', operationId: 'old-two', operationKind: 'sql' });
    recorder.finishRoot(oldTwo, { status: 'ok', result: {} });
    const database = new DatabaseSync(store.path);
    database.prepare("UPDATE execution_runs SET started_at = '2026-01-01T00:00:00.000Z' WHERE run_id IN (?, ?)").run(oldOne.runId, oldTwo.runId);
    database.close();
    const fresh = recorder.startRoot({ workspaceId: 'one', operationId: 'fresh', operationKind: 'sql' });
    recorder.finishRoot(fresh, { status: 'ok', result: {} });
    expect(store.cleanupExecutionTraces('one', '2026-02-01T00:00:00.000Z')).toEqual({ runsDeleted: 1, spansDeleted: 1 });
    expect(store.searchExecutionRuns({ workspaceId: 'one', limit: 10 }).records.map((item) => item.operationId)).toEqual(['fresh']);
    expect(store.searchExecutionRuns({ workspaceId: 'two', limit: 10 }).records.map((item) => item.operationId)).toEqual(['old-two']);
    store.close();
  });
});
