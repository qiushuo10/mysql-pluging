import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import type { StateStore } from '../config/store.js';
import type {
  ConnectionEnvironment,
  ExecutionRunRecord,
  ExecutionSpanRecord,
  TraceOperationKind,
  TraceStatus,
} from '../types.js';

const MAX_MEASURED_RESULT_BYTES = 16 * 1_048_576;
const TRACE_FINISH_ATTEMPTS = 3;
let lastUuidTimestamp = -1;
let lastUuidSequence = 0;

/** Generates an RFC 9562 UUIDv7 whose textual ordering follows creation time, including same-millisecond calls. */
export function uuidV7(now = Date.now()): string {
  let timestamp = Math.max(now, lastUuidTimestamp);
  if (timestamp === lastUuidTimestamp) {
    if (lastUuidSequence === 0x0fff) {
      timestamp = lastUuidTimestamp + 1;
      lastUuidTimestamp = timestamp;
      lastUuidSequence = 0;
    } else {
      lastUuidSequence += 1;
    }
  } else {
    lastUuidTimestamp = timestamp;
    lastUuidSequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }
  const bytes = randomBytes(16);
  let value = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  bytes[6] = 0x70 | ((lastUuidSequence >> 8) & 0x0f);
  bytes[7] = lastUuidSequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString('hex');
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString('hex');
  return value;
}

export function resultBytes(value: unknown): number {
  try {
    const measured = Buffer.byteLength(JSON.stringify(value), 'utf8');
    return Math.min(measured, MAX_MEASURED_RESULT_BYTES);
  } catch {
    return 0;
  }
}

export interface TraceRootInput {
  workspaceId: string | null;
  taskId?: string | null;
  operationId: string;
  operationKind: TraceOperationKind;
  datasourceIds?: string[];
  environment?: ConnectionEnvironment | null;
  connectionAliases?: string[];
  packId?: string | null;
  packVersion?: string | null;
  operationHash?: string | null;
  scriptHash?: string | null;
  queueDurationMs?: number;
}

export interface TraceChildInput {
  operationId: string;
  operationKind: TraceOperationKind;
  datasourceId?: string | null;
  environment?: ConnectionEnvironment | null;
  connectionAlias?: string | null;
  stepIndex: number;
  queueDurationMs?: number;
}

export interface ExecutionContext {
  readonly runId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly rootSpanId: string;
  readonly parentSpanId: string | null;
  readonly workspaceId: string | null;
  readonly operationId: string;
  readonly operationKind: TraceOperationKind;
  readonly startedAt: string;
  readonly startedPerformanceMs: number;
}

export interface TraceFinishInput {
  status: Exclude<TraceStatus, 'running'>;
  errorCategory?: string | null;
  result?: unknown;
  queueDurationMs?: number;
}

export class TraceRecorder {
  constructor(private readonly store: StateStore) {}

  startRoot(input: TraceRootInput): ExecutionContext {
    const startedAt = new Date().toISOString();
    const runId = uuidV7();
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const context: ExecutionContext = {
      runId, traceId, spanId, rootSpanId: spanId, parentSpanId: null,
      workspaceId: input.workspaceId, operationId: input.operationId,
      operationKind: input.operationKind, startedAt, startedPerformanceMs: performance.now(),
    };
    const run: ExecutionRunRecord = {
      runId, workspaceId: input.workspaceId, taskId: input.taskId ?? null, traceId, rootSpanId: spanId,
      operationId: input.operationId, operationKind: input.operationKind,
      datasourceIds: [...new Set(input.datasourceIds ?? [])], environment: input.environment ?? null,
      connectionAliases: [...new Set(input.connectionAliases ?? [])], packId: input.packId ?? null,
      packVersion: input.packVersion ?? null, operationHash: input.operationHash ?? null,
      scriptHash: input.scriptHash ?? null, startedAt, endedAt: null, durationMs: null,
      queueDurationMs: input.queueDurationMs ?? 0, status: 'running', errorCategory: null, resultBytes: null,
    };
    const root: ExecutionSpanRecord = {
      spanId, runId, traceId, parentSpanId: null, workspaceId: input.workspaceId,
      operationId: input.operationId, operationKind: input.operationKind,
      datasourceId: run.datasourceIds.length === 1 ? run.datasourceIds[0]! : null,
      environment: run.environment, connectionAlias: run.connectionAliases.length === 1 ? run.connectionAliases[0]! : null,
      stepIndex: 0, startedAt, endedAt: null, durationMs: null, queueDurationMs: run.queueDurationMs,
      status: 'running', errorCategory: null, resultBytes: null,
    };
    this.store.createExecutionRoot(run, root);
    return context;
  }

  tryStartRoot(input: TraceRootInput): ExecutionContext | null {
    try {
      return this.startRoot(input);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'trace_start_failed', operation_kind: input.operationKind,
        error_code: traceErrorCode(error),
      })}\n`);
      return null;
    }
  }

  startChild(parent: ExecutionContext, input: TraceChildInput): ExecutionContext {
    const startedAt = new Date().toISOString();
    const spanId = randomHex(8);
    const context: ExecutionContext = {
      runId: parent.runId, traceId: parent.traceId, spanId, rootSpanId: parent.rootSpanId,
      parentSpanId: parent.spanId, workspaceId: parent.workspaceId, operationId: input.operationId,
      operationKind: input.operationKind, startedAt, startedPerformanceMs: performance.now(),
    };
    this.store.createExecutionSpan({
      spanId, runId: parent.runId, traceId: parent.traceId, parentSpanId: parent.spanId,
      workspaceId: parent.workspaceId, operationId: input.operationId, operationKind: input.operationKind,
      datasourceId: input.datasourceId ?? null, environment: input.environment ?? null,
      connectionAlias: input.connectionAlias ?? null, stepIndex: input.stepIndex,
      startedAt, endedAt: null, durationMs: null, queueDurationMs: input.queueDurationMs ?? 0,
      status: 'running', errorCategory: null, resultBytes: null,
    });
    return context;
  }

  finishSpan(context: ExecutionContext, input: TraceFinishInput): boolean {
    return this.finishWithRetry(context, 'span', () => {
      this.store.finishExecutionSpan(context.spanId, {
        endedAt: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - context.startedPerformanceMs)),
        queueDurationMs: input.queueDurationMs, status: input.status, errorCategory: input.errorCategory ?? null,
        resultBytes: resultBytes(input.result),
      });
    });
  }

  finishRoot(context: ExecutionContext, input: TraceFinishInput): boolean {
    return this.finishWithRetry(context, 'root', () => {
      this.store.finishExecutionRoot(context.runId, context.rootSpanId, {
        endedAt: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - context.startedPerformanceMs)),
        queueDurationMs: input.queueDurationMs, status: input.status, errorCategory: input.errorCategory ?? null,
        resultBytes: resultBytes(input.result),
      });
    });
  }

  async withChild<T>(parent: ExecutionContext, input: TraceChildInput, handler: (context: ExecutionContext) => Promise<T>): Promise<T> {
    const child = this.startChild(parent, input);
    try {
      const value = await handler(child);
      const queueDurationMs = value && typeof value === 'object'
        ? Number((value as Record<string, unknown>).queue_duration_ms ?? 0)
        : 0;
      this.finishSpan(child, { status: 'ok', result: value, queueDurationMs });
      return value;
    } catch (error) {
      const normalized = error as { category?: string; code?: string; queueDurationMs?: unknown };
      const cancelled = normalized.code === 'REQUEST_CANCELLED';
      this.finishSpan(child, {
        status: cancelled ? 'cancelled' : 'error', errorCategory: normalized.category ?? 'internal_error',
        queueDurationMs: Number(normalized.queueDurationMs ?? 0),
      });
      throw error;
    }
  }

  private finishWithRetry(context: ExecutionContext, target: 'root' | 'span', action: () => void): boolean {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TRACE_FINISH_ATTEMPTS; attempt += 1) {
      try {
        action();
        return true;
      } catch (error) {
        lastError = error;
        if (!isRetryableSqliteError(error) || attempt === TRACE_FINISH_ATTEMPTS) break;
      }
    }
    process.stderr.write(`${JSON.stringify({
      level: 'warn', event: 'trace_finish_failed', target, run_id: context.runId, span_id: context.spanId,
      error_code: traceErrorCode(lastError), attempts: isRetryableSqliteError(lastError) ? TRACE_FINISH_ATTEMPTS : 1,
    })}\n`);
    return false;
  }
}

function traceErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code).slice(0, 64);
  }
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN';
}

function isRetryableSqliteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '').toUpperCase();
  const message = error instanceof Error ? error.message.toUpperCase() : '';
  return code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED')
    || message.includes('SQLITE_BUSY') || message.includes('SQLITE_LOCKED')
    || message.includes('DATABASE IS LOCKED');
}
