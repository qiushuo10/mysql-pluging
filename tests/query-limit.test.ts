import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateStore } from '../src/config/store.js';
import type { ConnectionRuntimeRegistry } from '../src/mysql/runtime.js';
import { MysqlService } from '../src/mysql/service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { service: MysqlService; runtimeCalls: { count: number } } {
  const root = mkdtempSync(join(tmpdir(), 'mysql-agent-query-limit-'));
  roots.push(root);
  const store = new StateStore(join(root, 'home'));
  store.addConnection({
    alias: 'app-test', host: 'localhost', username: 'agent', password: '', database: 'app',
  });
  const runtimeCalls = { count: 0 };
  const runtimes = {
    withRuntime: async () => {
      runtimeCalls.count += 1;
      return {
        value: {
          columns: [{ name: 'id', database_type: 'LONG' }],
          rows: Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })),
          rowCount: 5,
          truncated: true,
        },
        attemptCount: 1,
      };
    },
    closeAll: async () => undefined,
  } as unknown as ConnectionRuntimeRegistry;
  return { service: new MysqlService(store, runtimes), runtimeCalls };
}

describe('generic SELECT limits', () => {
  it('allows SQL LIMIT up to 200 independently from max_rows', async () => {
    const { service, runtimeCalls } = setup();
    const result = await service.query({
      connection: 'app-test',
      sql: `SELECT receive_status, routing_rule, COUNT(*) AS cnt,
        MIN(first_seen_at) AS min_at, MAX(first_seen_at) AS max_at
        FROM ky_work_order_receive_record
        WHERE first_seen_at >= '2026-09-16 00:00:00'
        GROUP BY receive_status, routing_rule
        LIMIT 20`,
      maxRows: 5,
    });

    expect(result).toEqual(expect.objectContaining({ row_count: 5, truncated: true }));
    expect(runtimeCalls.count).toBe(1);
    await service.close();
  });

  it('rejects a generic SQL LIMIT above 200 before execution', async () => {
    const { service, runtimeCalls } = setup();

    await expect(service.query({
      connection: 'app-test',
      sql: 'SELECT id FROM orders LIMIT 201',
      maxRows: 5,
    })).rejects.toMatchObject({ code: 'SELECT_LIMIT_EXCEEDED' });
    expect(runtimeCalls.count).toBe(0);
    await service.close();
  });
});
