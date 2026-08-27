import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ALIAS_PATTERN, MAX_AFFECTED_ROWS, MAX_MAX_ROWS, MAX_SQL_BYTES, PARAMETER_NAME_PATTERN } from '../constants.js';
import { PluginError } from '../errors.js';
import { defineBusinessOperation, type BusinessOperation } from '../business-queries/definition.js';

const PACK_SCHEMA_VERSION = 'mysql-agent/business-pack/1';
const MAX_PACK_FILE_BYTES = 1_048_576;
const PACK_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

const commonField = {
  description: z.string().max(256).optional(),
  nullable: z.boolean().default(false),
};

const stringFieldSchema = z.object({
  type: z.literal('string'),
  ...commonField,
  min_length: z.number().int().min(0).max(65_536).default(0),
  max_length: z.number().int().min(1).max(65_536).default(1_024),
  pattern: z.string().max(1_024).optional(),
  trim: z.boolean().default(false),
}).strict().refine((field) => field.min_length <= field.max_length, {
  message: 'min_length must not exceed max_length',
});

const numberFieldSchema = z.object({
  type: z.enum(['number', 'integer']),
  ...commonField,
  minimum: z.number().safe().default(Number.MIN_SAFE_INTEGER),
  maximum: z.number().safe().default(Number.MAX_SAFE_INTEGER),
}).strict().refine((field) => field.minimum <= field.maximum, {
  message: 'minimum must not exceed maximum',
});

const booleanFieldSchema = z.object({ type: z.literal('boolean'), ...commonField }).strict();
const nullFieldSchema = z.object({ type: z.literal('null'), description: commonField.description }).strict();
const scalarFieldSchema = z.discriminatedUnion('type', [
  stringFieldSchema,
  numberFieldSchema,
  booleanFieldSchema,
  nullFieldSchema,
]);
const arrayFieldSchema = z.object({
  type: z.literal('array'),
  description: commonField.description,
  items: scalarFieldSchema,
  min_items: z.number().int().min(1).max(100).default(1),
  max_items: z.number().int().min(1).max(100).default(100),
}).strict().refine((field) => field.min_items <= field.max_items, {
  message: 'min_items must not exceed max_items',
});
const parameterFieldSchema = z.union([scalarFieldSchema, arrayFieldSchema]);

const operationSchema = z.object({
  id: z.string().regex(PACK_ID_PATTERN),
  domain: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().min(1).max(256),
  description: z.string().min(1).max(1_024),
  use_when: z.string().min(1).max(2_048),
  connections: z.array(z.string().regex(ALIAS_PATTERN)).min(1).max(32),
  mode: z.enum(['read', 'insert', 'update', 'delete']),
  exposure: z.enum(['direct', 'domain']).default('domain'),
  input: z.record(z.string().regex(PARAMETER_NAME_PATTERN), parameterFieldSchema),
  sql_file: z.string().min(1).max(512),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_rows: z.number().int().min(1).max(MAX_MAX_ROWS).optional(),
  max_affected_rows: z.number().int().min(1).max(MAX_AFFECTED_ROWS).optional(),
  retry_safe: z.boolean().optional(),
  result_description: z.string().max(2_048).optional(),
}).strict().superRefine((operation, context) => {
  if (new Set(operation.connections).size !== operation.connections.length) {
    context.addIssue({ code: 'custom', path: ['connections'], message: 'connections must be unique' });
  }
  if (operation.mode === 'read' && operation.max_rows === undefined) {
    context.addIssue({ code: 'custom', path: ['max_rows'], message: 'read operations require max_rows' });
  }
  if (operation.mode !== 'read' && operation.max_rows !== undefined) {
    context.addIssue({ code: 'custom', path: ['max_rows'], message: 'write operations must not declare max_rows' });
  }
  if (operation.mode !== 'read' && operation.retry_safe !== undefined) {
    context.addIssue({ code: 'custom', path: ['retry_safe'], message: 'write operations must not declare retry_safe' });
  }
});

const packSchema = z.object({
  schema_version: z.literal(PACK_SCHEMA_VERSION),
  pack_id: z.string().regex(PACK_ID_PATTERN),
  version: z.string().min(1).max(64),
  operations: z.array(operationSchema).min(1).max(1_000),
}).strict();

type ScalarFieldConfig = z.infer<typeof scalarFieldSchema>;
type ParameterFieldConfig = z.infer<typeof parameterFieldSchema>;

export interface LoadedBusinessPack {
  id: string;
  version: string;
  path: string;
  operationCount: number;
}

export interface LoadedBusinessOperations {
  operations: readonly BusinessOperation[];
  packs: readonly LoadedBusinessPack[];
  home: string;
}

export function defaultBusinessPacksHome(): string {
  return fileURLToPath(new URL('../../business-packs', import.meta.url));
}

function packError(code: string, message: string, cause?: unknown): PluginError {
  return new PluginError({ category: 'config_error', code, message, cause });
}

function readBoundedFile(path: string, maxBytes: number, code: string): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    throw packError(code, `无法读取业务包文件 ${path}。`, error);
  }
  if (size > maxBytes) throw packError(code, `业务包文件 ${path} 超过 ${maxBytes} 字节上限。`);
  return readFileSync(path, 'utf8');
}

function resolveSqlFile(packFile: string, sqlFile: string): string {
  if (isAbsolute(sqlFile)) throw packError('BUSINESS_PACK_SQL_PATH_INVALID', 'sql_file 必须使用业务包内的相对路径。');
  const packRoot = realpathSync(dirname(packFile));
  const candidate = resolve(packRoot, sqlFile);
  let sqlPath: string;
  try {
    sqlPath = realpathSync(candidate);
  } catch (error) {
    throw packError('BUSINESS_PACK_SQL_NOT_FOUND', `找不到业务 SQL 文件 ${sqlFile}。`, error);
  }
  const pathFromRoot = relative(packRoot, sqlPath);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw packError('BUSINESS_PACK_SQL_PATH_INVALID', `业务 SQL 文件 ${sqlFile} 超出业务包目录。`);
  }
  return sqlPath;
}

function compilePattern(pattern: string, operationId: string, parameter: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw packError(
      'BUSINESS_PACK_INPUT_PATTERN_INVALID',
      `业务操作 ${operationId} 的参数 ${parameter} 包含无效正则表达式。`,
      error,
    );
  }
}

function scalarParameterSchema(field: ScalarFieldConfig, operationId: string, parameter: string): z.ZodType {
  let schema: z.ZodType;
  if (field.type === 'string') {
    let value = z.string();
    if (field.trim) value = value.trim();
    value = value.min(field.min_length).max(field.max_length);
    if (field.pattern) value = value.regex(compilePattern(field.pattern, operationId, parameter));
    schema = value;
  } else if (field.type === 'number') {
    schema = z.number().min(field.minimum).max(field.maximum);
  } else if (field.type === 'integer') {
    schema = z.number().int().min(field.minimum).max(field.maximum);
  } else if (field.type === 'boolean') {
    schema = z.boolean();
  } else {
    schema = z.null();
  }
  if (field.description) schema = schema.describe(field.description);
  return 'nullable' in field && field.nullable ? schema.nullable() : schema;
}

function parameterSchema(field: ParameterFieldConfig, operationId: string, parameter: string): z.ZodType {
  if (field.type !== 'array') return scalarParameterSchema(field, operationId, parameter);
  let schema: z.ZodType = z.array(scalarParameterSchema(field.items, operationId, parameter))
    .min(field.min_items)
    .max(field.max_items);
  if (field.description) schema = schema.describe(field.description);
  return schema;
}

function operationHash(input: {
  packId: string;
  packVersion: string;
  baseId: string;
  connection: string;
  sql: string;
  input: unknown;
}): string {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `sha256:${hash}`;
}

function parsePack(packFile: string): { operations: BusinessOperation[]; pack: LoadedBusinessPack } {
  const raw = readBoundedFile(packFile, MAX_PACK_FILE_BYTES, 'BUSINESS_PACK_FILE_INVALID');
  let document: unknown;
  try {
    document = parseYaml(raw, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw packError('BUSINESS_PACK_YAML_INVALID', `业务包 ${packFile} 不是有效 YAML。`, error);
  }
  const parsed = packSchema.safeParse(document);
  if (!parsed.success) {
    throw packError('BUSINESS_PACK_SCHEMA_INVALID', `业务包 ${packFile} 不符合 ${PACK_SCHEMA_VERSION}。`, parsed.error);
  }

  const operations: BusinessOperation[] = [];
  for (const source of parsed.data.operations) {
    const sqlPath = resolveSqlFile(packFile, source.sql_file);
    const sql = readBoundedFile(sqlPath, MAX_SQL_BYTES, 'BUSINESS_PACK_SQL_INVALID');
    const shape = Object.fromEntries(
      Object.entries(source.input).map(([parameter, field]) => [parameter, parameterSchema(field, source.id, parameter)]),
    );
    const input = z.object(shape);
    for (const connection of source.connections) {
      const id = `${source.id}.${connection}`;
      operations.push(defineBusinessOperation({
        id,
        domain: source.domain,
        name: source.name,
        title: source.title,
        description: source.description,
        useWhen: source.use_when,
        connection,
        mode: source.mode,
        exposure: source.exposure,
        input,
        sql,
        timeoutMs: source.timeout_ms,
        maxRows: source.max_rows,
        maxAffectedRows: source.max_affected_rows,
        retrySafe: source.retry_safe,
        resultDescription: source.result_description,
        packId: parsed.data.pack_id,
        packVersion: parsed.data.version,
        operationHash: operationHash({
          packId: parsed.data.pack_id,
          packVersion: parsed.data.version,
          baseId: source.id,
          connection,
          sql,
          input: source.input,
        }),
      }));
    }
  }
  return {
    operations,
    pack: {
      id: parsed.data.pack_id,
      version: parsed.data.version,
      path: packFile,
      operationCount: operations.length,
    },
  };
}

export function loadBusinessOperations(home?: string): LoadedBusinessOperations {
  const configuredHome = home || process.env.MYSQL_AGENT_BUSINESS_PACKS;
  const resolvedHome = resolve(configuredHome || defaultBusinessPacksHome());
  if (!existsSync(resolvedHome)) {
    if (configuredHome) throw packError('BUSINESS_PACKS_HOME_NOT_FOUND', `找不到业务包目录 ${resolvedHome}。`);
    return { operations: [], packs: [], home: resolvedHome };
  }
  const packDirectories = readdirSync(resolvedHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const packFiles = packDirectories.map((entry) => {
    const path = resolve(resolvedHome, entry.name, 'pack.yml');
    if (!existsSync(path)) throw packError('BUSINESS_PACK_FILE_NOT_FOUND', `业务包目录 ${entry.name} 缺少 pack.yml。`);
    return path;
  });
  const operations: BusinessOperation[] = [];
  const packs: LoadedBusinessPack[] = [];
  const packIds = new Set<string>();
  for (const packFile of packFiles) {
    const loaded = parsePack(packFile);
    if (packIds.has(loaded.pack.id)) {
      throw packError('DUPLICATE_BUSINESS_PACK', `业务包 ID ${loaded.pack.id} 重复。`);
    }
    packIds.add(loaded.pack.id);
    packs.push(loaded.pack);
    operations.push(...loaded.operations);
  }
  return { operations, packs, home: resolvedHome };
}
