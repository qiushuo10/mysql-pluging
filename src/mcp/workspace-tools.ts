import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { z } from 'zod';

import type { BusinessOperation } from '../business-queries/definition.js';
import { BusinessOperationRegistry } from '../business-queries/registry.js';
import type { AddConnectionInput, ConnectionIdentity, StateStore } from '../config/store.js';
import { PluginError, unknownError } from '../errors.js';
import type { MysqlService } from '../mysql/service.js';
import type { ConnectionEnvironment, ConnectionSummary } from '../types.js';
import type { WorkspaceContext, WorkspaceEnvironment } from '../workspace/context.js';
import { WorkspaceManager } from '../workspace/context.js';
import {
  workspaceDatasourceAddSchema,
  workspaceDatasourceBindSchema,
  workspaceDatasourceListSchema,
  workspaceDatasourceRemoveSchema,
  workspaceDatasourceUpdateSchema,
  workspaceHistorySearchSchema,
  workspaceListBusinessOperationsSchema,
  workspaceSchemaDescribeSchema,
  workspaceSchemaSearchSchema,
  workspaceSqlExecuteSchema,
  workspaceSqlQuerySchema,
  workspaceValidateSchema,
} from './schemas.js';

interface WorkspaceTarget {
  datasourceId: string;
  environment: ConnectionEnvironment;
  alias: string;
  policy: WorkspaceEnvironment;
  genericSuffix: string;
  identity: ConnectionIdentity;
}

function result(kind: string, data: Record<string, unknown>): CallToolResult {
  const structuredContent = {
    schema_version: 'mysql-agent/result/1', execution_id: randomUUID(), status: 'ok', kind, ...data,
  };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}

function failed(error: unknown): CallToolResult {
  const normalized = unknownError(error);
  const structuredContent = {
    schema_version: 'mysql-agent/result/1', execution_id: randomUUID(), status: 'error',
    category: normalized.category, code: normalized.code, message: normalized.message,
    retryable: normalized.retryable, write_outcome: normalized.writeOutcome,
  };
  return { content: [{ type: 'text', text: `${normalized.code}: ${normalized.message}` }], structuredContent, isError: true };
}

async function safe(handler: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try { return await handler(); } catch (error) { return failed(error); }
}

function configError(code: string, message: string, cause?: unknown): PluginError {
  return new PluginError({ category: 'config_error', code, message, cause });
}

async function invalidateRuntimeBestEffort(service: MysqlService, alias: string): Promise<void> {
  service.schema.invalidate(alias);
  try {
    await service.runtimes.invalidate(alias);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      level: 'warn', event: 'workspace_runtime_invalidation_failed', connection: alias,
      message: error instanceof Error ? error.message : 'unknown',
    })}\n`);
  }
}

function validateBinding(
  store: StateStore,
  workspace: WorkspaceContext,
  target: Pick<WorkspaceTarget, 'datasourceId' | 'environment' | 'alias'>,
): ConnectionSummary {
  const connection = store.requireConnection(target.alias);
  if (!connection.enabled) throw configError('WORKSPACE_CONNECTION_DISABLED', `binding ${target.datasourceId}/${target.environment} 指向已停用连接。`);
  if (connection.datasourceId !== target.datasourceId || connection.environment !== target.environment) {
    throw configError(
      'WORKSPACE_BINDING_METADATA_MISMATCH',
      `binding ${target.datasourceId}/${target.environment} 与连接 ${target.alias} 的 datasource/environment 不一致。`,
    );
  }
  if (target.environment === 'prod' && connection.accessMode !== 'read_only') {
    throw configError(
      'WORKSPACE_PROD_CONNECTION_NOT_READ_ONLY',
      `生产 binding ${target.datasourceId}/prod 只允许绑定物理 access_mode=read_only 的连接。`,
    );
  }
  const owned = connection.ownerScope === `workspace:${workspace.workspaceId}`;
  const shared = connection.ownerScope === 'global' && connection.shareable === true;
  if (!owned && !shared) {
    throw configError('WORKSPACE_CONNECTION_NOT_AUTHORIZED', `工作空间 ${workspace.workspaceId} 无权使用连接 ${target.alias}。`);
  }
  const { password: _password, ...summary } = connection;
  return summary;
}

function identityOf(connection: ConnectionSummary): ConnectionIdentity {
  return {
    alias: connection.alias,
    datasourceId: connection.datasourceId ?? connection.alias,
    environment: connection.environment ?? 'custom',
    ownerScope: connection.ownerScope ?? 'global',
    revision: connection.revision,
  };
}

export function workspaceTargets(manager: WorkspaceManager, store: StateStore): WorkspaceTarget[] {
  const workspace = manager.context;
  const targets: WorkspaceTarget[] = [];
  for (const [environment, policy] of workspace.environments) {
    for (const [datasourceId, alias] of Object.entries(policy.datasourceBindings)) {
      validateBinding(store, workspace, { datasourceId, environment, alias });
    }
    const visible = environment === workspace.defaultEnvironment || policy.exposeAsExplicitTool;
    if (!visible) continue;
    for (const [datasourceId, alias] of Object.entries(policy.datasourceBindings)) {
      const isDefault = datasourceId === workspace.defaultDatasource && environment === workspace.defaultEnvironment;
      const environmentPrefix = environment === 'prod' || environment !== workspace.defaultEnvironment ? environment : '';
      const datasourceSuffix = datasourceId === workspace.defaultDatasource ? '' : datasourceId;
      const suffix = isDefault && environment !== 'prod'
        ? ''
        : [environmentPrefix, datasourceSuffix].filter(Boolean).join('__');
      const connection = validateBinding(store, workspace, { datasourceId, environment, alias });
      targets.push({ datasourceId, environment, alias, policy, genericSuffix: suffix, identity: identityOf(connection) });
    }
  }
  const defaultTarget = targets.find((target) =>
    target.datasourceId === workspace.defaultDatasource && target.environment === workspace.defaultEnvironment);
  if (!defaultTarget) {
    throw configError('WORKSPACE_DEFAULT_TARGET_NOT_EXPOSED', '默认 binding 无法解析为可用工具目标。');
  }
  return targets.sort((left, right) => left.genericSuffix.localeCompare(right.genericSuffix));
}

function liveTarget(manager: WorkspaceManager, store: StateStore, source: WorkspaceTarget): WorkspaceTarget {
  const alias = manager.binding(source.datasourceId, source.environment);
  const workspace = manager.context;
  if (!alias) throw configError('WORKSPACE_BINDING_NOT_FOUND', `binding ${source.datasourceId}/${source.environment} 已不存在，请重新连接。`);
  const policy = workspace.environments.get(source.environment);
  if (!policy) throw configError('WORKSPACE_ENVIRONMENT_NOT_FOUND', `环境 ${source.environment} 已不存在，请重新连接。`);
  const connection = validateBinding(store, workspace, { datasourceId: source.datasourceId, environment: source.environment, alias });
  return { ...source, alias, policy, identity: identityOf(connection) };
}

function publicWorkspaceResult(data: Record<string, unknown>, target: WorkspaceTarget): Record<string, unknown> {
  const copy = { ...data };
  delete copy.connection;
  if (typeof copy.business_operation_id === 'string' && copy.business_operation_id.endsWith(`.${target.alias}`)) {
    copy.business_operation_id = copy.business_operation_id.slice(0, -(target.alias.length + 1));
  }
  copy.datasource_id = target.datasourceId;
  copy.environment = target.environment;
  return copy;
}

function publicOperationId(operation: BusinessOperation, target: WorkspaceTarget): string {
  return operation.id.endsWith(`.${target.alias}`) ? operation.id.slice(0, -(target.alias.length + 1)) : operation.id;
}

function registerName(names: Set<string>, name: string): void {
  const validation = validateToolName(name);
  if (!validation.isValid) throw configError('WORKSPACE_TOOL_NAME_INVALID', `工具名 ${name} 无效。`);
  if (names.has(name)) throw configError('WORKSPACE_TOOL_NAME_COLLISION', `工作空间工具名 ${name} 冲突。`);
  names.add(name);
}

function annotations(operation: BusinessOperation): ToolAnnotations {
  return {
    readOnlyHint: operation.mode === 'read',
    destructiveHint: operation.mode === 'update' || operation.mode === 'delete',
    idempotentHint: operation.mode === 'read',
    openWorldHint: true,
  };
}

function businessPrefix(target: WorkspaceTarget): string {
  return target.genericSuffix ? `${target.genericSuffix}__` : '';
}

function matchingOperations(registry: BusinessOperationRegistry, store: StateStore, target: WorkspaceTarget): BusinessOperation[] {
  const connection = store.requireConnection(target.alias);
  return registry.all()
    .filter((operation) => operation.connection === target.alias)
    .filter((operation) => operation.mode === 'read' || (target.policy.accessMode === 'read_write' && connection.accessMode === 'read_write'));
}

function registerBoundDataTools(
  server: McpServer,
  names: Set<string>,
  manager: WorkspaceManager,
  store: StateStore,
  service: MysqlService,
  initial: WorkspaceTarget,
  getClientName: () => string,
): void {
  const suffix = initial.genericSuffix ? `__${initial.genericSuffix}` : '';
  const targetLabel = `${initial.datasourceId}/${initial.environment}`;
  const queryName = `sql_query${suffix}`;
  registerName(names, queryName);
  server.registerTool(queryName, {
    title: `查询 ${targetLabel}`,
    description: `执行一条只读 SQL，目标由工作空间固定为 ${targetLabel}；输入不接受物理连接 alias。`,
    inputSchema: workspaceSqlQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => safe(async () => {
    const target = liveTarget(manager, store, initial);
    const value = await service.query({
      connection: target.alias, sql: args.sql, parameters: args.parameters, maxRows: args.max_rows,
      timeoutMs: args.timeout_ms, requestSignal: extra.signal, clientName: getClientName(),
      workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
      expectedConnection: target.identity,
    });
    return result('query', publicWorkspaceResult(value, target));
  }));

  const searchName = `schema_search${suffix}`;
  registerName(names, searchName);
  server.registerTool(searchName, {
    title: `搜索 ${targetLabel} Schema`, description: `目标由工作空间固定为 ${targetLabel}。`,
    inputSchema: workspaceSchemaSearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => safe(async () => {
    const target = liveTarget(manager, store, initial);
    const value = await service.schema.search({ connection: target.alias, keyword: args.keyword, limit: args.limit, refresh: args.refresh, requestSignal: extra.signal });
    return result('schema_search', publicWorkspaceResult(value, target));
  }));

  const describeName = `schema_describe${suffix}`;
  registerName(names, describeName);
  server.registerTool(describeName, {
    title: `描述 ${targetLabel} Schema`, description: `目标由工作空间固定为 ${targetLabel}。`,
    inputSchema: workspaceSchemaDescribeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => safe(async () => {
    const target = liveTarget(manager, store, initial);
    const value = await service.schema.describe({
      connection: target.alias, tables: args.tables, includeRelations: args.include_relations,
      relationDepth: args.relation_depth, includeInferredRelations: args.include_inferred_relations,
      refresh: args.refresh, requestSignal: extra.signal,
    });
    return result('schema_describe', publicWorkspaceResult(value, target));
  }));

  const connection = store.requireConnection(initial.alias);
  if (connection.accessMode === 'read_write' && initial.policy.accessMode === 'read_write') {
    const executeName = `sql_execute${suffix}`;
    registerName(names, executeName);
    server.registerTool(executeName, {
      title: `写入 ${targetLabel}`, description: `目标由工作空间固定为 ${targetLabel}。`,
      inputSchema: workspaceSqlExecuteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, (args, extra) => safe(async () => {
      const target = liveTarget(manager, store, initial);
      if (target.policy.accessMode !== 'read_write' || store.requireConnection(target.alias).accessMode !== 'read_write') {
        throw new PluginError({ category: 'permission_error', code: 'WORKSPACE_TARGET_READ_ONLY', message: `${target.datasourceId}/${target.environment} 只允许读取。` });
      }
      const value = await service.execute({
        connection: target.alias, sql: args.sql, parameters: args.parameters, timeoutMs: args.timeout_ms,
        maxAffectedRows: args.max_affected_rows, requestSignal: extra.signal, clientName: getClientName(),
        workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
        expectedConnection: target.identity,
      });
      return result('execute', publicWorkspaceResult(value, target));
    }));
  }
}

function registerWorkspaceBusinessTools(
  server: McpServer,
  names: Set<string>,
  manager: WorkspaceManager,
  store: StateStore,
  service: MysqlService,
  registry: BusinessOperationRegistry,
  targets: WorkspaceTarget[],
  getClientName: () => string,
): void {
  const visible: Array<{ target: WorkspaceTarget; operation: BusinessOperation }> = [];
  for (const target of targets) {
    for (const operation of matchingOperations(registry, store, target)) visible.push({ target, operation });
  }

  for (const item of visible.filter(({ operation }) => operation.exposure === 'direct')) {
    const prefix = businessPrefix(item.target);
    const toolName = `business__${prefix}${item.operation.domain}__${item.operation.name}`;
    registerName(names, toolName);
    server.registerTool(toolName, {
      title: item.operation.title,
      description: `${item.operation.description} 目标由工作空间固定为 ${item.target.datasourceId}/${item.target.environment}。`,
      inputSchema: item.operation.input,
      annotations: annotations(item.operation),
    }, (args, extra) => safe(async () => {
      const target = liveTarget(manager, store, item.target);
      if (target.alias !== item.operation.connection) {
        throw configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更；请重新连接以装载对应业务操作。');
      }
      const value = await registry.execute(item.operation, args, service, extra.signal, getClientName(), {
        workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
        expectedConnection: target.identity, publicOperationId: publicOperationId(item.operation, target),
      });
      return result('business_operation', publicWorkspaceResult(value, target));
    }));
  }

  const groups = new Map<string, Array<{ target: WorkspaceTarget; operation: BusinessOperation }>>();
  for (const item of visible.filter(({ operation }) => operation.exposure === 'domain')) {
    const lane = item.operation.mode === 'read' ? 'read' : 'write';
    const key = `${businessPrefix(item.target)}${item.operation.domain}\u0000${lane}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const [qualifiedDomain, lane] = key.split('\u0000') as [string, 'read' | 'write'];
    const toolName = `business__${qualifiedDomain}__${lane}`;
    registerName(names, toolName);
    const operationNames = group.map(({ operation }) => operation.name);
    if (new Set(operationNames).size !== operationNames.length) {
      throw configError('WORKSPACE_BUSINESS_DISCRIMINATOR_COLLISION', `工具 ${toolName} 的 operation 名称冲突。`);
    }
    const enumNames = operationNames as [string, ...string[]];
    const schemas = group.map(({ operation }) => operation.input);
    const selectedInput = schemas.length === 1 ? schemas[0]! : z.union(schemas as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
    const inputSchema = z.object({ operation: z.enum(enumNames), input: selectedInput }).strict();
    server.registerTool(toolName, {
      title: `${qualifiedDomain} ${lane === 'read' ? '查询' : '写入'}操作`,
      description: '固定业务操作；数据源和环境由工作空间 binding 注入。', inputSchema,
      annotations: { readOnlyHint: lane === 'read', destructiveHint: lane === 'write', idempotentHint: lane === 'read', openWorldHint: true },
    }, (args, extra) => safe(async () => {
      const parsed = inputSchema.parse(args) as { operation: string; input: unknown };
      const selected = group.find(({ operation }) => operation.name === parsed.operation);
      if (!selected) throw configError('BUSINESS_OPERATION_NOT_FOUND', `工具 ${toolName} 不包含 ${parsed.operation}。`);
      const target = liveTarget(manager, store, selected.target);
      if (target.alias !== selected.operation.connection) {
        throw configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更；请重新连接以装载对应业务操作。');
      }
      const value = await registry.execute(selected.operation, parsed.input, service, extra.signal, getClientName(), {
        workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
        expectedConnection: target.identity, publicOperationId: publicOperationId(selected.operation, target),
      });
      return result('business_operation', publicWorkspaceResult(value, target));
    }));
  }

  registerName(names, 'list_business_operations');
  server.registerTool('list_business_operations', {
    title: '查找当前工作空间业务操作', description: '只列出当前工作空间已解析且暴露的业务操作；不接受物理连接 alias。',
    inputSchema: workspaceListBusinessOperationsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(async () => {
    const keyword = args.keyword?.toLowerCase();
    const operations = visible
      .filter(({ operation }) => !args.domain || operation.domain === args.domain)
      .filter(({ operation }) => !args.mode || operation.mode === args.mode)
      .filter(({ operation }) => !keyword || [operation.id, operation.title, operation.description, operation.useWhen].join(' ').toLowerCase().includes(keyword))
      .slice(0, args.limit)
      .map(({ operation, target }) => ({
        id: publicOperationId(operation, target), domain: operation.domain, name: operation.name, title: operation.title,
        description: operation.description, use_when: operation.useWhen, mode: operation.mode,
        datasource_id: target.datasourceId, environment: target.environment, exposure: operation.exposure,
        input_schema: z.toJSONSchema(operation.input), business_pack_id: operation.packId ?? null,
        business_pack_version: operation.packVersion ?? null, business_operation_hash: operation.operationHash ?? null,
      }));
    return result('business_operation_list', { operations });
  }));
}

function updateInput(args: z.infer<typeof workspaceDatasourceUpdateSchema>, alias: string) {
  return {
    alias, description: args.description, host: args.host, port: args.port, username: args.username,
    password: args.password, database: args.database, allowedDatabases: args.allowed_databases,
    charset: args.charset, accessMode: args.access_mode, connectTimeoutMs: args.connect_timeout_ms,
    queryTimeoutMs: args.query_timeout_ms, poolMax: args.pool_max, idleTimeoutMs: args.idle_timeout_ms,
    enabled: args.enabled,
  };
}

function connectionInput(args: z.infer<typeof workspaceDatasourceAddSchema>, workspaceId: string): AddConnectionInput {
  return {
    alias: args.alias, datasourceId: args.datasource_id, environment: args.environment,
    ownerScope: `workspace:${workspaceId}`, shareable: false, description: args.description,
    host: args.host, port: args.port, username: args.username, password: args.password, database: args.database,
    allowedDatabases: args.allowed_databases, charset: args.charset, accessMode: args.access_mode,
    connectTimeoutMs: args.connect_timeout_ms, queryTimeoutMs: args.query_timeout_ms, poolMax: args.pool_max,
    idleTimeoutMs: args.idle_timeout_ms, enabled: args.enabled,
  };
}

function workspaceSummary(manager: WorkspaceManager, store: StateStore): Array<Record<string, unknown>> {
  return manager.allBindings().map((binding) => {
    const connection = validateBinding(store, manager.context, binding);
    return {
      datasource_id: binding.datasourceId, environment: binding.environment, alias: binding.alias,
      access_mode: connection.accessMode, workspace_access_mode: manager.context.environments.get(binding.environment)?.accessMode,
      enabled: connection.enabled, owner_scope: connection.ownerScope, shareable: connection.shareable,
      default: binding.datasourceId === manager.context.defaultDatasource && binding.environment === manager.context.defaultEnvironment,
    };
  });
}

function registerWorkspaceManagementTools(
  server: McpServer,
  names: Set<string>,
  manager: WorkspaceManager,
  store: StateStore,
  service: MysqlService,
): void {
  const addTool = (name: string) => registerName(names, name);
  addTool('workspace_datasource_add');
  server.registerTool('workspace_datasource_add', {
    title: '新增工作空间数据源', description: '创建当前工作空间自有的 dev/test/staging 连接并原子写入 binding；不回显密码。',
    inputSchema: workspaceDatasourceAddSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args) => safe(async () => {
    if (args.environment === 'prod' || args.environment === 'custom') {
      throw configError('WORKSPACE_DATASOURCE_ADD_ENVIRONMENT_FORBIDDEN', 'workspace_datasource_add 只允许 dev/test/staging；prod 必须由 admin 创建后绑定。');
    }
    if (store.getConnection(args.alias)) throw configError('CONNECTION_ALREADY_EXISTS', `连接 ${args.alias} 已存在。`);
    if (manager.binding(args.datasource_id, args.environment)) {
      throw configError('WORKSPACE_BINDING_ALREADY_EXISTS', `binding ${args.datasource_id}/${args.environment} 已存在。`);
    }
    const summary = store.addConnection(connectionInput(args, manager.context.workspaceId));
    let bindingCommitted = false;
    try {
      await manager.setBinding(args.datasource_id, args.environment, args.alias, args.make_default, { requireAbsent: true });
      bindingCommitted = true;
      store.assertConnectionIdentity(identityOf(summary));
    } catch (error) {
      if (bindingCommitted) {
        try {
          await manager.removeBinding(args.datasource_id, args.environment, { expectedAlias: args.alias });
        } catch (compensationError) {
          throw configError(
            'PARTIAL_CONFIGURATION',
            `连接 ${args.alias} 已创建但并发校验失败，且 binding 补偿失败；请重新连接后核对配置。`,
            { error, compensationError },
          );
        }
      }
      try {
        store.removeConnection(args.alias, identityOf(summary));
      } catch (compensationError) {
        throw configError(
          'PARTIAL_CONFIGURATION',
          `workspace 写入失败且连接 ${args.alias} 补偿删除失败；请在 admin 模式删除该连接后重试。`,
          { error, compensationError },
        );
      }
      throw error;
    }
    return result('workspace_datasource_add', {
      datasource_id: args.datasource_id, environment: args.environment, connection: summary,
      reconnect_required: true, reason: '工具目录发生变化；请重新连接以刷新新增目标工具。',
    });
  }));

  addTool('workspace_datasource_bind');
  server.registerTool('workspace_datasource_bind', {
    title: '绑定已有数据源', description: '只允许绑定当前工作空间自有连接，或 global 且 shareable 的连接。',
    inputSchema: workspaceDatasourceBindSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args) => safe(async () => {
    const priorAlias = manager.binding(args.datasource_id, args.environment);
    const connection = validateBinding(store, manager.context, { datasourceId: args.datasource_id, environment: args.environment, alias: args.alias });
    await manager.setBinding(
      args.datasource_id,
      args.environment,
      args.alias,
      args.make_default,
      priorAlias === undefined ? { requireAbsent: true } : { expectedAlias: priorAlias },
    );
    try {
      store.assertConnectionIdentity(identityOf(connection));
    } catch (error) {
      try {
        if (priorAlias === undefined) {
          await manager.removeBinding(args.datasource_id, args.environment, { expectedAlias: args.alias });
        } else {
          await manager.setBinding(args.datasource_id, args.environment, priorAlias, false, { expectedAlias: args.alias });
        }
      } catch (compensationError) {
        throw configError(
          'PARTIAL_CONFIGURATION',
          `binding ${args.datasource_id}/${args.environment} 并发校验失败且补偿失败；请重新连接后核对配置。`,
          { error, compensationError },
        );
      }
      throw error;
    }
    return result('workspace_datasource_bind', {
      datasource_id: args.datasource_id, environment: args.environment,
      reconnect_required: true, reason: '工具目录发生变化；请重新连接以刷新绑定目标。',
    });
  }));

  addTool('workspace_datasource_list');
  server.registerTool('workspace_datasource_list', {
    title: '列出当前工作空间数据源', description: '只显示当前工作空间已经授权的 binding，不显示密码或其他连接。',
    inputSchema: workspaceDatasourceListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safe(() => result('workspace_datasource_list', { workspace_id: manager.context.workspaceId, datasources: workspaceSummary(manager, store) })));

  addTool('workspace_datasource_update');
  server.registerTool('workspace_datasource_update', {
    title: '更新工作空间自有数据源', description: '只更新 owner_scope 属于当前工作空间的连接。',
    inputSchema: workspaceDatasourceUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (args) => safe(async () => {
    if (args.environment === 'prod') {
      throw configError('WORKSPACE_PROD_UPDATE_FORBIDDEN', 'prod 连接必须在 admin 模式更新。');
    }
    const alias = manager.binding(args.datasource_id, args.environment);
    if (!alias) throw configError('WORKSPACE_BINDING_NOT_FOUND', `找不到 binding ${args.datasource_id}/${args.environment}。`);
    const connection = store.requireConnection(alias);
    if (connection.ownerScope !== `workspace:${manager.context.workspaceId}`) {
      throw configError('WORKSPACE_CONNECTION_UPDATE_FORBIDDEN', `连接 ${alias} 不属于当前工作空间。`);
    }
    const toolSurfaceChanged = (args.access_mode !== undefined && args.access_mode !== connection.accessMode)
      || (args.enabled !== undefined && args.enabled !== connection.enabled);
    const summary = store.updateConnection(updateInput(args, alias), identityOf(connection));
    await invalidateRuntimeBestEffort(service, alias);
    return result('workspace_datasource_update', {
      datasource_id: args.datasource_id, environment: args.environment, connection: summary,
      reconnect_required: toolSurfaceChanged,
      reason: toolSurfaceChanged ? '访问模式或启用状态变化；请重新连接以刷新工具目录。' : null,
    });
  }));

  addTool('workspace_datasource_remove');
  server.registerTool('workspace_datasource_remove', {
    title: '解除工作空间数据源绑定', description: '默认只解除 binding；明确要求且连接属于当前工作空间、无其他引用时才删除物理连接。',
    inputSchema: workspaceDatasourceRemoveSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (args) => safe(async () => {
    const alias = manager.binding(args.datasource_id, args.environment);
    if (!alias) throw configError('WORKSPACE_BINDING_NOT_FOUND', `找不到 binding ${args.datasource_id}/${args.environment}。`);
    const connection = store.requireConnection(alias);
    if (args.delete_owned_connection) {
      if (connection.ownerScope !== `workspace:${manager.context.workspaceId}`) {
        throw configError('WORKSPACE_CONNECTION_DELETE_FORBIDDEN', `连接 ${alias} 不属于当前工作空间。`);
      }
      if (manager.references(alias) !== 1) {
        throw configError('WORKSPACE_CONNECTION_STILL_REFERENCED', `连接 ${alias} 仍被当前工作空间其他 binding 引用。`);
      }
    }
    await manager.removeBinding(args.datasource_id, args.environment, { expectedAlias: alias });
    let deleted = false;
    if (args.delete_owned_connection) {
      try {
        store.removeConnection(alias, identityOf(connection));
        deleted = true;
      } catch (error) {
        try { await manager.setBinding(args.datasource_id, args.environment, alias, false, { requireAbsent: true }); }
        catch (compensationError) {
          throw configError('PARTIAL_CONFIGURATION', `连接 ${alias} 删除失败且 binding 补偿失败；请使用 admin 模式核对连接和 descriptor。`, { error, compensationError });
        }
        throw error;
      }
      await invalidateRuntimeBestEffort(service, alias);
    }
    return result('workspace_datasource_remove', {
      datasource_id: args.datasource_id, environment: args.environment, connection_deleted: deleted,
      reconnect_required: true, reason: '工具目录发生变化；请重新连接以移除旧目标工具。',
    });
  }));

  addTool('workspace_validate');
  server.registerTool('workspace_validate', {
    title: '校验工作空间', description: '校验默认目标、所有 binding、所有权、元数据和工具命名。',
    inputSchema: workspaceValidateSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safe(() => {
    const targets = workspaceTargets(manager, store);
    return result('workspace_validate', {
      workspace_id: manager.context.workspaceId, valid: true, binding_count: manager.allBindings().length,
      exposed_target_count: targets.length, root_hash: manager.context.rootHash,
    });
  }));
}

export function registerWorkspaceTools(input: {
  server: McpServer;
  manager: WorkspaceManager;
  store: StateStore;
  service: MysqlService;
  registry: BusinessOperationRegistry;
  getClientName: () => string;
}): void {
  const names = new Set<string>();
  const targets = workspaceTargets(input.manager, input.store);
  for (const target of targets) registerBoundDataTools(input.server, names, input.manager, input.store, input.service, target, input.getClientName);

  registerName(names, 'history_search');
  input.server.registerTool('history_search', {
    title: '搜索当前工作空间 SQL 历史', description: 'workspace_id 由服务端强制注入；输入不能选择其他工作空间或物理连接。',
    inputSchema: workspaceHistorySearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(() => {
    const history = input.store.searchAudit({
      workspaceId: input.manager.context.workspaceId, datasourceId: args.datasource_id, environment: args.environment,
      executionId: args.execution_id, businessOperationId: args.business_operation_id, clientName: args.client_name,
      statementKind: args.statement_kind, status: args.status, since: args.since ? new Date(args.since).toISOString() : undefined,
      until: args.until ? new Date(args.until).toISOString() : undefined, beforeId: args.before_id, limit: args.limit,
    });
    const records = history.records.map((record) => ({
      id: record.id, execution_id: record.executionId, occurred_at: record.occurredAt,
      datasource_id: record.datasourceId, environment: record.environment,
      business_operation_id: record.businessOperationId, statement_kind: record.statementKind,
      sql_hash: record.sqlHash, duration_ms: record.durationMs, row_count: record.rowCount,
      affected_rows: record.affectedRows, status: record.status, error_category: record.errorCategory,
    }));
    return result('history_search', { record_count: records.length, records, next_before_id: history.nextBeforeId });
  }));

  registerWorkspaceBusinessTools(input.server, names, input.manager, input.store, input.service, input.registry, targets, input.getClientName);
  registerWorkspaceManagementTools(input.server, names, input.manager, input.store, input.service);
}
