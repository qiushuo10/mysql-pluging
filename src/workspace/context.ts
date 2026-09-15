import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
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
  discovery: z.object({
    enabled: z.boolean().default(false),
    retention_days: z.number().int().min(1).max(90).default(30),
  }).strict().default({ enabled: false, retention_days: 30 }),
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
  readonly discovery: Readonly<{ enabled: boolean; retentionDays: number }>;
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
  const descriptorDirectory = dirname(realpathSync(descriptorPath));
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
    discovery: Object.freeze({ enabled: document.discovery.enabled, retentionDays: document.discovery.retention_days }),
  });
}

export function loadWorkspaceContext(explicitPath: string): WorkspaceContext {
  const resolvedPath = resolve(explicitPath);
  const document = parseWorkspaceDocument(resolvedPath);
  const descriptorPath = realpathSync(resolvedPath);
  return toContext(descriptorPath, document);
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
  private readonly identityWorkspaceId: string;
  private readonly identityRootHash: string;

  constructor(path: string) {
    const resolvedPath = resolve(path);
    this.document = parseWorkspaceDocument(resolvedPath);
    const descriptorPath = realpathSync(resolvedPath);
    this.current = toContext(descriptorPath, this.document);
    this.identityWorkspaceId = this.current.workspaceId;
    this.identityRootHash = this.current.rootHash;
  }

  get context(): WorkspaceContext {
    return this.current;
  }

  binding(datasource: string, environment: ConnectionEnvironment): string | undefined {
    this.refreshFromDisk();
    return this.current.environments.get(environment)?.datasourceBindings[datasource];
  }

  allBindings(): Array<{ datasourceId: string; environment: ConnectionEnvironment; alias: string }> {
    this.refreshFromDisk();
    const result: Array<{ datasourceId: string; environment: ConnectionEnvironment; alias: string }> = [];
    for (const [environment, config] of this.current.environments) {
      for (const [datasourceId, alias] of Object.entries(config.datasourceBindings)) {
        result.push({ datasourceId, environment, alias });
      }
    }
    return result;
  }

  async setBinding(
    datasource: string,
    environment: ConnectionEnvironment,
    alias: string,
    makeDefault = false,
    options: { requireAbsent?: boolean; expectedAlias?: string } = {},
  ): Promise<void> {
    await this.mutate((next) => {
      const existing = next.environments[environment];
      const currentAlias = existing?.datasource_bindings[datasource];
      if (options.requireAbsent && currentAlias !== undefined) {
        throw new PluginError({
          category: 'config_error', code: 'WORKSPACE_DESCRIPTOR_CONFLICT',
          message: `binding ${datasource}/${environment} 已被并发更新，请重试。`, retryable: true, retryAfterMs: 50,
        });
      }
      if (options.expectedAlias !== undefined && currentAlias !== options.expectedAlias) {
        throw new PluginError({
          category: 'config_error', code: 'WORKSPACE_DESCRIPTOR_CONFLICT',
          message: `binding ${datasource}/${environment} 已被并发更新，请重试。`, retryable: true, retryAfterMs: 50,
        });
      }
      next.environments[environment] = existing ?? {
        datasource_bindings: {},
        expose_as_explicit_tool: environment !== next.default_environment,
      };
      next.environments[environment]!.datasource_bindings[datasource] = alias;
      if (makeDefault) {
        next.default_datasource = datasource;
        next.default_environment = environment;
      }
    });
  }

  async removeBinding(
    datasource: string,
    environment: ConnectionEnvironment,
    options: { expectedAlias?: string } = {},
  ): Promise<void> {
    await this.mutate((next) => {
      const target = next.environments[environment];
      if (!target?.datasource_bindings[datasource]) {
        throw workspaceError('WORKSPACE_BINDING_NOT_FOUND', `找不到 binding ${datasource}/${environment}。`);
      }
      if (options.expectedAlias !== undefined && target.datasource_bindings[datasource] !== options.expectedAlias) {
        throw new PluginError({
          category: 'config_error', code: 'WORKSPACE_DESCRIPTOR_CONFLICT',
          message: `binding ${datasource}/${environment} 已被并发更新，请重试。`, retryable: true, retryAfterMs: 50,
        });
      }
      if (next.default_datasource === datasource && next.default_environment === environment) {
        throw workspaceError('WORKSPACE_DEFAULT_BINDING_REMOVE_FORBIDDEN', '不能删除当前默认 binding；请先设置另一个默认目标。');
      }
      delete target.datasource_bindings[datasource];
    });
  }

  references(alias: string): number {
    return this.allBindings().filter((binding) => binding.alias === alias).length;
  }

  private refreshFromDisk(): void {
    const latest = parseWorkspaceDocument(this.current.descriptorPath);
    this.acceptLatest(latest);
  }

  private async mutate(change: (document: WorkspaceDocument) => void): Promise<void> {
    const release = await acquireDescriptorLock(this.current.descriptorPath);
    try {
      const raw = readFileSync(this.current.descriptorPath, 'utf8');
      const expectedHash = createHash('sha256').update(raw).digest('hex');
      const latest = parseWorkspaceDocument(this.current.descriptorPath);
      this.verifyIdentity(latest);
      const next = structuredClone(latest);
      change(next);
      this.commit(next, expectedHash);
    } finally {
      release();
    }
  }

  private commit(next: WorkspaceDocument, expectedHash: string): void {
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
      const actualHash = createHash('sha256').update(readFileSync(descriptorPath, 'utf8')).digest('hex');
      if (actualHash !== expectedHash) {
        throw new PluginError({
          category: 'config_error', code: 'WORKSPACE_DESCRIPTOR_CONFLICT',
          message: 'workspace descriptor 在更新期间发生变化，请重试。', retryable: true, retryAfterMs: 50,
        });
      }
      renameSync(temporaryPath, descriptorPath);
    } catch (error) {
      if (descriptorHandle !== undefined) closeSync(descriptorHandle);
      try { unlinkSync(temporaryPath); } catch { /* best effort */ }
      if (error instanceof PluginError && error.code === 'WORKSPACE_DESCRIPTOR_CONFLICT') throw error;
      throw workspaceError('WORKSPACE_WRITE_FAILED', `无法原子更新 workspace descriptor：${descriptorPath}。`, error);
    }
    this.acceptLatest(parsed.data);
  }

  private verifyIdentity(document: WorkspaceDocument): void {
    const context = toContext(this.current.descriptorPath, document);
    if (context.workspaceId !== this.identityWorkspaceId || context.rootHash !== this.identityRootHash) {
      throw new PluginError({
        category: 'permission_error', code: 'WORKSPACE_IDENTITY_CHANGED',
        message: 'workspace descriptor 的 workspace_id 或 root 在进程运行期间发生变化，请恢复配置并重新连接。',
      });
    }
  }

  private acceptLatest(document: WorkspaceDocument): void {
    this.verifyIdentity(document);
    this.document = document;
    this.current = toContext(this.current.descriptorPath, document);
  }
}

const DESCRIPTOR_LOCK_TIMEOUT_MS = 5_000;
const DESCRIPTOR_LOCK_STALE_MS = 30_000;

async function acquireDescriptorLock(descriptorPath: string): Promise<() => void> {
  const lockPath = `${descriptorPath}.lock`;
  const ownerPath = `${lockPath}/owner.json`;
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const ownerId = randomUUID();
      try {
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, owner_id: ownerId, created_at: new Date().toISOString() }), {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
      } catch (error) {
        try { unlinkSync(ownerPath); } catch { /* best effort */ }
        try { rmdirSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
      return () => {
        try {
          const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { owner_id?: unknown };
          if (owner.owner_id !== ownerId) return;
          unlinkSync(ownerPath);
          rmdirSync(lockPath);
        } catch { /* a crashed owner is recoverable through stale-lock handling */ }
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      if (code !== 'EEXIST') throw workspaceError('WORKSPACE_LOCK_FAILED', '无法创建 workspace descriptor 文件锁。', error);
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > DESCRIPTOR_LOCK_STALE_MS) {
          let ownerAlive = false;
          try {
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: unknown };
            if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); ownerAlive = true; }
              catch (probeError) {
                ownerAlive = (probeError as NodeJS.ErrnoException).code === 'EPERM';
              }
            }
          } catch { /* malformed stale owner is removable */ }
          if (!ownerAlive) {
            try { unlinkSync(ownerPath); } catch { /* owner may be absent */ }
            rmdirSync(lockPath);
            continue;
          }
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= DESCRIPTOR_LOCK_TIMEOUT_MS) {
        throw new PluginError({
          category: 'config_error', code: 'WORKSPACE_LOCK_TIMEOUT', message: 'workspace descriptor 正被其他进程更新，请稍后重试。',
          retryable: true, retryAfterMs: 100,
        });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}
