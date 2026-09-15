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

  it('preserves arithmetic operators while treating exponent signs as part of a numeric literal', () => {
    const scalar = sqlFingerprint('SELECT 1 LIMIT 1');
    const subtraction = sqlFingerprint('SELECT 1-2 LIMIT 1');
    const addition = sqlFingerprint('SELECT 1+2 LIMIT 1');
    expect(new Set([scalar, subtraction, addition]).size).toBe(3);
    expect(sqlFingerprint('SELECT 1e-2 LIMIT 1')).toBe(sqlFingerprint('SELECT 9E+8 LIMIT 3'));
    expect(sqlFingerprint('SELECT .5 LIMIT 1')).toBe(sqlFingerprint('SELECT 0.75 LIMIT 9'));
    expect(sqlFingerprint('SELECT 0xCAFE LIMIT 1')).toBe(sqlFingerprint('SELECT 0xBEEF LIMIT 2'));
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

  it('scores repetition only against events inside the requested window', () => {
    const store = new StateStore(tempHome());
    const fingerprint = 'b'.repeat(64);
    const add = (occurredAt: string) => store.recordDiscovery({
      workspaceId: 'windowed', runId: null, traceId: null, datasourceId: 'orders', environment: 'test',
      occurredAt, statementKind: 'select', sqlFingerprint: fingerprint, parameterShape: {},
      tableNames: ['orders'], durationMs: 1, resultBytes: 1, status: 'ok',
    });
    add('2026-09-15T00:00:00.000Z');
    add('2026-09-15T00:00:01.000Z');
    add('2026-09-15T00:00:02.000Z');
    const [candidate] = store.analyzeDiscoveryCandidates({
      workspaceId: 'windowed', since: '2026-09-15T00:00:00.500Z', minCount: 1, limit: 10,
    });
    // Two in-window events contain exactly one eligible transition. The
    // immediately preceding out-of-window event must not create a second one.
    expect(candidate).toMatchObject({ count: 2, repeated_sequence_score: 1 });
    expect(Number(candidate!.repeated_sequence_score)).toBeGreaterThanOrEqual(0);
    expect(Number(candidate!.repeated_sequence_score)).toBeLessThanOrEqual(1);
    store.close();
  });

  it('separates the same SQL fingerprint by canonical parameter shape', () => {
    const store = new StateStore(tempHome());
    const fingerprint = 'c'.repeat(64);
    const shapes: Array<Record<string, { type: string; list: boolean }>> = [
      { order_id: { type: 'string', list: false }, region: { type: 'string', list: false } },
      { region: { type: 'string', list: false }, order_id: { type: 'string', list: false } },
      { order_id: { type: 'number', list: false } },
      { order_id: { type: 'number', list: false } },
    ];
    for (const [index, parameterShape] of shapes.entries()) store.recordDiscovery({
      workspaceId: 'shapes', runId: null, traceId: null, datasourceId: 'orders', environment: 'test',
      occurredAt: `2026-09-15T00:00:0${index}.000Z`, statementKind: 'select', sqlFingerprint: fingerprint,
      parameterShape, tableNames: ['orders'], durationMs: 1, resultBytes: 1, status: 'ok',
    });
    const candidates = store.analyzeDiscoveryCandidates({ workspaceId: 'shapes', minCount: 2, limit: 10 });
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.parameter_shape)).toEqual(expect.arrayContaining([
      { order_id: { type: 'number', list: false } },
      { order_id: { type: 'string', list: false }, region: { type: 'string', list: false } },
    ]));
    store.close();
  });

  it('keeps candidate materialization bounded under a high-cardinality window', () => {
    const store = new StateStore(tempHome());
    for (let index = 0; index < 2_000; index += 1) store.recordDiscovery({
      workspaceId: 'pressure', runId: null, traceId: null, datasourceId: 'orders', environment: 'test',
      occurredAt: new Date(Date.UTC(2026, 8, 15, 0, 0, 0, index)).toISOString(), statementKind: 'select',
      sqlFingerprint: index.toString(16).padStart(64, '0'), parameterShape: {}, tableNames: ['orders'],
      durationMs: index % 100, resultBytes: index, status: 'ok',
    });
    const candidates = store.analyzeDiscoveryCandidates({ workspaceId: 'pressure', minCount: 1, limit: 7 });
    expect(candidates).toHaveLength(7);
    store.close();
  });
});
