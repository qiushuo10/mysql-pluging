import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { z } from 'zod';

import { ALIAS_PATTERN, MAX_AFFECTED_ROWS, MAX_MAX_ROWS } from '../constants.js';
import { PluginError } from '../errors.js';
import type { MysqlService } from '../mysql/service.js';
import { compileNamedParameters, discoverNamedParameters } from '../sql/parameters.js';
import { validateQuerySql, validateWriteSql } from '../sql/validator.js';
import type { SqlParameters, SqlScalar } from '../types.js';
import type { BusinessOperation } from './definition.js';

export class BusinessOperationRegistry {
  private readonly operations: readonly BusinessOperation[];
  private readonly byId: Map<string, BusinessOperation>;

  constructor(operations: readonly BusinessOperation[]) {
    this.operations = [...operations];
    this.byId = new Map();
    for (const operation of this.operations) {
      validateBusinessOperation(operation);
      if (this.byId.has(operation.id)) {
        throw new PluginError({
          category: 'config_error',
          code: 'DUPLICATE_BUSINESS_OPERATION',
          message: `业务操作 ${operation.id} 重复注册。`,
        });
      }
      this.byId.set(operation.id, operation);
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
  ): Promise<Record<string, unknown>> {
    const parameters = parseBusinessParameters(operation, input);
    if (operation.mode === 'read') {
      return service.query({
        connection: operation.connection,
        sql: operation.sql,
        parameters,
        maxRows: operation.maxRows,
        timeoutMs: operation.timeoutMs,
        businessOperationId: operation.id,
        businessPackId: operation.packId,
        businessPackVersion: operation.packVersion,
        businessOperationHash: operation.operationHash,
        retrySafeAfterSend: operation.retrySafe ?? false,
        requestSignal: signal,
        clientName,
      });
    }
    return service.execute({
      connection: operation.connection,
      sql: operation.sql,
      parameters,
      timeoutMs: operation.timeoutMs,
      maxAffectedRows: operation.maxAffectedRows,
      businessOperationId: operation.id,
      businessPackId: operation.packId,
      businessPackVersion: operation.packVersion,
      businessOperationHash: operation.operationHash,
      expectedMode: operation.mode,
      requestSignal: signal,
      clientName,
    });
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
  if (operation.timeoutMs !== undefined && (!Number.isInteger(operation.timeoutMs) || operation.timeoutMs < 100 || operation.timeoutMs > 300_000)) {
    throw new PluginError({ category: 'config_error', code: 'INVALID_BUSINESS_TIMEOUT', message: `业务操作 ${operation.id} 的 timeoutMs 无效。` });
  }
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
