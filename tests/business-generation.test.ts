import { describe, expect, it } from 'vitest';

import { RegistryGenerationManager } from '../src/business-queries/generation.js';
import { BusinessOperationRegistry } from '../src/business-queries/registry.js';
import type { BusinessScriptRuntime } from '../src/business-scripts/runtime.js';

function registry(onClose: () => void): BusinessOperationRegistry {
  const runtime: BusinessScriptRuntime = {
    validate: async () => ({ valid: true, sourceBytes: 0 }),
    execute: async () => ({ value: null, resultBytes: 4 }),
    close: async () => { onClose(); },
  };
  return new BusinessOperationRegistry([], runtime);
}

describe('RegistryGenerationManager', () => {
  it('keeps an in-flight old generation alive until its lease is released', async () => {
    let firstClosed = 0;
    const manager = new RegistryGenerationManager(registry(() => { firstClosed += 1; }));
    const lease = manager.acquire();
    const swapped = await manager.serializedReload(async () => ({ registry: registry(() => undefined), value: 'ok' }));
    expect(swapped.current.id).toBe(2);
    expect(firstClosed).toBe(0);
    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstClosed).toBe(1);
    await manager.close();
  });

  it('serializes concurrent reload preparation', async () => {
    const order: string[] = [];
    const manager = new RegistryGenerationManager(registry(() => undefined));
    const first = manager.serializedReload(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('first-end');
      return { registry: registry(() => undefined), value: 1 };
    });
    const second = manager.serializedReload(async () => {
      order.push('second-start');
      return { registry: registry(() => undefined), value: 2 };
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(manager.snapshot().id).toBe(3);
    await manager.close();
  });

  it('preserves the last-known-good generation when preparation fails', async () => {
    const manager = new RegistryGenerationManager(registry(() => undefined));
    await expect(manager.serializedReload(async () => { throw new Error('invalid pack'); })).rejects.toThrow('invalid pack');
    expect(manager.snapshot().id).toBe(1);
    await manager.close();
  });

  it('rolls back publication and closes the candidate before releasing the serialized turn', async () => {
    let candidateClosed = false;
    const order: string[] = [];
    const manager = new RegistryGenerationManager(registry(() => undefined));
    const failed = manager.serializedReload(async () => ({
      registry: registry(() => { candidateClosed = true; order.push('candidate-closed'); }),
      value: null,
      commit: () => { order.push('commit'); throw new Error('publish failed'); },
      rollback: () => { order.push('rollback'); },
    }));
    const next = manager.serializedReload(async () => {
      order.push('next-prepare');
      expect(candidateClosed).toBe(true);
      return { registry: registry(() => undefined), value: null };
    });
    await expect(failed).rejects.toThrow('publish failed');
    await next;
    expect(order).toEqual(['commit', 'rollback', 'candidate-closed', 'next-prepare']);
    expect(manager.snapshot().id).toBe(2);
    await manager.close();
  });

  it('waits for active leases before shutdown closes their registries', async () => {
    let closed = 0;
    let shutdownFinished = false;
    const manager = new RegistryGenerationManager(registry(() => { closed += 1; }));
    const lease = manager.acquire();
    const shutdown = manager.close().then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(0);
    expect(shutdownFinished).toBe(false);
    expect(() => manager.acquire()).toThrow(/closing/);
    await expect(manager.serializedReload(async () => ({
      registry: registry(() => undefined), value: null,
    }))).rejects.toThrow(/closing/);
    lease.release();
    await shutdown;
    expect(closed).toBe(1);
  });

  it('does not force-close SQL or script leases when a shutdown deadline elapses', async () => {
    let closed = 0;
    const manager = new RegistryGenerationManager(registry(() => { closed += 1; }));
    const sqlLease = manager.acquire();
    const scriptLease = manager.acquire();
    const shutdown = manager.close();
    const deadline = await Promise.race([
      shutdown.then(() => 'closed'),
      new Promise<'deadline'>((resolve) => setTimeout(() => resolve('deadline'), 20)),
    ]);
    expect(deadline).toBe('deadline');
    expect(closed).toBe(0);
    sqlLease.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(0);
    scriptLease.release();
    await shutdown;
    expect(closed).toBe(1);
  });

  it('closes an already-prepared candidate instead of publishing it after shutdown begins', async () => {
    const order: string[] = [];
    let releasePrepare!: () => void;
    const prepareBlocked = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const manager = new RegistryGenerationManager(registry(() => { order.push('initial-close'); }));
    const reload = manager.serializedReload(async () => {
      order.push('prepare');
      await prepareBlocked;
      return { registry: registry(() => { order.push('candidate-close'); }), value: null };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shutdown = manager.close();
    await expect(manager.serializedReload(async () => ({
      registry: registry(() => undefined), value: null,
    }))).rejects.toThrow(/closing/);
    releasePrepare();
    await expect(reload).rejects.toThrow(/closing/);
    await shutdown;
    expect(order).toEqual(['prepare', 'candidate-close', 'initial-close']);
  });

  it('force-closes a generation after its drain deadline without waiting for a leaked lease', async () => {
    let closed = 0;
    const manager = new RegistryGenerationManager(registry(() => { closed += 1; }));
    const lease = manager.acquire();
    manager.forceClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
    expect(() => manager.acquire()).toThrow(/closing/);
    lease.release();
    manager.forceClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  it('does not close a leased retired generation during shutdown', async () => {
    let oldClosed = 0;
    let currentClosed = 0;
    const manager = new RegistryGenerationManager(registry(() => { oldClosed += 1; }));
    const oldLease = manager.acquire();
    await manager.serializedReload(async () => ({
      registry: registry(() => { currentClosed += 1; }), value: null,
    }));
    const shutdown = manager.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldClosed).toBe(0);
    expect(currentClosed).toBe(1);
    oldLease.release();
    await shutdown;
    expect(oldClosed).toBe(1);
  });
});
