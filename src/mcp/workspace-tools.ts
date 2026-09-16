import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { z } from 'zod';

import type { BusinessOperation } from '../business-queries/definition.js';
import type { DisabledBusinessOperation } from '../business-packs/loader.js';
import { BusinessOperationRegistry } from '../business-queries/registry.js';
import { RegistryGenerationManager } from '../business-queries/generation.js';
import { loadBusinessOperationsFromHomes } from '../business-packs/loader.js';
import type { AddConnectionInput, ConnectionIdentity, StateStore } from '../config/store.js';
import { PluginError, unknownError } from '../errors.js';
import type { MysqlService } from '../mysql/service.js';
import { TraceRecorder, type ExecutionContext, type TraceRootInput } from '../trace/recorder.js';
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
  workspaceTraceSearchSchema,
  workspaceUsageSummarySchema,
  workspaceBusinessCandidateAnalyzeSchema,
  workspaceBusinessReloadSchema,
} from './schemas.js';

interface WorkspaceTarget {
  datasourceId: string;
  environment: ConnectionEnvironment;
  alias: string;
  policy: WorkspaceEnvironment;
  genericSuffix: string;
  identity: ConnectionIdentity;
}

interface TraceCursor {
  startedAt: string;
  runId: string;
}

function encodeTraceCursor(cursor: TraceCursor | null): string | null {
  return cursor === null
    ? null
    : Buffer.from(JSON.stringify({ version: 1, started_at: cursor.startedAt, run_id: cursor.runId }), 'utf8').toString('base64url');
}

function decodeTraceCursor(value: string | undefined): TraceCursor | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') throw new Error('not an object');
    const cursor = decoded as { version?: unknown; started_at?: unknown; run_id?: unknown };
    if (cursor.version !== 1 || typeof cursor.started_at !== 'string' || !Number.isFinite(Date.parse(cursor.started_at))
      || typeof cursor.run_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursor.run_id)) {
      throw new Error('invalid cursor fields');
    }
    return { startedAt: new Date(cursor.started_at).toISOString(), runId: cursor.run_id };
  } catch (error) {
    throw new PluginError({
      category: 'argument_error', code: 'INVALID_TRACE_CURSOR', message: 'trace_search cursor 无效或版本不受支持。', cause: error,
    });
  }
}

function result(kind: string, data: Record<string, unknown>): CallToolResult {
  const structuredContent = {
    schema_version: 'mysql-agent/result/1', execution_id: randomUUID(), status: 'ok', kind, ...data,
  };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}

function failed(
  error: unknown,
  trace?: Pick<ExecutionContext, 'traceId' | 'runId'>,
  telemetryPersisted = trace !== undefined,
): CallToolResult {
  const normalized = unknownError(error);
  const structuredContent = {
    schema_version: 'mysql-agent/result/1', execution_id: randomUUID(), status: 'error',
    category: normalized.category, code: normalized.code, message: normalized.message,
    retryable: normalized.retryable, write_outcome: normalized.writeOutcome,
    trace_id: trace?.traceId ?? null, run_id: trace?.runId ?? null,
    telemetry_persisted: telemetryPersisted,
  };
  return { content: [{ type: 'text', text: `${normalized.code}: ${normalized.message}` }], structuredContent, isError: true };
}

function attachTrace(response: CallToolResult, trace: ExecutionContext | null, telemetryPersisted: boolean): CallToolResult {
  const structuredContent = {
    ...(response.structuredContent ?? {}), trace_id: trace?.traceId ?? null, run_id: trace?.runId ?? null,
    telemetry_persisted: telemetryPersisted,
  };
  return { ...response, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}

async function tracedSafe(
  recorder: TraceRecorder,
  input: TraceRootInput,
  handler: (context: ExecutionContext | undefined) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const context = recorder.tryStartRoot(input);
  try {
    const rawResponse = await handler(context ?? undefined);
    let response = attachTrace(rawResponse, context, context !== null);
    if (context) {
      const queueDurationMs = Number((response.structuredContent as Record<string, unknown> | undefined)?.queue_duration_ms ?? 0);
      const persisted = recorder.finishRoot(context, { status: 'ok', result: response.structuredContent, queueDurationMs });
      if (!persisted) response = attachTrace(rawResponse, context, false);
    }
    return response;
  } catch (error) {
    const normalized = unknownError(error);
    let response = failed(normalized, context ?? undefined, context !== null);
    if (context) {
      const persisted = recorder.finishRoot(context, {
        status: normalized.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'error',
        errorCategory: normalized.category, result: response.structuredContent,
        queueDurationMs: Number((error as { queueDurationMs?: unknown })?.queueDurationMs ?? 0),
      });
      if (!persisted) response = failed(normalized, context, false);
    }
    return response;
  }
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
  // 本地补丁（AUTOSERVE）：原先在此禁止 prod binding 绑定非 read_only 连接
  // （WORKSPACE_PROD_CONNECTION_NOT_READ_ONLY）。现移除该限制，生产是否可写
  // 只由 workspace.yml 的 access_mode 与连接行的 access_mode 共同决定。
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

function resolveWorkspaceConnection(
  manager: WorkspaceManager,
  store: StateStore,
  datasourceId: string,
  environment: ConnectionEnvironment,
  expectedIdentity?: ConnectionIdentity,
): { alias: string; identity: ConnectionIdentity } {
  const alias = manager.binding(datasourceId, environment);
  if (!alias) throw configError('WORKSPACE_BINDING_NOT_FOUND', `binding ${datasourceId}/${environment} 已不存在，请重新连接。`);
  const connection = validateBinding(store, manager.context, { datasourceId, environment, alias });
  if (expectedIdentity && alias !== expectedIdentity.alias) {
    throw configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更；请重新连接以装载对应业务操作。');
  }
  if (expectedIdentity) store.assertConnectionIdentity(expectedIdentity);
  return { alias, identity: expectedIdentity ?? identityOf(connection) };
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

function publicBusinessResult(data: Record<string, unknown>, operation: BusinessOperation, target: WorkspaceTarget): Record<string, unknown> {
  const value = publicWorkspaceResult(data, target);
  if (operation.kind === 'script') {
    value.datasource_ids = operation.datasourceIds;
    delete value.datasource_id;
  }
  return value;
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

interface WorkspaceBusinessDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  target: WorkspaceTarget;
  operations: BusinessOperation[];
}

export interface WorkspaceReloadHooks {
  stageTool?: (name: string, register: () => RegisteredTool) => RegisteredTool;
  updateTool?: (name: string, update: () => void) => void;
  enableTool?: (name: string, enable: () => void) => void;
  disableTool?: (name: string, disable: () => void) => void;
  removeTool?: (name: string, remove: () => void) => void;
  recordEvent?: (record: () => void) => void;
  sendListChanged?: (send: () => void) => void;
}

export const MAX_BUSINESS_TOOL_TOMBSTONES = 32;

class BusinessToolTombstones {
  private readonly handles = new Map<string, RegisteredTool>();

  has(name: string): boolean { return this.handles.has(name); }

  add(name: string, handle: RegisteredTool): void {
    try { handle.disable(); } catch { /* failed removal must still leave the tool hidden */ }
    this.handles.set(name, handle);
    while (this.handles.size > MAX_BUSINESS_TOOL_TOMBSTONES) {
      const oldest = this.handles.entries().next().value as [string, RegisteredTool] | undefined;
      if (!oldest) break;
      try { oldest[1].remove(); } catch { /* local references remain strictly bounded */ }
      this.handles.delete(oldest[0]);
    }
  }

  /** Retry SDK-local removal without a previously failing publication hook. */
  reap(): void {
    for (const [name, handle] of this.handles) {
      try {
        handle.remove();
        this.handles.delete(name);
      } catch { /* retained for a later bounded retry */ }
    }
  }
}

function workspaceBusinessDescriptors(
  registry: BusinessOperationRegistry,
  store: StateStore,
  targets: WorkspaceTarget[],
): Map<string, WorkspaceBusinessDescriptor> {
  const visible: Array<{ target: WorkspaceTarget; operation: BusinessOperation }> = [];
  for (const target of targets) for (const operation of matchingOperations(registry, store, target)) visible.push({ target, operation });
  const descriptors = new Map<string, WorkspaceBusinessDescriptor>();
  for (const { target, operation } of visible.filter((item) => item.operation.exposure === 'direct')) {
    const name = `business__${businessPrefix(target)}${operation.domain}__${operation.name}`;
    descriptors.set(name, {
      name, title: operation.title,
      description: `${operation.description} 目标由工作空间固定为 ${target.datasourceId}/${target.environment}。`,
      inputSchema: operation.input, annotations: annotations(operation), target, operations: [operation],
    });
  }
  const groups = new Map<string, Array<{ target: WorkspaceTarget; operation: BusinessOperation }>>();
  for (const item of visible.filter(({ operation }) => operation.exposure === 'domain')) {
    const lane = item.operation.mode === 'read' ? 'read' : 'write';
    const name = `business__${businessPrefix(item.target)}${item.operation.domain}__${lane}`;
    const group = groups.get(name) ?? [];
    group.push(item); groups.set(name, group);
  }
  for (const [name, group] of groups) {
    const operationNames = group.map(({ operation }) => operation.name);
    if (new Set(operationNames).size !== operationNames.length) {
      throw configError('WORKSPACE_BUSINESS_DISCRIMINATOR_COLLISION', `工具 ${name} 的 operation 名称冲突。`);
    }
    const schemas = group.map(({ operation }) => operation.input);
    const selectedInput = schemas.length === 1 ? schemas[0]! : z.union(schemas as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
    const lane = group[0]!.operation.mode === 'read' ? 'read' : 'write';
    descriptors.set(name, {
      name, title: `${group[0]!.operation.domain} ${lane === 'read' ? '查询' : '写入'}操作`,
      description: '固定业务操作；数据源和环境由工作空间 binding 注入。',
      inputSchema: z.object({ operation: z.enum(operationNames as [string, ...string[]]), input: selectedInput }).strict(),
      annotations: { readOnlyHint: lane === 'read', destructiveHint: lane === 'write', idempotentHint: lane === 'read', openWorldHint: true },
      target: group[0]!.target, operations: group.map(({ operation }) => operation),
    });
  }
  return descriptors;
}

function workspaceBusinessSurface(
  registry: BusinessOperationRegistry,
  store: StateStore,
  targets: WorkspaceTarget[],
): Map<string, string> {
  return new Map([...workspaceBusinessDescriptors(registry, store, targets)].map(([name, descriptor]) => [
    name, JSON.stringify(z.toJSONSchema(descriptor.inputSchema)),
  ]));
}

function workspaceBusinessCatalogSurface(
  registry: BusinessOperationRegistry,
  store: StateStore,
  targets: WorkspaceTarget[],
): Map<string, string> {
  return new Map([...workspaceBusinessDescriptors(registry, store, targets)].map(([name, descriptor]) => [
    name,
    JSON.stringify({
      title: descriptor.title,
      description: descriptor.description,
      annotations: descriptor.annotations,
      inputSchema: z.toJSONSchema(descriptor.inputSchema),
      operations: descriptor.operations.map((operation) => ({
        registrationId: operation.registrationId,
        operationHash: operation.operationHash ?? null,
        scriptHash: operation.scriptHash ?? null,
      })).sort((left, right) => left.registrationId.localeCompare(right.registrationId)),
    }),
  ]));
}

function registerDynamicBusinessTool(input: {
  server: McpServer;
  descriptor: WorkspaceBusinessDescriptor;
  generations: RegistryGenerationManager;
  manager: WorkspaceManager;
  store: StateStore;
  service: MysqlService;
  getClientName: () => string;
  recorder: TraceRecorder;
}): RegisteredTool {
  const { descriptor } = input;
  return input.server.registerTool(descriptor.name, {
    title: descriptor.title, description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    annotations: descriptor.annotations,
  }, async (args, extra) => {
    const lease = input.generations.acquire();
    try {
      const targets = workspaceTargets(input.manager, input.store);
      const current = workspaceBusinessDescriptors(lease.registry, input.store, targets).get(descriptor.name);
      if (!current) return failed(configError('BUSINESS_OPERATION_REMOVED', `业务工具 ${descriptor.name} 已移除。`));
      const parsed = current.inputSchema.parse(args) as Record<string, unknown>;
      const operationName = current.operations.length === 1 && current.operations[0]!.exposure === 'direct'
        ? current.operations[0]!.name
        : String(parsed.operation ?? '');
      const operation = current.operations.find((candidate) => candidate.name === operationName);
      if (!operation) return failed(configError('BUSINESS_OPERATION_NOT_FOUND', `工具 ${descriptor.name} 不包含 ${operationName}。`));
      const operationInput = operation.exposure === 'direct' ? parsed : parsed.input;
      const target = targets.find((candidate) => candidate.datasourceId === current.target.datasourceId
        && candidate.environment === current.target.environment);
      if (!target || target.alias !== operation.connection) {
        return failed(configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更，无法安全解析业务操作。'));
      }
      return await tracedSafe(input.recorder, {
        workspaceId: input.manager.context.workspaceId,
        operationId: publicOperationId(operation, target), operationKind: operation.kind,
        datasourceIds: operation.kind === 'script' ? [...operation.datasourceIds] : [target.datasourceId],
        environment: target.environment,
        connectionAliases: operation.kind === 'script' ? Object.values(operation.connectionBindings) : [target.alias],
        packId: operation.packId, packVersion: operation.packVersion,
        operationHash: operation.operationHash, scriptHash: operation.scriptHash,
      }, async (traceContext) => {
        const value = await lease.registry.execute(operation, operationInput, input.service, extra.signal, input.getClientName(), {
          workspaceId: input.manager.context.workspaceId, datasourceId: target.datasourceId,
          environment: target.environment, expectedConnection: target.identity,
          publicOperationId: publicOperationId(operation, target), traceContext,
          traceRecorder: input.recorder,
          resolveConnection: (datasourceId) => {
            const expected = targets.find((candidate) => candidate.datasourceId === datasourceId
              && candidate.environment === target.environment)?.identity;
            if (!expected) throw configError('BUSINESS_SCRIPT_DEPENDENCY_RESOLUTION_FAILED', `脚本数据源 ${datasourceId}/${target.environment} 无法唯一解析。`);
            return resolveWorkspaceConnection(input.manager, input.store, datasourceId, target.environment, expected);
          },
        });
        return result('business_operation', publicBusinessResult(value, operation, target));
      });
    } finally {
      lease.release();
    }
  });
}

function registerBoundDataTools(
  server: McpServer,
  names: Set<string>,
  manager: WorkspaceManager,
  store: StateStore,
  service: MysqlService,
  initial: WorkspaceTarget,
  getClientName: () => string,
  recorder: TraceRecorder,
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
  }, (args, extra) => tracedSafe(recorder, {
    workspaceId: manager.context.workspaceId, operationId: queryName, operationKind: 'generic_sql',
    datasourceIds: [initial.datasourceId], environment: initial.environment, connectionAliases: [initial.alias],
  }, async (traceContext) => {
    const target = liveTarget(manager, store, initial);
    const value = await service.query({
      connection: target.alias, sql: args.sql, parameters: args.parameters, maxRows: args.max_rows,
      timeoutMs: args.timeout_ms, requestSignal: extra.signal, clientName: getClientName(),
      workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
      expectedConnection: target.identity, traceContext,
      discoveryEnabled: manager.context.discovery.enabled,
    });
    return result('query', publicWorkspaceResult(value, target));
  }));

  const searchName = `schema_search${suffix}`;
  registerName(names, searchName);
  server.registerTool(searchName, {
    title: `搜索 ${targetLabel} Schema`, description: `目标由工作空间固定为 ${targetLabel}。`,
    inputSchema: workspaceSchemaSearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => tracedSafe(recorder, {
    workspaceId: manager.context.workspaceId, operationId: searchName, operationKind: 'schema',
    datasourceIds: [initial.datasourceId], environment: initial.environment, connectionAliases: [initial.alias],
  }, async () => {
    const target = liveTarget(manager, store, initial);
    const value = await service.schema.search({
      connection: target.alias, keyword: args.keyword, limit: args.limit, refresh: args.refresh,
      requestSignal: extra.signal, expectedConnection: target.identity,
    });
    return result('schema_search', publicWorkspaceResult(value, target));
  }));

  const describeName = `schema_describe${suffix}`;
  registerName(names, describeName);
  server.registerTool(describeName, {
    title: `描述 ${targetLabel} Schema`, description: `目标由工作空间固定为 ${targetLabel}。`,
    inputSchema: workspaceSchemaDescribeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => tracedSafe(recorder, {
    workspaceId: manager.context.workspaceId, operationId: describeName, operationKind: 'schema',
    datasourceIds: [initial.datasourceId], environment: initial.environment, connectionAliases: [initial.alias],
  }, async () => {
    const target = liveTarget(manager, store, initial);
    const value = await service.schema.describe({
      connection: target.alias, tables: args.tables, includeRelations: args.include_relations,
      relationDepth: args.relation_depth, includeInferredRelations: args.include_inferred_relations,
      refresh: args.refresh, requestSignal: extra.signal, expectedConnection: target.identity,
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
    }, (args, extra) => tracedSafe(recorder, {
      workspaceId: manager.context.workspaceId, operationId: executeName, operationKind: 'generic_sql',
      datasourceIds: [initial.datasourceId], environment: initial.environment, connectionAliases: [initial.alias],
    }, async (traceContext) => {
      const target = liveTarget(manager, store, initial);
      if (target.policy.accessMode !== 'read_write' || store.requireConnection(target.alias).accessMode !== 'read_write') {
        throw new PluginError({ category: 'permission_error', code: 'WORKSPACE_TARGET_READ_ONLY', message: `${target.datasourceId}/${target.environment} 只允许读取。` });
      }
      const value = await service.execute({
        connection: target.alias, sql: args.sql, parameters: args.parameters, timeoutMs: args.timeout_ms,
        maxAffectedRows: args.max_affected_rows, requestSignal: extra.signal, clientName: getClientName(),
        workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
        expectedConnection: target.identity,
        traceContext,
        discoveryEnabled: manager.context.discovery.enabled,
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
  recorder: TraceRecorder,
  generations: RegistryGenerationManager,
  handles: Map<string, RegisteredTool>,
): void {
  const visible: Array<{ target: WorkspaceTarget; operation: BusinessOperation }> = [];
  for (const target of targets) {
    for (const operation of matchingOperations(registry, store, target)) visible.push({ target, operation });
  }

  for (const item of visible.filter(({ operation }) => operation.exposure === 'direct')) {
    const prefix = businessPrefix(item.target);
    const toolName = `business__${prefix}${item.operation.domain}__${item.operation.name}`;
    registerName(names, toolName);
    const handle = server.registerTool(toolName, {
      title: item.operation.title,
      description: `${item.operation.description} 目标由工作空间固定为 ${item.target.datasourceId}/${item.target.environment}。`,
      inputSchema: item.operation.input,
      annotations: annotations(item.operation),
    }, async (args, extra) => {
      const lease = generations.acquire();
      const operation = lease.registry.operation(item.operation.registrationId);
      if (!operation) { lease.release(); return failed(configError('BUSINESS_OPERATION_REMOVED', `业务操作 ${item.operation.id} 已移除。`)); }
      try { return await tracedSafe(recorder, {
      workspaceId: manager.context.workspaceId, operationId: publicOperationId(operation, item.target), operationKind: operation.kind,
      datasourceIds: operation.kind === 'script' ? [...operation.datasourceIds] : [item.target.datasourceId],
      environment: item.target.environment,
      connectionAliases: operation.kind === 'script' ? Object.values(operation.connectionBindings) : [item.target.alias],
      packId: operation.packId, packVersion: operation.packVersion, operationHash: operation.operationHash,
      scriptHash: operation.scriptHash,
    }, async (traceContext) => {
      const target = liveTarget(manager, store, item.target);
      if (target.alias !== operation.connection) {
        throw configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更；请重新连接以装载对应业务操作。');
      }
      const value = await lease.registry.execute(operation, args, service, extra.signal, getClientName(), {
        workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
        expectedConnection: target.identity, publicOperationId: publicOperationId(operation, target),
        traceContext, traceRecorder: recorder,
        resolveConnection: (datasourceId) => {
          const expected = targets.find((candidate) => candidate.datasourceId === datasourceId && candidate.environment === target.environment)?.identity;
          if (!expected) throw configError('BUSINESS_SCRIPT_DEPENDENCY_RESOLUTION_FAILED', `脚本数据源 ${datasourceId}/${target.environment} 未在启动快照中唯一解析。`);
          return resolveWorkspaceConnection(manager, store, datasourceId, target.environment, expected);
        },
      });
      return result('business_operation', publicBusinessResult(value, operation, target));
    }); } finally { lease.release(); }
    });
    handles.set(toolName, handle);
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
    const handle = server.registerTool(toolName, {
      title: `${qualifiedDomain} ${lane === 'read' ? '查询' : '写入'}操作`,
      description: '固定业务操作；数据源和环境由工作空间 binding 注入。', inputSchema,
      annotations: { readOnlyHint: lane === 'read', destructiveHint: lane === 'write', idempotentHint: lane === 'read', openWorldHint: true },
    }, async (args, extra) => {
      const operationName = String((args as { operation?: unknown }).operation ?? '');
      const selected = group.find(({ operation }) => operation.name === operationName);
      if (!selected) return safe(() => { throw configError('BUSINESS_OPERATION_NOT_FOUND', `工具 ${toolName} 不包含 ${operationName}。`); });
      const lease = generations.acquire();
      const operation = lease.registry.operation(selected.operation.registrationId);
      if (!operation) { lease.release(); return failed(configError('BUSINESS_OPERATION_REMOVED', `业务操作 ${selected.operation.id} 已移除。`)); }
      try { return await tracedSafe(recorder, {
        workspaceId: manager.context.workspaceId, operationId: publicOperationId(operation, selected.target), operationKind: operation.kind,
        datasourceIds: operation.kind === 'script' ? [...operation.datasourceIds] : [selected.target.datasourceId],
        environment: selected.target.environment,
        connectionAliases: operation.kind === 'script' ? Object.values(operation.connectionBindings) : [selected.target.alias],
        packId: operation.packId, packVersion: operation.packVersion, operationHash: operation.operationHash,
        scriptHash: operation.scriptHash,
      }, async (traceContext) => {
        const parsed = inputSchema.parse(args) as { operation: string; input: unknown };
        const target = liveTarget(manager, store, selected.target);
        if (target.alias !== operation.connection) {
          throw configError('WORKSPACE_BUSINESS_RECONNECT_REQUIRED', '业务 binding 已变更；请重新连接以装载对应业务操作。');
        }
        const value = await lease.registry.execute(operation, parsed.input, service, extra.signal, getClientName(), {
          workspaceId: manager.context.workspaceId, datasourceId: target.datasourceId, environment: target.environment,
          expectedConnection: target.identity, publicOperationId: publicOperationId(operation, target), traceContext,
          traceRecorder: recorder,
          resolveConnection: (datasourceId) => {
            const expected = targets.find((candidate) => candidate.datasourceId === datasourceId && candidate.environment === target.environment)?.identity;
            if (!expected) throw configError('BUSINESS_SCRIPT_DEPENDENCY_RESOLUTION_FAILED', `脚本数据源 ${datasourceId}/${target.environment} 未在启动快照中唯一解析。`);
            return resolveWorkspaceConnection(manager, store, datasourceId, target.environment, expected);
          },
        });
        return result('business_operation', publicBusinessResult(value, operation, target));
      });
      } finally { lease.release(); }
    });
    handles.set(toolName, handle);
  }

  registerName(names, 'list_business_operations');
  server.registerTool('list_business_operations', {
    title: '查找当前工作空间业务操作', description: '只列出当前工作空间已解析且暴露的业务操作；不接受物理连接 alias。',
    inputSchema: workspaceListBusinessOperationsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(async () => {
    const lease = generations.acquire();
    try {
    const currentVisible: Array<{ target: WorkspaceTarget; operation: BusinessOperation }> = [];
    for (const target of targets) for (const operation of matchingOperations(lease.registry, store, target)) currentVisible.push({ target, operation });
    const keyword = args.keyword?.toLowerCase();
    const operations = currentVisible
      .filter(({ operation }) => !args.domain || operation.domain === args.domain)
      .filter(({ operation }) => !args.mode || operation.mode === args.mode)
      .filter(({ operation }) => !keyword || [operation.id, operation.title, operation.description, operation.useWhen].join(' ').toLowerCase().includes(keyword))
      .slice(0, args.limit)
      .map(({ operation, target }) => ({
        id: publicOperationId(operation, target), domain: operation.domain, name: operation.name, title: operation.title,
        description: operation.description, use_when: operation.useWhen, mode: operation.mode, kind: operation.kind,
        datasource_id: operation.kind === 'sql' ? target.datasourceId : undefined,
        datasource_ids: operation.kind === 'script' ? operation.datasourceIds : undefined,
        environment: target.environment, exposure: operation.exposure,
        input_schema: z.toJSONSchema(operation.input), business_pack_id: operation.packId ?? null,
        business_pack_version: operation.packVersion ?? null, business_operation_hash: operation.operationHash ?? null,
      }));
    return result('business_operation_list', { operations, generation: lease.generation });
    } finally { lease.release(); }
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
  disabledState: { value: readonly DisabledBusinessOperation[] },
  generations: RegistryGenerationManager,
  businessHandles: Map<string, RegisteredTool>,
  getClientName: () => string,
  recorder: TraceRecorder,
  reloadHooks: WorkspaceReloadHooks,
): void {
  const addTool = (name: string) => registerName(names, name);
  const tombstones = new BusinessToolTombstones();
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
      disabled_business_operations: disabledState.value,
      business_generation: generations.snapshot(),
      last_business_reload: store.latestBusinessReload(manager.context.workspaceId),
    });
  }));

  addTool('workspace_business_reload');
  server.registerTool('workspace_business_reload', {
    title: '重新加载工作空间业务包',
    description: '重新读取并完整校验 business_pack_paths；仅在全部成功后原子切换到新 generation。失败保留上一版本。',
    inputSchema: workspaceBusinessReloadSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, () => safe(async () => {
    const candidateHolder: { value?: BusinessOperationRegistry } = {};
    try {
      const swapped = await generations.serializedReload(async (current) => {
        tombstones.reap();
        let oldSchemaSurface: Map<string, string>;
        let oldCatalogSurface: Map<string, string>;
        const targets = workspaceTargets(manager, store);
        oldSchemaSurface = workspaceBusinessSurface(current.registry, store, targets);
        oldCatalogSurface = workspaceBusinessCatalogSurface(current.registry, store, targets);
        const loaded = loadBusinessOperationsFromHomes(manager.context.businessPackPaths, { workspace: manager.context });
        const candidate = new BusinessOperationRegistry(loaded.operations);
        candidateHolder.value = candidate;
        await candidate.validateScripts();
        const nextDescriptors = workspaceBusinessDescriptors(candidate, store, targets);
        const nextSchemaSurface = workspaceBusinessSurface(candidate, store, targets);
        const nextCatalogSurface = workspaceBusinessCatalogSurface(candidate, store, targets);
        for (const [name, signature] of nextSchemaSurface) {
          const previous = oldSchemaSurface.get(name);
          if (previous !== undefined && previous !== signature) {
            throw configError('BUSINESS_TOOL_SCHEMA_CHANGED', `工具 ${name} 的输入 schema 发生变化；为避免客户端缓存误解析，本次未切换。`);
          }
        }
        const addedNames = [...nextSchemaSurface.keys()].filter((name) => !oldSchemaSurface.has(name));
        const removedNames = [...oldSchemaSurface.keys()].filter((name) => !nextSchemaSurface.has(name));
        const updatedNames = [...nextCatalogSurface.keys()].filter((name) => {
          const previous = oldCatalogSurface.get(name);
          return previous !== undefined && previous !== nextCatalogSurface.get(name);
        });
        const staged = new Map<string, RegisteredTool>();
        const newlyRegistered = new Set<string>();
        const metadataRollbacks: Array<() => void> = [];
        const cleanupStaged = () => {
          for (const [name, handle] of staged) {
            if (!newlyRegistered.has(name)) {
              try { handle.disable(); } catch { /* already disabled */ }
              continue;
            }
            try { reloadHooks.removeTool ? reloadHooks.removeTool(name, () => handle.remove()) : handle.remove(); }
            catch {
              // A hook can mutate and then throw, or throw before mutation. The SDK
              // remove operation is idempotent, so always force the local cleanup.
              try { handle.remove(); } catch { /* best effort */ }
            }
          }
          staged.clear();
          newlyRegistered.clear();
        };
        try {
          for (const name of updatedNames) {
            const handle = businessHandles.get(name);
            const descriptor = nextDescriptors.get(name);
            if (!handle || !descriptor) throw configError('BUSINESS_TOOL_HANDLE_MISSING', `工具 ${name} 缺少活动注册句柄。`);
            const previous = { title: handle.title, description: handle.description, annotations: handle.annotations };
            const update = () => handle.update({ title: descriptor.title, description: descriptor.description, annotations: descriptor.annotations });
            // Register compensation before invoking an injectable mutation: a hook may
            // perform the update and only then throw.
            metadataRollbacks.push(() => handle.update(previous));
            reloadHooks.updateTool ? reloadHooks.updateTool(name, update) : update();
          }
          for (const name of addedNames) {
            if (tombstones.has(name)) {
              throw configError('BUSINESS_TOOL_TOMBSTONE_BUSY', `工具 ${name} 的旧句柄尚未完成回收，请稍后重试。`);
            }
            const stale = businessHandles.get(name);
            const descriptor = nextDescriptors.get(name)!;
            let handle: RegisteredTool;
            if (stale) {
              const previous = {
                title: stale.title, description: stale.description,
                inputSchema: stale.inputSchema, annotations: stale.annotations,
              };
              metadataRollbacks.push(() => stale.update({
                title: previous.title, description: previous.description,
                paramsSchema: (previous.inputSchema as z.ZodObject).shape, annotations: previous.annotations,
              }));
              const update = () => stale.update({
                title: descriptor.title, description: descriptor.description,
                paramsSchema: (descriptor.inputSchema as z.ZodObject).shape, annotations: descriptor.annotations,
              });
              reloadHooks.updateTool ? reloadHooks.updateTool(name, update) : update();
              handle = stale;
            } else {
              const register = () => registerDynamicBusinessTool({
                server, descriptor, generations, manager, store, service, getClientName, recorder,
              });
              handle = reloadHooks.stageTool ? reloadHooks.stageTool(name, register) : register();
              newlyRegistered.add(name);
            }
            staged.set(name, handle);
            const disable = () => handle.disable();
            reloadHooks.disableTool ? reloadHooks.disableTool(name, disable) : disable();
          }
        } catch (error) {
          cleanupStaged();
          for (const rollback of metadataRollbacks.reverse()) { try { rollback(); } catch { /* best effort */ } }
          throw error;
        }
        const enabledStaged: Array<[string, RegisteredTool]> = [];
        const disabledRemoved: Array<[string, RegisteredTool]> = [];
        const rollbackPublication = () => {
          for (const [name, handle] of enabledStaged.reverse()) {
            try { reloadHooks.disableTool ? reloadHooks.disableTool(name, () => handle.disable()) : handle.disable(); } catch { /* best effort */ }
          }
          for (const [name, handle] of disabledRemoved.reverse()) {
            try { reloadHooks.enableTool ? reloadHooks.enableTool(name, () => handle.enable()) : handle.enable(); } catch { /* best effort */ }
          }
          cleanupStaged();
          for (const rollback of metadataRollbacks.reverse()) { try { rollback(); } catch { /* best effort */ } }
        };
        return {
          registry: candidate,
          value: {
            loaded, added: addedNames.length, removed: removedNames.length, updated: updatedNames.length,
          },
          commit: () => {
            for (const [name, handle] of staged) {
              const enable = () => handle.enable();
              enabledStaged.push([name, handle]);
              reloadHooks.enableTool ? reloadHooks.enableTool(name, enable) : enable();
            }
            for (const name of removedNames) {
              const handle = businessHandles.get(name);
              if (!handle) continue;
              const disable = () => handle.disable();
              disabledRemoved.push([name, handle]);
              reloadHooks.disableTool ? reloadHooks.disableTool(name, disable) : disable();
            }
            for (const [name, handle] of staged) { businessHandles.set(name, handle); names.add(name); }
            for (const name of removedNames) names.delete(name);
            disabledState.value = loaded.disabledOperations;
          },
          rollback: rollbackPublication,
          afterCommit: () => {
            for (const [name, handle] of disabledRemoved) {
              try {
                const remove = () => handle.remove();
                reloadHooks.removeTool ? reloadHooks.removeTool(name, remove) : remove();
              } catch (error) {
                tombstones.add(name, handle);
                process.stderr.write(`${JSON.stringify({
                  level: 'warn', event: 'business_tool_remove_failed', tool: name,
                  message: error instanceof Error ? error.message : 'unknown',
                })}\n`);
              } finally {
                businessHandles.delete(name);
              }
            }
            const published = generations.snapshot();
            try {
              const record = () => store.recordBusinessReload({
                workspaceId: manager.context.workspaceId, generation: published.id, status: 'ok',
                contentHash: published.hash, addedTools: addedNames.length,
                updatedTools: updatedNames.length, removedTools: removedNames.length,
              });
              reloadHooks.recordEvent ? reloadHooks.recordEvent(record) : record();
            } catch (error) {
              process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'business_reload_event_failed', generation: published.id, message: error instanceof Error ? error.message : 'unknown' })}\n`);
            }
            try {
              const notify = () => server.sendToolListChanged();
              reloadHooks.sendListChanged ? reloadHooks.sendListChanged(notify) : notify();
            } catch (error) {
              process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'business_tool_list_changed_failed', generation: published.id, message: error instanceof Error ? error.message : 'unknown' })}\n`);
            }
          },
        };
      });
      delete candidateHolder.value;
      return result('workspace_business_reload', {
        generation: swapped.current, previous_generation: swapped.previous,
        added_tools: swapped.value.added, updated_tools: swapped.value.updated, removed_tools: swapped.value.removed,
        disabled_business_operations: swapped.value.loaded.disabledOperations,
        reconnect_recommended: swapped.value.added > 0 || swapped.value.removed > 0,
      });
    } catch (error) {
      if (candidateHolder.value && !(error && typeof error === 'object'
        && (error as { registryCandidateClosed?: unknown }).registryCandidateClosed === true)) {
        await candidateHolder.value.close();
      }
      const normalized = unknownError(error);
      try {
        const record = () => store.recordBusinessReload({
          workspaceId: manager.context.workspaceId, generation: generations.snapshot().id,
          status: 'error', contentHash: generations.snapshot().hash, errorCode: normalized.code,
        });
        reloadHooks.recordEvent ? reloadHooks.recordEvent(record) : record();
      } catch { /* reload outcome remains authoritative even if telemetry is unavailable */ }
      throw error;
    }
  }));
}

export function registerWorkspaceTools(input: {
  server: McpServer;
  manager: WorkspaceManager;
  store: StateStore;
  service: MysqlService;
  registry: BusinessOperationRegistry;
  generationManager: RegistryGenerationManager;
  getClientName: () => string;
  recorder?: TraceRecorder;
  disabledOperations?: readonly DisabledBusinessOperation[];
  reloadHooks?: WorkspaceReloadHooks;
}): void {
  const names = new Set<string>();
  const businessHandles = new Map<string, RegisteredTool>();
  const disabledState: { value: readonly DisabledBusinessOperation[] } = { value: input.disabledOperations ?? [] };
  const recorder = input.recorder ?? new TraceRecorder(input.store);
  const staleBefore = new Date(Date.now() - 60 * 60_000).toISOString();
  input.store.reconcileStaleExecutionRuns(input.manager.context.workspaceId, staleBefore);
  const retentionBefore = new Date(Date.now() - input.manager.context.auditRetentionDays * 86_400_000).toISOString();
  input.store.cleanupExecutionTraces(input.manager.context.workspaceId, retentionBefore);
  if (input.manager.context.discovery.enabled) {
    const discoveryBefore = new Date(Date.now() - input.manager.context.discovery.retentionDays * 86_400_000).toISOString();
    input.store.cleanupDiscovery(input.manager.context.workspaceId, discoveryBefore);
  }
  const targets = workspaceTargets(input.manager, input.store);
  for (const target of targets) registerBoundDataTools(input.server, names, input.manager, input.store, input.service, target, input.getClientName, recorder);

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
      trace_id: record.traceId, span_id: record.spanId, run_id: record.runId,
    }));
    return result('history_search', { record_count: records.length, records, next_before_id: history.nextBeforeId });
  }));

  registerName(names, 'trace_search');
  input.server.registerTool('trace_search', {
    title: '搜索当前工作空间 Trace', description: '只返回当前 workspace 的根调用和步骤摘要；不返回物理连接 alias。',
    inputSchema: workspaceTraceSearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(() => {
    const cursor = decodeTraceCursor(args.cursor);
    const found = input.store.searchExecutionRuns({
      workspaceId: input.manager.context.workspaceId, traceId: args.trace_id, runId: args.run_id,
      operationId: args.operation_id, operationKind: args.operation_kind, status: args.status,
      datasourceId: args.datasource_id, environment: args.environment,
      since: args.since ? new Date(args.since).toISOString() : undefined,
      until: args.until ? new Date(args.until).toISOString() : undefined,
      beforeStartedAt: cursor?.startedAt ?? (args.before_started_at ? new Date(args.before_started_at).toISOString() : undefined),
      beforeRunId: cursor?.runId,
      limit: args.limit,
    });
    const records = found.records.map((run) => ({
      run_id: run.runId, trace_id: run.traceId, root_span_id: run.rootSpanId,
      task_id: run.taskId, operation_id: run.operationId, operation_kind: run.operationKind,
      datasource_ids: run.datasourceIds, environment: run.environment, pack_id: run.packId,
      pack_version: run.packVersion, operation_hash: run.operationHash, script_hash: run.scriptHash,
      started_at: run.startedAt, ended_at: run.endedAt, duration_ms: run.durationMs,
      queue_duration_ms: run.queueDurationMs, status: run.status, error_category: run.errorCategory,
      result_bytes: run.resultBytes,
      spans: input.store.listExecutionSpans(input.manager.context.workspaceId, run.runId).map((span) => ({
        span_id: span.spanId, parent_span_id: span.parentSpanId, operation_id: span.operationId,
        operation_kind: span.operationKind, datasource_id: span.datasourceId, environment: span.environment,
        step_index: span.stepIndex, started_at: span.startedAt, ended_at: span.endedAt,
        duration_ms: span.durationMs, queue_duration_ms: span.queueDurationMs, status: span.status,
        error_category: span.errorCategory, result_bytes: span.resultBytes,
      })),
    }));
    const nextCursor = found.nextBeforeStartedAt && found.nextBeforeRunId
      ? encodeTraceCursor({ startedAt: found.nextBeforeStartedAt, runId: found.nextBeforeRunId })
      : null;
    return result('trace_search', {
      record_count: records.length, records, next_cursor: nextCursor,
      next_before_started_at: found.nextBeforeStartedAt,
    });
  }));

  registerName(names, 'usage_summary');
  input.server.registerTool('usage_summary', {
    title: '统计当前工作空间调用', description: '按当前 workspace 聚合已完成根调用的次数、错误、延迟分位数和结果字节数。',
    inputSchema: workspaceUsageSummarySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(() => {
    const groups = input.store.usageSummary({
      workspaceId: input.manager.context.workspaceId, operationId: args.operation_id,
      operationKind: args.operation_kind, status: args.status, datasourceId: args.datasource_id,
      environment: args.environment, since: args.since ? new Date(args.since).toISOString() : undefined,
      until: args.until ? new Date(args.until).toISOString() : undefined, groupBy: args.group_by,
    }).map((group) => ({
      group: group.group, count: group.count, error_count: group.errorCount,
      p50_ms: group.p50Ms, p95_ms: group.p95Ms, p99_ms: group.p99Ms,
      avg_ms: group.avgMs, result_bytes: group.resultBytes,
    }));
    return result('usage_summary', { group_by: args.group_by ?? null, groups });
  }));

  registerName(names, 'business_candidate_analyze');
  input.server.registerTool('business_candidate_analyze', {
    title: '分析候选业务工具',
    description: '聚合当前工作空间显式开启的通用 SQL discovery 指纹；不返回 SQL、参数值或物理连接 alias。',
    inputSchema: workspaceBusinessCandidateAnalyzeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => safe(() => {
    if (!input.manager.context.discovery.enabled) {
      throw configError('WORKSPACE_DISCOVERY_DISABLED', '当前工作空间未开启 discovery。');
    }
    const discoveryBefore = new Date(Date.now() - input.manager.context.discovery.retentionDays * 86_400_000).toISOString();
    input.store.cleanupDiscovery(input.manager.context.workspaceId, discoveryBefore);
    const candidates = input.store.analyzeDiscoveryCandidates({
      workspaceId: input.manager.context.workspaceId,
      since: args.since ? new Date(args.since).toISOString() : undefined,
      until: args.until ? new Date(args.until).toISOString() : undefined,
      minCount: args.min_count,
      limit: args.limit,
    });
    const publishedUsage = (['sql', 'script'] as const).flatMap((operationKind) => input.store.usageSummary({
      workspaceId: input.manager.context.workspaceId, operationKind, groupBy: 'operation',
      since: args.since ? new Date(args.since).toISOString() : undefined,
      until: args.until ? new Date(args.until).toISOString() : undefined,
    }).map((group) => ({ operation_id: group.group, operation_kind: operationKind, count: group.count, error_count: group.errorCount })));
    return result('business_candidate_analysis', { candidates, published_usage: publishedUsage });
  }));

  registerWorkspaceBusinessTools(input.server, names, input.manager, input.store, input.service, input.registry, targets, input.getClientName, recorder, input.generationManager, businessHandles);
  registerWorkspaceManagementTools(input.server, names, input.manager, input.store, input.service, disabledState, input.generationManager, businessHandles, input.getClientName, recorder, input.reloadHooks ?? {});
}
