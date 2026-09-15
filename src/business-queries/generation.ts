import { createHash } from 'node:crypto';

import type { BusinessOperation } from './definition.js';
import { BusinessOperationRegistry } from './registry.js';

interface GenerationState {
  id: number;
  hash: string;
  createdAt: string;
  registry: BusinessOperationRegistry;
  refs: number;
  retired: boolean;
  closing: Promise<void> | null;
  closed: Promise<void>;
  resolveClosed: () => void;
}

export interface RegistryGenerationSnapshot {
  id: number;
  hash: string;
  createdAt: string;
  refCount: number;
}

export interface RegistryLease {
  generation: RegistryGenerationSnapshot;
  registry: BusinessOperationRegistry;
  release(): void;
}

export interface PreparedRegistryTransaction<T> {
  registry: BusinessOperationRegistry;
  value: T;
  /** Synchronous publication of the already-staged external surface. */
  commit?: () => void;
  /** Synchronous best-effort restoration when commit throws. */
  rollback?: () => void;
  /** Telemetry/notifications. Failure is logged and never rolls back a committed generation. */
  afterCommit?: () => void;
}

export function businessGenerationHash(operations: readonly BusinessOperation[]): string {
  const stable = operations.map((operation) => ({
    registrationId: operation.registrationId,
    id: operation.id,
    kind: operation.kind,
    environment: operation.environment ?? null,
    operationHash: operation.operationHash ?? null,
    scriptHash: operation.scriptHash ?? null,
  })).sort((left, right) => left.registrationId.localeCompare(right.registrationId));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/** Ref-counted last-known-good registry holder. It deliberately knows nothing about MCP. */
export class RegistryGenerationManager {
  private current: GenerationState;
  private readonly retired = new Set<GenerationState>();
  private reloadTail: Promise<void> = Promise.resolve();
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(registry: BusinessOperationRegistry) {
    this.current = this.createState(1, registry);
  }

  snapshot(): RegistryGenerationSnapshot {
    return this.publicSnapshot(this.current);
  }

  acquire(): RegistryLease {
    if (this.shutdownRequested) throw new Error('RegistryGenerationManager is closing');
    const state = this.current;
    state.refs += 1;
    let released = false;
    return {
      generation: this.publicSnapshot(state),
      registry: state.registry,
      release: () => {
        if (released) return;
        released = true;
        state.refs -= 1;
        void this.closeIfUnused(state);
      },
    };
  }

  async serializedReload<T>(prepare: (current: { registry: BusinessOperationRegistry; generation: RegistryGenerationSnapshot }) => Promise<PreparedRegistryTransaction<T>>): Promise<{
    previous: RegistryGenerationSnapshot;
    current: RegistryGenerationSnapshot;
    value: T;
  }> {
    if (this.shutdownRequested) throw new Error('RegistryGenerationManager is closing');
    let resolveTurn!: () => void;
    const turn = new Promise<void>((resolve) => { resolveTurn = resolve; });
    const prior = this.reloadTail;
    this.reloadTail = prior.then(() => turn, () => turn);
    await prior;
    try {
      if (this.shutdownRequested) throw new Error('RegistryGenerationManager is closing');
      const prepared = await prepare({ registry: this.current.registry, generation: this.publicSnapshot(this.current) });
      if (this.shutdownRequested) {
        try { await prepared.registry.close(); } finally {
          const error = new Error('RegistryGenerationManager is closing');
          Object.defineProperty(error, 'registryCandidateClosed', { value: true, enumerable: false });
          throw error;
        }
      }
      const previous = this.current;
      const next = this.createState(previous.id + 1, prepared.registry);
      this.current = next;
      try {
        prepared.commit?.();
      } catch (error) {
        this.current = previous;
        try { prepared.rollback?.(); } catch (rollbackError) {
          process.stderr.write(`${JSON.stringify({
            level: 'warn', event: 'registry_reload_rollback_failed',
            message: rollbackError instanceof Error ? rollbackError.message : 'unknown',
          })}\n`);
        }
        try { await prepared.registry.close(); } catch (closeError) {
          process.stderr.write(`${JSON.stringify({
            level: 'warn', event: 'registry_reload_candidate_close_failed',
            message: closeError instanceof Error ? closeError.message : 'unknown',
          })}\n`);
        }
        if (error && typeof error === 'object') {
          Object.defineProperty(error, 'registryCandidateClosed', { value: true, enumerable: false });
        }
        throw error;
      }
      previous.retired = true;
      this.retired.add(previous);
      void this.closeIfUnused(previous);
      try { prepared.afterCommit?.(); } catch (error) {
        process.stderr.write(`${JSON.stringify({
          level: 'warn', event: 'registry_reload_postcommit_failed',
          generation: next.id, message: error instanceof Error ? error.message : 'unknown',
        })}\n`);
      }
      return { previous: this.publicSnapshot(previous), current: this.publicSnapshot(next), value: prepared.value };
    } finally {
      resolveTurn();
    }
  }

  async close(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownPromise = (async () => {
      await this.reloadTail;
      const states = [this.current, ...this.retired];
      for (const state of states) {
        state.retired = true;
        this.retired.add(state);
        void this.closeIfUnused(state);
      }
      await Promise.all(states.map((state) => state.closed));
      this.retired.clear();
    })();
    return this.shutdownPromise;
  }

  /** Timeout-only path: close runtimes even if a handler failed to release its lease. */
  forceClose(): void {
    this.shutdownRequested = true;
    for (const state of [this.current, ...this.retired]) {
      state.retired = true;
      this.retired.add(state);
      this.startClose(state);
    }
  }

  private createState(id: number, registry: BusinessOperationRegistry): GenerationState {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    return {
      id, hash: businessGenerationHash(registry.all()), createdAt: new Date().toISOString(),
      registry, refs: 0, retired: false, closing: null, closed, resolveClosed,
    };
  }

  private publicSnapshot(state: GenerationState): RegistryGenerationSnapshot {
    return { id: state.id, hash: state.hash, createdAt: state.createdAt, refCount: state.refs };
  }

  private async closeIfUnused(state: GenerationState): Promise<void> {
    if (!state.retired || state.refs !== 0 || state.closing) return;
    this.startClose(state);
    await state.closed;
  }

  private startClose(state: GenerationState): void {
    if (state.closing) return;
    state.closing = Promise.resolve().then(() => state.registry.close());
    void state.closing.then(() => undefined, (error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        level: 'warn', event: 'registry_generation_close_failed', generation: state.id,
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`);
    }).finally(() => {
      state.resolveClosed();
      this.retired.delete(state);
    });
  }
}
