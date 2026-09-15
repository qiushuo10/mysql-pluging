import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { BusinessOperationRegistry, businessDirectToolName } from '../business-queries/registry.js';
import type { BusinessOperation } from '../business-queries/definition.js';
import {
  loadBusinessOperations,
  type LoadedBusinessPack,
} from '../business-packs/loader.js';
import { StateStore } from '../config/store.js';
import { PluginError, unknownError } from '../errors.js';
import { MysqlService } from '../mysql/service.js';
import type { SchemaSnapshotLoader } from '../mysql/schema.js';
import { WorkspaceManager, type RuntimeMode } from '../workspace/context.js';
import { registerWorkspaceTools } from './workspace-tools.js';
import {
  connectionAddSchema,
  connectionListSchema,
  connectionRemoveSchema,
  connectionUpdateSchema,
  historySearchSchema,
  listBusinessOperationsSchema,
  schemaDescribeSchema,
  schemaSearchSchema,
  sqlExecuteSchema,
  sqlQuerySchema,
} from './schemas.js';

export const MODEL_TEXT_MAX_CHARS = 45_000;

function compactModelData(data: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of [
    'schema_version', 'execution_id', 'status', 'kind', 'connection', 'database', 'action',
    'row_count', 'table_count', 'relation_count', 'duration_ms', 'attempt_count',
    'record_count', 'next_before_id',
  ]) {
    const value = data[key];
    if ((typeof value === 'string' && value.length <= 512) || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      compact[key] = value;
    }
  }
  compact.content_truncated = true;
  compact.content_note = 'MCP 文本内容已截断；structuredContent 保留完整的有界结果。';
  return compact;
}

export function modelVisibleData(data: Record<string, unknown>, maxChars = MODEL_TEXT_MAX_CHARS): Record<string, unknown> {
  if (JSON.stringify(data).length <= maxChars) return data;
  const preferredKeys = ['columns', 'rows', 'tables', 'relations', 'operations', 'connections'];
  const boundedKeys = [
    ...preferredKeys.filter((key) => Array.isArray(data[key])),
    ...Object.keys(data).filter((key) => Array.isArray(data[key]) && !preferredKeys.includes(key)),
  ];
  const candidate: Record<string, unknown> = {
    ...data,
    content_truncated: true,
    content_note: 'MCP 文本内容已截断；structuredContent 保留完整的有界结果。',
  };
  for (const key of boundedKeys) candidate[key] = [];

  if (JSON.stringify(candidate).length > maxChars) {
    const compact = compactModelData(data);
    return JSON.stringify(compact).length <= maxChars ? compact : { content_truncated: true };
  }

  for (const key of boundedKeys) {
    const source = data[key] as unknown[];
    let low = 0;
    let high = source.length;
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      candidate[key] = source.slice(0, count);
      if (JSON.stringify(candidate).length <= maxChars) low = count;
      else high = count - 1;
    }
    candidate[key] = source.slice(0, low);
  }
  return candidate;
}

function success(text: string, data: Record<string, unknown>): CallToolResult {
  const summary = text.length <= 1_000 ? text : `${text.slice(0, 999)}…`;
  const modelData = modelVisibleData(data, MODEL_TEXT_MAX_CHARS - summary.length - 1);
  const rendered = JSON.stringify(modelData);
  return {
    content: [{ type: 'text', text: `${summary}\n${rendered}` }],
    structuredContent: data,
    isError: false,
  };
}

function failure(error: unknown): CallToolResult {
  const pluginError = unknownError(error);
  const executionId = (pluginError as PluginError & { executionId?: string }).executionId ?? randomUUID();
  const mysqlIdentity = [
    pluginError.mysqlErrorName,
    pluginError.mysqlCode === null ? null : `errno ${pluginError.mysqlCode}`,
    pluginError.sqlState === null ? null : `SQLSTATE ${pluginError.sqlState}`,
  ].filter((value): value is string => value !== null).join(', ');
  const reason = pluginError.mysqlMessage ?? pluginError.message;
  const diagnostic = mysqlIdentity ? `${reason} (${mysqlIdentity})` : reason;
  const structuredContent: Record<string, unknown> = {
    schema_version: 'mysql-agent/result/1',
    execution_id: executionId,
    status: 'error',
    category: pluginError.category,
    code: pluginError.code,
    message: reason,
    retryable: pluginError.retryable,
    write_outcome: pluginError.writeOutcome,
    retry_after_ms: pluginError.retryAfterMs,
    attempt_count: pluginError.attemptCount,
    mysql_code: pluginError.mysqlCode,
    mysql_error_name: pluginError.mysqlErrorName,
    mysql_message: pluginError.mysqlMessage,
    sql_state: pluginError.sqlState,
  };
  return {
    content: [{ type: 'text', text: `${pluginError.code}: ${diagnostic}` }],
    structuredContent,
    isError: true,
  };
}

async function safe(handler: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return failure(error);
  }
}

function connectionResult(action: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 'mysql-agent/result/1',
    execution_id: randomUUID(),
    status: 'ok',
    kind: 'connection',
    action,
    ...data,
  };
}

function clientName(server: McpServer): string {
  const name = server.server.getClientVersion()?.name?.toLowerCase() ?? '';
  if (name.includes('codex')) return 'codex';
  if (name.includes('dsh') || name.includes('deepseek')) return 'dsh';
  return name || 'unknown';
}

async function invalidateRuntimeBestEffort(service: MysqlService, alias: string): Promise<void> {
  try {
    await service.runtimes.invalidate(alias);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      level: 'warn', event: 'runtime_invalidation_failed_after_config_commit', connection: alias,
      message: error instanceof Error ? error.message : 'unknown',
    })}\n`);
  }
}

function registerBaseTools(
  server: McpServer,
  store: StateStore,
  service: MysqlService,
  registry: BusinessOperationRegistry,
  mode: 'admin' | 'global',
): void {
  server.registerTool(
    'connection_add',
    {
      title: '新增 MySQL 数据源',
      description: '保存一个命名 MySQL 数据源到本地 SQLite。只保存配置，不测试连接，也不回显密码。',
      inputSchema: connectionAddSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      safe(() => {
        const summary = store.addConnection({
          alias: args.alias,
          datasourceId: args.datasource_id,
          environment: args.environment,
          ownerScope: args.owner_scope,
          shareable: args.shareable,
          description: args.description,
          host: args.host,
          port: args.port,
          username: args.username,
          password: args.password,
          database: args.database,
          allowedDatabases: args.allowed_databases,
          charset: args.charset,
          accessMode: args.access_mode,
          connectTimeoutMs: args.connect_timeout_ms,
          queryTimeoutMs: args.query_timeout_ms,
          poolMax: args.pool_max,
          idleTimeoutMs: args.idle_timeout_ms,
          enabled: args.enabled,
        });
        return success(`已保存数据源 ${args.alias}，将在第一次真实 SQL 调用时连接。`, connectionResult('add', { connection: summary }));
      }),
  );

  server.registerTool(
    'connection_update',
    {
      title: '修改 MySQL 数据源',
      description: '修改本地数据源配置并递增 revision。旧连接池完成在途调用后关闭。',
      inputSchema: connectionUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      safe(async () => {
        const summary = store.updateConnection({
          alias: args.alias,
          datasourceId: args.datasource_id,
          environment: args.environment,
          ownerScope: args.owner_scope,
          shareable: args.shareable,
          description: args.description,
          host: args.host,
          port: args.port,
          username: args.username,
          password: args.password,
          database: args.database,
          allowedDatabases: args.allowed_databases,
          charset: args.charset,
          accessMode: args.access_mode,
          connectTimeoutMs: args.connect_timeout_ms,
          queryTimeoutMs: args.query_timeout_ms,
          poolMax: args.pool_max,
          idleTimeoutMs: args.idle_timeout_ms,
          enabled: args.enabled,
        });
        service.schema.invalidate(args.alias);
        await invalidateRuntimeBestEffort(service, args.alias);
        return success(`已更新数据源 ${args.alias}。`, connectionResult('update', { connection: summary }));
      }),
  );

  server.registerTool(
    'connection_list',
    {
      title: '列出 MySQL 数据源',
      description: '列出本地数据源配置摘要。结果永不包含密码。',
      inputSchema: connectionListSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      safe(() => {
        const connections = store.listConnections(args.include_disabled);
        return success(`当前有 ${connections.length} 个数据源。`, connectionResult('list', { connections }));
      }),
  );

  server.registerTool(
    'connection_remove',
    {
      title: '删除 MySQL 数据源',
      description: '删除本地数据源配置并关闭当前进程中的对应连接池。',
      inputSchema: connectionRemoveSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      safe(async () => {
        store.removeConnection(args.alias);
        service.schema.invalidate(args.alias);
        await invalidateRuntimeBestEffort(service, args.alias);
        return success(`已删除数据源 ${args.alias}。`, connectionResult('remove', { alias: args.alias, removed: true }));
      }),
  );

  if (mode === 'admin') return;

  server.registerTool(
    'history_search',
    {
      title: '搜索 SQL 调用历史',
      description: '搜索本地 SQLite 中的 SQL 审计记录。可按调用 ID、数据源、业务操作、客户端、SQL 类型、状态和时间过滤。记录不含 SQL 参数值或旧结果集；若需要当前业务数据，请重新调用对应查询工具。',
      inputSchema: historySearchSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => safe(() => {
      const history = store.searchAudit({
        executionId: args.execution_id,
        connectionAlias: args.connection,
        businessOperationId: args.business_operation_id,
        clientName: args.client_name,
        statementKind: args.statement_kind,
        status: args.status,
        since: args.since ? new Date(args.since).toISOString() : undefined,
        until: args.until ? new Date(args.until).toISOString() : undefined,
        beforeId: args.before_id,
        limit: args.limit,
      });
      const records = history.records.map((record) => ({
        id: record.id,
        execution_id: record.executionId,
        occurred_at: record.occurredAt,
        client_name: record.clientName,
        connection: record.connectionAlias,
        business_operation_id: record.businessOperationId,
        business_pack_id: record.businessPackId,
        business_pack_version: record.businessPackVersion,
        business_operation_hash: record.businessOperationHash,
        statement_kind: record.statementKind,
        sql_hash: record.sqlHash,
        duration_ms: record.durationMs,
        row_count: record.rowCount,
        affected_rows: record.affectedRows,
        attempt_count: record.attemptCount,
        write_outcome: record.writeOutcome,
        status: record.status,
        error_category: record.errorCategory,
        mysql_error_code: record.mysqlErrorCode,
      }));
      return success(`找到 ${records.length} 条 SQL 调用历史。`, {
        schema_version: 'mysql-agent/result/1',
        execution_id: randomUUID(),
        status: 'ok',
        kind: 'history_search',
        record_count: records.length,
        records,
        next_before_id: history.nextBeforeId,
        result_replayable: false,
        note: '历史记录不包含参数值或结果集；需要当前数据时请重新执行查询。',
      });
    }),
  );

  server.registerTool(
    'schema_search',
    {
      title: '搜索 MySQL Schema',
      description: '在数据源 allowed_databases 范围内搜索表名、表注释、列名和列注释；只返回紧凑匹配结果，不接受 SQL。需要当前实时结构时传 refresh=true。',
      inputSchema: schemaSearchSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) => safe(async () => {
      const result = await service.schema.search({
        connection: args.connection,
        keyword: args.keyword,
        limit: args.limit,
        refresh: args.refresh,
        requestSignal: extra.signal,
      });
      return success(`Schema 搜索完成，找到 ${String(result.table_count)} 个表。`, result);
    }),
  );

  server.registerTool(
    'schema_describe',
    {
      title: '描述 MySQL 表结构',
      description: '返回选定表的列、主键、索引和相关关系子图；默认仅展开一层已声明外键，不返回 DDL。需要当前实时结构时传 refresh=true。',
      inputSchema: schemaDescribeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) => safe(async () => {
      const result = await service.schema.describe({
        connection: args.connection,
        tables: args.tables,
        includeRelations: args.include_relations,
        relationDepth: args.relation_depth,
        includeInferredRelations: args.include_inferred_relations,
        refresh: args.refresh,
        requestSignal: extra.signal,
      });
      return success(`Schema 描述完成，返回 ${(result.tables as unknown[]).length} 个相关表。`, result);
    }),
  );

  server.registerTool(
    'sql_query',
    {
      title: '执行参数化 MySQL 查询',
      description:
        '执行一条只读 SQL。先选匹配的 business__* 工具；没有业务工具时才使用本入口。SQL 用 :name 绑定标量、:...names 展开列表，值放在 parameters。MySQL BIGINT、雪花 ID 等大整数必须按 JSON 字符串传入，不能传 number。每个 SELECT（包括 COUNT）必须自带数字字面量 LIMIT，例如 COUNT 查询写 LIMIT 1；SHOW/DESCRIBE 不要求 LIMIT。',
      inputSchema: sqlQuerySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) =>
      safe(async () => {
        const result = await service.query({
          connection: args.connection,
          sql: args.sql,
          parameters: args.parameters,
          maxRows: args.max_rows,
          timeoutMs: args.timeout_ms,
          requestSignal: extra.signal,
          clientName: clientName(server),
        });
        return success(`查询成功，返回 ${String(result.row_count)} 行，耗时 ${String(result.duration_ms)} ms。`, result);
      }),
  );

  server.registerTool(
    'sql_execute',
    {
      title: '执行参数化 MySQL 写入',
      description:
        '执行一条 INSERT、UPDATE 或 DELETE。SQL 用 :name 绑定标量、:...names 展开列表，值放在 parameters。MySQL BIGINT、雪花 ID 等大整数必须按 JSON 字符串传入，不能传 number。UPDATE/DELETE 必须有引用字段的 WHERE，默认最多影响 100 行；写入发送后不会自动重试。',
      inputSchema: sqlExecuteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      safe(async () => {
        const result = await service.execute({
          connection: args.connection,
          sql: args.sql,
          parameters: args.parameters,
          timeoutMs: args.timeout_ms,
          maxAffectedRows: args.max_affected_rows,
          requestSignal: extra.signal,
          clientName: clientName(server),
        });
        return success(
          `${String(result.operation).toUpperCase()} 成功，影响 ${String(result.affected_rows)} 行，耗时 ${String(result.duration_ms)} ms。`,
          result,
        );
      }),
  );

  server.registerTool(
    'list_business_operations',
    {
      title: '查找内置业务操作',
      description: '先按数据源，再按业务域、关键词或读写模式查找启动时加载的本地业务 SQL 能力；不返回 SQL 文本。',
      inputSchema: listBusinessOperationsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      safe(() => {
        const operations = registry.list(args);
        return success(`找到 ${operations.length} 个业务操作。`, {
          schema_version: 'mysql-agent/result/1',
          execution_id: randomUUID(),
          status: 'ok',
          kind: 'business_operation_list',
          operations,
        });
      }),
  );
}

function directAnnotations(operation: BusinessOperation): ToolAnnotations {
  return {
    readOnlyHint: operation.mode === 'read',
    destructiveHint: operation.mode === 'update' || operation.mode === 'delete',
    idempotentHint: operation.mode === 'read',
    openWorldHint: true,
  };
}

function registerBusinessTools(server: McpServer, service: MysqlService, registry: BusinessOperationRegistry): void {
  for (const operation of registry.direct()) {
    server.registerTool(
      businessDirectToolName(operation),
      {
        title: operation.title,
        description: `${operation.description} 目标数据源：${operation.connection}。使用场景：${operation.useWhen}`,
        inputSchema: operation.input,
        annotations: directAnnotations(operation),
      },
      (args, extra) =>
        safe(async () => {
          const result = await registry.execute(operation, args, service, extra.signal, clientName(server));
          return success(`${operation.title}执行成功。`, result);
        }),
    );
  }

  for (const group of registry.grouped()) {
    const operationNames = group.operations.map((operation) => operation.name) as [string, ...string[]];
    const operationInputs = group.operations.map((operation) => operation.input);
    const operationInput = operationInputs.length === 1
      ? operationInputs[0]!
      : z.union(operationInputs as [typeof operationInputs[number], typeof operationInputs[number], ...typeof operationInputs]);
    const inputSchema = z.object({
      operation: z.enum(operationNames).describe('要执行的固定业务操作。'),
      input: operationInput.describe('所选 operation 对应的业务参数。'),
    }).strict();
    const descriptions = group.operations.map((operation) => `${operation.name}: ${operation.useWhen}`).join('；');
    server.registerTool(
      group.toolName,
      {
        title: `${group.domain} ${group.lane === 'read' ? '查询' : '写入'}操作`,
        description: `在固定数据源 ${group.connection} 上选择一个固定业务操作执行。${descriptions}`,
        inputSchema,
        annotations: {
          readOnlyHint: group.lane === 'read',
          destructiveHint: group.lane === 'write',
          idempotentHint: group.lane === 'read',
          openWorldHint: true,
        },
      },
      (args, extra) =>
        safe(async () => {
          const parsed = inputSchema.parse(args) as { operation: string; input: unknown };
          const operation = group.operations.find((item) => item.name === parsed.operation);
          if (!operation) {
            throw new PluginError({
              category: 'argument_error',
              code: 'BUSINESS_OPERATION_NOT_FOUND',
              message: `入口 ${group.toolName} 不包含操作 ${parsed.operation}。`,
            });
          }
          const result = await registry.execute(operation, parsed.input, service, extra.signal, clientName(server));
          return success(`${operation.title}执行成功。`, result);
        }),
    );
  }
}

export interface MysqlMcpApplication {
  server: McpServer;
  store: StateStore;
  service: MysqlService;
  businessRegistry: BusinessOperationRegistry;
  businessPacksHome: string | null;
  businessPacks: readonly LoadedBusinessPack[];
  mode: RuntimeMode;
  workspaceManager: WorkspaceManager | null;
  close(): Promise<void>;
}

export function createMysqlMcpApplication(options: {
  stateHome?: string;
  operations?: readonly BusinessOperation[];
  businessPacksHome?: string;
  schemaLoader?: SchemaSnapshotLoader;
  mode?: RuntimeMode;
  workspacePath?: string;
} = {}): MysqlMcpApplication {
  const mode = options.mode ?? 'global';
  if (mode === 'workspace' && !options.workspacePath) {
    throw new PluginError({ category: 'config_error', code: 'WORKSPACE_DESCRIPTOR_REQUIRED', message: 'workspace 模式必须显式提供 workspacePath。' });
  }
  const workspaceManager = mode === 'workspace' ? new WorkspaceManager(options.workspacePath!) : null;
  const workspaceLoads = workspaceManager && !options.operations
    ? workspaceManager.context.businessPackPaths.map((path) => loadBusinessOperations(path))
    : [];
  const loaded = options.operations
    ? { operations: options.operations, packs: [] as const, home: null }
    : workspaceManager
      ? {
          operations: workspaceLoads.flatMap((item) => [...item.operations]),
          packs: workspaceLoads.flatMap((item) => [...item.packs]),
          home: workspaceManager.context.businessPackPaths[0] ?? null,
        }
      : mode === 'admin'
        ? { operations: [] as readonly BusinessOperation[], packs: [] as const, home: null }
        : loadBusinessOperations(options.businessPacksHome);
  const businessRegistry = new BusinessOperationRegistry(loaded.operations);
  const store = new StateStore(options.stateHome);
  if (workspaceManager) {
    try {
      store.registerWorkspaceIdentity(workspaceManager.context.workspaceId, workspaceManager.context.rootHash);
    } catch (error) {
      store.close();
      throw error;
    }
  }
  const service = new MysqlService(store, undefined, options.schemaLoader);
  const server = new McpServer({ name: 'mysql-agent', version: '0.3.0' });
  if (workspaceManager) {
    registerWorkspaceTools({ server, manager: workspaceManager, store, service, registry: businessRegistry, getClientName: () => clientName(server) });
  } else {
    registerBaseTools(server, store, service, businessRegistry, mode === 'admin' ? 'admin' : 'global');
    if (mode === 'global') registerBusinessTools(server, service, businessRegistry);
  }
  return {
    server,
    store,
    service,
    businessRegistry,
    businessPacksHome: loaded.home,
    businessPacks: loaded.packs,
    mode,
    workspaceManager,
    close: () => service.close(),
  };
}
