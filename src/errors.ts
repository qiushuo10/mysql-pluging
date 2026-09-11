import type { WriteOutcome } from './types.js';

export type ErrorCategory =
  | 'argument_error'
  | 'config_error'
  | 'connection_error'
  | 'authentication_error'
  | 'timeout'
  | 'sql_error'
  | 'permission_error'
  | 'result_limit'
  | 'write_outcome_unknown'
  | 'internal_error';

export interface PluginErrorOptions {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  writeOutcome?: WriteOutcome;
  mysqlCode?: number;
  mysqlErrorName?: string;
  mysqlMessage?: string;
  sqlState?: string;
  attemptCount?: number;
  cause?: unknown;
}

export class PluginError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly writeOutcome: WriteOutcome;
  readonly mysqlCode: number | null;
  readonly mysqlErrorName: string | null;
  readonly mysqlMessage: string | null;
  readonly sqlState: string | null;
  readonly attemptCount: number;

  constructor(options: PluginErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'PluginError';
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.writeOutcome = options.writeOutcome ?? 'not_applicable';
    this.mysqlCode = options.mysqlCode ?? null;
    this.mysqlErrorName = options.mysqlErrorName ?? null;
    this.mysqlMessage = options.mysqlMessage ?? null;
    this.sqlState = options.sqlState ?? null;
    this.attemptCount = options.attemptCount ?? 1;
  }
}

export interface MysqlLikeError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
  sqlState?: string;
  fatal?: boolean;
}

const MYSQL_MESSAGE_MAX_CHARS = 1_000;

function normalizedParameterValues(values: readonly unknown[]): Set<string> {
  const output = new Set<string>();
  for (const value of values) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    output.add(String(value));
  }
  return output;
}

/** Returns a bounded, single-line MySQL diagnostic without echoing bound values. */
export function sanitizeMysqlMessage(message: string, boundValues: readonly unknown[] = []): string {
  const parameterValues = normalizedParameterValues(boundValues);
  const redacted = message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/Duplicate entry '.*?' for key/gi, "Duplicate entry '[REDACTED]' for key")
    .replace(/'((?:''|\\.|[^'])*)'/g, (quoted, value: string) =>
      parameterValues.has(value) ? "'[REDACTED]'" : quoted,
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= MYSQL_MESSAGE_MAX_CHARS) return redacted;
  return `${redacted.slice(0, MYSQL_MESSAGE_MAX_CHARS - 1)}…`;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

const CONNECTION_NUMBERS = new Set([2002, 2003, 2005, 2006, 2013]);

export function asMysqlError(error: unknown): MysqlLikeError | null {
  if (!(error instanceof Error)) return null;
  return error as MysqlLikeError;
}

export function isTransientMysqlError(error: unknown): boolean {
  const mysqlError = asMysqlError(error);
  if (!mysqlError) return false;
  return Boolean(
    (mysqlError.code && TRANSIENT_CODES.has(mysqlError.code)) ||
      (mysqlError.errno && CONNECTION_NUMBERS.has(mysqlError.errno)),
  );
}

export function mapMysqlError(
  error: unknown,
  connection: string,
  writeOutcome: WriteOutcome,
  attemptCount: number,
  boundValues: readonly unknown[] = [],
): PluginError {
  if (error instanceof PluginError) return error;

  const mysqlError = asMysqlError(error);
  const mysqlCode = mysqlError?.errno;
  const mysqlErrorName = mysqlError?.code;
  const sqlState = mysqlError?.sqlState;
  const transient = isTransientMysqlError(error);

  if (mysqlCode === 1045) {
    return new PluginError({
      category: 'authentication_error',
      code: 'MYSQL_AUTHENTICATION_FAILED',
      message: `数据源 ${connection} 认证失败。`,
      writeOutcome,
      mysqlCode,
      mysqlErrorName,
      sqlState,
      attemptCount,
      cause: error,
    });
  }

  if (mysqlCode === 1044 || mysqlCode === 1142 || mysqlCode === 1143 || mysqlCode === 1227) {
    return new PluginError({
      category: 'permission_error',
      code: 'MYSQL_PERMISSION_DENIED',
      message: `数据源 ${connection} 拒绝了当前数据库操作。`,
      writeOutcome,
      mysqlCode,
      mysqlErrorName,
      sqlState,
      attemptCount,
      cause: error,
    });
  }

  if (transient) {
    const unknownWrite = writeOutcome === 'unknown';
    return new PluginError({
      category: unknownWrite ? 'write_outcome_unknown' : 'connection_error',
      code: unknownWrite ? 'MYSQL_WRITE_OUTCOME_UNKNOWN' : 'MYSQL_CONNECTION_LOST',
      message: unknownWrite
        ? `数据源 ${connection} 在写入结果确认前断开，无法判断变更是否生效。`
        : `数据源 ${connection} 连接失败或已经断开。`,
      retryable: !unknownWrite,
      retryAfterMs: unknownWrite ? undefined : 250,
      writeOutcome,
      mysqlCode,
      mysqlErrorName,
      sqlState,
      attemptCount,
      cause: error,
    });
  }

  return new PluginError({
    category: 'sql_error',
    code: 'MYSQL_SQL_ERROR',
    message: 'MySQL 拒绝了当前 SQL，请检查语法、约束和字段。',
    writeOutcome,
    mysqlCode,
    mysqlErrorName,
    mysqlMessage: mysqlError?.sqlMessage
      ? sanitizeMysqlMessage(mysqlError.sqlMessage, boundValues)
      : undefined,
    sqlState,
    attemptCount,
    cause: error,
  });
}

export function unknownError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  return new PluginError({
    category: 'internal_error',
    code: 'INTERNAL_ERROR',
    message: '插件执行失败，请根据 execution_id 查看脱敏日志。',
    cause: error,
  });
}
