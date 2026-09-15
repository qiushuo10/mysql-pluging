import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { defineBusinessOperation, type BusinessOperation } from '../business-queries/definition.js';
import { ALIAS_PATTERN, MAX_AFFECTED_ROWS, MAX_MAX_ROWS, MAX_SQL_BYTES, PARAMETER_NAME_PATTERN } from '../constants.js';
import { PluginError } from '../errors.js';
import type { ConnectionEnvironment } from '../types.js';
import type { WorkspaceContext } from '../workspace/context.js';

const PACK_V1 = 'mysql-agent/business-pack/1';
const PACK_V2 = 'mysql-agent/business-pack/2';
const MAX_PACK_FILE_BYTES = 1_048_576;
const MAX_SCRIPT_BYTES = 65_536;
const MAX_SCRIPT_RESULT_BYTES = 262_144;
const PACK_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const TOOL_PART_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const environmentSchema = z.enum(['dev', 'test', 'staging', 'prod', 'custom']);

const commonField = { description: z.string().max(256).optional(), nullable: z.boolean().default(false) };
const stringFieldSchema = z.object({
  type: z.literal('string'), ...commonField, min_length: z.number().int().min(0).max(65_536).default(0),
  max_length: z.number().int().min(1).max(65_536).default(1_024), pattern: z.string().max(1_024).optional(),
  trim: z.boolean().default(false),
}).strict().refine((field) => field.min_length <= field.max_length, { message: 'min_length must not exceed max_length' });
const numberFieldSchema = z.object({
  type: z.enum(['number', 'integer']), ...commonField, minimum: z.number().safe().default(Number.MIN_SAFE_INTEGER),
  maximum: z.number().safe().default(Number.MAX_SAFE_INTEGER),
}).strict().refine((field) => field.minimum <= field.maximum, { message: 'minimum must not exceed maximum' });
const booleanFieldSchema = z.object({ type: z.literal('boolean'), ...commonField }).strict();
const nullFieldSchema = z.object({ type: z.literal('null'), description: commonField.description }).strict();
const scalarFieldSchema = z.discriminatedUnion('type', [stringFieldSchema, numberFieldSchema, booleanFieldSchema, nullFieldSchema]);
const arrayFieldSchema = z.object({
  type: z.literal('array'), description: commonField.description, items: scalarFieldSchema,
  min_items: z.number().int().min(1).max(100).default(1), max_items: z.number().int().min(1).max(100).default(100),
}).strict().refine((field) => field.min_items <= field.max_items, { message: 'min_items must not exceed max_items' });
const parameterFieldSchema = z.union([scalarFieldSchema, arrayFieldSchema]);
const inputSchema = z.record(z.string().regex(PARAMETER_NAME_PATTERN), parameterFieldSchema);
const commonOperation = {
  id: z.string().regex(PACK_ID_PATTERN), domain: z.string().regex(TOOL_PART_PATTERN), name: z.string().regex(TOOL_PART_PATTERN),
  title: z.string().min(1).max(256), description: z.string().min(1).max(1_024), use_when: z.string().min(1).max(2_048),
  exposure: z.enum(['direct', 'domain']).default('domain'), input: inputSchema,
};

const v1OperationSchema = z.object({
  ...commonOperation, connections: z.array(z.string().regex(ALIAS_PATTERN)).min(1).max(32),
  mode: z.enum(['read', 'insert', 'update', 'delete']), sql_file: z.string().min(1).max(512),
  timeout_ms: z.number().int().min(100).max(300_000).optional(), max_rows: z.number().int().min(1).max(MAX_MAX_ROWS).optional(),
  max_affected_rows: z.number().int().min(1).max(MAX_AFFECTED_ROWS).optional(), retry_safe: z.boolean().optional(),
  result_description: z.string().max(2_048).optional(),
}).strict().superRefine(validateSqlShape);

const v2SqlOperationSchema = z.object({
  ...commonOperation, kind: z.literal('sql'), datasource: z.string().regex(ALIAS_PATTERN),
  environments: z.array(environmentSchema).min(1).max(5), mode: z.enum(['read', 'insert', 'update', 'delete']),
  sql_file: z.string().min(1).max(512), timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_rows: z.number().int().min(1).max(MAX_MAX_ROWS).optional(), max_affected_rows: z.number().int().min(1).max(MAX_AFFECTED_ROWS).optional(),
  retry_safe: z.boolean().optional(), result_description: z.string().max(2_048).optional(),
}).strict().superRefine((operation, context) => {
  validateSqlShape(operation, context);
  if (new Set(operation.environments).size !== operation.environments.length) context.addIssue({ code: 'custom', path: ['environments'], message: 'environments must be unique' });
  if (operation.environments.includes('prod') && operation.mode !== 'read') context.addIssue({ code: 'custom', path: ['mode'], message: 'prod operations must be read' });
});

const v2ScriptOperationSchema = z.object({
  ...commonOperation, kind: z.literal('script'), datasource: z.string().regex(ALIAS_PATTERN).optional(),
  datasources: z.array(z.string().regex(ALIAS_PATTERN)).min(1).max(16).optional(),
  environments: z.array(environmentSchema).min(1).max(5), mode: z.literal('read'), script_file: z.string().min(1).max(512),
  uses: z.array(z.string().regex(PACK_ID_PATTERN)).min(1).max(16), timeout_ms: z.number().int().min(100).max(10_000).default(10_000),
  max_result_bytes: z.number().int().min(1).max(MAX_SCRIPT_RESULT_BYTES).default(MAX_SCRIPT_RESULT_BYTES),
  result_description: z.string().max(2_048).optional(),
}).strict().superRefine((operation, context) => {
  if ((operation.datasource === undefined) === (operation.datasources === undefined)) context.addIssue({ code: 'custom', path: ['datasource'], message: 'declare exactly one of datasource or datasources' });
  if (new Set(operation.environments).size !== operation.environments.length) context.addIssue({ code: 'custom', path: ['environments'], message: 'environments must be unique' });
  if (new Set(operation.uses).size !== operation.uses.length) context.addIssue({ code: 'custom', path: ['uses'], message: 'uses must be unique' });
  if (operation.datasources && new Set(operation.datasources).size !== operation.datasources.length) context.addIssue({ code: 'custom', path: ['datasources'], message: 'datasources must be unique' });
});

const v1PackSchema = z.object({ schema_version: z.literal(PACK_V1), pack_id: z.string().regex(PACK_ID_PATTERN), version: z.string().min(1).max(64), operations: z.array(v1OperationSchema).min(1).max(1_000) }).strict();
const v2PackSchema = z.object({ schema_version: z.literal(PACK_V2), pack_id: z.string().regex(PACK_ID_PATTERN), version: z.string().min(1).max(64), operations: z.array(z.discriminatedUnion('kind', [v2SqlOperationSchema, v2ScriptOperationSchema])).min(1).max(1_000) }).strict();

type ScalarFieldConfig = z.infer<typeof scalarFieldSchema>;
type ParameterFieldConfig = z.infer<typeof parameterFieldSchema>;
type V2Pack = z.infer<typeof v2PackSchema>;
type V2Operation = V2Pack['operations'][number];

export interface LoadedBusinessPack { id: string; version: string; path: string; operationCount: number; schemaVersion?: string; }
export interface DisabledBusinessOperation { id: string; environment: ConnectionEnvironment; reason: string; code: string; }
export interface LoadedBusinessOperations {
  operations: readonly BusinessOperation[];
  packs: readonly LoadedBusinessPack[];
  disabledOperations: readonly DisabledBusinessOperation[];
  home: string;
}
export interface LoadBusinessOperationsOptions { workspace?: WorkspaceContext; }

export function defaultBusinessPacksHome(): string { return fileURLToPath(new URL('../../business-packs', import.meta.url)); }
function packError(code: string, message: string, cause?: unknown): PluginError { return new PluginError({ category: 'config_error', code, message, cause }); }

function validateSqlShape(operation: { connections?: string[]; mode: string; max_rows?: number; retry_safe?: boolean }, context: z.RefinementCtx): void {
  if (operation.connections && new Set(operation.connections).size !== operation.connections.length) context.addIssue({ code: 'custom', path: ['connections'], message: 'connections must be unique' });
  if (operation.mode === 'read' && operation.max_rows === undefined) context.addIssue({ code: 'custom', path: ['max_rows'], message: 'read operations require max_rows' });
  if (operation.mode !== 'read' && operation.max_rows !== undefined) context.addIssue({ code: 'custom', path: ['max_rows'], message: 'write operations must not declare max_rows' });
  if (operation.mode !== 'read' && operation.retry_safe !== undefined) context.addIssue({ code: 'custom', path: ['retry_safe'], message: 'write operations must not declare retry_safe' });
}

function readBoundedFile(path: string, maxBytes: number, code: string): string {
  let size: number;
  try { size = statSync(path).size; } catch (error) { throw packError(code, `无法读取业务包文件 ${path}。`, error); }
  if (size > maxBytes) throw packError(code, `业务包文件 ${path} 超过 ${maxBytes} 字节上限。`);
  return readFileSync(path, 'utf8');
}

function resolvePackFile(packFile: string, childPath: string, kind: 'SQL' | 'SCRIPT'): string {
  if (isAbsolute(childPath)) throw packError(`BUSINESS_PACK_${kind}_PATH_INVALID`, `${kind.toLowerCase()}_file 必须使用业务包内的相对路径。`);
  const packRoot = realpathSync(dirname(packFile));
  let actual: string;
  try { actual = realpathSync(resolve(packRoot, childPath)); }
  catch (error) { throw packError(`BUSINESS_PACK_${kind}_NOT_FOUND`, `找不到业务${kind === 'SQL' ? ' SQL' : '脚本'}文件 ${childPath}。`, error); }
  const fromRoot = relative(packRoot, actual);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw packError(`BUSINESS_PACK_${kind}_PATH_INVALID`, `业务${kind === 'SQL' ? ' SQL' : '脚本'}文件 ${childPath} 超出业务包目录。`);
  return actual;
}

function compilePattern(pattern: string, operationId: string, parameter: string): RegExp {
  try { return new RegExp(pattern); }
  catch (error) { throw packError('BUSINESS_PACK_INPUT_PATTERN_INVALID', `业务操作 ${operationId} 的参数 ${parameter} 包含无效正则表达式。`, error); }
}
function scalarParameterSchema(field: ScalarFieldConfig, operationId: string, parameter: string): z.ZodType {
  let schema: z.ZodType;
  if (field.type === 'string') {
    let value = z.string(); if (field.trim) value = value.trim(); value = value.min(field.min_length).max(field.max_length);
    if (field.pattern) value = value.regex(compilePattern(field.pattern, operationId, parameter)); schema = value;
  } else if (field.type === 'number') schema = z.number().min(field.minimum).max(field.maximum);
  else if (field.type === 'integer') schema = z.number().int().min(field.minimum).max(field.maximum);
  else if (field.type === 'boolean') schema = z.boolean();
  else schema = z.null();
  if (field.description) schema = schema.describe(field.description);
  return 'nullable' in field && field.nullable ? schema.nullable() : schema;
}
function parameterSchema(field: ParameterFieldConfig, operationId: string, parameter: string): z.ZodType {
  if (field.type !== 'array') return scalarParameterSchema(field, operationId, parameter);
  let schema: z.ZodType = z.array(scalarParameterSchema(field.items, operationId, parameter)).min(field.min_items).max(field.max_items);
  if (field.description) schema = schema.describe(field.description); return schema;
}
function buildInput(source: { id: string; input: Record<string, ParameterFieldConfig> }): z.ZodObject {
  return z.object(Object.fromEntries(Object.entries(source.input).map(([name, field]) => [name, parameterSchema(field, source.id, name)])));
}
function contentHash(input: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`; }

interface ParsedV2 { packFile: string; pack: V2Pack; }
function parsePackDocument(packFile: string): z.infer<typeof v1PackSchema> | V2Pack {
  const raw = readBoundedFile(packFile, MAX_PACK_FILE_BYTES, 'BUSINESS_PACK_FILE_INVALID');
  let document: unknown;
  try { document = parseYaml(raw, { uniqueKeys: true, maxAliasCount: 0 }); }
  catch (error) { throw packError('BUSINESS_PACK_YAML_INVALID', `业务包 ${packFile} 不是有效 YAML。`, error); }
  const version = (document as { schema_version?: unknown } | null)?.schema_version;
  const parsed = version === PACK_V1 ? v1PackSchema.safeParse(document) : version === PACK_V2 ? v2PackSchema.safeParse(document) : null;
  if (!parsed?.success) throw packError('BUSINESS_PACK_SCHEMA_INVALID', `业务包 ${packFile} 不符合受支持的业务包协议。`, parsed?.error);
  return parsed.data;
}

function loadV1(packFile: string, pack: z.infer<typeof v1PackSchema>): BusinessOperation[] {
  const operations: BusinessOperation[] = [];
  for (const source of pack.operations) {
    const sql = readBoundedFile(resolvePackFile(packFile, source.sql_file, 'SQL'), MAX_SQL_BYTES, 'BUSINESS_PACK_SQL_INVALID');
    const input = buildInput(source);
    for (const connection of source.connections) operations.push(defineBusinessOperation({
      id: `${source.id}.${connection}`, domain: source.domain, name: source.name, title: source.title,
      description: source.description, useWhen: source.use_when, connection, mode: source.mode, input, sql,
      exposure: source.exposure, timeoutMs: source.timeout_ms, maxRows: source.max_rows,
      maxAffectedRows: source.max_affected_rows, retrySafe: source.retry_safe, resultDescription: source.result_description,
      packId: pack.pack_id, packVersion: pack.version,
      operationHash: contentHash({ packId: pack.pack_id, packVersion: pack.version, baseId: source.id, connection, sql, input: source.input }),
    }));
  }
  return operations;
}

function datasourceList(source: Extract<V2Operation, { kind: 'script' }>): string[] { return source.datasources ?? [source.datasource!]; }

function resolveV2(packs: ParsedV2[], workspace: WorkspaceContext): { operations: BusinessOperation[]; disabled: DisabledBusinessOperation[] } {
  const operations: BusinessOperation[] = [];
  const disabled: DisabledBusinessOperation[] = [];
  const definitions = new Map<string, Extract<V2Operation, { kind: 'sql' }>>();
  const allIds = new Set<string>();
  for (const { pack } of packs) for (const source of pack.operations) {
    if (allIds.has(source.id)) throw packError('DUPLICATE_BUSINESS_OPERATION', `业务操作 ${source.id} 重复定义。`);
    allIds.add(source.id);
    if (source.kind === 'sql') definitions.set(source.id, source);
  }
  for (const { packFile, pack } of packs) for (const source of pack.operations) {
    const input = buildInput(source);
    if (source.kind === 'sql') {
      const sql = readBoundedFile(resolvePackFile(packFile, source.sql_file, 'SQL'), MAX_SQL_BYTES, 'BUSINESS_PACK_SQL_INVALID');
      for (const environment of source.environments) {
        const alias = workspace.environments.get(environment)?.datasourceBindings[source.datasource];
        if (!alias) { disabled.push({ id: source.id, environment, code: 'WORKSPACE_BUSINESS_BINDING_MISSING', reason: `缺少 binding ${source.datasource}/${environment}` }); continue; }
        operations.push(defineBusinessOperation({
          id: source.id, registrationId: `${source.id}@${environment}`, kind: 'sql', domain: source.domain, name: source.name,
          title: source.title, description: source.description, useWhen: source.use_when, connection: alias,
          datasourceIds: [source.datasource], environment, connectionBindings: { [source.datasource]: alias }, mode: source.mode,
          input, sql, exposure: source.exposure, timeoutMs: source.timeout_ms, maxRows: source.max_rows,
          maxAffectedRows: source.max_affected_rows, retrySafe: source.retry_safe, resultDescription: source.result_description,
          packId: pack.pack_id, packVersion: pack.version,
          operationHash: contentHash({ packId: pack.pack_id, packVersion: pack.version, definition: source, sql }),
        }));
      }
      continue;
    }
    const script = readBoundedFile(resolvePackFile(packFile, source.script_file, 'SCRIPT'), MAX_SCRIPT_BYTES, 'BUSINESS_PACK_SCRIPT_INVALID');
    const datasources = datasourceList(source);
    for (const dependencyId of source.uses) {
      const dependency = definitions.get(dependencyId);
      if (!dependency) throw packError('BUSINESS_SCRIPT_DEPENDENCY_NOT_FOUND', `脚本 ${source.id} 依赖的已发布 v2 SQL 操作 ${dependencyId} 不存在。`);
      if (dependency.mode !== 'read') throw packError('BUSINESS_SCRIPT_DEPENDENCY_WRITE_FORBIDDEN', `脚本 ${source.id} 不能调用写操作 ${dependencyId}。`);
      if (!datasources.includes(dependency.datasource)) throw packError('BUSINESS_SCRIPT_DATASOURCE_NOT_DECLARED', `脚本 ${source.id} 未声明依赖 ${dependencyId} 的数据源 ${dependency.datasource}。`);
    }
    for (const environment of source.environments) {
      const bindings: Record<string, string> = {};
      const missing = datasources.filter((datasource) => {
        const alias = workspace.environments.get(environment)?.datasourceBindings[datasource];
        if (alias) bindings[datasource] = alias;
        return !alias;
      });
      const unavailableDependency = source.uses.find((id) => !definitions.get(id)!.environments.includes(environment));
      if (missing.length > 0 || unavailableDependency) {
        disabled.push({ id: source.id, environment, code: 'WORKSPACE_BUSINESS_BINDING_MISSING', reason: missing.length > 0 ? `缺少 binding ${missing.join(',')}/${environment}` : `依赖 ${unavailableDependency} 未发布到 ${environment}` });
        continue;
      }
      operations.push(defineBusinessOperation({
        id: source.id, registrationId: `${source.id}@${environment}`, kind: 'script', domain: source.domain, name: source.name,
        title: source.title, description: source.description, useWhen: source.use_when, connection: bindings[datasources[0]!]!,
        datasourceIds: datasources, environment, connectionBindings: bindings, mode: 'read', input, sql: '', script,
        uses: source.uses, exposure: source.exposure, timeoutMs: source.timeout_ms, maxResultBytes: source.max_result_bytes,
        resultDescription: source.result_description, packId: pack.pack_id, packVersion: pack.version,
        operationHash: contentHash({ packId: pack.pack_id, packVersion: pack.version, definition: source, script }),
        scriptHash: contentHash({ script }),
      }));
    }
  }
  return { operations, disabled };
}

export function loadBusinessOperationsFromHomes(
  homes: readonly string[],
  options: LoadBusinessOperationsOptions = {},
): LoadedBusinessOperations {
  if (homes.length === 0) return { operations: [], packs: [], disabledOperations: [], home: '' };
  const resolvedHomes = homes.map((home) => resolve(home));
  for (const resolvedHome of resolvedHomes) {
    if (!existsSync(resolvedHome)) throw packError('BUSINESS_PACKS_HOME_NOT_FOUND', `找不到业务包目录 ${resolvedHome}。`);
  }
  const packFiles = resolvedHomes.flatMap((resolvedHome) => readdirSync(resolvedHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = resolve(resolvedHome, entry.name, 'pack.yml');
      if (!existsSync(path)) throw packError('BUSINESS_PACK_FILE_NOT_FOUND', `业务包目录 ${entry.name} 缺少 pack.yml。`);
      return path;
    }));
  const operations: BusinessOperation[] = [];
  const packs: LoadedBusinessPack[] = [];
  const v2: ParsedV2[] = [];
  const packIds = new Set<string>();
  for (const packFile of packFiles) {
    const pack = parsePackDocument(packFile);
    if (packIds.has(pack.pack_id)) throw packError('DUPLICATE_BUSINESS_PACK', `业务包 ID ${pack.pack_id} 重复。`);
    packIds.add(pack.pack_id);
    packs.push({ id: pack.pack_id, version: pack.version, path: packFile, operationCount: pack.schema_version === PACK_V1 ? pack.operations.reduce((count, operation) => count + operation.connections.length, 0) : pack.operations.length, schemaVersion: pack.schema_version });
    if (pack.schema_version === PACK_V1) operations.push(...loadV1(packFile, pack)); else v2.push({ packFile, pack });
  }
  if (v2.length > 0 && !options.workspace) throw packError('BUSINESS_PACK_V2_WORKSPACE_REQUIRED', '业务包 v2 必须在 workspace context 中加载。');
  const resolved = options.workspace ? resolveV2(v2, options.workspace) : { operations: [], disabled: [] };
  operations.push(...resolved.operations);
  const registrations = new Set<string>();
  for (const operation of operations) {
    if (registrations.has(operation.registrationId)) throw packError('DUPLICATE_BUSINESS_OPERATION', `业务操作 ${operation.id} 重复注册。`);
    registrations.add(operation.registrationId);
  }
  return { operations, packs, disabledOperations: resolved.disabled, home: resolvedHomes[0]! };
}

export function loadBusinessOperations(home?: string, options: LoadBusinessOperationsOptions = {}): LoadedBusinessOperations {
  const configuredHome = home || process.env.MYSQL_AGENT_BUSINESS_PACKS;
  const resolvedHome = resolve(configuredHome || defaultBusinessPacksHome());
  if (!existsSync(resolvedHome)) {
    if (configuredHome) throw packError('BUSINESS_PACKS_HOME_NOT_FOUND', `找不到业务包目录 ${resolvedHome}。`);
    return { operations: [], packs: [], disabledOperations: [], home: resolvedHome };
  }
  return loadBusinessOperationsFromHomes([resolvedHome], options);
}
