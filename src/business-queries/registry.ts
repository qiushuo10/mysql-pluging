import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { z } from 'zod';

import { ALIAS_PATTERN, MAX_AFFECTED_ROWS, MAX_MAX_ROWS } from '../constants.js';
import { PluginError } from '../errors.js';
import type { MysqlService } from '../mysql/service.js';
import type { ConnectionIdentity } from '../config/store.js';
import type { BusinessScriptRuntime } from '../business-scripts/runtime.js';
import { RunBusinessScriptRuntime } from '../business-scripts/runtime.js';
import { compileNamedParameters, discoverNamedParameters } from '../sql/parameters.js';
import { validateQuerySql, validateWriteSql } from '../sql/validator.js';
import { TraceRecorder, type ExecutionContext } from '../trace/recorder.js';
import type { SqlParameters, SqlScalar } from '../types.js';
import type { ConnectionEnvironment } from '../types.js';
import type { BusinessOperation } from './definition.js';

const SCRIPT_CHILD_CLEANUP_TIMEOUT_MS = 500;

interface SafeHostError {
  category: PluginError['category'];
  code: string;
  retryable: boolean;
  writeOutcome: PluginError['writeOutcome'];
}

interface TrackedChild {
  context: ExecutionContext;
  finished: boolean;
  settled: Promise<void>;
}

function scriptChildResult(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of [
    'schema_version', 'status', 'kind', 'columns', 'rows', 'row_count', 'truncated',
    'duration_ms', 'attempt_count', 'queue_duration_ms', 'business_operation_id',
    'business_pack_id', 'business_pack_version', 'business_operation_hash',
  ]) {
    if (Object.hasOwn(value, key)) output[key] = value[key];
  }
  return output;
}

function safeHostPluginError(error: PluginError): SafeHostError {
  return {
    category: error.category, code: error.code, retryable: error.retryable,
    writeOutcome: error.writeOutcome,
  };
}

function restoredHostError(error: SafeHostError): PluginError {
  return new PluginError({
    category: error.category, code: error.code,
    message: '业务脚本内部操作失败；详细原因已脱敏，请通过 trace_id 检查对应步骤。',
    retryable: error.retryable, writeOutcome: error.writeOutcome,
  });
}

export class BusinessOperationRegistry {
  private readonly operations: readonly BusinessOperation[];
  private readonly byId: Map<string, BusinessOperation>;

  constructor(
    operations: readonly BusinessOperation[],
    private readonly scriptRuntime: BusinessScriptRuntime = new RunBusinessScriptRuntime(),
  ) {
    this.operations = [...operations];
    this.byId = new Map();
    for (const operation of this.operations) {
      validateBusinessOperation(operation);
      if (this.byId.has(operation.registrationId)) {
        throw new PluginError({
          category: 'config_error',
          code: 'DUPLICATE_BUSINESS_OPERATION',
          message: `业务操作 ${operation.id} 重复注册。`,
        });
      }
      this.byId.set(operation.registrationId, operation);
    }
    this.validateToolNames();
    const directCount = this.operations.filter((operation) => operation.exposure === 'direct').length;
    if (this.operations.length > 30 && directCount > 30) {
      throw new PluginError({
        category: 'config_error',
        code: 'TOO_MANY_DIRECT_BUSINESS_TOOLS',
        message: '业务操作超过 30 个后，最多只能保留 30 个 direct 工具，其余操作必须按业务域收敛。',
      });
    }
    for (const group of this.grouped()) {
      if (group.operations.length > 15) {
        throw new PluginError({
          category: 'config_error',
          code: 'BUSINESS_DOMAIN_TOO_LARGE',
          message: `业务域入口 ${group.toolName} 包含 ${group.operations.length} 个操作，超过上限 15，请继续拆分业务域。`,
        });
      }
    }
  }

  private validateToolNames(): void {
    const tools = new Map<string, string>();
    const add = (toolName: string, owner: string) => {
      const validation = validateToolName(toolName);
      if (!validation.isValid) {
        throw new PluginError({
          category: 'config_error', code: 'INVALID_BUSINESS_TOOL_NAME',
          message: `业务工具名 ${toolName} 不符合 MCP 工具名规则：${validation.warnings.join('；')}。`,
        });
      }
      const existing = tools.get(toolName);
      if (existing) {
        throw new PluginError({
          category: 'config_error', code: 'BUSINESS_TOOL_NAME_COLLISION',
          message: `业务工具名 ${toolName} 同时由 ${existing} 和 ${owner} 生成。`,
        });
      }
      tools.set(toolName, owner);
    };
    for (const operation of this.direct()) add(businessDirectToolName(operation), operation.id);
    for (const group of this.grouped()) {
      const names = new Set<string>();
      for (const operation of group.operations) {
        if (names.has(operation.name)) {
          throw new PluginError({
            category: 'config_error', code: 'DUPLICATE_BUSINESS_DISCRIMINATOR',
            message: `业务域入口 ${group.toolName} 重复使用 operation=${operation.name}。`,
          });
        }
        names.add(operation.name);
      }
      add(group.toolName, group.operations.map((operation) => operation.id).join(','));
    }
  }

  list(filters: { connection: string; domain?: string; keyword?: string; mode?: string; limit?: number }): Array<Record<string, unknown>> {
    const keyword = filters.keyword?.toLowerCase();
    return this.operations
      .filter((operation) => operation.connection === filters.connection)
      .filter((operation) => !filters.domain || operation.domain === filters.domain)
      .filter((operation) => !filters.mode || operation.mode === filters.mode)
      .filter(
        (operation) =>
          !keyword ||
          [operation.id, operation.title, operation.description, operation.useWhen]
            .join(' ')
            .toLowerCase()
            .includes(keyword),
      )
      .slice(0, filters.limit ?? 50)
      .map((operation) => ({
        id: operation.id,
        domain: operation.domain,
        name: operation.name,
        title: operation.title,
        description: operation.description,
        use_when: operation.useWhen,
        mode: operation.mode,
        connection: operation.connection,
        exposure: operation.exposure,
        input_schema: z.toJSONSchema(operation.input),
        result_description: operation.resultDescription ?? null,
        business_pack_id: operation.packId ?? null,
        business_pack_version: operation.packVersion ?? null,
        business_operation_hash: operation.operationHash ?? null,
      }));
  }

  direct(): readonly BusinessOperation[] {
    return this.operations.filter((operation) => operation.exposure === 'direct');
  }

  all(): readonly BusinessOperation[] {
    return this.operations;
  }

  async close(): Promise<void> {
    await this.scriptRuntime.close();
  }

  grouped(): Array<{ toolName: string; connection: string; domain: string; lane: 'read' | 'write'; operations: BusinessOperation[] }> {
    const groups = new Map<string, BusinessOperation[]>();
    for (const operation of this.operations.filter((item) => item.exposure === 'domain')) {
      const lane = operation.mode === 'read' ? 'read' : 'write';
      const key = `${operation.connection}\u0000${operation.domain}\u0000${lane}`;
      const items = groups.get(key) ?? [];
      items.push(operation);
      groups.set(key, items);
    }
    return [...groups.entries()].map(([key, operations]) => {
      const [connection, domain, lane] = key.split('\u0000') as [string, string, 'read' | 'write'];
      return { toolName: `business__${connection}__${domain}__${lane}`, connection, domain, lane, operations };
    });
  }

  async execute(
    operation: BusinessOperation,
    input: unknown,
    service: MysqlService,
    signal?: AbortSignal,
    clientName?: string,
    executionContext?: {
      workspaceId: string;
      datasourceId: string;
      environment: ConnectionEnvironment;
      expectedConnection?: ConnectionIdentity;
      publicOperationId?: string;
      traceContext?: ExecutionContext;
      traceRecorder?: TraceRecorder;
      resolveConnection?: (datasourceId: string) => { alias: string; identity: ConnectionIdentity };
    },
  ): Promise<Record<string, unknown>> {
    if (operation.kind === 'script') {
      return this.executeScript(operation, input, service, signal, clientName, executionContext);
    }
    const parameters = parseBusinessParameters(operation, input);
    if (operation.mode === 'read') {
      return service.query({
        connection: operation.connection,
        sql: operation.sql,
        parameters,
        maxRows: operation.maxRows,
        timeoutMs: operation.timeoutMs,
        businessOperationId: executionContext?.publicOperationId ?? operation.id,
        businessPackId: operation.packId,
        businessPackVersion: operation.packVersion,
        businessOperationHash: operation.operationHash,
        retrySafeAfterSend: operation.retrySafe ?? false,
        requestSignal: signal,
        clientName,
        workspaceId: executionContext?.workspaceId,
        datasourceId: executionContext?.datasourceId,
        environment: executionContext?.environment,
        expectedConnection: executionContext?.expectedConnection,
        traceContext: executionContext?.traceContext,
      });
    }
    return service.execute({
      connection: operation.connection,
      sql: operation.sql,
      parameters,
      timeoutMs: operation.timeoutMs,
      maxAffectedRows: operation.maxAffectedRows,
      businessOperationId: executionContext?.publicOperationId ?? operation.id,
      businessPackId: operation.packId,
      businessPackVersion: operation.packVersion,
      businessOperationHash: operation.operationHash,
      expectedMode: operation.mode,
      requestSignal: signal,
      clientName,
      workspaceId: executionContext?.workspaceId,
      datasourceId: executionContext?.datasourceId,
      environment: executionContext?.environment,
      expectedConnection: executionContext?.expectedConnection,
      traceContext: executionContext?.traceContext,
    });
  }

  private async executeScript(
    operation: BusinessOperation,
    input: unknown,
    service: MysqlService,
    signal?: AbortSignal,
    clientName?: string,
    executionContext?: {
      workspaceId: string;
      datasourceId: string;
      environment: ConnectionEnvironment;
      expectedConnection?: ConnectionIdentity;
      publicOperationId?: string;
      traceContext?: ExecutionContext;
      traceRecorder?: TraceRecorder;
      resolveConnection?: (datasourceId: string) => { alias: string; identity: ConnectionIdentity };
    },
  ): Promise<Record<string, unknown>> {
    if (!executionContext?.traceContext || !executionContext.traceRecorder || !executionContext.resolveConnection || !operation.environment) {
      throw new PluginError({ category: 'config_error', code: 'BUSINESS_SCRIPT_WORKSPACE_REQUIRED', message: '脚本业务操作只能在可追踪的 workspace context 中执行。' });
    }
    const parsed = operation.input.parse(input) as Record<string, unknown>;
    let stepIndex = 0;
    const trackedChildren: TrackedChild[] = [];
    const hostErrors: SafeHostError[] = [];
    let runtimeResult: Awaited<ReturnType<BusinessScriptRuntime['execute']>> | undefined;
    let runtimeError: unknown;
    try {
      runtimeResult = await this.scriptRuntime.execute({
        id: operation.id,
        source: operation.script!,
        timeoutMs: operation.timeoutMs ?? 10_000,
        maxResultBytes: operation.maxResultBytes ?? 262_144,
        input: parsed,
        signal,
        callOperation: async (operationId, childInput, childSignal) => {
          const childStep = ++stepIndex;
          try {
            if (!operation.uses.includes(operationId)) {
              throw new PluginError({ category: 'permission_error', code: 'BUSINESS_SCRIPT_OPERATION_NOT_ALLOWED', message: '脚本请求了未授权的内部操作。' });
            }
            const matches = this.operations.filter((candidate) => candidate.kind === 'sql'
              && candidate.id === operationId && candidate.environment === operation.environment);
            if (matches.length !== 1) {
              throw new PluginError({ category: 'config_error', code: 'BUSINESS_SCRIPT_DEPENDENCY_RESOLUTION_FAILED', message: `内部操作 ${operationId} 无法在当前环境唯一解析。` });
            }
            const dependency = matches[0]!;
            if (dependency.mode !== 'read') {
              throw new PluginError({ category: 'permission_error', code: 'BUSINESS_SCRIPT_WRITE_FORBIDDEN', message: '脚本只能调用只读业务操作。' });
            }
            const datasourceId = dependency.datasourceIds[0];
            if (!datasourceId || !operation.datasourceIds.includes(datasourceId)) {
              throw new PluginError({ category: 'permission_error', code: 'BUSINESS_SCRIPT_DATASOURCE_NOT_ALLOWED', message: '脚本请求了未声明的数据源。' });
            }
            const live = executionContext.resolveConnection!(datasourceId);
            if (dependency.connection !== live.alias || operation.connectionBindings[datasourceId] !== live.alias) {
              throw new PluginError({ category: 'permission_error', code: 'BUSINESS_SCRIPT_TARGET_CHANGED', message: '脚本依赖的 workspace binding 已变化，请重新连接。' });
            }
            const childContext = executionContext.traceRecorder!.startChild(executionContext.traceContext!, {
              operationId: dependency.id, operationKind: 'sql', datasourceId, environment: operation.environment,
              connectionAlias: live.alias, stepIndex: childStep,
            });
            const tracked: TrackedChild = { context: childContext, finished: false, settled: Promise.resolve() };
            const work = (async () => {
              try {
                const childValue = await this.execute(dependency, childInput, service, childSignal, clientName, {
                  workspaceId: executionContext.workspaceId, datasourceId, environment: operation.environment!,
                  expectedConnection: live.identity, publicOperationId: dependency.id, traceContext: childContext,
                });
                if (!tracked.finished) {
                  tracked.finished = true;
                  executionContext.traceRecorder!.finishSpan(childContext, {
                    status: 'ok', result: childValue,
                    queueDurationMs: Number(childValue.queue_duration_ms ?? 0),
                  });
                }
                return scriptChildResult(childValue);
              } catch (error) {
                if (!tracked.finished) {
                  tracked.finished = true;
                  const plugin = error as { category?: string; code?: string; queueDurationMs?: unknown };
                  executionContext.traceRecorder!.finishSpan(childContext, {
                    status: plugin.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'error',
                    errorCategory: plugin.category ?? 'internal_error',
                    queueDurationMs: Number(plugin.queueDurationMs ?? 0),
                  });
                }
                throw error;
              }
            })();
            tracked.settled = work.then(() => undefined, () => undefined);
            trackedChildren.push(tracked);
            return await work;
          } catch (error) {
            if (error instanceof PluginError) hostErrors.push(safeHostPluginError(error));
            throw new Error('业务脚本内部操作失败。');
          }
        },
      });
    } catch (error) {
      runtimeError = error;
    } finally {
      const pending = trackedChildren.filter((child) => !child.finished);
      if (pending.length > 0) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled(pending.map((child) => child.settled)),
            new Promise<void>((resolveDelay) => { cleanupTimer = setTimeout(resolveDelay, SCRIPT_CHILD_CLEANUP_TIMEOUT_MS); }),
          ]);
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
        for (const child of pending) {
          if (child.finished) continue;
          child.finished = true;
          executionContext.traceRecorder.finishSpan(child.context, {
            status: signal?.aborted || (runtimeError as { code?: unknown } | undefined)?.code === 'REQUEST_CANCELLED'
              || (runtimeError as { code?: unknown } | undefined)?.code === 'BUSINESS_SCRIPT_TIMEOUT'
              ? 'cancelled' : 'error',
            errorCategory: (runtimeError as { category?: string } | undefined)?.category ?? 'internal_error',
          });
        }
      }
    }
    if (runtimeError !== undefined) {
      const code = (runtimeError as { code?: unknown })?.code;
      // run@2.1.4 and the provider-neutral adapter do not retain per-request identity on the mapped error.
      // Restore semantics only when exactly one host failure exists; multiple candidates must stay generic.
      if (code === 'BUSINESS_SCRIPT_HOST_CALL_FAILED' && hostErrors.length === 1) {
        throw restoredHostError(hostErrors[0]!);
      }
      throw runtimeError;
    }
    const result = runtimeResult!;
    return {
      schema_version: 'mysql-agent/result/1', status: 'ok', kind: 'business_script',
      business_operation_id: executionContext.publicOperationId ?? operation.id,
      business_pack_id: operation.packId ?? null, business_pack_version: operation.packVersion ?? null,
      business_operation_hash: operation.operationHash ?? null, script_hash: operation.scriptHash ?? null,
      output: result.value, result_bytes: result.resultBytes,
    };
  }
}

export function businessDirectToolName(operation: BusinessOperation): string {
  return `business__${operation.connection}__${operation.domain}__${operation.name}`;
}

type PlaceholderKind = 'scalar' | 'list';
type JsonSchema = Record<string, unknown>;

function placeholderKinds(sql: string): Map<string, PlaceholderKind> {
  const kinds = new Map<string, PlaceholderKind>();
  for (const token of discoverNamedParameters(sql)) {
    const { name, kind } = token;
    const existing = kinds.get(name);
    if (existing && existing !== kind) {
      throw new PluginError({
        category: 'config_error', code: 'INVALID_BUSINESS_SQL_PARAMETERS',
        message: `业务 SQL 参数 ${name} 不能同时作为标量和列表使用。`,
      });
    }
    kinds.set(name, kind);
  }
  return kinds;
}

function schemaRecord(value: unknown): JsonSchema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchema : null;
}

function supportedScalarSchema(schema: JsonSchema): boolean {
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.length > 0 && schema.anyOf.every((item) => {
      const branch = schemaRecord(item);
      return branch !== null && supportedScalarSchema(branch);
    });
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0 || types.some((type) => !['string', 'boolean', 'null', 'number', 'integer'].includes(String(type)))) {
    return false;
  }
  if (types.includes('number') || types.includes('integer')) {
    const enumerated = Array.isArray(schema.enum)
      ? schema.enum.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
      : typeof schema.const === 'number' && Number.isFinite(schema.const) && Math.abs(schema.const) <= Number.MAX_SAFE_INTEGER;
    const bounded = typeof schema.minimum === 'number' && schema.minimum >= -Number.MAX_SAFE_INTEGER
      && typeof schema.maximum === 'number' && schema.maximum <= Number.MAX_SAFE_INTEGER;
    if (!enumerated && !bounded) return false;
  }
  return true;
}

function supportedZodOutput(schema: unknown, allowArray: boolean): boolean {
  const holder = schemaRecord(schema);
  const def = schemaRecord(holder?._zod)?.def ?? holder?._def;
  const definition = schemaRecord(def);
  if (!definition || definition.coerce === true) return false;
  const type = definition.type;
  if (type === 'array') return allowArray && supportedZodOutput(definition.element, false);
  if (type === 'union') {
    return !allowArray && Array.isArray(definition.options)
      && definition.options.length > 0
      && definition.options.every((option) => supportedZodOutput(option, false));
  }
  if (type === 'nullable') return !allowArray && supportedZodOutput(definition.innerType, false);
  return !allowArray && ['string', 'number', 'boolean', 'null', 'literal', 'enum'].includes(String(type));
}

function validateInputCompatibility(operation: BusinessOperation, kinds: Map<string, PlaceholderKind>): void {
  let schema: JsonSchema;
  try {
    const generated = z.toJSONSchema(operation.input);
    const record = schemaRecord(generated);
    if (!record) throw new Error('input schema is not an object');
    schema = record;
  } catch (error) {
    throw new PluginError({
      category: 'config_error', code: 'INVALID_BUSINESS_INPUT_SCHEMA',
      message: `业务操作 ${operation.id} 的 input schema 不能安全映射为 SQL 参数。`, cause: error,
    });
  }
  const properties = schemaRecord(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : []);
  if (schema.type !== 'object' || schema.additionalProperties !== false || !properties) {
    throw new PluginError({
      category: 'config_error', code: 'INVALID_BUSINESS_INPUT_SCHEMA',
      message: `业务操作 ${operation.id} 的 input schema 必须是严格对象。`,
    });
  }
  for (const [name, kind] of kinds) {
    const propertySchema = schemaRecord(properties[name]);
    const zodProperty = operation.input.shape[name];
    if (!required.has(name) || !propertySchema || !zodProperty) {
      throw new PluginError({
        category: 'config_error', code: 'INVALID_BUSINESS_INPUT_SCHEMA',
        message: `业务操作 ${operation.id} 的 SQL 参数 ${name} 必须是 input schema 的必填属性。`,
      });
    }
    if (kind === 'list') {
      const items = schemaRecord(propertySchema.items);
      if (propertySchema.type !== 'array' || typeof propertySchema.minItems !== 'number' || propertySchema.minItems < 1
        || typeof propertySchema.maxItems !== 'number' || propertySchema.maxItems > 100
        || !items || !supportedScalarSchema(items) || !supportedZodOutput(zodProperty, true)) {
        throw new PluginError({
          category: 'config_error', code: 'INVALID_BUSINESS_INPUT_SCHEMA',
          message: `业务操作 ${operation.id} 的列表参数 ${name} 必须是 1..100 个受支持标量的一维数组。`,
        });
      }
    } else if (propertySchema.type === 'array' || !supportedScalarSchema(propertySchema) || !supportedZodOutput(zodProperty, false)) {
      throw new PluginError({
        category: 'config_error', code: 'INVALID_BUSINESS_INPUT_SCHEMA',
        message: `业务操作 ${operation.id} 的标量参数 ${name} 类型不受支持。`,
      });
    }
  }
}

function isSqlScalar(value: unknown): value is SqlScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
}

/** Revalidates parsed Zod output before it can reach named SQL compilation. */
export function parseBusinessParameters(operation: BusinessOperation, input: unknown): SqlParameters {
  if (operation.kind !== 'sql' || operation.sql === undefined) {
    throw new PluginError({ category: 'config_error', code: 'BUSINESS_SQL_REQUIRED', message: `业务操作 ${operation.id} 不是 SQL 操作。` });
  }
  const parsed: unknown = operation.input.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginError({ category: 'argument_error', code: 'INVALID_BUSINESS_PARAMETER_VALUE', message: '业务操作参数必须是对象。' });
  }
  const kinds = placeholderKinds(operation.sql);
  const parameters: SqlParameters = {};
  for (const [name, kind] of kinds) {
    const value: unknown = (parsed as Record<string, unknown>)[name];
    if (kind === 'list') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(isSqlScalar)) {
        throw new PluginError({ category: 'argument_error', code: 'INVALID_BUSINESS_PARAMETER_VALUE', message: `业务列表参数 ${name} 的解析结果无效。` });
      }
      parameters[name] = [...value];
    } else {
      if (!isSqlScalar(value)) {
        throw new PluginError({ category: 'argument_error', code: 'INVALID_BUSINESS_PARAMETER_VALUE', message: `业务标量参数 ${name} 的解析结果无效。` });
      }
      parameters[name] = value;
    }
  }
  return parameters;
}

function validateBusinessOperation(operation: BusinessOperation): void {
  if (!ALIAS_PATTERN.test(operation.connection)) {
    throw new PluginError({
      category: 'config_error', code: 'INVALID_BUSINESS_CONNECTION',
      message: `业务操作 ${operation.id} 的 connection ${operation.connection} 不符合别名规则。`,
    });
  }
  const timeoutMaximum = operation.kind === 'script' ? 10_000 : 300_000;
  if (operation.timeoutMs !== undefined && (!Number.isInteger(operation.timeoutMs) || operation.timeoutMs < 100 || operation.timeoutMs > timeoutMaximum)) {
    throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_TIMEOUT', message: `业务操作 ${operation.id} 的 timeoutMs 无效。` });
  }
  if (operation.kind === 'script') {
    if (operation.mode !== 'read' || !operation.script || operation.uses.length < 1 || operation.uses.length > 16
      || operation.datasourceIds.length < 1 || operation.datasourceIds.length > 16
      || !operation.environment || !Number.isInteger(operation.maxResultBytes)
      || operation.maxResultBytes! < 1 || operation.maxResultBytes! > 262_144) {
      throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_SCRIPT', message: `业务脚本 ${operation.id} 的定义或边界无效。` });
    }
    return;
  }
  if (operation.sql === undefined) throw new PluginError({ category: 'config_error', code: 'BUSINESS_SQL_REQUIRED', message: `业务操作 ${operation.id} 缺少 SQL。` });
  const kinds = placeholderKinds(operation.sql);
  const parameters: SqlParameters = Object.fromEntries(
    [...kinds].map(([name, kind]) => [name, kind === 'list' ? [null] : null]),
  );
  const sqlParameterNames = Object.keys(parameters).sort();
  const inputNames = Object.keys(operation.input.shape).sort();
  if (JSON.stringify(sqlParameterNames) !== JSON.stringify(inputNames)) {
    throw new PluginError({
      category: 'config_error', code: 'INVALID_BUSINESS_SQL_PARAMETERS',
      message: `业务操作 ${operation.id} 的 SQL 参数与 input schema 不一致。`,
    });
  }
  validateInputCompatibility(operation, kinds);
  let compiled: string;
  try {
    compiled = compileNamedParameters(operation.sql, parameters).sql;
  } catch (error) {
    throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_SQL_PARAMETERS', message: `业务操作 ${operation.id} 的 SQL 参数无效。`, cause: error });
  }
  const allowed = [...compiled.matchAll(/\b([A-Za-z_][A-Za-z0-9_$-]*)\s*\./g)].map((match) => match[1]!);
  try {
    if (operation.mode === 'read') {
      if (!Number.isInteger(operation.maxRows) || operation.maxRows! < 1 || operation.maxRows! > MAX_MAX_ROWS) {
        throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_MAX_ROWS', message: `只读业务操作 ${operation.id} 必须声明 1..${MAX_MAX_ROWS} 的 maxRows。` });
      }
      if (operation.maxAffectedRows !== undefined) throw new Error('read operation has maxAffectedRows');
      const validation = validateQuerySql(compiled, allowed, operation.maxRows!);
      if (validation.kind !== 'select') throw new Error(`read kind ${validation.kind}`);
    } else {
      if (operation.maxRows !== undefined || operation.retrySafe === true) throw new Error('write operation has read-only metadata');
      if (operation.maxAffectedRows !== undefined && (!Number.isInteger(operation.maxAffectedRows) || operation.maxAffectedRows < 1 || operation.maxAffectedRows > MAX_AFFECTED_ROWS)) {
        throw new Error('invalid maxAffectedRows');
      }
      const validation = validateWriteSql(compiled, allowed);
      if (validation.kind !== operation.mode) throw new Error(`mode ${operation.mode} does not match ${validation.kind}`);
    }
  } catch (error) {
    if (error instanceof PluginError && error.code === 'INVALID_BUSINESS_MAX_ROWS') throw error;
    if (error instanceof PluginError && (error.code === 'EXECUTABLE_COMMENT_FORBIDDEN' || error.code === 'BARE_CARRIAGE_RETURN_FORBIDDEN')) {
      throw new PluginError({
        category: 'config_error', code: error.code,
        message: error.code === 'EXECUTABLE_COMMENT_FORBIDDEN'
          ? `业务操作 ${operation.id} 的固定 SQL 不允许 MySQL 或 MariaDB 可执行注释。`
          : `业务操作 ${operation.id} 的固定 SQL 不允许未组成 CRLF 的单独回车符。`,
        cause: error,
      });
    }
    throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_SQL', message: `业务操作 ${operation.id} 的固定 SQL、模式或边界无效。`, cause: error });
  }
}
