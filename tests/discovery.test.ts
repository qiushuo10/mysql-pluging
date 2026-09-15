import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { StateStore } from '../src/config/store.js';
import { parameterShape, sqlFingerprint } from '../src/discovery/fingerprint.js';

function tempHome(): string { return mkdtempSync(join(tmpdir(), 'mysql-agent-discovery-')); }

describe('discovery privacy and candidates', () => {
  it('removes comments and literal values before producing the one-way fingerprint', () => {
    const first = sqlFingerprint("SELECT * FROM `orders` WHERE id = 123 AND name = 'secret-a' LIMIT 10 -- private");
    const second = sqlFingerprint("select * from `orders` where id=999 and name='secret-b' limit 20 /* hidden */");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(parameterShape({ order_id: '123', flags: [true, false], missing: null })).toEqual({
      flags: { type: 'boolean', list: true }, missing: { type: 'null', list: false }, order_id: { type: 'string', list: false },
    });
  });

  it('isolates workspaces, aggregates candidates and never persists source values or aliases', () => {
    const store = new StateStore(tempHome());
    const fingerprint = sqlFingerprint("SELECT id FROM orders WHERE customer = 'private-customer' LIMIT 5");
    const record = (workspaceId: string, occurredAt: string, durationMs: number) => store.recordDiscovery({
      workspaceId, runId: null, traceId: null, datasourceId: 'autoserver', environment: 'test',
      occurredAt, statementKind: 'select', sqlFingerprint: fingerprint,
      parameterShape: { customer: { type: 'string', list: false } }, tableNames: ['orders'],
      durationMs, resultBytes: 20, status: 'ok',
    });
    record('workspace-a', '2026-09-15T00:00:00.000Z', 10);
    record('workspace-a', '2026-09-15T00:00:01.000Z', 20);
    record('workspace-a', '2026-09-15T00:00:02.000Z', 30);
    record('workspace-b', '2026-09-15T00:00:03.000Z', 999);

    const candidates = store.analyzeDiscoveryCandidates({ workspaceId: 'workspace-a', minCount: 2, limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ count: 3, error_count: 0, p50_ms: 20, p95_ms: 30, avg_result_bytes: 20 });
    expect(store.analyzeDiscoveryCandidates({ workspaceId: 'workspace-b', minCount: 2, limit: 10 })).toEqual([]);

    store.close();
    const raw = new DatabaseSync(join(store.home, 'state.db'), { readOnly: true });
    const definition = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'discovery_events'").get() as { sql: string };
    const persisted = JSON.stringify(raw.prepare('SELECT * FROM discovery_events').all());
    expect(definition.sql).not.toContain('connection_alias');
    expect(persisted).not.toContain('private-customer');
    expect(persisted).not.toContain('auto-dev');
    raw.close();
  });

  it('applies retention to one workspace only', () => {
    const store = new StateStore(tempHome());
    for (const workspaceId of ['workspace-a', 'workspace-b']) store.recordDiscovery({
      workspaceId, runId: null, traceId: null, datasourceId: 'autoserver', environment: 'test',
      occurredAt: '2026-01-01T00:00:00.000Z', statementKind: 'select', sqlFingerprint: 'a'.repeat(64),
      parameterShape: {}, tableNames: ['orders'], durationMs: 1, resultBytes: 0, status: 'ok',
    });
    expect(store.cleanupDiscovery('workspace-a', '2026-02-01T00:00:00.000Z')).toBe(1);
    expect(store.analyzeDiscoveryCandidates({ workspaceId: 'workspace-a', minCount: 1, limit: 10 })).toEqual([]);
    expect(store.analyzeDiscoveryCandidates({ workspaceId: 'workspace-b', minCount: 1, limit: 10 })).toHaveLength(1);
    store.close();
  });
});
