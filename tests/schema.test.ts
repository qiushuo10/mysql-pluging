import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SCHEMA_SNAPSHOT_BYTES, SCHEMA_SNAPSHOT_FORMAT_VERSION } from '../src/constants.js';
import { StateStore } from '../src/config/store.js';
import { createMetadataByteBudget, executeMetadataQueryAttempt } from '../src/mysql/executor.js';
import { ConnectionRuntime, ConnectionRuntimeRegistry, type RuntimeRunOptions } from '../src/mysql/runtime.js';
import { DatabaseAttemptError } from '../src/mysql/runtime.js';
import { MysqlService } from '../src/mysql/service.js';
import {
  SchemaService,
  loadSchemaSnapshotFromMysql,
  normalizeSnapshot,
  type SchemaSnapshot,
  type SchemaSnapshotLoader,
  type SchemaTable,
} from '../src/mysql/schema.js';
import type { ConnectionConfig } from '../src/types.js';

const homes: string[] = [];

function table(name: string, columns: SchemaSnapshot['tables'][number]['columns'], comment: string | null = null) {
  return {
    database: 'app', name, type: 'table' as const, comment, columns,
    indexes: [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id'] }],
  };
}

function column(name: string, ordinal: number, options: { primary?: boolean; comment?: string; type?: string } = {}) {
  return {
    name, ordinal, data_type: options.type ?? 'bigint', column_type: options.type ?? 'bigint',
    nullable: false, default: null, primary_key: options.primary ?? false, comment: options.comment ?? null,
  };
}

const snapshot: SchemaSnapshot = {
  tables: [
    table('order_items', [column('id', 1, { primary: true }), column('order_id', 2), column('product_id', 3)], '订单明细'),
    table('orders', [column('id', 1, { primary: true }), column('user_id', 2), column('status', 3, { type: 'varchar', comment: '订单状态' })], '订单'),
    table('products', [column('id', 1, { primary: true }), column('name', 2, { type: 'varchar' })]),
    table('users', [column('id', 1, { primary: true }), column('display_name', 2, { type: 'varchar', comment: '客户姓名' })], '客户'),
  ],
  relations: [
    {
      name: 'fk_items_order', source: 'foreign_key', source_database: 'app', source_table: 'order_items',
      source_columns: ['order_id'], target_database: 'app', target_table: 'orders', target_columns: ['id'],
      on_update: 'RESTRICT', on_delete: 'CASCADE',
    },
    {
      name: 'fk_orders_user', source: 'foreign_key', source_database: 'app', source_table: 'orders',
      source_columns: ['user_id'], target_database: 'app', target_table: 'users', target_columns: ['id'],
      on_update: 'RESTRICT', on_delete: 'RESTRICT',
    },
  ],
};

const snapshotWithInvoices: SchemaSnapshot = {
  ...snapshot,
  tables: [...snapshot.tables, table('invoices', [column('id', 1, { primary: true })])],
};

function setup(loader: SchemaSnapshotLoader = async () => snapshot) {
  const home = mkdtempSync(join(tmpdir(), 'mysql-agent-schema-'));
  homes.push(home);
  const store = new StateStore(home);
  store.addConnection({
    alias: 'app-test', host: 'localhost', username: 'agent', password: 'never-return-this',
    database: 'app', allowedDatabases: ['app'],
  });
  const runtimes = new ConnectionRuntimeRegistry();
  return { store, runtimes, service: new SchemaService(store, runtimes, loader) };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('SchemaService', () => {
  it('searches names and comments with deterministic scoring and bounded compact columns', async () => {
    const { store, service } = setup();
    const result = await service.search({ connection: 'app-test', keyword: '订单', limit: 1 });
    expect(result.kind).toBe('schema_search');
    expect(result.allowed_databases).toEqual(['app']);
    expect(result.table_count).toBe(1);
    expect((result.tables as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({ database: 'app', name: 'orders' }));
    expect(JSON.stringify(result)).not.toContain('never-return-this');
    expect(JSON.stringify(result)).not.toContain('CREATE TABLE');

    const columnResult = await service.search({ connection: 'app-test', keyword: '客户姓名', limit: 5 });
    expect((columnResult.tables as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({
      name: 'users',
      matched_columns: [expect.objectContaining({ name: 'display_name' })],
    }));
    const bounded = await service.search({ connection: 'app-test', keyword: 'id', limit: 1 });
    expect(bounded.table_count).toBe(1);
    expect(bounded.truncated).toBe(true);
    store.close();
  });

  it('describes only the requested relationship subgraph at depth 0..2', async () => {
    const { store, service } = setup();
    const depth0 = await service.describe({
      connection: 'app-test', tables: ['order_items'], includeRelations: true,
      relationDepth: 0, includeInferredRelations: false,
    });
    expect((depth0.tables as SchemaSnapshot['tables']).map((item) => item.name)).toEqual(['order_items']);
    expect(depth0.relations).toEqual([]);

    const depth1 = await service.describe({
      connection: 'app-test', tables: ['app.order_items'], includeRelations: true,
      relationDepth: 1, includeInferredRelations: true,
    });
    expect((depth1.tables as SchemaSnapshot['tables']).map((item) => item.name)).toEqual(['order_items', 'orders', 'products']);
    expect((depth1.relations as SchemaSnapshot['relations']).map((item) => item.source)).toEqual(['foreign_key', 'inferred']);
    expect((depth1.relations as SchemaSnapshot['relations']).find((item) => item.source === 'inferred')).toEqual(
      expect.objectContaining({ confidence: 0.8, reason: expect.stringContaining('not a declared foreign key') }),
    );

    const depth2 = await service.describe({
      connection: 'app-test', tables: ['order_items'], includeRelations: true,
      relationDepth: 2, includeInferredRelations: false,
    });
    expect((depth2.tables as SchemaSnapshot['tables']).map((item) => item.name)).toEqual(['order_items', 'orders', 'users']);
    store.close();
  });

  it('enforces allowed database scope before table lookup', async () => {
    const { store, service } = setup();
    await expect(service.describe({
      connection: 'app-test', tables: ['private.secrets'], includeRelations: true,
      relationDepth: 1, includeInferredRelations: false,
    })).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED' });
    store.close();
  });

  it('coalesces concurrent loads and uses memory then shared SQLite snapshots', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loader: SchemaSnapshotLoader = async () => { calls += 1; await gate; return snapshot; };
    const { store, runtimes, service } = setup(loader);
    const first = service.search({ connection: 'app-test', limit: 5 });
    const second = service.search({ connection: 'app-test', limit: 5 });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect((one.cache as { source: string }).source).toBe('mysql');
    expect((two.cache as { source: string }).source).toBe('mysql');
    expect((await service.search({ connection: 'app-test', limit: 5 }).then((result) => result.cache)) as { source: string }).toEqual(
      expect.objectContaining({ source: 'memory' }),
    );
    const secondProcess = new SchemaService(store, runtimes, async () => { throw new Error('must not load MySQL'); });
    const persisted = await secondProcess.search({ connection: 'app-test', limit: 5 });
    expect((persisted.cache as { source: string }).source).toBe('sqlite');
    store.close();
  });

  it('forces a fresh MySQL load and replaces cached Schema snapshots', async () => {
    let calls = 0;
    let current = snapshot;
    const { store, service } = setup(async () => {
      calls += 1;
      return current;
    });

    const initial = await service.search({ connection: 'app-test', limit: 10 });
    expect((initial.cache as { source: string }).source).toBe('mysql');
    expect((initial.tables as SchemaSnapshot['tables']).map((item) => item.name)).not.toContain('invoices');

    current = snapshotWithInvoices;
    const cached = await service.search({ connection: 'app-test', limit: 10 });
    expect((cached.cache as { source: string }).source).toBe('memory');
    expect((cached.tables as SchemaSnapshot['tables']).map((item) => item.name)).not.toContain('invoices');

    const refreshed = await service.search({ connection: 'app-test', limit: 10, refresh: true });
    expect((refreshed.cache as { source: string }).source).toBe('mysql');
    expect((refreshed.tables as SchemaSnapshot['tables']).map((item) => item.name)).toContain('invoices');
    expect(calls).toBe(2);

    const after = await service.describe({
      connection: 'app-test', tables: ['invoices'], includeRelations: false,
      relationDepth: 0, includeInferredRelations: false,
    });
    expect((after.cache as { source: string }).source).toBe('memory');
    expect(calls).toBe(2);
    store.close();
  });

  it('does not satisfy a forced refresh from a cache-preferred in-flight load', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, service } = setup(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return snapshot;
    });

    const ordinary = service.search({ connection: 'app-test', limit: 5 });
    const forced = service.search({ connection: 'app-test', limit: 5, refresh: true });
    release();

    await expect(ordinary).resolves.toEqual(expect.objectContaining({ kind: 'schema_search' }));
    const refreshed = await forced;
    expect((refreshed.cache as { source: string }).source).toBe('mysql');
    expect(calls).toBe(2);
    store.close();
  });

  it('reloads a stale memory snapshot once when describe sees a newly added table', async () => {
    let calls = 0;
    let current = snapshot;
    const { store, service } = setup(async () => { calls += 1; return current; });
    await service.search({ connection: 'app-test', limit: 5 });
    current = snapshotWithInvoices;

    const described = await service.describe({
      connection: 'app-test', tables: ['invoices'], includeRelations: false,
      relationDepth: 0, includeInferredRelations: false,
    });
    expect((described.tables as SchemaSnapshot['tables']).map((item) => item.name)).toEqual(['invoices']);
    expect((described.cache as { source: string }).source).toBe('mysql');
    expect(calls).toBe(2);
    store.close();
  });

  it('bypasses a stale L2 snapshot and performs one fresh load on describe miss', async () => {
    const { store, runtimes, service } = setup(async () => snapshot);
    await service.search({ connection: 'app-test', limit: 5 });
    let freshCalls = 0;
    const secondProcess = new SchemaService(store, runtimes, async () => {
      freshCalls += 1;
      return snapshotWithInvoices;
    });
    const described = await secondProcess.describe({
      connection: 'app-test', tables: ['invoices'], includeRelations: false,
      relationDepth: 0, includeInferredRelations: false,
    });
    expect((described.tables as SchemaSnapshot['tables']).map((item) => item.name)).toEqual(['invoices']);
    expect(freshCalls).toBe(1);
    store.close();
  });

  it('reloads a cached miss only once before returning SCHEMA_TABLE_NOT_FOUND', async () => {
    let calls = 0;
    const { store, service } = setup(async () => { calls += 1; return snapshot; });
    await service.search({ connection: 'app-test', limit: 5 });
    await expect(service.describe({
      connection: 'app-test', tables: ['never_there'], includeRelations: false,
      relationDepth: 0, includeInferredRelations: false,
    })).rejects.toMatchObject({ code: 'SCHEMA_TABLE_NOT_FOUND' });
    expect(calls).toBe(2);
    store.close();
  });

  it('lets a later waiter cancel promptly without aborting the shared schema load', async () => {
    let calls = 0;
    let internalSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, service } = setup(async (_config, signal) => {
      calls += 1;
      internalSignal = signal;
      await gate;
      return snapshot;
    });
    const first = service.search({ connection: 'app-test', limit: 5 });
    const controller = new AbortController();
    const second = service.search({ connection: 'app-test', limit: 5, requestSignal: controller.signal });
    controller.abort();

    const cancelled = await Promise.race([
      second.then(() => 'resolved', (error: unknown) => error),
      new Promise<'too_slow'>((resolve) => setTimeout(() => resolve('too_slow'), 100)),
    ]);
    expect(cancelled).toEqual(expect.objectContaining({ category: 'timeout', code: 'REQUEST_CANCELLED' }));
    expect(internalSignal?.aborted).toBe(false);
    release();
    await expect(first).resolves.toEqual(expect.objectContaining({ kind: 'schema_search' }));
    expect(internalSignal?.aborted).toBe(false);
    expect(calls).toBe(1);
    store.close();
  });

  it('aborts the internal loader when its sole waiter cancels', async () => {
    let observedSignal: AbortSignal | undefined;
    let sawAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => { sawAbort = resolve; });
    const { store, service } = setup(async (_config, signal) => {
      observedSignal = signal;
      return new Promise<SchemaSnapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sawAbort();
          reject(new Error('internal schema load cancelled'));
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const request = service.search({ connection: 'app-test', limit: 5, requestSignal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ category: 'timeout', code: 'REQUEST_CANCELLED' });
    await abortObserved;
    expect(observedSignal?.aborted).toBe(true);
    await Promise.resolve();
    store.close();
  });

  it('aborts after the final waiter cancels and lets the next request start a fresh load', async () => {
    let calls = 0;
    const internalSignals: AbortSignal[] = [];
    const { store, service } = setup(async (_config, signal) => {
      calls += 1;
      internalSignals.push(signal!);
      if (calls > 1) return snapshot;
      return new Promise<SchemaSnapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('first shared load cancelled')), { once: true });
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.search({ connection: 'app-test', limit: 5, requestSignal: firstController.signal });
    const second = service.search({ connection: 'app-test', limit: 5, requestSignal: secondController.signal });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(internalSignals[0]?.aborted).toBe(false);
    secondController.abort();
    await expect(second).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(internalSignals[0]?.aborted).toBe(true);

    await expect(service.search({ connection: 'app-test', limit: 5 })).resolves.toEqual(
      expect.objectContaining({ kind: 'schema_search' }),
    );
    expect(calls).toBe(2);
    expect(internalSignals[1]?.aborted).toBe(false);
    store.close();
  });

  it('makes old snapshots unreachable after a connection revision update', async () => {
    let calls = 0;
    const { store, service } = setup(async () => { calls += 1; return snapshot; });
    await service.search({ connection: 'app-test', limit: 5 });
    store.updateConnection({ alias: 'app-test', description: 'revision two' });
    await service.search({ connection: 'app-test', limit: 5 });
    expect(calls).toBe(2);
    store.close();
  });

  it('bypasses persisted snapshots with a wrong shape or future loaded_at', async () => {
    for (const mutation of ['shape', 'future-time'] as const) {
      let calls = 0;
      const { store, runtimes, service } = setup(async () => snapshot);
      await service.search({ connection: 'app-test', limit: 5 });
      const raw = new DatabaseSync(store.path);
      if (mutation === 'shape') raw.prepare('UPDATE schema_snapshots SET snapshot_json = ?').run('{"tables":{},"relations":[]}');
      else raw.prepare('UPDATE schema_snapshots SET loaded_at = ?').run(new Date(Date.now() + 60_000).toISOString());
      raw.close();
      const second = new SchemaService(store, runtimes, async () => { calls += 1; return snapshot; });
      const result = await second.search({ connection: 'app-test', limit: 5 });
      expect((result.cache as { source: string }).source).toBe('mysql');
      expect(calls).toBe(1);
      store.close();
    }
  });

  it('deletes an oversized but structurally valid SQLite snapshot and replaces it from the loader', async () => {
    let calls = 0;
    const { store, runtimes } = setup();
    const config = store.requireConnection('app-test');
    const key = `${config.alias}\u0000${config.revision}\u0000${config.database}\u0000${JSON.stringify([...config.allowedDatabases].sort())}`;
    const oversized: SchemaSnapshot = {
      tables: Array.from({ length: 300 }, (_, index) =>
        table(`persisted_wide_${index}`, [column('id', 1, { primary: true })], 'x'.repeat(65_535))),
      relations: [],
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(MAX_SCHEMA_SNAPSHOT_BYTES);
    expect(store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION, cacheKey: key, connectionAlias: config.alias,
      connectionRevision: config.revision, defaultDatabase: config.database,
      allowedDatabases: config.allowedDatabases, snapshot: oversized, loadedAt: new Date().toISOString(),
    })).toBe(true);

    const service = new SchemaService(store, runtimes, async () => { calls += 1; return snapshot; });
    const result = await service.search({ connection: 'app-test', limit: 5 });
    expect((result.cache as { source: string }).source).toBe('mysql');
    expect(calls).toBe(1);
    const persisted = store.readSchemaSnapshot(key);
    expect(persisted?.snapshot).toEqual(snapshot);
    const raw = new DatabaseSync(store.path);
    expect((raw.prepare('SELECT length(CAST(snapshot_json AS BLOB)) AS bytes FROM schema_snapshots WHERE cache_key = ?').get(key) as { bytes: number }).bytes)
      .toBeLessThanOrEqual(MAX_SCHEMA_SNAPSHOT_BYTES);
    raw.close();
    store.close();
  });

  it('rechecks persisted object size and refreshes even when cleanup itself fails', async () => {
    let calls = 0;
    const { store, runtimes } = setup();
    const config = store.requireConnection('app-test');
    const oversized: SchemaSnapshot = {
      tables: Array.from({ length: 300 }, (_, index) =>
        table(`alternate_wide_${index}`, [column('id', 1, { primary: true })], 'x'.repeat(65_535))),
      relations: [],
    };
    (store as unknown as { readSchemaSnapshot: () => unknown }).readSchemaSnapshot = () => ({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION, cacheKey: 'alternate', connectionAlias: config.alias,
      connectionRevision: config.revision, defaultDatabase: config.database,
      allowedDatabases: config.allowedDatabases, snapshot: oversized, loadedAt: new Date().toISOString(),
    });
    (store as unknown as { deleteSchemaSnapshot: () => boolean }).deleteSchemaSnapshot = () => {
      throw new Error('simulated cleanup failure');
    };
    const service = new SchemaService(store, runtimes, async () => { calls += 1; return snapshot; });
    const result = await service.search({ connection: 'app-test', limit: 5 });
    expect((result.cache as { source: string }).source).toBe('mysql');
    expect(calls).toBe(1);
    store.close();
  });

  it('rejects malformed loader snapshots before persistence', async () => {
    const { store, service } = setup(async () => ({ tables: 'bad', relations: [] }) as unknown as SchemaSnapshot);
    await expect(service.search({ connection: 'app-test', limit: 5 })).rejects.toMatchObject({ code: 'INVALID_SCHEMA_SNAPSHOT' });
    const raw = new DatabaseSync(store.path);
    expect((raw.prepare('SELECT COUNT(*) AS count FROM schema_snapshots').get() as { count: number }).count).toBe(0);
    raw.close();
    store.close();
  });

  it('rejects oversized normalized snapshots and complete describe responses', async () => {
    const oversized: SchemaSnapshot = {
      tables: Array.from({ length: 300 }, (_, index) => table(`wide_${index}`, [column('id', 1, { primary: true })], 'x'.repeat(65_000))),
      relations: [],
    };
    const first = setup(async () => oversized);
    await expect(first.service.search({ connection: 'app-test', limit: 1 })).rejects.toMatchObject({ code: 'SCHEMA_SNAPSHOT_BYTE_LIMIT' });
    first.store.close();

    const largeDescribe: SchemaSnapshot = {
      tables: Array.from({ length: 20 }, (_, index) => table(`large_${index}`, [column('id', 1, { primary: true })], 'x'.repeat(60_000))),
      relations: [],
    };
    const second = setup(async () => largeDescribe);
    await expect(second.service.search({ connection: 'app-test', limit: 20 })).rejects.toMatchObject({ code: 'SCHEMA_SEARCH_RESULT_LIMIT' });
    await expect(second.service.describe({
      connection: 'app-test', tables: largeDescribe.tables.map((item) => item.name),
      includeRelations: false, relationDepth: 0, includeInferredRelations: false,
    })).rejects.toMatchObject({ code: 'SCHEMA_DESCRIBE_RESULT_LIMIT' });
    second.store.close();
  });

  it('does not infer a relation to composite or non-unique id indexes', async () => {
    for (const indexes of [
      [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id', 'tenant_id'] }],
      [{ name: 'idx_id', unique: false, primary: false, type: 'BTREE', columns: ['id'] }],
    ]) {
      const target = { ...table('products', [column('id', 1, { primary: true }), column('tenant_id', 2)]), indexes };
      const scoped: SchemaSnapshot = {
        tables: [table('invoice_lines', [column('id', 1, { primary: true }), column('product_id', 2)]), target],
        relations: [],
      };
      const { store, service } = setup(async () => scoped);
      const result = await service.describe({
        connection: 'app-test', tables: ['invoice_lines'], includeRelations: true,
        relationDepth: 1, includeInferredRelations: true,
      });
      expect(result.relations).toEqual([]);
      expect((result.tables as SchemaTable[]).map((item) => item.name)).toEqual(['invoice_lines']);
      store.close();
    }
  });

  it('clears L1 and preserves the original MySQL error when persistent invalidation fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mysql-agent-schema-drift-'));
    homes.push(home);
    const store = new StateStore(home);
    store.addConnection({ alias: 'drift-test', host: 'localhost', username: 'agent', password: '', database: 'app' });
    const mysqlError = Object.assign(new Error('table missing'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' });
    const runtime = { run: async () => { throw new DatabaseAttemptError(mysqlError, true); } } as unknown as ConnectionRuntime;
    const runtimes = {
      async withRuntime<T>(_config: ConnectionConfig, callback: (value: ConnectionRuntime) => Promise<T>): Promise<T> { return callback(runtime); },
      closeAll: async () => undefined,
    } as unknown as ConnectionRuntimeRegistry;
    const service = new MysqlService(store, runtimes, async () => snapshot);
    await service.schema.search({ connection: 'drift-test', limit: 5 });
    (store as unknown as { invalidateSchemaSnapshots: () => number }).invalidateSchemaSnapshots = () => {
      throw new Error('simulated sqlite busy');
    };

    await expect(service.query({
      connection: 'drift-test', sql: 'SELECT id FROM missing_table LIMIT 1', maxRows: 1,
    })).rejects.toMatchObject({ code: 'MYSQL_SQL_ERROR', mysqlCode: 1146 });
    const after = await service.schema.search({ connection: 'drift-test', limit: 5 });
    expect((after.cache as { source: string }).source).toBe('sqlite');
    const raw = new DatabaseSync(store.path);
    expect(raw.prepare('SELECT error_category, mysql_error_code FROM execution_audit ORDER BY id DESC LIMIT 1').get()).toEqual(
      expect.objectContaining({ error_category: 'sql_error', mysql_error_code: 1146 }),
    );
    raw.close();
    await service.close();
  });
});

describe('real metadata execution path', () => {
  const config: ConnectionConfig = {
    alias: 'metadata-test', description: null, host: 'localhost', port: 3306,
    username: 'agent', password: 'secret', database: 'alpha',
    allowedDatabases: ['zeta', 'alpha', 'alpha'], charset: 'utf8mb4', accessMode: 'read_only',
    connectTimeoutMs: 1_000, queryTimeoutMs: 12_345, poolMax: 2, idleTimeoutMs: 60_000,
    enabled: true, revision: 7, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
  };

  it('uses fixed scoped information_schema SQL through runtime.run and the existing pool', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let releases = 0;
    const connection = {
      execute: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('information_schema.tables')) {
          return [[{ table_schema: 'alpha', table_name: 'orders', table_type: 'BASE TABLE', table_comment: '' }], []];
        }
        if (sql.includes('information_schema.columns')) {
          return [[{ table_schema: 'alpha', table_name: 'orders', column_name: 'id', ordinal_position: 1, data_type: 'bigint', column_type: 'bigint', is_nullable: 'NO', column_default: null, column_key: 'PRI', column_comment: '' }], []];
        }
        if (sql.includes('information_schema.statistics')) {
          return [[{ table_schema: 'alpha', table_name: 'orders', index_name: 'PRIMARY', non_unique: 0, index_type: 'BTREE', seq_in_index: 1, column_name: 'id' }], []];
        }
        return [[], []];
      },
      release: () => { releases += 1; },
      destroy: () => undefined,
    };
    const pool = { getConnection: async () => connection };
    const operationSignal = new AbortController().signal;
    let runOptions: RuntimeRunOptions | undefined;
    const fakeRuntime = {
      pool,
      async run<T>(options: RuntimeRunOptions, operation: (signal: AbortSignal) => Promise<T>) {
        runOptions = options;
        return { value: await operation(operationSignal), attemptCount: 1 };
      },
    } as unknown as ConnectionRuntime;
    const fakeRegistry = {
      async withRuntime<T>(_config: ConnectionConfig, callback: (runtime: ConnectionRuntime) => Promise<T>): Promise<T> {
        return callback(fakeRuntime);
      },
    } as unknown as ConnectionRuntimeRegistry;
    const requestController = new AbortController();

    const loaded = await loadSchemaSnapshotFromMysql(config, fakeRegistry, requestController.signal);
    expect(loaded.tables[0]).toEqual(expect.objectContaining({ database: 'alpha', name: 'orders' }));
    expect(runOptions).toEqual(expect.objectContaining({
      timeoutMs: 12_345,
      requestSignal: requestController.signal,
      retrySafeAfterSend: true,
    }));
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.sql)).toEqual([
      expect.stringContaining('FROM information_schema.tables'),
      expect.stringContaining('FROM information_schema.columns'),
      expect.stringContaining('FROM information_schema.statistics'),
      expect.stringContaining('FROM information_schema.key_column_usage'),
    ]);
    expect(calls[3]?.sql).toContain('JOIN information_schema.referential_constraints');
    expect(calls.slice(0, 3).map((call) => call.values)).toEqual([
      ['alpha', 'zeta'], ['alpha', 'zeta'], ['alpha', 'zeta'],
    ]);
    expect(calls[3]?.values).toEqual(['alpha', 'zeta', 'alpha', 'zeta', 'alpha', 'zeta']);
    expect(calls.every((call) => !call.sql.includes('__'))).toBe(true);
    expect(calls.every((call) => (call.sql.match(/\?/g) ?? []).length === call.values.length)).toBe(true);
    expect(calls.every((call) => call.values.every((value) => config.allowedDatabases.includes(String(value))))).toBe(true);
    expect(config.allowedDatabases).not.toContain('information_schema');
    expect(releases).toBe(4);
  });

  it('enforces metadata row and byte bounds inside executeMetadataQueryAttempt', async () => {
    const runtimeForRows = metadataRuntimeWithRows([{ id: 1 }, { id: 2 }]);
    await expect(executeMetadataQueryAttempt(
      runtimeForRows, 'SELECT fixed_metadata', [], 1, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SCHEMA_METADATA_ROW_LIMIT' });

    const runtimeForBytes = metadataRuntimeWithRows([{ value: 'x'.repeat(MAX_SCHEMA_SNAPSHOT_BYTES + 1) }]);
    await expect(executeMetadataQueryAttempt(
      runtimeForBytes, 'SELECT fixed_metadata', [], 1, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SCHEMA_METADATA_BYTE_LIMIT' });
  });

  it('shares one cumulative byte budget across metadata result sets', async () => {
    const budget = createMetadataByteBudget(100);
    await executeMetadataQueryAttempt(
      metadataRuntimeWithRows([{ value: 'x'.repeat(45) }]), 'SELECT fixed_metadata', [], 1,
      new AbortController().signal, budget,
    );
    await expect(executeMetadataQueryAttempt(
      metadataRuntimeWithRows([{ value: 'y'.repeat(45) }]), 'SELECT fixed_metadata', [], 1,
      new AbortController().signal, budget,
    )).rejects.toMatchObject({ code: 'SCHEMA_METADATA_BYTE_LIMIT' });
  });

  it('propagates the waiter-owned internal cancellation through the default loader to runtime.run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mysql-agent-schema-default-loader-'));
    homes.push(home);
    const store = new StateStore(home);
    store.addConnection({
      alias: 'default-loader', host: 'localhost', username: 'agent', password: '', database: 'app',
    });
    let observedSignal: AbortSignal | undefined;
    let destroyed = false;
    let rejectExecute: ((error: Error) => void) | undefined;
    let resolveDestroyed!: () => void;
    const destroyedPromise = new Promise<void>((resolve) => { resolveDestroyed = resolve; });
    const connection = {
      execute: async () => {
        if (destroyed) throw new Error('connection already destroyed on schema cancellation');
        return new Promise<never>((_resolve, reject) => { rejectExecute = reject; });
      },
      release: () => undefined,
      destroy: () => {
        destroyed = true;
        resolveDestroyed();
        rejectExecute?.(new Error('connection destroyed on schema cancellation'));
      },
    };
    const fakeRuntime = {
      pool: { getConnection: async () => connection },
      async run<T>(options: RuntimeRunOptions, operation: (signal: AbortSignal) => Promise<T>) {
        observedSignal = options.requestSignal;
        return { value: await operation(options.requestSignal!), attemptCount: 1 };
      },
    } as unknown as ConnectionRuntime;
    const fakeRegistry = {
      async withRuntime<T>(_config: ConnectionConfig, callback: (runtime: ConnectionRuntime) => Promise<T>): Promise<T> {
        return callback(fakeRuntime);
      },
    } as unknown as ConnectionRuntimeRegistry;
    const service = new SchemaService(store, fakeRegistry);
    const controller = new AbortController();
    const request = service.search({ connection: 'default-loader', limit: 5, requestSignal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await destroyedPromise;
    expect(observedSignal?.aborted).toBe(true);
    expect(destroyed).toBe(true);
    await Promise.resolve();
    store.close();
  });
});

function metadataRuntimeWithRows(rows: Array<Record<string, unknown>>): ConnectionRuntime {
  const connection = {
    execute: async () => [rows, []],
    release: () => undefined,
    destroy: () => undefined,
  };
  return { pool: { getConnection: async () => connection } } as unknown as ConnectionRuntime;
}

describe('schema normalization', () => {
  it('normalizes primary keys, indexes, and declared foreign keys without DDL', () => {
    const normalized = normalizeSnapshot(
      [{ table_schema: 'app', table_name: 'orders', table_type: 'BASE TABLE', table_comment: 'Orders' }],
      [{ table_schema: 'app', table_name: 'orders', column_name: 'id', ordinal_position: 1, data_type: 'bigint', column_type: 'bigint unsigned', is_nullable: 'NO', column_default: null, column_key: 'PRI', column_comment: '' }],
      [{ table_schema: 'app', table_name: 'orders', index_name: 'PRIMARY', non_unique: 0, index_type: 'BTREE', seq_in_index: 1, column_name: 'id' }],
      [{ constraint_schema: 'app', constraint_name: 'fk_parent', source_schema: 'app', source_table: 'orders', source_column: 'parent_id', target_schema: 'app', target_table: 'orders', target_column: 'id', ordinal_position: 1, update_rule: 'RESTRICT', delete_rule: 'CASCADE' }],
    );
    expect(normalized.tables[0]?.columns[0]).toEqual(expect.objectContaining({ primary_key: true, nullable: false }));
    expect(normalized.tables[0]?.indexes[0]).toEqual(expect.objectContaining({ primary: true, unique: true }));
    expect(normalized.relations[0]).toEqual(expect.objectContaining({ source: 'foreign_key', on_delete: 'CASCADE' }));
    expect(JSON.stringify(normalized)).not.toContain('CREATE TABLE');
  });
});
