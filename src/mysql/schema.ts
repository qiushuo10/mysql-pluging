import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

import {
  MAX_SCHEMA_COLUMNS,
  MAX_SCHEMA_DESCRIBE_TABLES,
  MAX_SCHEMA_DESCRIBE_RESULT_BYTES,
  MAX_SCHEMA_INDEX_ROWS,
  MAX_SCHEMA_MATCHED_COLUMNS,
  MAX_SCHEMA_RELATIONS,
  MAX_SCHEMA_RELATION_ROWS,
  MAX_SCHEMA_SEARCH_RESULT_BYTES,
  MAX_SCHEMA_TABLES,
  MAX_SCHEMA_SNAPSHOT_BYTES,
  SCHEMA_SNAPSHOT_FORMAT_VERSION,
  SCHEMA_L1_TTL_MS,
  SCHEMA_L2_TTL_MS,
} from '../constants.js';
import { StateStore, type ConnectionIdentity } from '../config/store.js';
import { PluginError, mapMysqlError } from '../errors.js';
import type { ConnectionConfig } from '../types.js';
import { createMetadataByteBudget, executeMetadataQueryAttempt } from './executor.js';
import { ConnectionRuntimeRegistry, DatabaseAttemptError } from './runtime.js';

export interface SchemaColumn {
  name: string;
  ordinal: number;
  data_type: string;
  column_type: string;
  nullable: boolean;
  default: unknown;
  primary_key: boolean;
  comment: string | null;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  type: string;
  columns: string[];
}

export interface SchemaTable {
  database: string;
  name: string;
  type: 'table' | 'view';
  comment: string | null;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
}

export interface SchemaRelation {
  name: string;
  source: 'foreign_key' | 'inferred';
  source_database: string;
  source_table: string;
  source_columns: string[];
  target_database: string;
  target_table: string;
  target_columns: string[];
  on_update?: string;
  on_delete?: string;
  confidence?: number;
  reason?: string;
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  relations: SchemaRelation[];
}

const schemaColumnSchema = z.object({
  name: z.string().min(1).max(64), ordinal: z.number().int().positive(),
  data_type: z.string().min(1).max(128), column_type: z.string().min(1).max(1024),
  nullable: z.boolean(), default: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  primary_key: z.boolean(), comment: z.string().max(65_535).nullable(),
}).strict();
const schemaIndexSchema = z.object({
  name: z.string().min(1).max(128), unique: z.boolean(), primary: z.boolean(),
  type: z.string().max(64), columns: z.array(z.string().min(1).max(64)).max(1_000),
}).strict();
const schemaTableSchema = z.object({
  database: z.string().min(1).max(64), name: z.string().min(1).max(64),
  type: z.enum(['table', 'view']), comment: z.string().max(65_535).nullable(),
  columns: z.array(schemaColumnSchema).max(MAX_SCHEMA_COLUMNS),
  indexes: z.array(schemaIndexSchema).max(MAX_SCHEMA_INDEX_ROWS),
}).strict();
const schemaRelationSchema = z.object({
  name: z.string().min(1).max(256), source: z.enum(['foreign_key', 'inferred']),
  source_database: z.string().min(1).max(64), source_table: z.string().min(1).max(64),
  source_columns: z.array(z.string().min(1).max(64)).min(1).max(1_000),
  target_database: z.string().min(1).max(64), target_table: z.string().min(1).max(64),
  target_columns: z.array(z.string().min(1).max(64)).min(1).max(1_000),
  on_update: z.string().max(64).optional(), on_delete: z.string().max(64).optional(),
  confidence: z.number().min(0).max(1).optional(), reason: z.string().max(1_024).optional(),
}).strict();
const schemaSnapshotSchema = z.object({
  tables: z.array(schemaTableSchema).max(MAX_SCHEMA_TABLES),
  relations: z.array(schemaRelationSchema).max(MAX_SCHEMA_RELATION_ROWS),
}).strict();

export interface LoadedSchemaSnapshot {
  snapshot: SchemaSnapshot;
  source: 'memory' | 'sqlite' | 'mysql';
  loadedAt: string;
}

export type SchemaSnapshotLoader = (
  config: ConnectionConfig,
  requestSignal?: AbortSignal,
) => Promise<SchemaSnapshot>;

const TABLES_SQL = `
  SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
         TABLE_TYPE AS table_type, TABLE_COMMENT AS table_comment
  FROM information_schema.tables
  WHERE TABLE_SCHEMA IN (__DATABASE_SCOPE__)
  ORDER BY TABLE_SCHEMA, TABLE_NAME
  LIMIT 5001
`;

const COLUMNS_SQL = `
  SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
         COLUMN_NAME AS column_name, ORDINAL_POSITION AS ordinal_position,
         DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
         IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
         COLUMN_KEY AS column_key, COLUMN_COMMENT AS column_comment
  FROM information_schema.columns
  WHERE TABLE_SCHEMA IN (__DATABASE_SCOPE__)
  ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  LIMIT 50001
`;

const INDEXES_SQL = `
  SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
         INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
         INDEX_TYPE AS index_type, SEQ_IN_INDEX AS seq_in_index,
         COLUMN_NAME AS column_name
  FROM information_schema.statistics
  WHERE TABLE_SCHEMA IN (__DATABASE_SCOPE__)
  ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  LIMIT 50001
`;

const RELATIONS_SQL = `
  SELECT kcu.CONSTRAINT_SCHEMA AS constraint_schema,
         kcu.CONSTRAINT_NAME AS constraint_name,
         kcu.TABLE_SCHEMA AS source_schema, kcu.TABLE_NAME AS source_table,
         kcu.COLUMN_NAME AS source_column,
         kcu.REFERENCED_TABLE_SCHEMA AS target_schema,
         kcu.REFERENCED_TABLE_NAME AS target_table,
         kcu.REFERENCED_COLUMN_NAME AS target_column,
         kcu.ORDINAL_POSITION AS ordinal_position,
         rc.UPDATE_RULE AS update_rule, rc.DELETE_RULE AS delete_rule
  FROM information_schema.key_column_usage AS kcu
  JOIN information_schema.referential_constraints AS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.TABLE_NAME = kcu.TABLE_NAME
  WHERE kcu.CONSTRAINT_SCHEMA IN (__DATABASE_SCOPE__)
    AND kcu.TABLE_SCHEMA IN (__SOURCE_DATABASE_SCOPE__)
    AND kcu.REFERENCED_TABLE_SCHEMA IN (__TARGET_DATABASE_SCOPE__)
    AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY kcu.CONSTRAINT_SCHEMA, kcu.TABLE_NAME,
           kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
  LIMIT 20001
`;

function scopedSql(sql: string, count: number): string {
  const placeholders = Array.from({ length: count }, () => '?').join(', ');
  return sql
    .replace('__DATABASE_SCOPE__', placeholders)
    .replace('__SOURCE_DATABASE_SCOPE__', placeholders)
    .replace('__TARGET_DATABASE_SCOPE__', placeholders);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key);
  return value.length > 0 ? value : null;
}

function tableKey(database: string, table: string): string {
  return `${database}.${table}`;
}

export async function loadSchemaSnapshotFromMysql(
  config: ConnectionConfig,
  runtimes: ConnectionRuntimeRegistry,
  requestSignal?: AbortSignal,
): Promise<SchemaSnapshot> {
  const databases = [...new Set(config.allowedDatabases)].sort();
  const run = await runtimes.withRuntime(config, (runtime) =>
    runtime.run(
      {
        timeoutMs: config.queryTimeoutMs,
        requestSignal,
        retrySafeAfterSend: true,
      },
      async (signal) => {
        const values = databases;
        const byteBudget = createMetadataByteBudget();
        const tables = await executeMetadataQueryAttempt(
          runtime,
          scopedSql(TABLES_SQL, databases.length),
          values,
          MAX_SCHEMA_TABLES,
          signal,
          byteBudget,
        );
        const columns = await executeMetadataQueryAttempt(
          runtime,
          scopedSql(COLUMNS_SQL, databases.length),
          values,
          MAX_SCHEMA_COLUMNS,
          signal,
          byteBudget,
        );
        const indexes = await executeMetadataQueryAttempt(
          runtime,
          scopedSql(INDEXES_SQL, databases.length),
          values,
          MAX_SCHEMA_INDEX_ROWS,
          signal,
          byteBudget,
        );
        const relations = await executeMetadataQueryAttempt(
          runtime,
          scopedSql(RELATIONS_SQL, databases.length),
          [...values, ...values, ...values],
          MAX_SCHEMA_RELATION_ROWS,
          signal,
          byteBudget,
        );
        return validateAndBoundSnapshot(normalizeSnapshot(tables, columns, indexes, relations));
      },
    ),
  );
  return run.value;
}

export function normalizeSnapshot(
  tableRows: Array<Record<string, unknown>>,
  columnRows: Array<Record<string, unknown>>,
  indexRows: Array<Record<string, unknown>>,
  relationRows: Array<Record<string, unknown>>,
): SchemaSnapshot {
  const columnsByTable = new Map<string, SchemaColumn[]>();
  for (const row of columnRows) {
    const key = tableKey(text(row, 'table_schema'), text(row, 'table_name'));
    const columns = columnsByTable.get(key) ?? [];
    columns.push({
      name: text(row, 'column_name'),
      ordinal: Number(row.ordinal_position),
      data_type: text(row, 'data_type'),
      column_type: text(row, 'column_type'),
      nullable: text(row, 'is_nullable') === 'YES',
      default: row.column_default ?? null,
      primary_key: text(row, 'column_key') === 'PRI',
      comment: nullableText(row, 'column_comment'),
    });
    columnsByTable.set(key, columns);
  }

  const indexGroups = new Map<string, SchemaIndex>();
  for (const row of indexRows) {
    const database = text(row, 'table_schema');
    const table = text(row, 'table_name');
    const name = text(row, 'index_name');
    const key = `${tableKey(database, table)}\u0000${name}`;
    const index = indexGroups.get(key) ?? {
      name,
      unique: Number(row.non_unique) === 0,
      primary: name === 'PRIMARY',
      type: text(row, 'index_type'),
      columns: [],
    };
    const column = text(row, 'column_name');
    if (column) index.columns.push(column);
    indexGroups.set(key, index);
  }
  const indexesByTable = new Map<string, SchemaIndex[]>();
  for (const [key, index] of indexGroups) {
    const keyEnd = key.indexOf('\u0000');
    const owner = key.slice(0, keyEnd);
    const indexes = indexesByTable.get(owner) ?? [];
    indexes.push(index);
    indexesByTable.set(owner, indexes);
  }

  const tables = tableRows.map((row): SchemaTable => {
    const database = text(row, 'table_schema');
    const name = text(row, 'table_name');
    const key = tableKey(database, name);
    return {
      database,
      name,
      type: text(row, 'table_type').toUpperCase().includes('VIEW') ? 'view' : 'table',
      comment: nullableText(row, 'table_comment'),
      columns: (columnsByTable.get(key) ?? []).sort((left, right) => left.ordinal - right.ordinal),
      indexes: (indexesByTable.get(key) ?? []).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }).sort((left, right) => tableKey(left.database, left.name).localeCompare(tableKey(right.database, right.name)));

  const relationGroups = new Map<string, SchemaRelation>();
  for (const row of relationRows) {
    const database = text(row, 'constraint_schema');
    const name = text(row, 'constraint_name');
    const sourceTable = text(row, 'source_table');
    const key = `${database}\u0000${sourceTable}\u0000${name}`;
    const relation = relationGroups.get(key) ?? {
      name,
      source: 'foreign_key',
      source_database: text(row, 'source_schema'),
      source_table: sourceTable,
      source_columns: [],
      target_database: text(row, 'target_schema'),
      target_table: text(row, 'target_table'),
      target_columns: [],
      on_update: text(row, 'update_rule'),
      on_delete: text(row, 'delete_rule'),
    };
    relation.source_columns.push(text(row, 'source_column'));
    relation.target_columns.push(text(row, 'target_column'));
    relationGroups.set(key, relation);
  }
  const relations = [...relationGroups.values()].sort(compareRelations);
  return { tables, relations };
}

interface CacheEntry {
  snapshot: SchemaSnapshot;
  loadedAt: string;
  expiresAt: number;
}

interface InFlightSchemaLoad {
  controller: AbortController;
  promise: Promise<LoadedSchemaSnapshot>;
  activeWaiters: number;
  settled: boolean;
  bypassPersistent: boolean;
}

export class SchemaService {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightSchemaLoad>();
  private readonly loader: SchemaSnapshotLoader;

  constructor(
    private readonly store: StateStore,
    private readonly runtimes: ConnectionRuntimeRegistry,
    loader?: SchemaSnapshotLoader,
  ) {
    this.loader = loader ?? ((config, signal) => loadSchemaSnapshotFromMysql(config, this.runtimes, signal));
  }

  async search(request: {
    connection: string;
    keyword?: string;
    limit: number;
    refresh?: boolean;
    requestSignal?: AbortSignal;
    expectedConnection?: ConnectionIdentity;
  }): Promise<Record<string, unknown>> {
    const started = performance.now();
    const config = this.requireEnabledConnection(request.connection, request.expectedConnection);
    const loaded = request.refresh === true
      ? await this.refreshSnapshot(config, request.requestSignal)
      : await this.getSnapshot(config, request.requestSignal);
    const keyword = request.keyword?.trim().toLowerCase();
    const allMatches = loaded.snapshot.tables
      .map((table) => searchMatch(table, keyword))
      .filter((match): match is NonNullable<typeof match> => match !== null)
      .sort((left, right) => right.score - left.score || tableKey(left.database, left.name).localeCompare(tableKey(right.database, right.name)));
    const matches = allMatches
      .slice(0, request.limit)
      .map(({ score: _score, ...match }) => match);
    const result = this.resultBase('schema_search', config, loaded, started, {
      keyword: request.keyword?.trim() || null,
      tables: matches,
      table_count: matches.length,
      truncated: allMatches.length > request.limit,
    });
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SCHEMA_SEARCH_RESULT_BYTES) {
      throw new PluginError({
        category: 'result_limit', code: 'SCHEMA_SEARCH_RESULT_LIMIT',
        message: 'Schema 搜索结果超过大小上限，请减少 limit 或使用更精确的 keyword。',
      });
    }
    return result;
  }

  async describe(request: {
    connection: string;
    tables: string[];
    includeRelations: boolean;
    relationDepth: number;
    includeInferredRelations: boolean;
    refresh?: boolean;
    requestSignal?: AbortSignal;
    expectedConnection?: ConnectionIdentity;
  }): Promise<Record<string, unknown>> {
    const started = performance.now();
    const config = this.requireEnabledConnection(request.connection, request.expectedConnection);
    const requestedKeys = request.tables.map((identifier) => {
      const resolved = parseTableIdentifier(identifier, config);
      return tableKey(resolved.database, resolved.table);
    });
    let loaded = request.refresh === true
      ? await this.refreshSnapshot(config, request.requestSignal)
      : await this.getSnapshot(config, request.requestSignal);
    let byKey = new Map(loaded.snapshot.tables.map((table) => [tableKey(table.database, table.name), table]));
    let missing = requestedKeys.filter((key) => !byKey.has(key));
    if (missing.length > 0 && loaded.source !== 'mysql') {
      loaded = await this.refreshSnapshot(config, request.requestSignal);
      byKey = new Map(loaded.snapshot.tables.map((table) => [tableKey(table.database, table.name), table]));
      missing = requestedKeys.filter((key) => !byKey.has(key));
    }
    if (missing.length > 0) {
      throw new PluginError({
        category: 'argument_error',
        code: 'SCHEMA_TABLE_NOT_FOUND',
        message: `Schema 快照中找不到表 ${missing[0]}。请先用 schema_search 确认表名。`,
      });
    }
    const selected = new Set(requestedKeys);

    const relations = request.includeRelations
      ? [
          ...loaded.snapshot.relations,
          ...(request.includeInferredRelations ? inferRelations(loaded.snapshot) : []),
        ].sort(compareRelations)
      : [];
    const included = new Set(selected);
    let frontier = new Set(selected);
    let truncated = false;
    for (let depth = 0; depth < request.relationDepth; depth += 1) {
      const next = new Set<string>();
      for (const relation of relations) {
        const source = tableKey(relation.source_database, relation.source_table);
        const target = tableKey(relation.target_database, relation.target_table);
        if (!frontier.has(source) && !frontier.has(target)) continue;
        for (const key of [source, target]) {
          if (included.has(key) || !byKey.has(key)) continue;
          if (included.size >= MAX_SCHEMA_DESCRIBE_TABLES) {
            truncated = true;
            continue;
          }
          included.add(key);
          next.add(key);
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    const outputRelations = relations.filter((relation) =>
      included.has(tableKey(relation.source_database, relation.source_table)) &&
      included.has(tableKey(relation.target_database, relation.target_table)),
    );
    if (outputRelations.length > MAX_SCHEMA_RELATIONS) truncated = true;
    const outputTables = [...included]
      .sort()
      .map((key) => byKey.get(key))
      .filter((table): table is SchemaTable => table !== undefined);
    const result = this.resultBase('schema_describe', config, loaded, started, {
      requested_tables: [...selected].sort(),
      relation_depth: request.relationDepth,
      include_relations: request.includeRelations,
      include_inferred_relations: request.includeInferredRelations,
      tables: outputTables,
      relations: outputRelations.slice(0, MAX_SCHEMA_RELATIONS),
      truncated,
    });
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SCHEMA_DESCRIBE_RESULT_BYTES) {
      throw new PluginError({
        category: 'result_limit',
        code: 'SCHEMA_DESCRIBE_RESULT_LIMIT',
        message: 'Schema 描述结果超过大小上限，请减少 tables 或 relation_depth。',
      });
    }
    return result;
  }

  invalidate(alias: string, revision?: number): void {
    for (const key of this.memory.keys()) {
      if (key.startsWith(`${alias}\u0000`) && (revision === undefined || key.startsWith(`${alias}\u0000${revision}\u0000`))) {
        this.memory.delete(key);
      }
    }
    try {
      this.store.invalidateSchemaSnapshots(alias, revision);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'schema_snapshot_invalidation_failed', connection: alias,
        revision: revision ?? null, message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
    }
  }

  private async getSnapshot(config: ConnectionConfig, requestSignal?: AbortSignal): Promise<LoadedSchemaSnapshot> {
    throwIfCancelled(requestSignal, config.alias);
    const key = schemaCacheKey(config);
    const now = Date.now();
    const memory = this.memory.get(key);
    if (memory && memory.expiresAt > now) {
      return { snapshot: memory.snapshot, source: 'memory', loadedAt: memory.loadedAt };
    }
    this.memory.delete(key);

    const current = this.inFlight.get(key);
    const load = current ?? this.startLoad(key, config, false);
    return this.waitForLoad(key, load, requestSignal, config.alias);
  }

  private async refreshSnapshot(config: ConnectionConfig, requestSignal?: AbortSignal): Promise<LoadedSchemaSnapshot> {
    throwIfCancelled(requestSignal, config.alias);
    const key = schemaCacheKey(config);
    while (true) {
      const current = this.inFlight.get(key);
      if (!current) break;
      if (current.bypassPersistent) return this.waitForLoad(key, current, requestSignal, config.alias);
      await this.waitForLoad(key, current, requestSignal, config.alias);
      throwIfCancelled(requestSignal, config.alias);
    }
    this.invalidate(config.alias, config.revision);
    const load = this.startLoad(key, config, true);
    return this.waitForLoad(key, load, requestSignal, config.alias);
  }

  private startLoad(key: string, config: ConnectionConfig, bypassPersistent: boolean): InFlightSchemaLoad {
    const controller = new AbortController();
    let entry: InFlightSchemaLoad;
    const promise = this.loadSnapshot(key, config, bypassPersistent, controller.signal).finally(() => {
      entry.settled = true;
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    });
    entry = { controller, promise, activeWaiters: 0, settled: false, bypassPersistent };
    this.inFlight.set(key, entry);
    return entry;
  }

  private waitForLoad(
    key: string,
    entry: InFlightSchemaLoad,
    signal: AbortSignal | undefined,
    alias: string,
  ): Promise<LoadedSchemaSnapshot> {
    throwIfCancelled(signal, alias);
    entry.activeWaiters += 1;
    return new Promise<LoadedSchemaSnapshot>((resolve, reject) => {
      let waiting = true;
      const finish = () => {
        if (!waiting) return;
        waiting = false;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (entry.activeWaiters > 0) entry.activeWaiters -= 1;
        if (entry.activeWaiters === 0 && !entry.settled) {
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          entry.controller.abort();
        }
      };
      const onAbort = () => {
        finish();
        reject(cancellationError(alias));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  }

  private async loadSnapshot(
    key: string,
    config: ConnectionConfig,
    bypassPersistent: boolean,
    loadSignal: AbortSignal,
  ): Promise<LoadedSchemaSnapshot> {
    const persisted = bypassPersistent ? null : this.store.readSchemaSnapshot(key);
    const persistedLoadedAt = persisted ? Date.parse(persisted.loadedAt) : Number.NaN;
    const persistedAge = Date.now() - persistedLoadedAt;
    const persistedScopeValid = persisted !== null &&
      persisted.connectionAlias === config.alias && persisted.connectionRevision === config.revision &&
      persisted.defaultDatabase === config.database &&
      Array.isArray(persisted.allowedDatabases) && persisted.allowedDatabases.every((database) => typeof database === 'string') &&
      JSON.stringify([...persisted.allowedDatabases].sort()) === JSON.stringify([...config.allowedDatabases].sort());
    if (persisted && persistedScopeValid && persisted.formatVersion === SCHEMA_SNAPSHOT_FORMAT_VERSION &&
        Number.isFinite(persistedAge) && persistedAge >= 0 && persistedAge <= SCHEMA_L2_TTL_MS) {
      try {
        const snapshot = validateAndBoundSnapshot(persisted.snapshot);
        this.memory.set(key, { snapshot, loadedAt: persisted.loadedAt, expiresAt: Date.now() + SCHEMA_L1_TTL_MS });
        return { snapshot, source: 'sqlite', loadedAt: persisted.loadedAt };
      } catch {
        this.deletePersistedBestEffort(key);
      }
    } else if (persisted) {
      this.deletePersistedBestEffort(key);
    }
    let snapshot: SchemaSnapshot;
    try {
      snapshot = validateAndBoundSnapshot(await this.loader(config, loadSignal));
    } catch (error) {
      if (error instanceof DatabaseAttemptError) {
        const attempts = Number((error as DatabaseAttemptError & { attemptCount?: number }).attemptCount ?? 1);
        throw mapMysqlError(error.original, config.alias, 'not_applicable', attempts);
      }
      throw error;
    }
    throwIfCancelled(loadSignal, config.alias);
    const loadedAt = new Date().toISOString();
    const snapshotWritten = this.store.writeSchemaSnapshot({
      formatVersion: SCHEMA_SNAPSHOT_FORMAT_VERSION,
      cacheKey: key,
      connectionAlias: config.alias,
      connectionRevision: config.revision,
      defaultDatabase: config.database,
      allowedDatabases: [...config.allowedDatabases].sort(),
      snapshot,
      loadedAt,
    });
    if (!snapshotWritten) {
      throw new PluginError({
        category: 'config_error',
        code: 'CONNECTION_REVISION_CHANGED',
        message: `数据源 ${config.alias} 的配置在 Schema 加载期间发生变化，请重试。`,
        retryable: true,
        retryAfterMs: 100,
      });
    }
    this.memory.set(key, { snapshot, loadedAt, expiresAt: Date.now() + SCHEMA_L1_TTL_MS });
    return { snapshot, source: 'mysql', loadedAt };
  }

  private deletePersistedBestEffort(key: string): void {
    try {
      this.store.deleteSchemaSnapshot(key);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'invalid_schema_snapshot_delete_failed',
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
    }
  }

  private requireEnabledConnection(alias: string, expected?: ConnectionIdentity): ConnectionConfig {
    if (expected && expected.alias !== alias) {
      throw new PluginError({
        category: 'permission_error', code: 'AUTH_TARGET_CHANGED',
        message: 'Schema 请求连接与已验证的 workspace 目标不一致。', retryable: true,
      });
    }
    const config = expected ? this.store.assertConnectionIdentity(expected) : this.store.requireConnection(alias);
    if (!config.enabled) {
      throw new PluginError({
        category: 'config_error',
        code: 'CONNECTION_DISABLED',
        message: `数据源 ${alias} 已停用。`,
      });
    }
    return config;
  }

  private resultBase(
    kind: string,
    config: ConnectionConfig,
    loaded: LoadedSchemaSnapshot,
    started: number,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      schema_version: 'mysql-agent/result/1',
      execution_id: randomUUID(),
      status: 'ok',
      kind,
      connection: config.alias,
      connection_revision: config.revision,
      database: config.database,
      allowed_databases: [...config.allowedDatabases].sort(),
      cache: { source: loaded.source, loaded_at: loaded.loadedAt },
      duration_ms: Math.round(performance.now() - started),
      ...data,
    };
  }
}

function cancellationError(alias: string): PluginError {
  return new PluginError({
    category: 'timeout',
    code: 'REQUEST_CANCELLED',
    message: `数据源 ${alias} 的调用已取消。`,
    retryable: false,
  });
}

function throwIfCancelled(signal: AbortSignal | undefined, alias: string): void {
  if (signal?.aborted) throw cancellationError(alias);
}

function schemaCacheKey(config: ConnectionConfig): string {
  return `${config.alias}\u0000${config.revision}\u0000${config.database}\u0000${JSON.stringify([...config.allowedDatabases].sort())}`;
}

function parseTableIdentifier(identifier: string, config: ConnectionConfig): { database: string; table: string } {
  const parts = identifier.split('.');
  const database = parts.length === 1 ? config.database : parts[0]!;
  const table = parts.length === 1 ? parts[0]! : parts[1]!;
  if (parts.length > 2 || !database || !table || !/^[A-Za-z0-9_$-]{1,64}$/.test(database) || !/^[A-Za-z0-9_$-]{1,64}$/.test(table)) {
    throw new PluginError({
      category: 'argument_error',
      code: 'INVALID_SCHEMA_TABLE_IDENTIFIER',
      message: `表标识 ${identifier} 无效；请使用 table 或 allowed_database.table。`,
    });
  }
  if (!config.allowedDatabases.includes(database)) {
    throw new PluginError({
      category: 'permission_error',
      code: 'DATABASE_NOT_ALLOWED',
      message: `数据库 ${database} 不在数据源 ${config.alias} 的 allowed_databases 中。`,
    });
  }
  return { database, table };
}

function scoreText(value: string | null, keyword: string, weights: [number, number, number]): number {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized === keyword) return weights[0];
  if (normalized.startsWith(keyword)) return weights[1];
  if (normalized.includes(keyword)) return weights[2];
  return 0;
}

function searchMatch(table: SchemaTable, keyword?: string): (Record<string, unknown> & { score: number; database: string; name: string }) | null {
  if (!keyword) {
    return { score: 0, database: table.database, name: table.name, type: table.type, comment: table.comment, matched_columns: [] };
  }
  let score = scoreText(table.name, keyword, [1_000, 800, 600]) + scoreText(table.comment, keyword, [350, 300, 250]);
  const matchedColumns = table.columns
    .map((column) => ({
      column,
      score: scoreText(column.name, keyword, [550, 450, 350]) + scoreText(column.comment, keyword, [250, 200, 150]),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.column.ordinal - right.column.ordinal);
  score += matchedColumns.reduce((total, match) => total + match.score, 0);
  if (score === 0) return null;
  return {
    score,
    database: table.database,
    name: table.name,
    type: table.type,
    comment: table.comment,
    matched_columns: matchedColumns.slice(0, MAX_SCHEMA_MATCHED_COLUMNS).map(({ column }) => ({
      name: column.name,
      data_type: column.data_type,
      comment: column.comment,
    })),
  };
}

function compareRelations(left: SchemaRelation, right: SchemaRelation): number {
  return [left.source_database, left.source_table, left.name, left.target_database, left.target_table]
    .join('\u0000')
    .localeCompare([right.source_database, right.source_table, right.name, right.target_database, right.target_table].join('\u0000'));
}

function inferRelations(snapshot: SchemaSnapshot): SchemaRelation[] {
  const tablesByDatabase = new Map<string, SchemaTable[]>();
  for (const table of snapshot.tables) {
    const tables = tablesByDatabase.get(table.database) ?? [];
    tables.push(table);
    tablesByDatabase.set(table.database, tables);
  }
  const declaredColumns = new Set(
    snapshot.relations.flatMap((relation) =>
      relation.source_columns.map((column) => `${relation.source_database}.${relation.source_table}.${column}`),
    ),
  );
  const inferred: SchemaRelation[] = [];
  for (const source of snapshot.tables) {
    for (const column of source.columns) {
      if (!column.name.endsWith('_id') || column.name === 'id') continue;
      if (declaredColumns.has(`${source.database}.${source.name}.${column.name}`)) continue;
      const stem = column.name.slice(0, -3);
      const candidates = (tablesByDatabase.get(source.database) ?? []).filter((candidate) =>
        candidate.name === stem || candidate.name === `${stem}s`,
      ).filter((candidate) => {
        const id = candidate.columns.find((candidateColumn) => candidateColumn.name === 'id');
        const uniquelyIdentifiesRow = candidate.indexes.some(
          (index) => (index.primary || index.unique) && index.columns.length === 1 && index.columns[0] === 'id',
        );
        return id !== undefined && uniquelyIdentifiesRow && compatibleTypes(column, id);
      });
      if (candidates.length !== 1) continue;
      const target = candidates[0]!;
      const exact = target.name === stem;
      inferred.push({
        name: `inferred_${source.name}_${column.name}_${target.name}_id`,
        source: 'inferred',
        source_database: source.database,
        source_table: source.name,
        source_columns: [column.name],
        target_database: target.database,
        target_table: target.name,
        target_columns: ['id'],
        confidence: exact ? 0.9 : 0.8,
        reason: `${column.name} matches ${target.name}.id by conservative name and type compatibility; this is not a declared foreign key.`,
      });
    }
  }
  return inferred.sort(compareRelations);
}

function compatibleTypes(left: SchemaColumn, right: SchemaColumn): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(left.column_type) === normalize(right.column_type);
}

function validateAndBoundSnapshot(value: unknown): SchemaSnapshot {
  const parsed = schemaSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new PluginError({
      category: 'internal_error',
      code: 'INVALID_SCHEMA_SNAPSHOT',
      message: 'Schema 元数据结构无效，未写入缓存。',
      cause: parsed.error,
    });
  }
  const snapshot = parsed.data as SchemaSnapshot;
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SCHEMA_SNAPSHOT_BYTES) {
    throw new PluginError({
      category: 'result_limit',
      code: 'SCHEMA_SNAPSHOT_BYTE_LIMIT',
      message: '规范化 Schema 快照超过大小上限，请缩小 allowed_databases 范围。',
    });
  }
  return snapshot;
}
