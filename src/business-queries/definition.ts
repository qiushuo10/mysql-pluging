import { z } from 'zod';

import { OPERATION_ID_PATTERN } from '../constants.js';
import { PluginError } from '../errors.js';
import type { BusinessMode } from '../types.js';

export interface BusinessOperationOptions<InputSchema extends z.ZodObject> {
  id: string;
  domain: string;
  name: string;
  title: string;
  description: string;
  useWhen: string;
  connection: string;
  mode: BusinessMode;
  input: InputSchema;
  /** Omitted by legacy callers and treated as `sql`. */
  kind?: 'sql' | 'script';
  sql: string;
  script?: string;
  uses?: readonly string[];
  datasourceIds?: readonly string[];
  environment?: 'dev' | 'test' | 'staging' | 'prod' | 'custom';
  connectionBindings?: Readonly<Record<string, string>>;
  registrationId?: string;
  timeoutMs?: number;
  maxRows?: number;
  maxAffectedRows?: number;
  retrySafe?: boolean;
  exposure?: 'direct' | 'domain';
  resultDescription?: string;
  packId?: string;
  packVersion?: string;
  operationHash?: string;
  scriptHash?: string;
  maxResultBytes?: number;
}

export interface BusinessOperation<InputSchema extends z.ZodObject = z.ZodObject> extends BusinessOperationOptions<InputSchema> {
  readonly kind: 'sql' | 'script';
  readonly exposure: 'direct' | 'domain';
  readonly uses: readonly string[];
  readonly datasourceIds: readonly string[];
  readonly connectionBindings: Readonly<Record<string, string>>;
  readonly registrationId: string;
}

const TOOL_PART_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function defineBusinessOperation<InputSchema extends z.ZodObject>(
  options: BusinessOperationOptions<InputSchema>,
): BusinessOperation<InputSchema> {
  if (!OPERATION_ID_PATTERN.test(options.id)) {
    throw new PluginError({
      category: 'config_error',
      code: 'INVALID_BUSINESS_OPERATION_ID',
      message: `业务操作 ID ${options.id} 不符合命名规则。`,
    });
  }
  if (!TOOL_PART_PATTERN.test(options.domain) || !TOOL_PART_PATTERN.test(options.name)) {
    throw new PluginError({
      category: 'config_error',
      code: 'INVALID_BUSINESS_TOOL_NAME',
      message: `业务操作 ${options.id} 的 domain 或 name 不符合工具命名规则。`,
    });
  }
  if (!options.id.startsWith(`${options.domain}.`)) {
    throw new PluginError({
      category: 'config_error',
      code: 'BUSINESS_OPERATION_DOMAIN_MISMATCH',
      message: `业务操作 ${options.id} 必须以 ${options.domain}. 开头。`,
    });
  }
  const kind = options.kind ?? 'sql';
  if (kind === 'script' && typeof options.script !== 'string') {
    throw new PluginError({ category: 'config_error', code: 'BUSINESS_SCRIPT_REQUIRED', message: `业务操作 ${options.id} 缺少脚本。` });
  }
  return Object.freeze({
    ...options,
    kind,
    input: options.input.strict() as InputSchema,
    exposure: options.exposure ?? 'domain',
    uses: Object.freeze([...(options.uses ?? [])]),
    datasourceIds: Object.freeze([...(options.datasourceIds ?? [])]),
    connectionBindings: Object.freeze({ ...(options.connectionBindings ?? {}) }),
    registrationId: options.registrationId ?? options.id,
  });
}
