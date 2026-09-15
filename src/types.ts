export type AccessMode = 'read_only' | 'read_write';
export type ConnectionEnvironment = 'dev' | 'test' | 'staging' | 'prod' | 'custom';
export type StatementKind = 'select' | 'show' | 'describe' | 'explain' | 'insert' | 'update' | 'delete';
export type BusinessMode = 'read' | 'insert' | 'update' | 'delete';
export type WriteOutcome = 'not_applicable' | 'not_sent' | 'known_failed' | 'committed' | 'unknown';

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
