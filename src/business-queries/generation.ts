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

  constructor(registry: BusinessOperationRegistry) {
    this.current = this.createState(1, registry);
  }

  snapshot(): RegistryGenerationSnapshot {
    return this.publicSnapshot(this.current);
  }

  acquire(): RegistryLease {
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

  async serializedReload<T>(prepare: () => Promise<PreparedRegistryTransaction<T>>): Promise<{
    previous: RegistryGenerationSnapshot;
    current: RegistryGenerationSnapshot;
    value: T;
  }> {
    let resolveTurn!: () => void;
    const turn = new Promise<void>((resolve) => { resolveTurn = resolve; });
    const prior = this.reloadTail;
    this.reloadTail = prior.then(() => turn, () => turn);
    await prior;
    try {
      const prepared = await prepare();
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
    await this.reloadTail;
    const states = [this.current, ...this.retired];
    await Promise.all(states.map(async (state) => {
      state.retired = true;
      if (!state.closing) state.closing = state.registry.close();
      await state.closing;
    }));
    this.retired.clear();
  }

  private createState(id: number, registry: BusinessOperationRegistry): GenerationState {
    return { id, hash: businessGenerationHash(registry.all()), createdAt: new Date().toISOString(), registry, refs: 0, retired: false, closing: null };
  }

  private publicSnapshot(state: GenerationState): RegistryGenerationSnapshot {
    return { id: state.id, hash: state.hash, createdAt: state.createdAt, refCount: state.refs };
  }

  private async closeIfUnused(state: GenerationState): Promise<void> {
    if (!state.retired || state.refs !== 0 || state.closing) return;
    state.closing = state.registry.close();
    try { await state.closing; } finally { this.retired.delete(state); }
  }
}
