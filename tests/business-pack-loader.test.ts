import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadBusinessOperations } from '../src/business-packs/loader.js';
import { createMysqlMcpApplication } from '../src/mcp/server.js';

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePack(root: string, sql = 'SELECT id FROM orders WHERE id = :id LIMIT 1'): void {
  const pack = join(root, 'sample');
  mkdirSync(join(pack, 'sql'), { recursive: true });
  writeFileSync(join(pack, 'pack.yml'), `
schema_version: mysql-agent/business-pack/1
pack_id: sample
version: 2.3.4
operations:
  - id: order.find
    domain: order
    name: find
    title: 查订单
    description: 按 ID 查询订单。
    use_when: 已知订单 ID 时使用。
    connections: [auto-dev, auto-fat]
    mode: read
    input:
      id:
        type: string
        min_length: 1
        max_length: 64
        trim: true
    sql_file: sql/find.sql
    max_rows: 1
    retry_safe: true
`);
  writeFileSync(join(pack, 'sql', 'find.sql'), sql);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('business pack loader', () => {
  it('loads the shipped AutoServer pack and expands operations per connection', () => {
    const loaded = loadBusinessOperations();
    expect(loaded.packs).toEqual([
      expect.objectContaining({ id: 'autoserver', version: '1.0.1', operationCount: 4 }),
    ]);
    expect(loaded.operations.map((operation) => operation.id)).toEqual([
      'work_order.summary_since.auto-dev',
      'work_order.summary_since.auto-prod',
      'work_order.trace_by_waybill_no.auto-dev',
      'work_order.trace_by_waybill_no.auto-prod',
    ]);
    expect(loaded.operations.every((operation) => operation.operationHash?.startsWith('sha256:'))).toBe(true);
  });

  it('loads once per MCP application and a restarted application sees changed SQL', async () => {
    const root = temporaryRoot('mysql-agent-packs-');
    const firstState = temporaryRoot('mysql-agent-state-');
    const secondState = temporaryRoot('mysql-agent-state-');
    writePack(root);
    const first = createMysqlMcpApplication({ businessPacksHome: root, stateHome: firstState });
    const firstOperation = first.businessRegistry.grouped()[0]!.operations[0]!;
    const firstHash = firstOperation.operationHash;

    writeFileSync(join(root, 'sample', 'sql', 'find.sql'), 'SELECT order_no FROM orders WHERE id = :id LIMIT 1');
    expect(first.businessRegistry.grouped()[0]!.operations[0]!.operationHash).toBe(firstHash);

    const second = createMysqlMcpApplication({ businessPacksHome: root, stateHome: secondState });
    expect(second.businessRegistry.grouped()[0]!.operations[0]!.operationHash).not.toBe(firstHash);
    await first.close();
    await second.close();
  });

  it('rejects an explicitly configured missing directory', () => {
    const root = temporaryRoot('mysql-agent-missing-packs-');
    expect(() => loadBusinessOperations(join(root, 'missing'))).toThrow(/找不到业务包目录/);
  });

  it('rejects SQL files outside their pack directory', () => {
    const root = temporaryRoot('mysql-agent-invalid-pack-');
    const pack = join(root, 'sample');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(root, 'outside.sql'), 'SELECT id FROM orders LIMIT 1');
    writeFileSync(join(pack, 'pack.yml'), `
schema_version: mysql-agent/business-pack/1
pack_id: sample
version: 1.0.0
operations:
  - id: order.find
    domain: order
    name: find
    title: 查订单
    description: 按 ID 查询订单。
    use_when: 已知订单 ID 时使用。
    connections: [auto-dev]
    mode: read
    input: {}
    sql_file: ../outside.sql
    max_rows: 1
`);
    expect(() => loadBusinessOperations(root)).toThrow(/超出业务包目录/);
  });
});
