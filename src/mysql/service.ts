import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { DEFAULT_MAX_ROWS, MAX_MAX_ROWS, MAX_RESULT_BYTES } from '../constants.js';
import { StateStore } from '../config/store.js';
import { PluginError, mapMysqlError, unknownError } from '../errors.js';
import { compileNamedParameters } from '../sql/parameters.js';
import { validateQuerySql, validateWriteSql } from '../sql/validator.js';
import type { BusinessMode, ConnectionConfig, SqlParameters, WriteOutcome } from '../types.js';
import { boundedAffectedRows, executeQueryAttempt, executeWriteAttempt } from './executor.js';
import { ConnectionRuntimeRegistry, DatabaseAttemptError } from './runtime.js';
import { SchemaService, type SchemaSnapshotLoader } from './schema.js';

export interface QueryRequest {
  connection: string;
  sql: string;
  parameters?: SqlParameters;
  maxRows?: number;
  timeoutMs?: number;
  businessOperationId?: string;
  businessPackId?: string;
  businessPackVersion?: string;
  businessOperationHash?: string;
  retrySafeAfterSend?: boolean;
  requestSignal?: AbortSignal;
  clientName?: string;
}

export interface WriteRequest extends Omit<QueryRequest, 'maxRows' | 'retrySafeAfterSend'> {
  maxAffectedRows?: number;
  expectedMode?: Exclude<BusinessMode, 'read'>;
}

interface QueryResultEnvelope extends Record<string, unknown> {
  columns: Array<{ name: string; database_type: string; binary?: boolean }>;
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Bounds the complete Agent-facing query result, including columns and the service envelope. */
export function boundQueryResult(result: QueryResultEnvelope): QueryResultEnvelope {
  if (serializedBytes(result) <= MAX_RESULT_BYTES) return result;

  const fixed: QueryResultEnvelope = { ...result, rows: [], row_count: 0, truncated: true };
  if (serializedBytes(fixed) > MAX_RESULT_BYTES) {
    throw new PluginError({
      category: 'result_limit',
      code: 'QUERY_RESULT_METADATA_LIMIT',
      message: '查询结果的固定元数据超过大小上限，请减少或缩短返回列。',
    });
  }

  let low = 0;
  let high = result.rows.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidate: QueryResultEnvelope = {
      ...result,
      rows: result.rows.slice(0, count),
      row_count: count,
      truncated: true,
    };
    if (serializedBytes(candidate) <= MAX_RESULT_BYTES) low = count;
    else high = count - 1;
  }
  return { ...result, rows: result.rows.slice(0, low), row_count: low, truncated: true };
}

export class MysqlService {
  readonly store: StateStore;
  readonly runtimes: ConnectionRuntimeRegistry;
  readonly schema: SchemaService;

  constructor(store: StateStore, runtimes = new ConnectionRuntimeRegistry(), schemaLoader?: SchemaSnapshotLoader) {
    this.store = store;
    this.runtimes = runtimes;
    this.schema = new SchemaService(store, runtimes, schemaLoader);
  }

  async query(request: QueryRequest): Promise<Record<string, unknown>> {
    const executionId = randomUUID();
    const started = performance.now();
    let config: ConnectionConfig | undefined;
    let kind = 'query';
    let attemptCount = 1;
    const compiled = compileNamedParameters(request.sql, request.parameters);
    const sqlHash = this.hashSql(compiled.sql);
    try {
      config = this.requireEnabledConnection(request.connection);
      const maxRows = request.maxRows ?? DEFAULT_MAX_ROWS;
      if (maxRows < 1 || maxRows > MAX_MAX_ROWS) {
        throw new PluginError({
          category: 'argument_error',
          code: 'INVALID_MAX_ROWS',
          message: `max_rows 必须在 1 到 ${MAX_MAX_ROWS} 之间。`,
        });
      }
      const validation = validateQuerySql(compiled.sql, config.allowedDatabases, maxRows);
      kind = validation.kind;
      const timeoutMs = this.effectiveTimeout(config, request.timeoutMs);
      const run = await this.runtimes.withRuntime(config, (runtime) =>
        runtime.run(
          {
            timeoutMs,
            requestSignal: request.requestSignal,
            retrySafeAfterSend: request.retrySafeAfterSend ?? false,
          },
          (signal) => executeQueryAttempt(runtime, compiled.sql, compiled.values, validation.kind, maxRows, signal),
        ),
      );
      attemptCount = run.attemptCount;
      const durationMs = Math.round(performance.now() - started);
      const result = boundQueryResult({
        schema_version: 'mysql-agent/result/1',
        execution_id: executionId,
        status: 'ok',
        kind: 'query',
        connection: config.alias,
        database: config.database,
        business_operation_id: request.businessOperationId ?? null,
        business_pack_id: request.businessPackId ?? null,
        business_pack_version: request.businessPackVersion ?? null,
        business_operation_hash: request.businessOperationHash ?? null,
        columns: run.value.columns,
        rows: run.value.rows,
        row_count: run.value.rowCount,
        truncated: run.value.truncated,
        duration_ms: durationMs,
        attempt_count: attemptCount,
      });
      this.audit({
        executionId,
        clientName: request.clientName,
        config,
        businessOperationId: request.businessOperationId,
        businessPackId: request.businessPackId,
        businessPackVersion: request.businessPackVersion,
        businessOperationHash: request.businessOperationHash,
        statementKind: validation.kind,
        sqlHash,
        durationMs,
        rowCount: result.row_count,
        affectedRows: null,
        attemptCount,
        writeOutcome: 'not_applicable',
        status: 'ok',
      });
      return result;
    } catch (error) {
      if (config && isSchemaDriftError(error)) this.schema.invalidate(config.alias, config.revision);
      const pluginError = this.mapExecutionError(error, request.connection, false, attemptCount);
      const durationMs = Math.round(performance.now() - started);
      this.auditError(executionId, request, config, kind, sqlHash, durationMs, pluginError);
      throw Object.assign(pluginError, { executionId });
    }
  }

  async execute(request: WriteRequest): Promise<Record<string, unknown>> {
    const executionId = randomUUID();
    const started = performance.now();
    let config: ConnectionConfig | undefined;
    let kind: 'insert' | 'update' | 'delete' | 'write' = 'write';
    let attemptCount = 1;
    let writeSent = false;
    const compiled = compileNamedParameters(request.sql, request.parameters);
    const sqlHash = this.hashSql(compiled.sql);
    try {
      config = this.requireEnabledConnection(request.connection);
      if (config.accessMode !== 'read_write') {
        throw new PluginError({
          category: 'permission_error',
          code: 'READ_ONLY_CONNECTION',
          message: `数据源 ${config.alias} 只允许读取。`,
          writeOutcome: 'not_sent',
        });
      }
      const validation = validateWriteSql(compiled.sql, config.allowedDatabases);
      kind = validation.kind as 'insert' | 'update' | 'delete';
      if (request.expectedMode && request.expectedMode !== kind) {
        throw new PluginError({
          category: 'argument_error',
          code: 'BUSINESS_MODE_MISMATCH',
          message: `业务操作声明为 ${request.expectedMode}，实际 SQL 是 ${kind}。`,
          writeOutcome: 'not_sent',
        });
      }
      const timeoutMs = this.effectiveTimeout(config, request.timeoutMs);
      const run = await this.runtimes.withRuntime(config, (runtime) =>
        runtime.run(
          {
            timeoutMs,
            requestSignal: request.requestSignal,
            retrySafeAfterSend: false,
          },
          (signal) =>
            executeWriteAttempt(
              runtime,
              compiled.sql,
              compiled.values,
              kind as 'insert' | 'update' | 'delete',
              boundedAffectedRows(request.maxAffectedRows),
              signal,
              () => {
                writeSent = true;
              },
            ),
        ),
      );
      attemptCount = run.attemptCount;
      const durationMs = Math.round(performance.now() - started);
      const result = {
        schema_version: 'mysql-agent/result/1',
        execution_id: executionId,
        status: 'ok',
        kind: 'execute',
        operation: kind,
        connection: config.alias,
        database: config.database,
        business_operation_id: request.businessOperationId ?? null,
        business_pack_id: request.businessPackId ?? null,
        business_pack_version: request.businessPackVersion ?? null,
        business_operation_hash: request.businessOperationHash ?? null,
        affected_rows: run.value.affectedRows,
        changed_rows: run.value.changedRows,
        last_insert_id: run.value.lastInsertId,
        warning_count: run.value.warningCount,
        write_outcome: run.value.writeOutcome,
        duration_ms: durationMs,
        attempt_count: attemptCount,
      };
      this.audit({
        executionId,
        clientName: request.clientName,
        config,
        businessOperationId: request.businessOperationId,
        businessPackId: request.businessPackId,
        businessPackVersion: request.businessPackVersion,
        businessOperationHash: request.businessOperationHash,
        statementKind: kind,
        sqlHash,
        durationMs,
        rowCount: null,
        affectedRows: run.value.affectedRows,
        attemptCount,
        writeOutcome: run.value.writeOutcome,
        status: 'ok',
      });
      return result;
    } catch (error) {
      if (config && isSchemaDriftError(error)) this.schema.invalidate(config.alias, config.revision);
      const pluginError = this.mapExecutionError(error, request.connection, true, attemptCount, writeSent);
      const durationMs = Math.round(performance.now() - started);
      this.auditError(executionId, request, config, kind, sqlHash, durationMs, pluginError);
      throw Object.assign(pluginError, { executionId });
    }
  }

  async close(): Promise<void> {
    await this.runtimes.closeAll();
    this.store.close();
  }

  private requireEnabledConnection(alias: string): ConnectionConfig {
    const config = this.store.requireConnection(alias);
    if (!config.enabled) {
      throw new PluginError({
        category: 'config_error',
        code: 'CONNECTION_DISABLED',
        message: `数据源 ${alias} 已停用。`,
      });
    }
    return config;
  }

  private effectiveTimeout(config: ConnectionConfig, requested?: number): number {
    if (requested === undefined) return config.queryTimeoutMs;
    if (requested < 100 || requested > config.queryTimeoutMs) {
      throw new PluginError({
        category: 'argument_error',
        code: 'INVALID_TIMEOUT',
        message: `timeout_ms 必须在 100 到 ${config.queryTimeoutMs} 之间。`,
      });
    }
    return requested;
  }

  private mapExecutionError(
    error: unknown,
    connection: string,
    write: boolean,
    attempts: number,
    writeSent = false,
  ): PluginError {
    if (error instanceof PluginError) return write ? normalizeWritePluginError(error, connection, writeSent) : error;
    if (error instanceof DatabaseAttemptError) {
      const attemptCount = Number((error as DatabaseAttemptError & { attemptCount?: number }).attemptCount ?? attempts);
      const writeOutcome: WriteOutcome = write
        ? error.sent
          ? error.transient
            ? 'unknown'
            : 'known_failed'
          : 'not_sent'
        : 'not_applicable';
      return mapMysqlError(error.original, connection, writeOutcome, attemptCount);
    }
    return unknownError(error);
  }

  private hashSql(sql: string): string {
    return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');
  }

  private audit(input: {
    executionId: string;
    clientName?: string;
    config: ConnectionConfig;
    businessOperationId?: string;
    businessPackId?: string;
    businessPackVersion?: string;
    businessOperationHash?: string;
    statementKind: string;
    sqlHash: string;
    durationMs: number;
    rowCount: number | null;
    affectedRows: number | null;
    attemptCount: number;
    writeOutcome: WriteOutcome;
    status: 'ok' | 'error';
    errorCategory?: string;
    mysqlErrorCode?: number | null;
  }): void {
    try {
      this.store.recordAudit({
        executionId: input.executionId,
        occurredAt: new Date().toISOString(),
        clientName: input.clientName ?? 'unknown',
        connectionAlias: input.config.alias,
        businessOperationId: input.businessOperationId ?? null,
        businessPackId: input.businessPackId ?? null,
        businessPackVersion: input.businessPackVersion ?? null,
        businessOperationHash: input.businessOperationHash ?? null,
        statementKind: input.statementKind,
        sqlHash: input.sqlHash,
        durationMs: input.durationMs,
        rowCount: input.rowCount,
        affectedRows: input.affectedRows,
        attemptCount: input.attemptCount,
        writeOutcome: input.writeOutcome,
        status: input.status,
        errorCategory: input.errorCategory ?? null,
        mysqlErrorCode: input.mysqlErrorCode ?? null,
      });
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'audit_write_failed', execution_id: input.executionId, message: error instanceof Error ? error.message : 'unknown' })}\n`,
      );
    }
  }

  private auditError(
    executionId: string,
    request: QueryRequest | WriteRequest,
    config: ConnectionConfig | undefined,
    statementKind: string,
    sqlHash: string,
    durationMs: number,
    error: PluginError,
  ): void {
    if (!config) return;
    this.audit({
      executionId,
      clientName: request.clientName,
      config,
      businessOperationId: request.businessOperationId,
      businessPackId: request.businessPackId,
      businessPackVersion: request.businessPackVersion,
      businessOperationHash: request.businessOperationHash,
      statementKind,
      sqlHash,
      durationMs,
      rowCount: null,
      affectedRows: null,
      attemptCount: error.attemptCount,
      writeOutcome: error.writeOutcome,
      status: 'error',
      errorCategory: error.category,
      mysqlErrorCode: error.mysqlCode,
    });
  }
}

function isSchemaDriftError(error: unknown): boolean {
  const original = error instanceof DatabaseAttemptError ? error.original : error;
  if (!original || typeof original !== 'object') return false;
  const mysql = original as { code?: unknown; errno?: unknown };
  return mysql.code === 'ER_BAD_FIELD_ERROR' || mysql.code === 'ER_NO_SUCH_TABLE' || mysql.errno === 1054 || mysql.errno === 1146;
}

export function normalizeWritePluginError(error: PluginError, connection: string, sent: boolean): PluginError {
  if (error.writeOutcome !== 'not_applicable') return error;
  if (sent && (error.category === 'timeout' || error.code === 'REQUEST_CANCELLED')) {
    return new PluginError({
      category: 'write_outcome_unknown',
      code: 'MYSQL_WRITE_OUTCOME_UNKNOWN',
      message: `数据源 ${connection} 在写入结果确认前中断，无法判断变更是否生效。`,
      retryable: false,
      writeOutcome: 'unknown',
      attemptCount: error.attemptCount,
      cause: error,
    });
  }
  return new PluginError({
    category: error.category,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs ?? undefined,
    writeOutcome: sent ? 'unknown' : 'not_sent',
    mysqlCode: error.mysqlCode ?? undefined,
    sqlState: error.sqlState ?? undefined,
    attemptCount: error.attemptCount,
    cause: error,
  });
}
