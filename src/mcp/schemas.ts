import { z } from 'zod';

import { ALIAS_PATTERN, DEFAULT_MAX_ROWS, DEFAULT_POOL_MAX, MAX_AFFECTED_ROWS, MAX_MAX_ROWS, MAX_POOL_MAX } from '../constants.js';

const alias = z.string().regex(ALIAS_PATTERN).describe('已配置的数据源别名，例如 auto-dev。');
const datasourceId = z.string().regex(ALIAS_PATTERN).describe('稳定的数据源标识；省略时使用 alias。');
const environment = z.enum(['dev', 'test', 'staging', 'prod', 'custom']);
const ownerScope = z.string().min(1).max(256);
const database = z.string().min(1).max(64).describe('默认 MySQL 数据库名。');
const allowedDatabases = z.array(database).min(1).max(32).describe('该连接允许访问的数据库白名单。');
// Keep the MCP schema broad enough for unsafe JSON numbers to reach the plugin's
// actionable validation. compileNamedParameters rejects them before any SQL is sent.
const parameterScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const parameterValue = z.union([parameterScalar, z.array(parameterScalar).min(1).max(100)]);
export const sqlParameters = z
  .record(z.string(), parameterValue)
  .describe('命名参数对象。SQL 中用 :name 绑定标量，用 :...names 展开非空列表；值不得拼进 SQL 文本。MySQL BIGINT、雪花 ID 等可能超过 JavaScript 安全整数范围的值必须使用 JSON 字符串。');

const connectionFields = {
  datasource_id: datasourceId.optional(),
  environment: environment.default('custom'),
  owner_scope: ownerScope.default('global'),
  shareable: z.boolean().default(false),
  description: z.string().max(256).nullable().optional(),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(3306),
  username: z.string().min(1).max(128),
  password: z.string().max(1_024),
  database,
  allowed_databases: allowedDatabases.optional(),
  charset: z.literal('utf8mb4').default('utf8mb4'),
  access_mode: z.enum(['read_only', 'read_write']).default('read_write'),
  connect_timeout_ms: z.number().int().min(1_000).max(30_000).default(5_000),
  query_timeout_ms: z.number().int().min(100).max(300_000).default(30_000),
  pool_max: z.number().int().min(1).max(MAX_POOL_MAX).default(DEFAULT_POOL_MAX),
  idle_timeout_ms: z.number().int().min(10_000).max(600_000).default(60_000),
  enabled: z.boolean().default(true),
};

export const connectionAddSchema = z
  .object({ alias, ...connectionFields })
  .strict()
  .superRefine((input, context) => {
    if (input.allowed_databases && !input.allowed_databases.includes(input.database)) {
      context.addIssue({
        code: 'custom',
        path: ['allowed_databases'],
        message: 'allowed_databases must contain database',
      });
    }
  });

export const connectionUpdateSchema = z
  .object({
    alias,
    datasource_id: datasourceId.optional(),
    environment: environment.optional(),
    owner_scope: ownerScope.optional(),
    shareable: z.boolean().optional(),
    description: connectionFields.description,
    host: connectionFields.host.optional(),
    port: connectionFields.port.optional(),
    username: connectionFields.username.optional(),
    password: connectionFields.password.optional(),
    database: connectionFields.database.optional(),
    allowed_databases: connectionFields.allowed_databases,
    charset: z.literal('utf8mb4').optional(),
    access_mode: z.enum(['read_only', 'read_write']).optional(),
    connect_timeout_ms: z.number().int().min(1_000).max(30_000).optional(),
    query_timeout_ms: z.number().int().min(100).max(300_000).optional(),
    pool_max: z.number().int().min(1).max(MAX_POOL_MAX).optional(),
    idle_timeout_ms: z.number().int().min(10_000).max(600_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== 'alias'), {
    message: 'At least one field must be updated',
  });

export const connectionListSchema = z.object({ include_disabled: z.boolean().default(true) }).strict();
export const connectionRemoveSchema = z.object({ alias }).strict();

export const sqlQuerySchema = z
  .object({
    connection: alias,
    sql: z
      .string()
      .min(1)
      .max(65_536)
      .describe('单条只读 SQL。每个 SELECT（包括 COUNT）必须包含数字字面量 LIMIT；COUNT 通常使用 LIMIT 1。SHOW/DESCRIBE 不要求 LIMIT。'),
    parameters: sqlParameters.default({}),
    max_rows: z.number().int().min(1).max(MAX_MAX_ROWS).default(DEFAULT_MAX_ROWS).describe('允许返回的最大行数，默认 1000；SQL 中的 LIMIT 不能超过该值。'),
    timeout_ms: z.number().int().min(100).max(300_000).optional().describe('本次调用超时，不能超过数据源配置上限。'),
  })
  .strict();

export const sqlExecuteSchema = z
  .object({
    connection: alias,
    sql: z
      .string()
      .min(1)
      .max(65_536)
      .describe('单条 INSERT、UPDATE 或 DELETE。值用 :name 或 :...names 占位，不得拼进 SQL；UPDATE/DELETE 必须包含引用字段的 WHERE。'),
    parameters: sqlParameters.default({}),
    timeout_ms: z.number().int().min(100).max(300_000).optional().describe('本次调用超时，不能超过数据源配置上限。'),
    max_affected_rows: z
      .number()
      .int()
      .min(1)
      .max(MAX_AFFECTED_ROWS)
      .default(MAX_AFFECTED_ROWS)
      .describe('允许提交的最大影响行数；超过后回滚。'),
  })
  .strict();

export const schemaSearchSchema = z
  .object({
    connection: alias,
    keyword: z.string().min(1).max(128).optional().describe('搜索表名、表注释、列名和列注释。'),
    limit: z.number().int().min(1).max(50).default(20),
    refresh: z.boolean().default(false).describe('为 true 时跳过内存和 SQLite 缓存，从 MySQL 重新加载 Schema 快照。'),
  })
  .strict();

export const schemaDescribeSchema = z
  .object({
    connection: alias,
    tables: z
      .array(z.string().min(1).max(129))
      .min(1)
      .max(20)
      .describe('1 到 20 个表标识；table 使用默认库，也可使用 allowed_database.table。'),
    include_relations: z.boolean().default(true),
    relation_depth: z.number().int().min(0).max(2).default(1),
    include_inferred_relations: z.boolean().default(false),
    refresh: z.boolean().default(false).describe('为 true 时跳过内存和 SQLite 缓存，从 MySQL 重新加载 Schema 快照。'),
  })
  .strict();

export const listBusinessOperationsSchema = z
  .object({
    connection: alias,
    domain: z.string().min(1).max(64).optional(),
    keyword: z.string().min(1).max(128).optional(),
    mode: z.enum(['read', 'insert', 'update', 'delete']).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const workspaceSqlQuerySchema = sqlQuerySchema.omit({ connection: true });
export const workspaceSqlExecuteSchema = sqlExecuteSchema.omit({ connection: true });
export const workspaceSchemaSearchSchema = schemaSearchSchema.omit({ connection: true });
export const workspaceSchemaDescribeSchema = schemaDescribeSchema.omit({ connection: true });
export const workspaceListBusinessOperationsSchema = listBusinessOperationsSchema.omit({ connection: true });

const workspaceDatasourceIdentity = {
  datasource_id: datasourceId,
  environment,
};

export const workspaceDatasourceAddSchema = z.object({
  ...workspaceDatasourceIdentity,
  alias,
  description: connectionFields.description,
  host: connectionFields.host,
  port: connectionFields.port,
  username: connectionFields.username,
  password: connectionFields.password,
  database: connectionFields.database,
  allowed_databases: connectionFields.allowed_databases,
  charset: connectionFields.charset,
  access_mode: z.enum(['read_only', 'read_write']).default('read_write'),
  connect_timeout_ms: connectionFields.connect_timeout_ms,
  query_timeout_ms: connectionFields.query_timeout_ms,
  pool_max: connectionFields.pool_max,
  idle_timeout_ms: connectionFields.idle_timeout_ms,
  enabled: connectionFields.enabled,
  make_default: z.boolean().default(false),
}).strict();

export const workspaceDatasourceBindSchema = z.object({
  ...workspaceDatasourceIdentity,
  alias,
  make_default: z.boolean().default(false),
}).strict();

export const workspaceDatasourceListSchema = z.object({}).strict();

export const workspaceDatasourceUpdateSchema = z.object({
  ...workspaceDatasourceIdentity,
  description: connectionFields.description,
  host: connectionFields.host.optional(),
  port: connectionFields.port.optional(),
  username: connectionFields.username.optional(),
  password: connectionFields.password.optional(),
  database: connectionFields.database.optional(),
  allowed_databases: connectionFields.allowed_databases,
  charset: z.literal('utf8mb4').optional(),
  access_mode: z.enum(['read_only', 'read_write']).optional(),
  connect_timeout_ms: z.number().int().min(1_000).max(30_000).optional(),
  query_timeout_ms: z.number().int().min(100).max(300_000).optional(),
  pool_max: z.number().int().min(1).max(MAX_POOL_MAX).optional(),
  idle_timeout_ms: z.number().int().min(10_000).max(600_000).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== 'datasource_id' && key !== 'environment'), {
  message: 'At least one connection field must be updated',
});

export const workspaceDatasourceRemoveSchema = z.object({
  ...workspaceDatasourceIdentity,
  delete_owned_connection: z.boolean().default(false),
}).strict();

export const workspaceValidateSchema = z.object({}).strict();

const auditTimestamp = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), {
  message: '必须是带时区的 ISO 8601 时间，例如 2026-08-27T10:00:00+08:00',
});

export const historySearchSchema = z
  .object({
    execution_id: z.string().uuid().optional().describe('按某次工具调用返回的 execution_id 精确查找。'),
    connection: alias.optional(),
    business_operation_id: z.string().min(1).max(192).optional(),
    client_name: z.string().min(1).max(64).optional(),
    statement_kind: z.enum(['select', 'show', 'describe', 'explain', 'insert', 'update', 'delete', 'query', 'write']).optional(),
    status: z.enum(['ok', 'error']).optional(),
    since: auditTimestamp.optional().describe('只返回该时间及之后的记录。'),
    until: auditTimestamp.optional().describe('只返回该时间及之前的记录。'),
    before_id: z.number().int().positive().optional().describe('翻页游标；传上次返回的 next_before_id。'),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((input) => !input.since || !input.until || Date.parse(input.since) <= Date.parse(input.until), {
    message: 'since 不能晚于 until',
    path: ['since'],
  });

export const workspaceHistorySearchSchema = z.object({
  execution_id: z.string().uuid().optional(),
  business_operation_id: z.string().min(1).max(192).optional(),
  client_name: z.string().min(1).max(64).optional(),
  statement_kind: z.enum(['select', 'show', 'describe', 'explain', 'insert', 'update', 'delete', 'query', 'write']).optional(),
  status: z.enum(['ok', 'error']).optional(),
  since: auditTimestamp.optional(),
  until: auditTimestamp.optional(),
  before_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  datasource_id: datasourceId.optional(),
  environment: environment.optional(),
}).strict().refine((input) => !input.since || !input.until || Date.parse(input.since) <= Date.parse(input.until), {
  message: 'since 不能晚于 until', path: ['since'],
});

const traceId = z.string().regex(/^[0-9a-f]{32}$/, 'trace_id 必须是 32 位小写十六进制');
const runId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'run_id 必须是 UUIDv7');
const completedTraceStatus = z.enum(['ok', 'error', 'cancelled']);
const traceStatus = z.enum(['running', 'ok', 'error', 'cancelled']);
const traceOperationKind = z.enum(['sql', 'script', 'generic_sql', 'schema']);

export const workspaceTraceSearchSchema = z.object({
  trace_id: traceId.optional(),
  run_id: runId.optional(),
  operation_id: z.string().min(1).max(192).optional(),
  operation_kind: traceOperationKind.optional(),
  status: traceStatus.optional(),
  datasource_id: datasourceId.optional(),
  environment: environment.optional(),
  since: auditTimestamp.optional(),
  until: auditTimestamp.optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/, 'cursor 无效').optional(),
  before_started_at: auditTimestamp.optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict().refine((input) => !input.since || !input.until || Date.parse(input.since) <= Date.parse(input.until), {
  message: 'since 不能晚于 until', path: ['since'],
}).refine((input) => !input.cursor || !input.before_started_at, {
  message: 'cursor 与 before_started_at 不能同时提供', path: ['cursor'],
});

export const workspaceUsageSummarySchema = z.object({
  operation_id: z.string().min(1).max(192).optional(),
  operation_kind: traceOperationKind.optional(),
  status: completedTraceStatus.optional(),
  datasource_id: datasourceId.optional(),
  environment: environment.optional(),
  since: auditTimestamp.optional(),
  until: auditTimestamp.optional(),
  group_by: z.enum(['operation', 'kind', 'datasource', 'environment', 'status']).optional(),
}).strict().refine((input) => !input.since || !input.until || Date.parse(input.since) <= Date.parse(input.until), {
  message: 'since 不能晚于 until', path: ['since'],
});
