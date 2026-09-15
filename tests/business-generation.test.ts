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
});
