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
  DiscoveryCandidateFilters,
  DiscoveryRecord,
  ExecutionRunRecord,
  ExecutionSpanRecord,
  SchemaSnapshotRecord,
  TraceSearchFilters,
  TraceStatus,
  UsageGroupBy,
  UsageSummaryFilters,
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

export interface ConnectionIdentity {
  alias: string;
  datasourceId: string;
  environment: ConnectionEnvironment;
  ownerScope: string;
  revision: number;
}

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

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function usageGroup(row: Record<string, unknown>, groupBy?: UsageGroupBy): string {
  if (!groupBy) return 'all';
  if (groupBy === 'operation') return String(row.operation_id);
  if (groupBy === 'kind') return String(row.operation_kind);
  if (groupBy === 'datasource') return parseStringArray(row.datasource_ids_json).sort().join(',') || '(none)';
  if (groupBy === 'environment') return row.environment === null ? '(none)' : String(row.environment);
  return String(row.status);
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
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
      if (current < 7) {
        const auditColumns = this.database.prepare('PRAGMA table_info(execution_audit)').all() as Array<{ name: string }>;
        const names = new Set(auditColumns.map((column) => column.name));
        if (auditColumns.length > 0) {
          if (!names.has('workspace_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN workspace_id TEXT');
          if (!names.has('datasource_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN datasource_id TEXT');
          if (!names.has('environment')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN environment TEXT');
          this.database.exec(`
            CREATE INDEX IF NOT EXISTS idx_execution_audit_workspace
              ON execution_audit(workspace_id, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_execution_audit_workspace_target
              ON execution_audit(workspace_id, datasource_id, environment, occurred_at DESC);
          `);
        }
        this.recordMigration(7);
      }
      if (current < 8) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS workspace_identities (
            workspace_id TEXT PRIMARY KEY,
            root_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
          );
        `);
        this.recordMigration(8);
      }
      if (current < 9) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS execution_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            client_name TEXT NOT NULL,
            connection_alias TEXT NOT NULL,
            workspace_id TEXT,
            datasource_id TEXT,
            environment TEXT,
            trace_id TEXT,
            span_id TEXT,
            run_id TEXT,
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
        `);
        const auditColumns = this.database.prepare('PRAGMA table_info(execution_audit)').all() as Array<{ name: string }>;
        const auditNames = new Set(auditColumns.map((column) => column.name));
        if (!auditNames.has('trace_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN trace_id TEXT');
        if (!auditNames.has('span_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN span_id TEXT');
        if (!auditNames.has('run_id')) this.database.exec('ALTER TABLE execution_audit ADD COLUMN run_id TEXT');
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS execution_runs (
            run_id TEXT PRIMARY KEY,
            workspace_id TEXT,
            task_id TEXT,
            trace_id TEXT NOT NULL,
            root_span_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            operation_kind TEXT NOT NULL,
            datasource_ids_json TEXT NOT NULL DEFAULT '[]',
            environment TEXT,
            connection_aliases_json TEXT NOT NULL DEFAULT '[]',
            pack_id TEXT,
            pack_version TEXT,
            operation_hash TEXT,
            script_hash TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            queue_duration_ms INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_category TEXT,
            result_bytes INTEGER
          );
          CREATE TABLE IF NOT EXISTS execution_spans (
            span_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES execution_runs(run_id) ON DELETE CASCADE,
            trace_id TEXT NOT NULL,
            parent_span_id TEXT,
            workspace_id TEXT,
            operation_id TEXT NOT NULL,
            operation_kind TEXT NOT NULL,
            datasource_id TEXT,
            environment TEXT,
            connection_alias TEXT,
            step_index INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            queue_duration_ms INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_category TEXT,
            result_bytes INTEGER
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_runs_trace_root ON execution_runs(trace_id, root_span_id);
          CREATE INDEX IF NOT EXISTS idx_execution_runs_workspace_started ON execution_runs(workspace_id, started_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_runs_workspace_operation ON execution_runs(workspace_id, operation_id, started_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_runs_workspace_target ON execution_runs(workspace_id, environment, started_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_spans_run_step ON execution_spans(run_id, step_index, started_at);
          CREATE INDEX IF NOT EXISTS idx_execution_spans_trace ON execution_spans(trace_id, started_at);
          CREATE INDEX IF NOT EXISTS idx_execution_spans_workspace_target ON execution_spans(workspace_id, datasource_id, environment, started_at DESC);
          CREATE INDEX IF NOT EXISTS idx_execution_audit_trace ON execution_audit(trace_id, span_id);
          CREATE INDEX IF NOT EXISTS idx_execution_audit_run ON execution_audit(run_id, occurred_at DESC);
        `);
        this.recordMigration(9);
      }
      if (current < 10) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS discovery_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL,
            run_id TEXT,
            trace_id TEXT,
            datasource_id TEXT NOT NULL,
            environment TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            statement_kind TEXT NOT NULL,
            sql_fingerprint TEXT NOT NULL,
            parameter_shape_json TEXT NOT NULL,
            table_names_json TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            result_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            previous_fingerprint TEXT,
            previous_gap_ms INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_discovery_workspace_time
            ON discovery_events(workspace_id, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_discovery_workspace_candidate
            ON discovery_events(workspace_id, datasource_id, environment, statement_kind, sql_fingerprint);

          CREATE TABLE IF NOT EXISTS business_reload_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            status TEXT NOT NULL,
            content_hash TEXT,
            error_code TEXT,
            added_tools INTEGER NOT NULL DEFAULT 0,
            updated_tools INTEGER NOT NULL DEFAULT 0,
            removed_tools INTEGER NOT NULL DEFAULT 0,
            occurred_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_business_reload_workspace_time
            ON business_reload_events(workspace_id, occurred_at DESC);
        `);
        this.recordMigration(10);
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

  updateConnection(input: UpdateConnectionInput, expected?: ConnectionIdentity): ConnectionSummary {
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
          ${expected ? 'AND datasource_id = ? AND environment = ? AND owner_scope = ? AND revision = ?' : ''}
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
        ...(expected ? [expected.datasourceId, expected.environment, expected.ownerScope, expected.revision] : []),
      );
      if (updated.changes === 0) {
        if (expected) {
          throw new PluginError({
            category: 'permission_error', code: 'AUTH_TARGET_CHANGED',
            message: `连接 ${input.alias} 的授权目标或 revision 已变化，请重新读取后重试。`, retryable: true,
          });
        }
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

  removeConnection(alias: string, expected?: ConnectionIdentity): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare(`
        DELETE FROM connections WHERE alias = ?
        ${expected ? 'AND datasource_id = ? AND environment = ? AND owner_scope = ? AND revision = ?' : ''}
      `).run(alias, ...(expected ? [expected.datasourceId, expected.environment, expected.ownerScope, expected.revision] : []));
      if (result.changes === 0) {
        if (expected) {
          throw new PluginError({
            category: 'permission_error', code: 'AUTH_TARGET_CHANGED',
            message: `连接 ${alias} 的授权目标或 revision 已变化，未执行删除。`, retryable: true,
          });
        }
        throw new PluginError({
          category: 'config_error',
          code: 'CONNECTION_NOT_FOUND',
          message: `找不到数据源 ${alias}。`,
        });
      }
      this.database.prepare('DELETE FROM schema_snapshots WHERE connection_alias = ?').run(alias);
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

  assertConnectionIdentity(expected: ConnectionIdentity): ConnectionConfig {
    const connection = this.requireConnection(expected.alias);
    if (connection.datasourceId !== expected.datasourceId
      || connection.environment !== expected.environment
      || connection.ownerScope !== expected.ownerScope
      || connection.revision !== expected.revision) {
      throw new PluginError({
        category: 'permission_error', code: 'AUTH_TARGET_CHANGED',
        message: `连接 ${expected.alias} 的授权目标或 revision 已变化，请重新解析 workspace binding。`, retryable: true,
      });
    }
    return connection;
  }

  registerWorkspaceIdentity(workspaceId: string, rootHash: string): void {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare('SELECT root_hash FROM workspace_identities WHERE workspace_id = ?')
        .get(workspaceId) as { root_hash: string } | undefined;
      if (existing && existing.root_hash !== rootHash) {
        throw new PluginError({
          category: 'permission_error', code: 'WORKSPACE_IDENTITY_ROOT_MISMATCH',
          message: `workspace_id ${workspaceId} 已绑定到另一个 root；本期不允许隐式迁移。`,
        });
      }
      if (existing) {
        this.database.prepare('UPDATE workspace_identities SET last_seen_at = ? WHERE workspace_id = ?').run(now, workspaceId);
      } else {
        this.database.prepare('INSERT INTO workspace_identities(workspace_id, root_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
          .run(workspaceId, rootHash, now, now);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordAudit(record: AuditRecord): void {
    this.database
      .prepare(`
        INSERT INTO execution_audit (
          execution_id, occurred_at, client_name, connection_alias,
          workspace_id, datasource_id, environment, trace_id, span_id, run_id,
          business_operation_id, business_pack_id, business_pack_version,
          business_operation_hash, statement_kind, sql_hash, duration_ms,
          row_count, affected_rows, attempt_count, write_outcome, status,
          error_category, mysql_error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.executionId,
        record.occurredAt,
        record.clientName,
        record.connectionAlias,
        record.workspaceId ?? null,
        record.datasourceId ?? null,
        record.environment ?? null,
        record.traceId ?? null,
        record.spanId ?? null,
        record.runId ?? null,
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
    add('workspace_id = ?', filters.workspaceId);
    add('datasource_id = ?', filters.datasourceId);
    add('environment = ?', filters.environment);
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
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      datasourceId: row.datasource_id === null ? null : String(row.datasource_id),
      environment: row.environment === null ? null : String(row.environment) as ConnectionEnvironment,
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
      traceId: row.trace_id === null ? null : String(row.trace_id),
      spanId: row.span_id === null ? null : String(row.span_id),
      runId: row.run_id === null ? null : String(row.run_id),
    }));
    return {
      records,
      nextBeforeId: hasMore && records.length > 0 ? records[records.length - 1]!.id : null,
    };
  }

  createExecutionRun(record: ExecutionRunRecord): void {
    this.database.prepare(`
      INSERT INTO execution_runs (
        run_id, workspace_id, task_id, trace_id, root_span_id, operation_id, operation_kind,
        datasource_ids_json, environment, connection_aliases_json, pack_id, pack_version,
        operation_hash, script_hash, started_at, ended_at, duration_ms, queue_duration_ms,
        status, error_category, result_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId, record.workspaceId, record.taskId, record.traceId, record.rootSpanId,
      record.operationId, record.operationKind, JSON.stringify(record.datasourceIds), record.environment,
      JSON.stringify(record.connectionAliases), record.packId, record.packVersion, record.operationHash,
      record.scriptHash, record.startedAt, record.endedAt, record.durationMs, record.queueDurationMs,
      record.status, record.errorCategory, record.resultBytes,
    );
  }

  createExecutionSpan(record: ExecutionSpanRecord): void {
    this.database.prepare(`
      INSERT INTO execution_spans (
        span_id, run_id, trace_id, parent_span_id, workspace_id, operation_id, operation_kind,
        datasource_id, environment, connection_alias, step_index, started_at, ended_at,
        duration_ms, queue_duration_ms, status, error_category, result_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.spanId, record.runId, record.traceId, record.parentSpanId, record.workspaceId,
      record.operationId, record.operationKind, record.datasourceId, record.environment,
      record.connectionAlias, record.stepIndex, record.startedAt, record.endedAt, record.durationMs,
      record.queueDurationMs, record.status, record.errorCategory, record.resultBytes,
    );
  }

  createExecutionRoot(run: ExecutionRunRecord, rootSpan: ExecutionSpanRecord): void {
    this.withTraceWriteTimeout(() => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.createExecutionRun(run);
        this.createExecutionSpan(rootSpan);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  finishExecutionRun(runId: string, finish: {
    endedAt: string; durationMs: number; queueDurationMs?: number; status: Exclude<TraceStatus, 'running'>;
    errorCategory: string | null; resultBytes: number;
  }): void {
    this.withTraceWriteTimeout(() => this.finishExecutionRunOnce(runId, finish));
  }

  private finishExecutionRunOnce(runId: string, finish: {
    endedAt: string; durationMs: number; queueDurationMs?: number; status: Exclude<TraceStatus, 'running'>;
    errorCategory: string | null; resultBytes: number;
  }): void {
    const result = this.database.prepare(`
      UPDATE execution_runs SET ended_at = ?, duration_ms = ?,
        queue_duration_ms = COALESCE(?, queue_duration_ms), status = ?, error_category = ?, result_bytes = ?
      WHERE run_id = ? AND status = 'running'
    `).run(finish.endedAt, finish.durationMs, finish.queueDurationMs ?? null, finish.status, finish.errorCategory, finish.resultBytes, runId);
    if (result.changes !== 1) {
      throw new PluginError({
        category: 'config_error', code: 'TRACE_RUN_FINISH_TARGET_MISSING',
        message: `Trace run ${runId} 不存在或已经结束。`,
      });
    }
  }

  finishExecutionSpan(spanId: string, finish: {
    endedAt: string; durationMs: number; queueDurationMs?: number; status: Exclude<TraceStatus, 'running'>;
    errorCategory: string | null; resultBytes: number;
  }): void {
    this.withTraceWriteTimeout(() => this.finishExecutionSpanOnce(spanId, finish));
  }

  private finishExecutionSpanOnce(spanId: string, finish: {
    endedAt: string; durationMs: number; queueDurationMs?: number; status: Exclude<TraceStatus, 'running'>;
    errorCategory: string | null; resultBytes: number;
  }): void {
    const result = this.database.prepare(`
      UPDATE execution_spans SET ended_at = ?, duration_ms = ?,
        queue_duration_ms = COALESCE(?, queue_duration_ms), status = ?, error_category = ?, result_bytes = ?
      WHERE span_id = ? AND status = 'running'
    `).run(finish.endedAt, finish.durationMs, finish.queueDurationMs ?? null, finish.status, finish.errorCategory, finish.resultBytes, spanId);
    if (result.changes !== 1) {
      throw new PluginError({
        category: 'config_error', code: 'TRACE_SPAN_FINISH_TARGET_MISSING',
        message: `Trace span ${spanId} 不存在或已经结束。`,
      });
    }
  }

  finishExecutionRoot(runId: string, rootSpanId: string, finish: {
    endedAt: string; durationMs: number; queueDurationMs?: number; status: Exclude<TraceStatus, 'running'>;
    errorCategory: string | null; resultBytes: number;
  }): void {
    this.withTraceWriteTimeout(() => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.finishExecutionSpanOnce(rootSpanId, finish);
        this.finishExecutionRunOnce(runId, finish);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private withTraceWriteTimeout<T>(operation: () => T): T {
    this.database.exec('PRAGMA busy_timeout=25');
    try {
      return operation();
    } finally {
      this.database.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    }
  }

  searchExecutionRuns(filters: TraceSearchFilters): {
    records: ExecutionRunRecord[];
    nextBeforeStartedAt: string | null;
    nextBeforeRunId: string | null;
  } {
    const clauses = ['workspace_id = ?'];
    const values: Array<string | number> = [filters.workspaceId];
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return;
      clauses.push(clause);
      values.push(value);
    };
    add('trace_id = ?', filters.traceId);
    add('run_id = ?', filters.runId);
    add('operation_id = ?', filters.operationId);
    add('operation_kind = ?', filters.operationKind);
    add('status = ?', filters.status);
    if (filters.datasourceId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(execution_runs.datasource_ids_json) WHERE value = ?)");
      values.push(filters.datasourceId);
    }
    add('environment = ?', filters.environment);
    add('started_at >= ?', filters.since);
    add('started_at <= ?', filters.until);
    if (filters.beforeStartedAt !== undefined && filters.beforeRunId !== undefined) {
      clauses.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
      values.push(filters.beforeStartedAt, filters.beforeStartedAt, filters.beforeRunId);
    } else {
      add('started_at < ?', filters.beforeStartedAt);
    }
    const rows = this.database.prepare(`
      SELECT * FROM execution_runs WHERE ${clauses.join(' AND ')}
      ORDER BY started_at DESC, run_id DESC LIMIT ?
    `).all(...values, filters.limit + 1) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > filters.limit;
    const selected = hasMore ? rows.slice(0, filters.limit) : rows;
    const records = selected.map((row) => this.executionRunFromRow(row));
    const last = hasMore && records.length > 0 ? records.at(-1)! : null;
    return {
      records,
      nextBeforeStartedAt: last?.startedAt ?? null,
      nextBeforeRunId: last?.runId ?? null,
    };
  }

  listExecutionSpans(workspaceId: string, runId: string): ExecutionSpanRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM execution_spans WHERE workspace_id = ? AND run_id = ? ORDER BY step_index, started_at, span_id
    `).all(workspaceId, runId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.executionSpanFromRow(row));
  }

  usageSummary(filters: UsageSummaryFilters): Array<{
    group: string; count: number; errorCount: number; p50Ms: number; p95Ms: number; p99Ms: number;
    avgMs: number; resultBytes: number;
  }> {
    const clauses = ["workspace_id = ?", "status <> 'running'", 'duration_ms IS NOT NULL'];
    const values: Array<string | number> = [filters.workspaceId];
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return;
      clauses.push(clause); values.push(value);
    };
    add('operation_id = ?', filters.operationId);
    add('operation_kind = ?', filters.operationKind);
    add('status = ?', filters.status);
    if (filters.datasourceId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(execution_runs.datasource_ids_json) WHERE value = ?)");
      values.push(filters.datasourceId);
    }
    add('environment = ?', filters.environment);
    add('started_at >= ?', filters.since);
    add('started_at <= ?', filters.until);
    const rows = this.database.prepare(`SELECT operation_id, operation_kind, datasource_ids_json, environment, status, duration_ms, result_bytes
      FROM execution_runs WHERE ${clauses.join(' AND ')}`).all(...values) as unknown as Array<Record<string, unknown>>;
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = usageGroup(row, filters.groupBy);
      const group = groups.get(key) ?? [];
      group.push(row); groups.set(key, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([group, items]) => {
      const durations = items.map((item) => Number(item.duration_ms)).sort((left, right) => left - right);
      return {
        group, count: items.length, errorCount: items.filter((item) => item.status !== 'ok').length,
        p50Ms: percentile(durations, 0.50), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99),
        avgMs: durations.length === 0 ? 0 : Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 100) / 100,
        resultBytes: items.reduce((sum, item) => sum + Number(item.result_bytes ?? 0), 0),
      };
    });
  }

  recordDiscovery(record: DiscoveryRecord): void {
    const previous = this.database.prepare(`SELECT sql_fingerprint, occurred_at FROM discovery_events
      WHERE workspace_id = ? AND datasource_id = ? AND environment = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`)
      .get(record.workspaceId, record.datasourceId, record.environment) as { sql_fingerprint: string; occurred_at: string } | undefined;
    const gap = previous ? Math.max(0, Date.parse(record.occurredAt) - Date.parse(previous.occurred_at)) : null;
    this.database.prepare(`INSERT INTO discovery_events (
      workspace_id, run_id, trace_id, datasource_id, environment, occurred_at,
      statement_kind, sql_fingerprint, parameter_shape_json, table_names_json,
      duration_ms, result_bytes, status, previous_fingerprint, previous_gap_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.workspaceId, record.runId, record.traceId, record.datasourceId, record.environment,
        record.occurredAt, record.statementKind, record.sqlFingerprint,
        JSON.stringify(record.parameterShape), JSON.stringify([...new Set(record.tableNames)].sort()),
        record.durationMs, record.resultBytes, record.status,
        previous?.sql_fingerprint ?? null, gap,
      );
  }

  analyzeDiscoveryCandidates(filters: DiscoveryCandidateFilters): Array<Record<string, unknown>> {
    const clauses = ['workspace_id = ?'];
    const values: Array<string | number> = [filters.workspaceId];
    if (filters.since) { clauses.push('occurred_at >= ?'); values.push(filters.since); }
    if (filters.until) { clauses.push('occurred_at <= ?'); values.push(filters.until); }
    const rows = this.database.prepare(`SELECT * FROM discovery_events WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at, id`).all(...values) as unknown as Array<Record<string, unknown>>;
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = [row.datasource_id, row.environment, row.statement_kind, row.sql_fingerprint].join('\u0000');
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].filter((items) => items.length >= filters.minCount).map((items) => {
      const sample = items[0]!;
      const durations = items.map((row) => Number(row.duration_ms)).sort((a, b) => a - b);
      const repeated = items.filter((row) => row.previous_fingerprint === sample.sql_fingerprint
        && Number(row.previous_gap_ms ?? Number.MAX_SAFE_INTEGER) <= 300_000).length;
      const repeatedSequenceScore = Math.round((repeated / Math.max(1, items.length - 1)) * 1000) / 1000;
      const estimatedCallsSaved = Math.max(0, items.length - 1);
      const errorCount = items.filter((row) => row.status === 'error').length;
      const score = Math.round((Math.log2(items.length + 1) * 10 + repeatedSequenceScore * 20
        + Math.min(20, percentile(durations, 0.95) / 500) - errorCount / items.length * 10) * 100) / 100;
      const resultBytes = items.map((row) => Number(row.result_bytes ?? 0));
      return {
        datasource_id: String(sample.datasource_id), environment: String(sample.environment),
        statement_kind: String(sample.statement_kind), sql_fingerprint: String(sample.sql_fingerprint),
        count: items.length, error_count: errorCount,
        p50_ms: percentile(durations, 0.5), p95_ms: percentile(durations, 0.95),
        avg_ms: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length * 100) / 100,
        avg_result_bytes: Math.round(resultBytes.reduce((sum, value) => sum + value, 0) / resultBytes.length * 100) / 100,
        repeated_sequence_score: repeatedSequenceScore,
        estimated_mcp_calls_saved: estimatedCallsSaved, score,
        table_names: parseStringArray(sample.table_names_json),
        parameter_shape: JSON.parse(String(sample.parameter_shape_json)) as unknown,
      };
    }).sort((left, right) => Number(right.score) - Number(left.score)
      || Number(right.count) - Number(left.count))
      .slice(0, filters.limit);
  }

  cleanupDiscovery(workspaceId: string, before: string): number {
    return Number(this.database.prepare('DELETE FROM discovery_events WHERE workspace_id = ? AND occurred_at < ?')
      .run(workspaceId, before).changes);
  }

  recordBusinessReload(input: {
    workspaceId: string; generation: number; status: 'ok' | 'error'; contentHash?: string | null;
    errorCode?: string | null; addedTools?: number; updatedTools?: number; removedTools?: number; occurredAt?: string;
  }): void {
    this.database.prepare(`INSERT INTO business_reload_events (
      workspace_id, generation, status, content_hash, error_code, added_tools,
      updated_tools, removed_tools, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.workspaceId, input.generation, input.status, input.contentHash ?? null,
        input.errorCode ?? null, input.addedTools ?? 0, input.updatedTools ?? 0,
        input.removedTools ?? 0, input.occurredAt ?? new Date().toISOString());
  }

  latestBusinessReload(workspaceId: string): Record<string, unknown> | null {
    const row = this.database.prepare(`SELECT generation, status, content_hash, error_code,
      added_tools, updated_tools, removed_tools, occurred_at FROM business_reload_events
      WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`).get(workspaceId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /** Detailed export is intentionally deferred; callers must export and verify before invoking retention cleanup. */
  cleanupExecutionTraces(workspaceId: string, before: string): { runsDeleted: number; spansDeleted: number } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const spans = this.database.prepare(`SELECT COUNT(*) AS count FROM execution_spans
        WHERE workspace_id = ? AND run_id IN (
          SELECT run_id FROM execution_runs
          WHERE workspace_id = ? AND status <> 'running' AND ended_at IS NOT NULL AND ended_at < ?
        )`)
        .get(workspaceId, workspaceId, before) as { count: number };
      const deleted = this.database.prepare(`DELETE FROM execution_runs
        WHERE workspace_id = ? AND status <> 'running' AND ended_at IS NOT NULL AND ended_at < ?`).run(workspaceId, before);
      this.database.exec('COMMIT');
      return { runsDeleted: Number(deleted.changes), spansDeleted: Number(spans.count) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileStaleExecutionRuns(workspaceId: string, startedBefore: string, endedAt = new Date().toISOString()): {
    runsReconciled: number;
    spansReconciled: number;
  } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const spans = this.database.prepare(`
        UPDATE execution_spans SET ended_at = ?,
          duration_ms = CAST(MAX(0, (julianday(?) - julianday(started_at)) * 86400000) AS INTEGER),
          status = 'error', error_category = 'abandoned', result_bytes = 0
        WHERE workspace_id = ? AND status = 'running' AND started_at < ?
      `).run(endedAt, endedAt, workspaceId, startedBefore);
      const runs = this.database.prepare(`
        UPDATE execution_runs SET ended_at = ?,
          duration_ms = CAST(MAX(0, (julianday(?) - julianday(started_at)) * 86400000) AS INTEGER),
          status = 'error', error_category = 'abandoned', result_bytes = 0
        WHERE workspace_id = ? AND status = 'running' AND started_at < ?
      `).run(endedAt, endedAt, workspaceId, startedBefore);
      this.database.exec('COMMIT');
      return { runsReconciled: Number(runs.changes), spansReconciled: Number(spans.changes) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private executionRunFromRow(row: Record<string, unknown>): ExecutionRunRecord {
    return {
      runId: String(row.run_id), workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      taskId: row.task_id === null ? null : String(row.task_id), traceId: String(row.trace_id), rootSpanId: String(row.root_span_id),
      operationId: String(row.operation_id), operationKind: String(row.operation_kind) as ExecutionRunRecord['operationKind'],
      datasourceIds: parseStringArray(row.datasource_ids_json), environment: row.environment === null ? null : String(row.environment) as ExecutionRunRecord['environment'],
      connectionAliases: parseStringArray(row.connection_aliases_json), packId: row.pack_id === null ? null : String(row.pack_id),
      packVersion: row.pack_version === null ? null : String(row.pack_version), operationHash: row.operation_hash === null ? null : String(row.operation_hash),
      scriptHash: row.script_hash === null ? null : String(row.script_hash), startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms), queueDurationMs: Number(row.queue_duration_ms),
      status: String(row.status) as TraceStatus, errorCategory: row.error_category === null ? null : String(row.error_category),
      resultBytes: row.result_bytes === null ? null : Number(row.result_bytes),
    };
  }

  private executionSpanFromRow(row: Record<string, unknown>): ExecutionSpanRecord {
    return {
      spanId: String(row.span_id), runId: String(row.run_id), traceId: String(row.trace_id),
      parentSpanId: row.parent_span_id === null ? null : String(row.parent_span_id), workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      operationId: String(row.operation_id), operationKind: String(row.operation_kind) as ExecutionSpanRecord['operationKind'],
      datasourceId: row.datasource_id === null ? null : String(row.datasource_id), environment: row.environment === null ? null : String(row.environment) as ExecutionSpanRecord['environment'],
      connectionAlias: row.connection_alias === null ? null : String(row.connection_alias), stepIndex: Number(row.step_index),
      startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at), durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      queueDurationMs: Number(row.queue_duration_ms), status: String(row.status) as TraceStatus,
      errorCategory: row.error_category === null ? null : String(row.error_category), resultBytes: row.result_bytes === null ? null : Number(row.result_bytes),
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
