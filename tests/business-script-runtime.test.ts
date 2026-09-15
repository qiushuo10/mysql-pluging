import { describe, expect, it } from 'vitest';

import { RunBusinessScriptRuntime } from '../src/business-scripts/runtime.js';

function request(source: string, overrides: Partial<Parameters<RunBusinessScriptRuntime['execute']>[0]> = {}) {
  return {
    id: 'test.script', source, timeoutMs: 1_000, maxResultBytes: 32_768, input: { id: 'A1' },
    callOperation: async (id: string, input: unknown) => ({ id, input }),
    ...overrides,
  };
}

describe('RunBusinessScriptRuntime', () => {
  it('only exposes the two explicit host namespaces', async () => {
    const runtime = new RunBusinessScriptRuntime();
    const result = await runtime.execute(request(`
      const input = await workflow.input();
      return {
        input,
        process: typeof process,
        require: typeof require,
        Buffer: typeof Buffer,
        fetch: typeof fetch,
        WebSocket: typeof WebSocket,
        timers: typeof setTimeout,
        eval: typeof eval,
        Function: typeof Function,
      };
    `));
    expect(result.value).toEqual({
      input: { id: 'A1' }, process: 'undefined', require: 'undefined', Buffer: 'undefined', fetch: 'undefined',
      WebSocket: 'undefined', timers: 'undefined', eval: 'undefined', Function: 'undefined',
    });
    await runtime.close();
  });

  it('runs TypeScript function-body source without a module loader', async () => {
    const runtime = new RunBusinessScriptRuntime();
    const value = await runtime.execute(request(`
      const input: { id: string } = await workflow.input();
      const row = await operations.call('order.find', input);
      return { row };
    `));
    expect(value.value).toEqual({ row: { id: 'order.find', input: { id: 'A1' } } });
  });

  it('blocks code generation and module loading escape routes', async () => {
    const runtime = new RunBusinessScriptRuntime();
    for (const source of [
      `return Function('return 1')();`,
      `return (() => {}).constructor('return typeof process')();`,
      `return (async () => {}).constructor('return typeof process')();`,
      `return eval('1');`,
      `return import('node:fs');`,
    ]) await expect(runtime.execute(request(source))).rejects.toMatchObject({ code: 'BUSINESS_SCRIPT_EXECUTION_FAILED' });
  });

  it('maps timeout, cancellation, bridge and serialization failures to stable errors', async () => {
    const runtime = new RunBusinessScriptRuntime();
    await expect(runtime.execute(request('while (true) {}', { timeoutMs: 100 }))).rejects.toMatchObject({ code: 'BUSINESS_SCRIPT_TIMEOUT' });

    const controller = new AbortController();
    controller.abort();
    await expect(runtime.execute(request('return 1;', { signal: controller.signal }))).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    await expect(runtime.execute(request(`
      await workflow.input();
      for (let index = 0; index < 16; index += 1) await operations.call('order.find', { index });
      return true;
    `))).rejects.toMatchObject({ code: 'BUSINESS_SCRIPT_BRIDGE_LIMIT' });

    await expect(runtime.execute(request('return 1n;'))).rejects.toMatchObject({ code: 'BUSINESS_SCRIPT_SERIALIZATION_FAILED' });
    await expect(runtime.execute(request(`return '${'x'.repeat(2048)}';`, { maxResultBytes: 64 }))).rejects.toMatchObject({ code: expect.stringMatching(/BUSINESS_SCRIPT_(RESULT_TOO_LARGE|SERIALIZATION_FAILED)/) });
  });

  it('fails closed on memory exhaustion attempts', async () => {
    const runtime = new RunBusinessScriptRuntime();
    await expect(runtime.execute(request(`
      const values = [];
      while (true) values.push(new Array(10000).fill('0123456789'));
    `))).rejects.toMatchObject({ code: expect.stringMatching(/^BUSINESS_SCRIPT_/) });
  });

  it('limits in-flight host calls to two and forwards runtime cancellation to host work', async () => {
    const runtime = new RunBusinessScriptRuntime();
    let maximum = 0;
    let active = 0;
    let hostAborted = false;
    const callOperation = async (_id: string, _input: unknown, signal: AbortSignal) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          signal.addEventListener('abort', () => { hostAborted = true; clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
        return true;
      } finally { active -= 1; }
    };
    await expect(runtime.execute(request(`
      return await Promise.all([
        operations.call('order.find', { id: 1 }),
        operations.call('order.find', { id: 2 }),
        operations.call('order.find', { id: 3 }),
      ]);
    `, { callOperation }))).rejects.toMatchObject({ code: 'BUSINESS_SCRIPT_BRIDGE_LIMIT' });
    expect(maximum).toBeLessThanOrEqual(2);

    await expect(runtime.execute(request(`await operations.call('order.find', {}); return true;`, {
      timeoutMs: 100, callOperation,
    }))).rejects.toMatchObject({ code: expect.stringMatching(/BUSINESS_SCRIPT_(TIMEOUT|HOST_CALL_FAILED)/) });
    expect(hostAborted).toBe(true);
  });
});
