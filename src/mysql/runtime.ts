import { RWLock } from '@rocicorp/lock';
import {
  BrokenCircuitError,
  BulkheadRejectedError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  TaskCancelledError,
  TimeoutStrategy,
  bulkhead,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  type BulkheadPolicy,
  type CircuitBreakerPolicy,
} from 'cockatiel';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';

import {
  BULKHEAD_QUEUE_MULTIPLIER,
  BULKHEAD_QUEUE_TIMEOUT_MS,
} from '../constants.js';
import { PluginError, isTransientMysqlError } from '../errors.js';
import type { ConnectionConfig } from '../types.js';

export class DatabaseAttemptError extends Error {
  readonly original: unknown;
  readonly sent: boolean;
  readonly transient: boolean;

  constructor(original: unknown, sent: boolean) {
    super(original instanceof Error ? original.message : 'Database operation failed', { cause: original });
    this.name = 'DatabaseAttemptError';
    this.original = original;
    this.sent = sent;
    this.transient = isTransientMysqlError(original);
  }
}

interface RuntimeEntry {
  lock: RWLock;
  current: ConnectionRuntime | undefined;
}

export interface RuntimeRunOptions {
  timeoutMs: number;
  requestSignal?: AbortSignal;
  retrySafeAfterSend: boolean;
}

export interface RuntimeRunResult<T> {
  value: T;
  attemptCount: number;
  queueDurationMs?: number;
}

export class ConnectionRuntime {
  readonly config: ConnectionConfig;
  readonly pool: Pool;
  readonly bulkhead: BulkheadPolicy;
  readonly circuit: CircuitBreakerPolicy;
  private readonly connections = new Set<PoolConnection>();
  private closePromise: Promise<void> | null = null;
  private forceClosed = false;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      charset: config.charset,
      connectTimeout: config.connectTimeoutMs,
      waitForConnections: false,
      connectionLimit: config.poolMax,
      maxIdle: Math.min(2, config.poolMax),
      idleTimeout: config.idleTimeoutMs,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      maxPreparedStatements: 256,
    });
    this.pool.on('connection', (connection) => { this.connections.add(connection); });
    this.bulkhead = bulkhead(config.poolMax, config.poolMax * BULKHEAD_QUEUE_MULTIPLIER);
    this.circuit = circuitBreaker(
      handleWhen((error) => error instanceof DatabaseAttemptError && error.transient),
      {
        breaker: new ConsecutiveBreaker(3),
        halfOpenAfter: new ExponentialBackoff({
          initialDelay: 5_000,
          maxDelay: 30_000,
        }),
      },
    );
    this.circuit.onBreak(() => this.logCircuit('open'));
    this.circuit.onHalfOpen(() => this.logCircuit('half_open'));
    this.circuit.onReset(() => this.logCircuit('closed'));
  }

  async run<T>(options: RuntimeRunOptions, operation: (signal: AbortSignal) => Promise<T>): Promise<RuntimeRunResult<T>> {
    let entered = false;
    let queueTimedOut = false;
    let attemptCount = 0;
    const queuedAt = performance.now();
    let queueDurationMs = 0;
    const queueController = new AbortController();
    const signals = [queueController.signal];
    if (options.requestSignal) signals.push(options.requestSignal);
    const queueSignal = AbortSignal.any(signals);

    let rejectQueueTimeout: ((error: PluginError) => void) | undefined;
    const queueTimeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectQueueTimeout = reject;
    });
    const queueTimer = setTimeout(() => {
      if (entered) return;
      queueTimedOut = true;
      queueController.abort();
      rejectQueueTimeout?.(
        new PluginError({
          category: 'connection_error',
          code: 'BUSY',
          message: `数据源 ${this.config.alias} 当前请求过多，请稍后重试。`,
          retryable: true,
          retryAfterMs: 250,
        }),
      );
    }, BULKHEAD_QUEUE_TIMEOUT_MS);
    queueTimer.unref();

    const bulkheadPromise = this.bulkhead.execute(async () => {
      entered = true;
      queueDurationMs = Math.max(0, Math.round(performance.now() - queuedAt));
      clearTimeout(queueTimer);
      const retryPolicy = retry(
        handleWhen(
          (error) =>
            error instanceof DatabaseAttemptError &&
            error.transient &&
            (!error.sent || options.retrySafeAfterSend),
        ),
        {
          maxAttempts: 1,
          backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 300 }),
        },
      );
      const timeoutPolicy = timeout(options.timeoutMs, TimeoutStrategy.Aggressive);
      const activeSignal = options.requestSignal ?? new AbortController().signal;
      const value = (await timeoutPolicy.execute(
        ({ signal }) =>
          this.circuit.execute(
            () =>
              retryPolicy.execute(() => {
                attemptCount += 1;
                return operation(signal);
              }, signal),
            signal,
          ),
        activeSignal,
      )) as T;
      return { value, attemptCount, queueDurationMs };
    }, queueSignal);

    // Cockatiel removes an aborted queued item when a slot opens. Attach a handler
    // now so the deferred rejection cannot become an unhandled promise.
    void bulkheadPromise.catch(() => undefined);

    try {
      return await Promise.race([bulkheadPromise, queueTimeoutPromise]);
    } catch (error) {
      clearTimeout(queueTimer);
      if (error instanceof PluginError) throw Object.assign(error, { queueDurationMs: Math.max(0, Math.round(performance.now() - queuedAt)) });
      if (error instanceof BulkheadRejectedError || (error instanceof TaskCancelledError && queueTimedOut)) {
        throw Object.assign(new PluginError({
          category: 'connection_error',
          code: 'BUSY',
          message: `数据源 ${this.config.alias} 当前请求过多，请稍后重试。`,
          retryable: true,
          retryAfterMs: 250,
          attemptCount,
          cause: error,
        }), { queueDurationMs: Math.max(0, Math.round(performance.now() - queuedAt)) });
      }
      if (error instanceof BrokenCircuitError) {
        throw new PluginError({
          category: 'connection_error',
          code: 'CIRCUIT_OPEN',
          message: `数据源 ${this.config.alias} 连续连接失败，插件已暂时停止新连接。`,
          retryable: true,
          retryAfterMs: 5_000,
          attemptCount,
          cause: error,
        });
      }
      if (error instanceof TaskCancelledError) {
        throw new PluginError({
          category: 'timeout',
          code: options.requestSignal?.aborted ? 'REQUEST_CANCELLED' : 'QUERY_TIMEOUT',
          message: options.requestSignal?.aborted
            ? `数据源 ${this.config.alias} 的调用已取消。`
            : `数据源 ${this.config.alias} 的调用超过 ${options.timeoutMs} ms。`,
          retryable: !options.requestSignal?.aborted,
          attemptCount,
          cause: error,
        });
      }
      if (error instanceof DatabaseAttemptError) {
        error.message = `${error.message}`;
        throw Object.assign(error, { attemptCount });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.forceClosed) return;
    this.closePromise ??= this.pool.end();
    await this.closePromise;
  }

  forceClose(): void {
    if (this.forceClosed) return;
    this.forceClosed = true;
    for (const connection of this.connections) {
      try { connection.destroy(); } catch { /* best effort during forced shutdown */ }
    }
    this.connections.clear();
    void this.pool.end().catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'mysql_runtime_force_close_failed', connection: this.config.alias,
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
    });
  }

  private logCircuit(state: string): void {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', event: 'mysql_circuit_state', connection: this.config.alias, state })}\n`,
    );
  }
}

export class ConnectionRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private assertOpen(): void {
    if (this.closing) throw new PluginError({
      category: 'internal_error', code: 'SERVER_SHUTTING_DOWN',
      message: 'MySQL runtime 正在关闭。', retryable: true, retryAfterMs: 1_000,
    });
  }

  private entry(alias: string): RuntimeEntry {
    let entry = this.entries.get(alias);
    if (!entry) {
      entry = { lock: new RWLock(), current: undefined };
      this.entries.set(alias, entry);
    }
    return entry;
  }

  async withRuntime<T>(
    config: ConnectionConfig,
    callback: (runtime: ConnectionRuntime) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const entry = this.entry(config.alias);
    await entry.lock.withWrite(async () => {
      this.assertOpen();
      if (entry.current?.config.revision === config.revision) return;
      const previous = entry.current;
      entry.current = new ConnectionRuntime(config);
      if (previous) await previous.close();
    });

    return entry.lock.withRead(async () => {
      this.assertOpen();
      if (!entry.current || entry.current.config.revision !== config.revision) {
        throw new PluginError({
          category: 'config_error',
          code: 'CONNECTION_REVISION_CHANGED',
          message: `数据源 ${config.alias} 的配置正在切换，请重试。`,
          retryable: true,
          retryAfterMs: 100,
        });
      }
      return callback(entry.current);
    });
  }

  async invalidate(alias: string): Promise<void> {
    const entry = this.entries.get(alias);
    if (!entry) return;
    await entry.lock.withWrite(async () => {
      const current = entry.current;
      entry.current = undefined;
      if (current) await current.close();
    });
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    this.closePromise ??= Promise.all([...this.entries.keys()].map((alias) => this.invalidate(alias)))
      .then(() => { this.entries.clear(); });
    await this.closePromise;
  }

  forceClose(): void {
    this.closing = true;
    for (const entry of this.entries.values()) {
      const current = entry.current;
      entry.current = undefined;
      current?.forceClose();
    }
    this.entries.clear();
  }
}
