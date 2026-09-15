import { Buffer } from 'node:buffer';

import {
  createRunner,
  RunError,
  getHostFunctionContext,
  setMaxWorkers,
  type Runner,
} from 'run';

import { PluginError } from '../errors.js';

export const BUSINESS_SCRIPT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  memoryLimitBytes: 32 * 1_048_576,
  maxStackSizeBytes: 1_048_576,
  maxSourceBytes: 65_536,
  maxResultBytes: 262_144,
  maxConsoleOutputBytes: 8_192,
  maxHostFunctionArgumentsBytes: 262_144,
  maxHostFunctionOutputBytes: 1_048_576,
  maxBridgeRequests: 16,
  maxInFlightBridgeRequests: 2,
  maxContinuationBytes: 1_048_576,
});

let workerLimitInitialized = false;
const HARDENING_PRELUDE = 'const Function = undefined;\n';

/** `run` owns a process-global worker pool, so configure it once per process. */
export function initializeBusinessScriptWorkers(): void {
  if (workerLimitInitialized) return;
  setMaxWorkers(2);
  workerLimitInitialized = true;
}

export interface ScriptOperationDefinition {
  id: string;
  source: string;
  timeoutMs: number;
  maxResultBytes: number;
}

export interface ScriptValidationReport { valid: boolean; sourceBytes: number; }

export interface ScriptExecutionRequest extends ScriptOperationDefinition {
  input: Record<string, unknown>;
  signal?: AbortSignal;
  callOperation(operationId: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface ScriptExecutionResult { value: unknown; resultBytes: number; }

/** Stable provider-neutral boundary. Business-pack and registry code do not import `run`. */
export interface BusinessScriptRuntime {
  validate(definition: ScriptOperationDefinition): Promise<ScriptValidationReport>;
  execute(request: ScriptExecutionRequest): Promise<ScriptExecutionResult>;
  close(): Promise<void>;
}

function scriptError(category: 'argument_error' | 'config_error' | 'timeout' | 'result_limit' | 'internal_error', code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}): PluginError {
  return new PluginError({ category, code, message, retryable: options.retryable, cause: options.cause });
}

function mapRunError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  const code = RunError.isInstance(error) || (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string')
    ? String((error as { code: string }).code)
    : 'RUN_ERROR';
  if (code === 'RUN_ABORTED') return scriptError('timeout', 'REQUEST_CANCELLED', '业务脚本调用已取消。');
  if (code === 'RUN_TIMEOUT') return scriptError('timeout', 'BUSINESS_SCRIPT_TIMEOUT', '业务脚本执行超时。');
  if (code === 'RUN_CONCURRENCY_LIMIT') return scriptError('internal_error', 'BUSINESS_SCRIPT_CONCURRENCY_LIMIT', '业务脚本执行容量已满，请稍后重试。', { retryable: true });
  if (code === 'RUN_BRIDGE_LIMIT') return scriptError('argument_error', 'BUSINESS_SCRIPT_BRIDGE_LIMIT', '业务脚本超过宿主调用次数或并发限制。');
  if (code === 'RUN_SOURCE_TOO_LARGE') return scriptError('config_error', 'BUSINESS_SCRIPT_SOURCE_TOO_LARGE', '业务脚本超过源码大小上限。');
  if (code === 'RUN_SERIALIZATION_ERROR') return scriptError('result_limit', 'BUSINESS_SCRIPT_SERIALIZATION_FAILED', '业务脚本返回值必须是有界 JSON 数据。');
  if (code === 'RUN_HOST_FUNCTION_ERROR' || code === 'RUN_HOST_BRIDGE_ERROR') return scriptError('internal_error', 'BUSINESS_SCRIPT_HOST_CALL_FAILED', '业务脚本内部操作失败，请通过 trace_id 检查脱敏步骤记录。');
  if (code === 'RUN_DETACHED_BRIDGE_REQUEST') return scriptError('argument_error', 'BUSINESS_SCRIPT_DETACHED_CALL', '业务脚本必须等待所有内部操作完成。');
  if (code === 'RUN_PROTOCOL_ERROR') return scriptError('internal_error', 'BUSINESS_SCRIPT_RUNTIME_PROTOCOL_ERROR', '业务脚本运行时协议失败。');
  return scriptError('config_error', 'BUSINESS_SCRIPT_EXECUTION_FAILED', '业务脚本无法安全执行。');
}

function jsonResult(value: unknown, maxBytes: number): ScriptExecutionResult {
  let rendered: string | undefined;
  try { rendered = JSON.stringify(value); } catch (error) {
    throw scriptError('result_limit', 'BUSINESS_SCRIPT_SERIALIZATION_FAILED', '业务脚本返回值必须是 JSON 可序列化数据。', { cause: error });
  }
  if (rendered === undefined) throw scriptError('result_limit', 'BUSINESS_SCRIPT_SERIALIZATION_FAILED', '业务脚本必须返回 JSON 值。');
  const bytes = Buffer.byteLength(rendered, 'utf8');
  if (bytes > maxBytes) throw scriptError('result_limit', 'BUSINESS_SCRIPT_RESULT_TOO_LARGE', `业务脚本结果超过 ${maxBytes} 字节上限。`);
  return { value: JSON.parse(rendered) as unknown, resultBytes: bytes };
}

export class RunBusinessScriptRuntime implements BusinessScriptRuntime {
  private readonly runner: Runner<string>;

  constructor() {
    initializeBusinessScriptWorkers();
    this.runner = createRunner({ limits: BUSINESS_SCRIPT_LIMITS });
  }

  async validate(definition: ScriptOperationDefinition): Promise<ScriptValidationReport> {
    const sourceBytes = Buffer.byteLength(HARDENING_PRELUDE + definition.source, 'utf8');
    if (sourceBytes > BUSINESS_SCRIPT_LIMITS.maxSourceBytes) throw scriptError('config_error', 'BUSINESS_SCRIPT_SOURCE_TOO_LARGE', '业务脚本超过源码大小上限。');
    if (definition.timeoutMs < 100 || definition.timeoutMs > BUSINESS_SCRIPT_LIMITS.timeoutMs) throw scriptError('config_error', 'BUSINESS_SCRIPT_TIMEOUT_INVALID', '业务脚本 timeoutMs 超出允许范围。');
    if (definition.maxResultBytes < 1 || definition.maxResultBytes > BUSINESS_SCRIPT_LIMITS.maxResultBytes) throw scriptError('config_error', 'BUSINESS_SCRIPT_RESULT_LIMIT_INVALID', '业务脚本 maxResultBytes 超出允许范围。');
    return { valid: true, sourceBytes };
  }

  async execute(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    await this.validate(request);
    try {
      const result = await this.runner.run<unknown>({
        source: HARDENING_PRELUDE + request.source,
        sourceType: 'function-body',
        abortSignal: request.signal,
        limits: { timeoutMs: request.timeoutMs, maxResultBytes: request.maxResultBytes },
        hostFunctions: {
          workflow: { input: () => request.input },
          operations: { call: (operationId: string, input: unknown) => request.callOperation(operationId, input, getHostFunctionContext().abortSignal) },
        },
      });
      if (result.status !== 'completed') throw scriptError('config_error', 'BUSINESS_SCRIPT_INTERRUPTION_FORBIDDEN', '业务脚本不允许中断或续跑。');
      return jsonResult(result.value, request.maxResultBytes);
    } catch (error) {
      throw mapRunError(error);
    }
  }

  async close(): Promise<void> { /* `run` owns and reuses the process-global worker pool. */ }
}
