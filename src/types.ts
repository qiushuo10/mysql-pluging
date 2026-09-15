export type AccessMode = 'read_only' | 'read_write';
export type ConnectionEnvironment = 'dev' | 'test' | 'staging' | 'prod' | 'custom';
export type StatementKind = 'select' | 'show' | 'describe' | 'explain' | 'insert' | 'update' | 'delete';
export type BusinessMode = 'read' | 'insert' | 'update' | 'delete';
export type WriteOutcome = 'not_applicable' | 'not_sent' | 'known_failed' | 'committed' | 'unknown';
export type TraceOperationKind = 'sql' | 'script' | 'generic_sql' | 'schema';
export type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface ConnectionConfig {
  alias: string;
  datasourceId?: string;
  environment?: ConnectionEnvironment;
  ownerScope?: string;
  shareable?: boolean;
  description: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  allowedDatabases: string[];
  charset: 'utf8mb4';
  accessMode: AccessMode;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  poolMax: number;
  idleTimeoutMs: number;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionSummary = Omit<ConnectionConfig, 'password'>;

export interface AuditRecord {
  executionId: string;
  occurredAt: string;
  clientName: string;
  connectionAlias: string;
  workspaceId?: string | null;
  datasourceId?: string | null;
  environment?: ConnectionEnvironment | null;
  traceId?: string | null;
  spanId?: string | null;
  runId?: string | null;
  businessOperationId: string | null;
  businessPackId: string | null;
  businessPackVersion: string | null;
  businessOperationHash: string | null;
  statementKind: string;
  sqlHash: string;
  durationMs: number;
  rowCount: number | null;
  affectedRows: number | null;
  attemptCount: number;
  writeOutcome: WriteOutcome;
  status: 'ok' | 'error';
  errorCategory: string | null;
  mysqlErrorCode: number | null;
}

export interface ExecutionRunRecord {
  runId: string;
  workspaceId: string | null;
  taskId: string | null;
  traceId: string;
  rootSpanId: string;
  operationId: string;
  operationKind: TraceOperationKind;
  datasourceIds: string[];
  environment: ConnectionEnvironment | null;
  connectionAliases: string[];
  packId: string | null;
  packVersion: string | null;
  operationHash: string | null;
  scriptHash: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  queueDurationMs: number;
  status: TraceStatus;
  errorCategory: string | null;
  resultBytes: number | null;
}

export interface ExecutionSpanRecord {
  spanId: string;
  runId: string;
  traceId: string;
  parentSpanId: string | null;
  workspaceId: string | null;
  operationId: string;
  operationKind: TraceOperationKind;
  datasourceId: string | null;
  environment: ConnectionEnvironment | null;
  connectionAlias: string | null;
  stepIndex: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  queueDurationMs: number;
  status: TraceStatus;
  errorCategory: string | null;
  resultBytes: number | null;
}

export interface TraceSearchFilters {
  workspaceId: string;
  traceId?: string;
  runId?: string;
  operationId?: string;
  operationKind?: TraceOperationKind;
  status?: TraceStatus;
  datasourceId?: string;
  environment?: ConnectionEnvironment;
  since?: string;
  until?: string;
  beforeStartedAt?: string;
  limit: number;
}

export type UsageGroupBy = 'operation' | 'kind' | 'datasource' | 'environment' | 'status';

export interface UsageSummaryFilters {
  workspaceId: string;
  operationId?: string;
  operationKind?: TraceOperationKind;
  status?: Exclude<TraceStatus, 'running'>;
  datasourceId?: string;
  environment?: ConnectionEnvironment;
  since?: string;
  until?: string;
  groupBy?: UsageGroupBy;
}

export interface AuditHistoryRecord extends AuditRecord {
  id: number;
}

export interface AuditHistoryFilters {
  executionId?: string;
  connectionAlias?: string;
  workspaceId?: string;
  datasourceId?: string;
  environment?: ConnectionEnvironment;
  businessOperationId?: string;
  clientName?: string;
  statementKind?: string;
  status?: 'ok' | 'error';
  since?: string;
  until?: string;
  beforeId?: number;
  limit: number;
}

export interface SchemaSnapshotRecord {
  formatVersion: number;
  cacheKey: string;
  connectionAlias: string;
  connectionRevision: number;
  defaultDatabase: string;
  allowedDatabases: string[];
  snapshot: unknown;
  loadedAt: string;
}

export type SqlScalar = string | number | boolean | null;
export type SqlParameterValue = SqlScalar | SqlScalar[];
export type SqlParameters = Record<string, SqlParameterValue>;
