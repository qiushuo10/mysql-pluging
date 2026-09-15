import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { ALIAS_PATTERN } from '../constants.js';
import { PluginError } from '../errors.js';
import type { AccessMode, ConnectionEnvironment } from '../types.js';

export type RuntimeMode = 'admin' | 'workspace' | 'global';

const WORKSPACE_SCHEMA_VERSION = 'mysql-agent/workspace/1';
const WORKSPACE_FILE_MAX_BYTES = 1_048_576;
const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const environmentName = z.enum(['dev', 'test', 'staging', 'prod', 'custom']);
const datasourceId = z.string().regex(ALIAS_PATTERN);

const environmentSchema = z.object({
  datasource_bindings: z.record(datasourceId, z.string().regex(ALIAS_PATTERN)).default({}),
  access_mode: z.enum(['read_only', 'read_write']).optional(),
  expose_as_explicit_tool: z.boolean().default(false),
}).strict();

const workspaceSchema = z.object({
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
  label: z.string().min(1).max(256),
  runtime_mode: z.literal('workspace'),
  default_datasource: datasourceId,
  default_environment: environmentName,
  environments: z.partialRecord(environmentName, environmentSchema),
  business_pack_paths: z.array(z.string().min(1).max(1_024)).max(32).default([]),
  audit_retention_days: z.number().int().min(1).max(3_650).default(30),
}).strict().superRefine((workspace, context) => {
  if (workspace.environments.prod?.access_mode === 'read_write') {
    context.addIssue({
      code: 'custom',
      path: ['environments', 'prod', 'access_mode'],
      message: 'prod environment must be read_only in workspace mode',
    });
  }
});

type WorkspaceDocument = z.infer<typeof workspaceSchema>;

export interface WorkspaceEnvironment {
  name: ConnectionEnvironment;
  datasourceBindings: Readonly<Record<string, string>>;
  accessMode: AccessMode;
  exposeAsExplicitTool: boolean;
}

export interface WorkspaceContext {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly descriptorPath: string;
  readonly descriptorDirectory: string;
  readonly rootHash: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly runtimeMode: 'workspace';
  readonly defaultDatasource: string;
  readonly defaultEnvironment: ConnectionEnvironment;
  readonly environments: ReadonlyMap<ConnectionEnvironment, WorkspaceEnvironment>;
  readonly businessPackPaths: readonly string[];
  readonly auditRetentionDays: number;
}

export interface RuntimeOptions {
  mode: RuntimeMode;
  workspacePath?: string;
}

function workspaceError(code: string, message: string, cause?: unknown): PluginError {
  return new PluginError({ category: 'config_error', code, message, cause });
}

function parseWorkspaceDocument(descriptorPath: string): WorkspaceDocument {
  if (!existsSync(descriptorPath)) {
    throw workspaceError('WORKSPACE_DESCRIPTOR_NOT_FOUND', `找不到 workspace descriptor：${descriptorPath}。`);
  }
  if (!statSync(descriptorPath).isFile()) {
    throw workspaceError('WORKSPACE_DESCRIPTOR_NOT_FILE', `workspace descriptor 不是文件：${descriptorPath}。`);
  }
  if (statSync(descriptorPath).size > WORKSPACE_FILE_MAX_BYTES) {
    throw workspaceError('WORKSPACE_DESCRIPTOR_TOO_LARGE', `workspace descriptor 超过 ${WORKSPACE_FILE_MAX_BYTES} 字节。`);
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(descriptorPath, 'utf8'), { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw workspaceError('WORKSPACE_YAML_INVALID', `workspace descriptor 不是有效 YAML：${descriptorPath}。`, error);
  }
  const parsed = workspaceSchema.safeParse(document);
  if (!parsed.success) {
    throw workspaceError('WORKSPACE_SCHEMA_INVALID', `workspace descriptor 不符合 ${WORKSPACE_SCHEMA_VERSION}。`, parsed.error);
  }
  if (!parsed.data.environments[parsed.data.default_environment]) {
    throw workspaceError('WORKSPACE_DEFAULT_ENVIRONMENT_MISSING', `默认环境 ${parsed.data.default_environment} 未在 environments 中声明。`);
  }
  if (!parsed.data.environments[parsed.data.default_environment]!.datasource_bindings[parsed.data.default_datasource]) {
    throw workspaceError(
      'WORKSPACE_DEFAULT_BINDING_MISSING',
      `默认目标 ${parsed.data.default_datasource}/${parsed.data.default_environment} 缺少 binding。`,
    );
  }
  for (const path of parsed.data.business_pack_paths) {
    if (isAbsolute(path)) {
      throw workspaceError('WORKSPACE_BUSINESS_PACK_PATH_INVALID', `business_pack_paths 必须是相对 descriptor 的路径：${path}。`);
    }
  }
  return parsed.data;
}

function toContext(descriptorPath: string, document: WorkspaceDocument): WorkspaceContext {
  const descriptorDirectory = dirname(descriptorPath);
  const environments = new Map<ConnectionEnvironment, WorkspaceEnvironment>();
  for (const [name, environment] of Object.entries(document.environments)) {
    const typedName = name as ConnectionEnvironment;
    environments.set(typedName, Object.freeze({
      name: typedName,
      datasourceBindings: Object.freeze({ ...environment.datasource_bindings }),
      accessMode: environment.access_mode ?? (typedName === 'prod' ? 'read_only' : 'read_write'),
      exposeAsExplicitTool: environment.expose_as_explicit_tool,
    }));
  }
  return Object.freeze({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    descriptorPath,
    descriptorDirectory,
    rootHash: createHash('sha256').update(descriptorDirectory).digest('hex'),
    workspaceId: document.workspace_id,
    label: document.label,
    runtimeMode: document.runtime_mode,
    defaultDatasource: document.default_datasource,
    defaultEnvironment: document.default_environment,
    environments,
    businessPackPaths: Object.freeze(document.business_pack_paths.map((path) => resolve(descriptorDirectory, path))),
    auditRetentionDays: document.audit_retention_days,
  });
}

export function loadWorkspaceContext(explicitPath: string): WorkspaceContext {
  const descriptorPath = resolve(explicitPath);
  return toContext(descriptorPath, parseWorkspaceDocument(descriptorPath));
}

export function parseRuntimeOptions(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeOptions {
  let modeValue = environment.MYSQL_AGENT_MODE;
  let workspaceValue = environment.MYSQL_AGENT_WORKSPACE;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--mode') {
      const value = argv[index + 1];
      if (!value) throw workspaceError('CLI_ARGUMENT_MISSING', '--mode 必须提供值。');
      modeValue = value;
      index += 1;
    } else if (token === '--workspace') {
      const value = argv[index + 1];
      if (!value) throw workspaceError('CLI_ARGUMENT_MISSING', '--workspace 必须提供路径。');
      workspaceValue = value;
      index += 1;
    } else {
      throw workspaceError('CLI_ARGUMENT_UNKNOWN', `未知参数 ${token}。`);
    }
  }
  const mode = modeValue ?? 'global';
  if (mode !== 'admin' && mode !== 'workspace' && mode !== 'global') {
    throw workspaceError('INVALID_RUNTIME_MODE', `运行模式 ${mode} 无效。`);
  }
  if (mode === 'workspace' && !workspaceValue) {
    throw workspaceError('WORKSPACE_DESCRIPTOR_REQUIRED', 'workspace 模式必须显式提供 --workspace 或 MYSQL_AGENT_WORKSPACE。');
  }
  return { mode, workspacePath: workspaceValue ? resolve(workspaceValue) : undefined };
}

export class WorkspaceManager {
  private document: WorkspaceDocument;
  private current: WorkspaceContext;

  constructor(path: string) {
    const descriptorPath = resolve(path);
    this.document = parseWorkspaceDocument(descriptorPath);
    this.current = toContext(descriptorPath, this.document);
  }

  get context(): WorkspaceContext {
    return this.current;
  }

  binding(datasource: string, environment: ConnectionEnvironment): string | undefined {
    return this.current.environments.get(environment)?.datasourceBindings[datasource];
  }

  allBindings(): Array<{ datasourceId: string; environment: ConnectionEnvironment; alias: string }> {
    const result: Array<{ datasourceId: string; environment: ConnectionEnvironment; alias: string }> = [];
    for (const [environment, config] of this.current.environments) {
      for (const [datasourceId, alias] of Object.entries(config.datasourceBindings)) {
        result.push({ datasourceId, environment, alias });
      }
    }
    return result;
  }

  setBinding(datasource: string, environment: ConnectionEnvironment, alias: string, makeDefault = false): void {
    const next = structuredClone(this.document);
    const existing = next.environments[environment];
    next.environments[environment] = existing ?? {
      datasource_bindings: {},
      expose_as_explicit_tool: environment !== next.default_environment,
    };
    next.environments[environment]!.datasource_bindings[datasource] = alias;
    if (makeDefault) {
      next.default_datasource = datasource;
      next.default_environment = environment;
    }
    this.commit(next);
  }

  removeBinding(datasource: string, environment: ConnectionEnvironment): void {
    const next = structuredClone(this.document);
    const target = next.environments[environment];
    if (!target?.datasource_bindings[datasource]) {
      throw workspaceError('WORKSPACE_BINDING_NOT_FOUND', `找不到 binding ${datasource}/${environment}。`);
    }
    if (next.default_datasource === datasource && next.default_environment === environment) {
      throw workspaceError('WORKSPACE_DEFAULT_BINDING_REMOVE_FORBIDDEN', '不能删除当前默认 binding；请先设置另一个默认目标。');
    }
    delete target.datasource_bindings[datasource];
    this.commit(next);
  }

  references(alias: string): number {
    return this.allBindings().filter((binding) => binding.alias === alias).length;
  }

  private commit(next: WorkspaceDocument): void {
    const parsed = workspaceSchema.safeParse(next);
    if (!parsed.success) throw workspaceError('WORKSPACE_SCHEMA_INVALID', '更新后的 workspace 配置无效。', parsed.error);
    const descriptorPath = this.current.descriptorPath;
    const temporaryPath = `${descriptorPath}.tmp-${process.pid}-${randomUUID()}`;
    let descriptorHandle: number | undefined;
    try {
      writeFileSync(temporaryPath, stringifyYaml(parsed.data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(temporaryPath, 0o600);
      descriptorHandle = openSync(temporaryPath, 'r');
      fsyncSync(descriptorHandle);
      closeSync(descriptorHandle);
      descriptorHandle = undefined;
      renameSync(temporaryPath, descriptorPath);
    } catch (error) {
      if (descriptorHandle !== undefined) closeSync(descriptorHandle);
      try { unlinkSync(temporaryPath); } catch { /* best effort */ }
      throw workspaceError('WORKSPACE_WRITE_FAILED', `无法原子更新 workspace descriptor：${descriptorPath}。`, error);
    }
    this.document = parsed.data;
    this.current = toContext(descriptorPath, parsed.data);
  }
}
