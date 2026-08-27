import { Buffer } from 'node:buffer';
import type { FieldPacket, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { MAX_AFFECTED_ROWS, MAX_RESULT_BYTES, MAX_SCHEMA_SNAPSHOT_BYTES } from '../constants.js';
import { PluginError } from '../errors.js';
import type { StatementKind, WriteOutcome } from '../types.js';
import { ConnectionRuntime, DatabaseAttemptError } from './runtime.js';

export interface QueryExecutionResult {
  columns: Array<{ name: string; database_type: string; binary?: boolean }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface WriteExecutionResult {
  affectedRows: number;
  changedRows: number;
  lastInsertId: string | null;
  warningCount: number;
  writeOutcome: WriteOutcome;
}

export interface MetadataByteBudget {
  remainingBytes: number;
}

export function createMetadataByteBudget(maxBytes = MAX_SCHEMA_SNAPSHOT_BYTES): MetadataByteBudget {
  return { remainingBytes: maxBytes };
}

function normalizeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeRows(rows: RowDataPacket[], maxRows: number): { rows: Array<Record<string, unknown>>; truncated: boolean } {
  const output: Array<Record<string, unknown>> = [];
  let bytes = 2;
  let truncated = false;
  for (const row of rows) {
    if (output.length >= maxRows) {
      truncated = true;
      break;
    }
    const normalized = Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, normalizeValue(value)]),
    );
    const rowBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1;
    if (bytes + rowBytes > MAX_RESULT_BYTES) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    output.push(normalized);
  }
  return { rows: output, truncated };
}

function destroyOnAbort(connection: PoolConnection, signal: AbortSignal): () => void {
  const onAbort = () => connection.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export async function executeQueryAttempt(
  runtime: ConnectionRuntime,
  sql: string,
  values: Array<string | number | boolean | null>,
  kind: StatementKind,
  maxRows: number,
  signal: AbortSignal,
): Promise<QueryExecutionResult> {
  let connection: PoolConnection;
  try {
    connection = await runtime.pool.getConnection();
  } catch (error) {
    throw new DatabaseAttemptError(error, false);
  }

  let destroyed = false;
  const cleanupAbort = destroyOnAbort(connection, signal);
  const markDestroyed = () => {
    destroyed = true;
    connection.destroy();
  };
  if (signal.aborted) markDestroyed();

  try {
    const [rawRows, fields] =
      kind === 'show' || kind === 'describe' || kind === 'explain'
        ? await connection.query<RowDataPacket[]>(sql, values)
        : await connection.execute<RowDataPacket[]>(sql, values);
    const normalized = normalizeRows(rawRows, maxRows);
    return {
      columns: (fields as FieldPacket[]).map((field) => ({
        name: field.name,
        database_type: field.typeName ?? String(field.columnType ?? field.type ?? 'unknown'),
        ...(typeof field.flags === 'number' && (field.flags & 128) !== 0 ? { binary: true } : {}),
      })),
      rows: normalized.rows,
      rowCount: normalized.rows.length,
      truncated: normalized.truncated,
    };
  } catch (error) {
    if (signal.aborted) destroyed = true;
    if (destroyed) connection.destroy();
    throw new DatabaseAttemptError(error, true);
  } finally {
    cleanupAbort();
    if (!destroyed && !signal.aborted) connection.release();
  }
}

/** Executes plugin-owned information_schema SQL without passing it through Agent SQL validation. */
export async function executeMetadataQueryAttempt(
  runtime: ConnectionRuntime,
  sql: string,
  values: string[],
  maxRows: number,
  signal: AbortSignal,
  byteBudget = createMetadataByteBudget(),
): Promise<Array<Record<string, unknown>>> {
  let connection: PoolConnection;
  try {
    connection = await runtime.pool.getConnection();
  } catch (error) {
    throw new DatabaseAttemptError(error, false);
  }

  let destroyed = false;
  const cleanupAbort = destroyOnAbort(connection, signal);
  const destroy = () => {
    destroyed = true;
    connection.destroy();
  };
  if (signal.aborted) destroy();

  try {
    const [rawRows] = await connection.execute<RowDataPacket[]>(sql, values);
    if (rawRows.length > maxRows) {
      throw new PluginError({
        category: 'result_limit',
        code: 'SCHEMA_METADATA_ROW_LIMIT',
        message: `Schema 元数据超过内部行数上限 ${maxRows}，请缩小 allowed_databases 范围。`,
      });
    }
    return rawRows.map((row) => {
      const normalized = Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, normalizeValue(value)]),
      );
      byteBudget.remainingBytes -= Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1;
      if (byteBudget.remainingBytes < 0) {
        throw new PluginError({
          category: 'result_limit',
          code: 'SCHEMA_METADATA_BYTE_LIMIT',
          message: 'Schema 元数据超过内部大小上限，请缩小 allowed_databases 范围。',
        });
      }
      return normalized;
    });
  } catch (error) {
    if (signal.aborted) destroyed = true;
    if (destroyed) connection.destroy();
    if (error instanceof PluginError) throw error;
    throw new DatabaseAttemptError(error, true);
  } finally {
    cleanupAbort();
    if (!destroyed && !signal.aborted) connection.release();
  }
}

export async function executeWriteAttempt(
  runtime: ConnectionRuntime,
  sql: string,
  values: Array<string | number | boolean | null>,
  kind: 'insert' | 'update' | 'delete',
  maxAffectedRows: number,
  signal: AbortSignal,
  onSent?: () => void,
): Promise<WriteExecutionResult> {
  let connection: PoolConnection;
  try {
    connection = await runtime.pool.getConnection();
  } catch (error) {
    throw new DatabaseAttemptError(error, false);
  }

  let destroyed = false;
  let sent = false;
  const cleanupAbort = destroyOnAbort(connection, signal);
  const destroy = () => {
    destroyed = true;
    connection.destroy();
  };

  try {
    await connection.ping();
    await connection.beginTransaction();
    sent = true;
    onSent?.();
    const [result] = await connection.execute<ResultSetHeader>(sql, values);
    if ((kind === 'update' || kind === 'delete') && result.affectedRows > maxAffectedRows) {
      await connection.rollback();
      throw new PluginError({
        category: 'result_limit',
        code: 'AFFECTED_ROWS_EXCEEDED',
        message: `本次 ${kind.toUpperCase()} 预计影响 ${result.affectedRows} 行，超过上限 ${maxAffectedRows}，事务已回滚。`,
        writeOutcome: 'known_failed',
      });
    }
    await connection.commit();
    return {
      affectedRows: result.affectedRows,
      changedRows: result.changedRows,
      lastInsertId: result.insertId ? String(result.insertId) : null,
      warningCount: result.warningStatus,
      writeOutcome: 'committed',
    };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    if (!signal.aborted) {
      try {
        await connection.rollback();
      } catch {
        destroy();
      }
    } else {
      destroy();
    }
    throw new DatabaseAttemptError(error, sent);
  } finally {
    cleanupAbort();
    if (!destroyed && !signal.aborted) connection.release();
  }
}

export function boundedAffectedRows(requested?: number): number {
  if (requested === undefined) return MAX_AFFECTED_ROWS;
  return Math.min(requested, MAX_AFFECTED_ROWS);
}
