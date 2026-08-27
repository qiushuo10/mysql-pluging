import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { StateStore } from '../src/config/store.js';
import { SCHEMA_SNAPSHOT_FORMAT_VERSION } from '../src/constants.js';

const homes: string[] = [];

function createStore(): StateStore {
  const home = mkdtempSync(join(tmpdir(), 'mysql-agent-store-'));
  homes.push(home);
  return new StateStore(home);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('stores plaintext credentials but never returns them in summaries', () => {
    const store = createStore();
    const summary = store.addConnection({
      alias: 'auto-fat',
      host: '127.0.0.1',
      username: 'agent',
      password: 'local-test-password',
      database: 'auto_server_fat',
    });

    expect(summary).not.toHaveProperty('password');
    expect(summary.poolMax).toBe(10);
    expect(store.requireConnection('auto-fat').password).toBe('local-test-password');
    expect(store.listConnections()[0]).not.toHaveProperty('password');
    store.close();
  });

  it('increments revision and preserves omitted password fields', () => {
    const store = createStore();
    store.addConnection({
      alias: 'voicehub-test',
      host: 'localhost',
      username: 'agent',
      password: 'secret',
      database: 'voicehub_test',
    });

    const updated = store.updateConnection({ alias: 'voicehub-test', description: 'VoiceHub test data' });
    expect(updated.revision).toBe(2);
    expect(store.requireConnection('voicehub-test').password).toBe('secret');
    store.close();
  });

  it('requires the default database in the allowed database list', () => {
    const store = createStore();
    expect(() =>
      store.addConnection({
        alias: 'bad-scope',
        host: 'localhost',
        username: 'agent',
        password: '',
        database: 'one',
        allowedDatabases: ['two'],
      }),
    ).toThrow(/allowed_databases/);
    store.close();
  });

  it('migrates, reads, writes, and invalidates shared schema snapshots', () => {
    const store = createStore();
    store.addConnection({ alias: 'schema-test', host: 'localhost', username: 'agent', password: 'secret', database: 'app' });
    store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION,
      cacheKey: 'schema-test-key',
      connectionAlias: 'schema-test',
      connectionRevision: 1,
      defaultDatabase: 'app',
      allowedDatabases: ['app'],
      snapshot: { tables: [], relations: [] },
      loadedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(store.readSchemaSnapshot('schema-test-key')).toEqual(expect.objectContaining({ connectionRevision: 1 }));
    expect(store.invalidateSchemaSnapshots('schema-test', 2)).toBe(0);
    expect(store.invalidateSchemaSnapshots('schema-test', 1)).toBe(1);
    expect(store.readSchemaSnapshot('schema-test-key')).toBeNull();
    store.close();
  });

  it('cleans persistent schema snapshots when a connection revision changes or is removed', () => {
    const store = createStore();
    store.addConnection({ alias: 'schema-clean', host: 'localhost', username: 'agent', password: '', database: 'app' });
    const write = (key: string, revision: number) => store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION,
      cacheKey: key, connectionAlias: 'schema-clean', connectionRevision: revision,
      defaultDatabase: 'app', allowedDatabases: ['app'], snapshot: { tables: [], relations: [] }, loadedAt: new Date().toISOString(),
    });
    write('one', 1);
    store.updateConnection({ alias: 'schema-clean', description: 'changed' });
    expect(store.readSchemaSnapshot('one')).toBeNull();
    write('two', 2);
    store.removeConnection('schema-clean');
    expect(store.readSchemaSnapshot('two')).toBeNull();
    store.close();
  });

  it('deletes malformed JSON and unknown snapshot formats on read', () => {
    const store = createStore();
    store.addConnection({ alias: 'bad-cache', host: 'localhost', username: 'agent', password: '', database: 'app' });
    const write = (key: string) => store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION, cacheKey: key, connectionAlias: 'bad-cache',
      connectionRevision: 1, defaultDatabase: 'app', allowedDatabases: ['app'],
      snapshot: { tables: [], relations: [] }, loadedAt: new Date().toISOString(),
    });
    write('malformed');
    write('future-format');
    const raw = new DatabaseSync(store.path);
    raw.prepare('UPDATE schema_snapshots SET snapshot_json = ? WHERE cache_key = ?').run('{', 'malformed');
    raw.prepare('UPDATE schema_snapshots SET format_version = ? WHERE cache_key = ?').run(99, 'future-format');
    raw.close();
    expect(store.readSchemaSnapshot('malformed')).toBeNull();
    expect(store.readSchemaSnapshot('future-format')).toBeNull();
    store.close();
  });

  it('treats malformed snapshots as a miss even when best-effort deletion fails', () => {
    const store = createStore();
    store.addConnection({ alias: 'cleanup-fail', host: 'localhost', username: 'agent', password: '', database: 'app' });
    store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION, cacheKey: 'cleanup-fail-key', connectionAlias: 'cleanup-fail',
      connectionRevision: 1, defaultDatabase: 'app', allowedDatabases: ['app'],
      snapshot: { tables: [], relations: [] }, loadedAt: new Date().toISOString(),
    });
    const raw = new DatabaseSync(store.path);
    raw.prepare('UPDATE schema_snapshots SET snapshot_json = ? WHERE cache_key = ?').run('{', 'cleanup-fail-key');
    raw.close();
    (store as unknown as { deleteSchemaSnapshot: () => boolean }).deleteSchemaSnapshot = () => {
      throw new Error('simulated cleanup failure');
    };
    expect(store.readSchemaSnapshot('cleanup-fail-key')).toBeNull();
    store.close();
  });

  it('upgrades a legacy v2 database and supports repeated startup', () => {
    const home = mkdtempSync(join(tmpdir(), 'mysql-agent-store-v2-'));
    homes.push(home);
    const path = join(home, 'state.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'old'), (2, 'old');
      CREATE TABLE schema_snapshots (
        cache_key TEXT PRIMARY KEY, connection_alias TEXT NOT NULL, connection_revision INTEGER NOT NULL,
        default_database TEXT NOT NULL, allowed_databases_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, loaded_at TEXT NOT NULL
      );
    `);
    legacy.close();
    const first = new StateStore(home);
    const inspect = new DatabaseSync(path);
    expect((inspect.prepare('PRAGMA table_info(schema_snapshots)').all() as Array<{ name: string }>).map((row) => row.name)).toContain('format_version');
    expect((inspect.prepare('PRAGMA table_info(execution_audit)').all() as Array<{ name: string }>).map((row) => row.name)).toEqual(
      expect.arrayContaining(['business_pack_id', 'business_pack_version', 'business_operation_hash']),
    );
    expect((inspect.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(4);
    inspect.close();
    const second = new StateStore(home);
    second.close();
    first.close();
  });

  it('rejects a state database newer than this plugin', () => {
    const home = mkdtempSync(join(tmpdir(), 'mysql-agent-store-future-'));
    homes.push(home);
    const database = new DatabaseSync(join(home, 'state.db'));
    database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (99, 'future')`);
    database.close();
    expect(() => new StateStore(home)).toThrow(/高于当前支持版本/);
  });

  it('stores and searches bounded SQL audit history without SQL text or parameter values', () => {
    const store = createStore();
    const base = {
      clientName: 'codex', connectionAlias: 'auto-dev', businessOperationId: 'work_order.summary_since.auto-dev',
      businessPackId: 'autoserver', businessPackVersion: '1.0.0', businessOperationHash: 'sha256:operation',
      statementKind: 'select', sqlHash: 'sql-hash', durationMs: 12, rowCount: 5, affectedRows: null,
      attemptCount: 1, writeOutcome: 'not_applicable' as const, status: 'ok' as const,
      errorCategory: null, mysqlErrorCode: null,
    };
    store.recordAudit({ ...base, executionId: '11111111-1111-4111-8111-111111111111', occurredAt: '2026-08-27T01:00:00.000Z' });
    store.recordAudit({ ...base, executionId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-08-27T02:00:00.000Z' });

    const first = store.searchAudit({ connectionAlias: 'auto-dev', status: 'ok', limit: 1 });
    expect(first.records).toEqual([expect.objectContaining({
      executionId: '22222222-2222-4222-8222-222222222222', businessPackVersion: '1.0.0', sqlHash: 'sql-hash',
    })]);
    expect(first.nextBeforeId).toBeTypeOf('number');
    const second = store.searchAudit({ beforeId: first.nextBeforeId!, limit: 1 });
    expect(second.records[0]?.executionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(second.nextBeforeId).toBeNull();
    store.close();
  });
});
