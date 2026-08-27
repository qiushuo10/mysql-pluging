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
  sql: string;
  timeoutMs?: number;
  maxRows?: number;
  maxAffectedRows?: number;
  retrySafe?: boolean;
  exposure?: 'direct' | 'domain';
  resultDescription?: string;
  packId?: string;
  packVersion?: string;
  operationHash?: string;
}

export interface BusinessOperation<InputSchema extends z.ZodObject = z.ZodObject> extends BusinessOperationOptions<InputSchema> {
  readonly exposure: 'direct' | 'domain';
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
  return Object.freeze({
    ...options,
    input: options.input.strict() as InputSchema,
    exposure: options.exposure ?? 'domain',
  });
}
