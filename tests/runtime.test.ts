import { describe, expect, it } from 'vitest';

import type { ConnectionConfig } from '../src/types.js';
import { ConnectionRuntime } from '../src/mysql/runtime.js';

const config: ConnectionConfig = {
  alias: 'load-test',
  description: null,
  host: '127.0.0.1',
  port: 3306,
  username: 'agent',
  password: '',
  database: 'test',
  allowedDatabases: ['test'],
  charset: 'utf8mb4',
  accessMode: 'read_write',
  connectTimeoutMs: 1000,
  queryTimeoutMs: 5000,
  poolMax: 2,
  idleTimeoutMs: 60000,
  enabled: true,
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ConnectionRuntime bulkhead', () => {
  it('runs at most 2 operations, queues 8, and rejects the rest', async () => {
    const runtime = new ConnectionRuntime(config);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const calls = Array.from({ length: 12 }, () =>
      runtime
        .run({ timeoutMs: 5000, retrySafeAfterSend: false }, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate;
          active -= 1;
          return 'ok';
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await Promise.all(calls);

    expect(maxActive).toBe(2);
    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(
      results.filter(
        (result) => !result.ok && (result.error as { code?: string }).code === 'BUSY',
      ),
    ).toHaveLength(2);
    await runtime.close();
  });
});
