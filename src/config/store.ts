import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_QUERY_TIMEOUT_MS,
  MAX_POOL_MAX,
  MAX_SCHEMA_SNAPSHOT_BYTES,
  SCHEMA_SNAPSHOT_FORMAT_VERSION,
  STATE_SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
} from '../constants.js';
import { PluginError } from '../errors.js';
import type {
  AccessMode,
  AuditHistoryFilters,
  AuditHistoryRecord,
  AuditRecord,
  ConnectionConfig,
  ConnectionEnvironment,
  ConnectionSummary,
  SchemaSnapshotRecord,
} from '../types.js';

export interface AddConnectionInput {
  alias: string;
  datasourceId?: string;
  environment?: ConnectionEnvironment;
  ownerScope?: string;
  shareable?: boolean;
  description?: string | null;
  host: string;
  port?: number;
  username: string;
  password: string;
  database: string;
  allowedDatabases?: string[];
  charset?: 'utf8mb4';
  accessMode?: AccessMode;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
  enabled?: boolean;
}

export type UpdateConnectionInput = Partial<Omit<AddConnectionInput, 'alias'>> & { alias: string };

interface ConnectionRow {
  alias: string;
  datasource_id: string | null;
  environment: string;
  owner_scope: string;
  shareable: number;
  description: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  default_database: string;
  allowed_databases_json: string;
  charset: string;
  access_mode: string;
  connect_timeout_ms: number;
  query_timeout_ms: number;
  pool_max: number;
  idle_timeout_ms: number;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SchemaSnapshotRow {
  format_version: number;
  cache_key: string;
  connection_alias: string;
  connection_revision: number;
  default_database: string;
  allowed_databases_json: string;
  snapshot_json: string;
  loaded_at: string;
}

export function resolveStateHome(explicitHome?: string): string {
  const configured = explicitHome ?? process.env.MYSQL_AGENT_HOME;
  return resolve(configured || join(homedir(), '.mysql-agent'));
}

export class StateStore {
  readonly home: string;
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(home?: string) {
    this.home = resolveStateHome(home);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.home, 0o700);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }

    this.path = join(this.home, 'state.db');
    this.database = new DatabaseSync(this.path);
    this.database.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    this.database.exec('PRAGMA journal_mode=WAL');
    this.database.exec('PRAGMA foreign_keys=ON');
    this.migrate();
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
      const current = Number((this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0);
      if (current > STATE_SCHEMA_VERSION) {
        throw new PluginError({
          category: 'config_error',
          code: 'STATE_SCHEMA_TOO_NEW',
          message: `state.db 版本 ${current} 高于当前支持版本 ${STATE_SCHEMA_VERSION}。`,
        });
      }
      if (current < 1) {
        this.database.exec(`
        CREATE TABLE IF NOT EXISTS connections (
          alias TEXT PRIMARY KEY,
          datasource_id TEXT,
          environment TEXT NOT NULL DEFAULT 'custom',
          owner_scope TEXT NOT NULL DEFAULT 'global',
          shareable INTEGER NOT NULL DEFAULT 0,
          description TEXT,
          host TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 3306,
          username TEXT NOT NULL,
          password TEXT NOT NULL,
          default_database TEXT NOT NULL,
          allowed_databases_json TEXT NOT NULL DEFAULT '[]',
          charset TEXT NOT NULL DEFAULT 'utf8mb4',
          access_mode TEXT NOT NULL DEFAULT 'read_write',
          connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
          query_timeout_ms INTEGER NOT NULL DEFAULT 30000,
          pool_max INTEGER NOT NULL DEFAULT ${DEFAULT_POOL_MAX},
          idle_timeout_ms INTEGER NOT NULL DEFAULT 60000,
          enabled INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS execution_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          execution_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          client_name TEXT NOT NULL,
          connection_alias TEXT NOT NULL,
          business_operation_id TEXT,
          business_pack_id TEXT,
          business_pack_version TEXT,
          business_operation_hash TEXT,
          statement_kind TEXT NOT NULL,
          sql_hash TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          row_count INTEGER,
          affected_rows INTEGER,
          attempt_count INTEGER NOT NULL DEFAULT 1,
          write_outcome TEXT,
          status TEXT NOT NULL,
          error_category TEXT,
          mysql_error_code INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_execution_audit_occurred_at
          ON execution_audit(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_execution_audit_connection
          ON execution_audit(connection_alias, occurred_at DESC);
        `);
        this.recordMigration(1);
      }
      if (current < 2) {
        this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_snapshots (
          cache_key TEXT PRIMARY KEY,
          connection_alias TEXT NOT NULL,
          connection_revision INTEGER NOT NULL,
          default_database TEXT NOT NULL,
          allowed_databases_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          loaded_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_schema_snapshots_connection
          ON schema_snapshots(connection_alias, connection_revision);
        `);
        this.recordMigration(2);
      }
      if (current < 3) {
        const columns = this.database.prepare('PRAGMA table_info(schema_snapshots)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'format_version')) {
          this.database.exec(`ALTER TABLE schema_snapshots ADD COLUMN format_version INTEGER NOT NULL DEFAULT ${SCHEMA_SNAPSHOT_FORMAT_VERSION}`);
        }
        this.recordMigration(3);
      }
      if (current < 4) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS execution_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            client_name TEXT NOT NULL,
            connection_alias TEXT NOT NULL,
            business_operation_id TEXT,
            business_pack_id TEXT,
            business_pack_version TEXT,
            business_operation_hash TEXT,
            statement_kind TEXT NOT NULL,
            sql_hash TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            row_count INTEGER,
            affected_rows INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 1,
            write_outcome TEXT,
            status TEXT NOT NULL,
            error_category TEXT,
            mysql_error_code INTEGER
          )
        `);
        const auditColumns = this.database.prepare('PRAGMA table_info(execution_audit)').all() as Array<{ name: string }>;
        const names = new Set(auditColumns.map((column) => column.name));
        if (!names.has('business_pack_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN business_pack_id TEXT');
        if (!names.has('business_pack_version')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN business_pack_version TEXT');
        if (!names.has('business_operation_hash')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN business_operation_hash TEXT');
        this.database.exec(`
          CREATE INDEX IF NOT EXISTS idx_execution_audit_occurred_at
            ON execution_audit(occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_audit_connection
            ON execution_audit(connection_alias, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_audit_execution_id
            ON execution_audit(execution_id);
          CREATE INDEX IF NOT EXISTS idx_execution_audit_business_operation
            ON execution_audit(business_operation_id, occurred_at DESC);
        `);
        this.recordMigration(4);
      }
      if (current < 5) {
        const connectionColumns = this.database.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string; dflt_value: string | null }>;
        const names = new Set(connectionColumns.map((column) => column.name));
        if (connectionColumns.length > 0) {
          if (!names.has('datasource_id')) this.database.exec('ALTER TABLE connections ADD COLUMN datasource_id TEXT');
          if (!names.has('environment')) this.database.exec("ALTER TABLE connections ADD COLUMN environment TEXT NOT NULL DEFAULT 'custom'");
          if (!names.has('owner_scope')) this.database.exec("ALTER TABLE connections ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'global'");
          if (!names.has('shareable')) this.database.exec('ALTER TABLE connections ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0');
          this.database.exec("UPDATE connections SET datasource_id = alias WHERE datasource_id IS NULL OR datasource_id = ''");
          this.database
            .prepare('UPDATE connections SET pool_max = ?, revision = revision + 1, updated_at = ? WHERE pool_max > ?')
            .run(MAX_POOL_MAX, new Date().toISOString(), MAX_POOL_MAX);
          const poolDefault = connectionColumns.find((column) => column.name === 'pool_max')?.dflt_value;
          if (poolDefault !== String(DEFAULT_POOL_MAX)) {
            this.rebuildConnectionsTableWithCompatibleMetadata();
          }
          this.installConnectionCompatibilityTriggers();
        }
        this.recordMigration(5);
      }
      if (current < 6) {
        const connectionColumns = this.database.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string; notnull: number }>;
        if (connectionColumns.length > 0) {
          const datasourceIdColumn = connectionColumns.find((column) => column.name === 'datasource_id');
          if (datasourceIdColumn?.notnull === 1) {
            this.rebuildConnectionsTableWithCompatibleMetadata();
          }
          this.installConnectionCompatibilityTriggers();
        }
        this.recordMigration(6);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private rebuildConnectionsTableWithCompatibleMetadata(): void {
    this.database.exec(`
      CREATE TABLE _connections_rebuild (
        alias TEXT PRIMARY KEY,
        datasource_id TEXT,
        environment TEXT NOT NULL DEFAULT 'custom',
        owner_scope TEXT NOT NULL DEFAULT 'global',
        shareable INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 3306,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        default_database TEXT NOT NULL,
        allowed_databases_json TEXT NOT NULL DEFAULT '[]',
        charset TEXT NOT NULL DEFAULT 'utf8mb4',
        access_mode TEXT NOT NULL DEFAULT 'read_write',
        connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
        query_timeout_ms INTEGER NOT NULL DEFAULT 30000,
        pool_max INTEGER NOT NULL DEFAULT ${DEFAULT_POOL_MAX},
        idle_timeout_ms INTEGER NOT NULL DEFAULT 60000,
        enabled INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO _connections_rebuild (
        alias, datasource_id, environment, owner_scope, shareable,
        description, host, port, username, password, default_database,
        allowed_databases_json, charset, access_mode, connect_timeout_ms,
        query_timeout_ms, pool_max, idle_timeout_ms, enabled, revision,
        created_at, updated_at
      )
      SELECT
        alias, datasource_id, environment, owner_scope, shareable,
        description, host, port, username, password, default_database,
        allowed_databases_json, charset, access_mode, connect_timeout_ms,
        query_timeout_ms, pool_max, idle_timeout_ms, enabled, revision,
        created_at, updated_at
      FROM connections;
      DROP TABLE connections;
      ALTER TABLE _connections_rebuild RENAME TO connections;
    `);
  }

  private installConnectionCompatibilityTriggers(): void {
    this.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_connections_v5_insert_defaults
      AFTER INSERT ON connections
      WHEN NEW.datasource_id IS NULL OR NEW.datasource_id = '' OR NEW.pool_max > ${MAX_POOL_MAX}
      BEGIN
        UPDATE connections
        SET datasource_id = CASE
              WHEN NEW.datasource_id IS NULL OR NEW.datasource_id = '' THEN NEW.alias
              ELSE NEW.datasource_id
            END,
            pool_max = MIN(NEW.pool_max, ${MAX_POOL_MAX})
        WHERE alias = NEW.alias;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_connections_v5_pool_cap
      AFTER UPDATE OF pool_max ON connections
      WHEN NEW.pool_max > ${MAX_POOL_MAX}
      BEGIN
        UPDATE connections SET pool_max = ${MAX_POOL_MAX} WHERE alias = NEW.alias;
      END;
    `);
  }

  private recordMigration(version: number): void {
    this.database
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
  }

  addConnection(input: AddConnectionInput): ConnectionSummary {
    const now = new Date().toISOString();
    const allowedDatabases = input.allowedDatabases ?? [input.database];
    this.validateDatabaseScope(input.database, allowedDatabases);
    this.validatePoolMax(input.poolMax ?? DEFAULT_POOL_MAX);
    try {
      this.database
        .prepare(`
          INSERT INTO connections (
            alias, datasource_id, environment, owner_scope, shareable,
            description, host, port, username, password, default_database,
            allowed_databases_json, charset, access_mode, connect_timeout_ms,
            query_timeout_ms, pool_max, idle_timeout_ms, enabled, revision,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            1, ?, ?
          )
        `)
        .run(
          input.alias,
          input.datasourceId ?? input.alias,
          input.environment ?? 'custom',
          input.ownerScope ?? 'global',
          input.shareable === true ? 1 : 0,
          input.description ?? null,
          input.host,
          input.port ?? 3306,
          input.username,
          input.password,
          input.database,
          JSON.stringify(allowedDatabases),
          input.charset ?? 'utf8mb4',
          input.accessMode ?? 'read_write',
          input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          input.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
          input.poolMax ?? DEFAULT_POOL_MAX,
          input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          input.enabled === false ? 0 : 1,
          now,
          now,
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new PluginError({
          category: 'argument_error',
          code: 'CONNECTION_ALREADY_EXISTS',
          message: `数据源别名 ${input.alias} 已存在。`,
          cause: error,
        });
      }
      throw error;
    }
    return this.toSummary(this.requireConnection(input.alias));
  }

  updateConnection(input: UpdateConnectionInput): ConnectionSummary {
    const existing = this.requireConnection(input.alias);
    const next: AddConnectionInput = {
      alias: existing.alias,
      datasourceId: input.datasourceId ?? existing.datasourceId ?? existing.alias,
      environment: input.environment ?? existing.environment ?? 'custom',
      ownerScope: input.ownerScope ?? existing.ownerScope ?? 'global',
      shareable: input.shareable ?? existing.shareable ?? false,
      description: input.description === undefined ? existing.description : input.description,
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
      username: input.username ?? existing.username,
      password: input.password === undefined ? existing.password : input.password,
      database: input.database ?? existing.database,
      allowedDatabases: input.allowedDatabases ?? existing.allowedDatabases,
      charset: input.charset ?? existing.charset,
      accessMode: input.accessMode ?? existing.accessMode,
      connectTimeoutMs: input.connectTimeoutMs ?? existing.connectTimeoutMs,
      queryTimeoutMs: input.queryTimeoutMs ?? existing.queryTimeoutMs,
      poolMax: input.poolMax ?? existing.poolMax,
      idleTimeoutMs: input.idleTimeoutMs ?? existing.idleTimeoutMs,
      enabled: input.enabled ?? existing.enabled,
    };
    this.validateDatabaseScope(next.database, next.allowedDatabases ?? [next.database]);
    this.validatePoolMax(next.poolMax ?? DEFAULT_POOL_MAX);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`
        UPDATE connections SET
          datasource_id = ?, environment = ?, owner_scope = ?, shareable = ?,
          description = ?, host = ?, port = ?, username = ?, password = ?,
          default_database = ?, allowed_databases_json = ?, charset = ?,
          access_mode = ?, connect_timeout_ms = ?, query_timeout_ms = ?,
          pool_max = ?, idle_timeout_ms = ?, enabled = ?, revision = revision + 1,
          updated_at = ?
        WHERE alias = ?
      `).run(
        next.datasourceId ?? next.alias,
        next.environment ?? 'custom',
        next.ownerScope ?? 'global',
        next.shareable === true ? 1 : 0,
        next.description ?? null,
        next.host,
        next.port ?? 3306,
        next.username,
        next.password,
        next.database,
        JSON.stringify(next.allowedDatabases ?? [next.database]),
        next.charset ?? 'utf8mb4',
        next.accessMode ?? 'read_write',
        next.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        next.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        next.poolMax ?? DEFAULT_POOL_MAX,
        next.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        next.enabled === false ? 0 : 1,
        now,
        input.alias,
      );
      if (updated.changes === 0) {
        throw new PluginError({ category: 'config_error', code: 'CONNECTION_NOT_FOUND', message: `找不到数据源 ${input.alias}。` });
      }
      this.database.prepare('DELETE FROM schema_snapshots WHERE connection_alias = ?').run(input.alias);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.toSummary({
      ...existing,
      datasourceId: next.datasourceId ?? next.alias,
      environment: next.environment ?? 'custom',
      ownerScope: next.ownerScope ?? 'global',
      shareable: next.shareable ?? false,
      description: next.description ?? null,
      host: next.host,
      port: next.port ?? 3306,
      username: next.username,
      password: next.password,
      database: next.database,
      allowedDatabases: next.allowedDatabases ?? [next.database],
      charset: next.charset ?? 'utf8mb4',
      accessMode: next.accessMode ?? 'read_write',
      connectTimeoutMs: next.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: next.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      poolMax: next.poolMax ?? DEFAULT_POOL_MAX,
      idleTimeoutMs: next.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      enabled: next.enabled ?? true,
      revision: existing.revision + 1,
      updatedAt: now,
    });
  }

  removeConnection(alias: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM schema_snapshots WHERE connection_alias = ?').run(alias);
      const result = this.database.prepare('DELETE FROM connections WHERE alias = ?').run(alias);
      if (result.changes === 0) {
        throw new PluginError({
          category: 'config_error',
          code: 'CONNECTION_NOT_FOUND',
          message: `找不到数据源 ${alias}。`,
        });
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  getConnection(alias: string): ConnectionConfig | null {
    const row = this.database
      .prepare('SELECT * FROM connections WHERE alias = ?')
      .get(alias) as unknown as ConnectionRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  requireConnection(alias: string): ConnectionConfig {
    const connection = this.getConnection(alias);
    if (!connection) {
      throw new PluginError({
        category: 'config_error',
        code: 'CONNECTION_NOT_FOUND',
        message: `找不到数据源 ${alias}。`,
      });
    }
    return connection;
  }

  listConnections(includeDisabled = true): ConnectionSummary[] {
    const rows = this.database
      .prepare(`SELECT * FROM connections ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY alias`)
      .all() as unknown as ConnectionRow[];
    return rows.map((row) => this.toSummary(this.fromRow(row)));
  }

  recordAudit(record: AuditRecord): void {
    this.database
      .prepare(`
        INSERT INTO execution_audit (
          execution_id, occurred_at, client_name, connection_alias,
          business_operation_id, business_pack_id, business_pack_version,
          business_operation_hash, statement_kind, sql_hash, duration_ms,
          row_count, affected_rows, attempt_count, write_outcome, status,
          error_category, mysql_error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.executionId,
        record.occurredAt,
        record.clientName,
        record.connectionAlias,
        record.businessOperationId,
        record.businessPackId,
        record.businessPackVersion,
        record.businessOperationHash,
        record.statementKind,
        record.sqlHash,
        record.durationMs,
        record.rowCount,
        record.affectedRows,
        record.attemptCount,
        record.writeOutcome,
        record.status,
        record.errorCategory,
        record.mysqlErrorCode,
      );
  }

  searchAudit(filters: AuditHistoryFilters): { records: AuditHistoryRecord[]; nextBeforeId: number | null } {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return;
      clauses.push(clause);
      values.push(value);
    };
    add('execution_id = ?', filters.executionId);
    add('connection_alias = ?', filters.connectionAlias);
    add('business_operation_id = ?', filters.businessOperationId);
    add('client_name = ?', filters.clientName);
    add('statement_kind = ?', filters.statementKind);
    add('status = ?', filters.status);
    add('occurred_at >= ?', filters.since);
    add('occurred_at <= ?', filters.until);
    add('id < ?', filters.beforeId);
    const rows = this.database.prepare(`
      SELECT * FROM execution_audit
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT ?
    `).all(...values, filters.limit + 1) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > filters.limit;
    const selected = hasMore ? rows.slice(0, filters.limit) : rows;
    const records = selected.map((row) => ({
      id: Number(row.id),
      executionId: String(row.execution_id),
      occurredAt: String(row.occurred_at),
      clientName: String(row.client_name),
      connectionAlias: String(row.connection_alias),
      businessOperationId: row.business_operation_id === null ? null : String(row.business_operation_id),
      businessPackId: row.business_pack_id === null ? null : String(row.business_pack_id),
      businessPackVersion: row.business_pack_version === null ? null : String(row.business_pack_version),
      businessOperationHash: row.business_operation_hash === null ? null : String(row.business_operation_hash),
      statementKind: String(row.statement_kind),
      sqlHash: String(row.sql_hash),
      durationMs: Number(row.duration_ms),
      rowCount: row.row_count === null ? null : Number(row.row_count),
      affectedRows: row.affected_rows === null ? null : Number(row.affected_rows),
      attemptCount: Number(row.attempt_count),
      writeOutcome: String(row.write_outcome ?? 'not_applicable') as AuditRecord['writeOutcome'],
      status: String(row.status) as AuditRecord['status'],
      errorCategory: row.error_category === null ? null : String(row.error_category),
      mysqlErrorCode: row.mysql_error_code === null ? null : Number(row.mysql_error_code),
    }));
    return {
      records,
      nextBeforeId: hasMore && records.length > 0 ? records[records.length - 1]!.id : null,
    };
  }

  readSchemaSnapshot(cacheKey: string): SchemaSnapshotRecord | null {
    const row = this.database
      .prepare('SELECT * FROM schema_snapshots WHERE cache_key = ?')
      .get(cacheKey) as unknown as SchemaSnapshotRow | undefined;
    if (!row) return null;
    if (row.format_version !== SCHEMA_SNAPSHOT_FORMAT_VERSION) {
      this.deleteSchemaSnapshotBestEffort(cacheKey);
      return null;
    }
    if (typeof row.snapshot_json !== 'string' || Buffer.byteLength(row.snapshot_json, 'utf8') > MAX_SCHEMA_SNAPSHOT_BYTES) {
      this.deleteSchemaSnapshotBestEffort(cacheKey);
      return null;
    }
    try {
      return {
        formatVersion: row.format_version,
        cacheKey: row.cache_key,
        connectionAlias: row.connection_alias,
        connectionRevision: row.connection_revision,
        defaultDatabase: row.default_database,
        allowedDatabases: JSON.parse(row.allowed_databases_json) as string[],
        snapshot: JSON.parse(row.snapshot_json) as unknown,
        loadedAt: row.loaded_at,
      };
    } catch {
      this.deleteSchemaSnapshotBestEffort(cacheKey);
      return null;
    }
  }

  writeSchemaSnapshot(record: SchemaSnapshotRecord): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO schema_snapshots (
          format_version, cache_key, connection_alias, connection_revision, default_database,
          allowed_databases_json, snapshot_json, loaded_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM connections WHERE alias = ? AND revision = ?
        )
        ON CONFLICT(cache_key) DO UPDATE SET
          format_version = excluded.format_version,
          connection_alias = excluded.connection_alias,
          connection_revision = excluded.connection_revision,
          default_database = excluded.default_database,
          allowed_databases_json = excluded.allowed_databases_json,
          snapshot_json = excluded.snapshot_json,
          loaded_at = excluded.loaded_at
      `)
      .run(
        record.formatVersion,
        record.cacheKey,
        record.connectionAlias,
        record.connectionRevision,
        record.defaultDatabase,
        JSON.stringify(record.allowedDatabases),
        JSON.stringify(record.snapshot),
        record.loadedAt,
        record.connectionAlias,
        record.connectionRevision,
      );
    return result.changes > 0;
  }

  deleteSchemaSnapshot(cacheKey: string): boolean {
    try {
      return this.database.prepare('DELETE FROM schema_snapshots WHERE cache_key = ?').run(cacheKey).changes > 0;
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'invalid_schema_snapshot_delete_failed',
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
      return false;
    }
  }

  private deleteSchemaSnapshotBestEffort(cacheKey: string): void {
    try {
      this.deleteSchemaSnapshot(cacheKey);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'invalid_schema_snapshot_delete_failed',
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
    }
  }

  invalidateSchemaSnapshots(alias: string, revision?: number): number {
    const result = revision === undefined
      ? this.database.prepare('DELETE FROM schema_snapshots WHERE connection_alias = ?').run(alias)
      : this.database
          .prepare('DELETE FROM schema_snapshots WHERE connection_alias = ? AND connection_revision = ?')
          .run(alias, revision);
    return Number(result.changes);
  }

  close(): void {
    this.database.close();
  }

  private fromRow(row: ConnectionRow): ConnectionConfig {
    return {
      alias: row.alias,
      datasourceId: row.datasource_id || row.alias,
      environment: (row.environment || 'custom') as ConnectionEnvironment,
      ownerScope: row.owner_scope || 'global',
      shareable: row.shareable === 1,
      description: row.description,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.password,
      database: row.default_database,
      allowedDatabases: JSON.parse(row.allowed_databases_json) as string[],
      charset: 'utf8mb4',
      accessMode: row.access_mode as AccessMode,
      connectTimeoutMs: row.connect_timeout_ms,
      queryTimeoutMs: row.query_timeout_ms,
      poolMax: row.pool_max,
      idleTimeoutMs: row.idle_timeout_ms,
      enabled: row.enabled === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toSummary(connection: ConnectionConfig): ConnectionSummary {
    const { password: _password, ...summary } = connection;
    return summary;
  }

  private validateDatabaseScope(database: string, allowedDatabases: string[]): void {
    if (!allowedDatabases.includes(database)) {
      throw new PluginError({
        category: 'argument_error',
        code: 'DEFAULT_DATABASE_NOT_ALLOWED',
        message: `allowed_databases 必须包含默认数据库 ${database}。`,
      });
    }
  }

  private validatePoolMax(poolMax: number): void {
    if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > MAX_POOL_MAX) {
      throw new PluginError({
        category: 'argument_error',
        code: 'POOL_MAX_OUT_OF_RANGE',
        message: `pool_max 必须是 1 到 ${MAX_POOL_MAX} 之间的整数。`,
      });
    }
  }
}
