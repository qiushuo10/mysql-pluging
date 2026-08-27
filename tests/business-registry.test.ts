import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineBusinessOperation } from '../src/business-queries/definition.js';
import { BusinessOperationRegistry, businessDirectToolName, parseBusinessParameters } from '../src/business-queries/registry.js';
import { loadBusinessOperations } from '../src/business-packs/loader.js';
import { PluginError } from '../src/errors.js';
import { compileNamedParameters } from '../src/sql/parameters.js';
import { validateQuerySql } from '../src/sql/validator.js';
import type { SqlParameters } from '../src/types.js';

const businessOperations = loadBusinessOperations().operations;
const workOrderSummarySince = businessOperations.find(
  (operation) => operation.name === 'summary_since' && operation.connection === 'auto-dev',
)!;
const workOrderTraceByWaybillNo = businessOperations.find(
  (operation) => operation.name === 'trace_by_waybill_no' && operation.connection === 'auto-dev',
)!;
const workOrderProdSummarySince = businessOperations.find(
  (operation) => operation.name === 'summary_since' && operation.connection === 'auto-prod',
)!;
const workOrderProdTraceByWaybillNo = businessOperations.find(
  (operation) => operation.name === 'trace_by_waybill_no' && operation.connection === 'auto-prod',
)!;

function operation(index: number, exposure: 'direct' | 'domain' = 'direct') {
  return defineBusinessOperation({
    id: `order.op_${index}`,
    domain: 'order',
    name: `op_${index}`,
    title: `操作 ${index}`,
    description: '测试操作',
    useWhen: '测试注册表时使用',
    connection: 'auto-fat',
    mode: 'read',
    input: z.object({ id: z.string() }),
    sql: 'SELECT id FROM orders WHERE id = :id LIMIT 1',
    maxRows: 1,
    exposure,
  });
}

describe('BusinessOperationRegistry', () => {
  it('keeps small catalogs as direct tools', () => {
    const registry = new BusinessOperationRegistry([operation(1), operation(2)]);
    expect(registry.direct()).toHaveLength(2);
    expect(registry.list({ connection: 'auto-fat' })).toHaveLength(2);
  });

  it('requires catalogs above 30 operations to group the long tail', () => {
    expect(() => new BusinessOperationRegistry(Array.from({ length: 31 }, (_, index) => operation(index)))).toThrow(
      /最多只能保留 30/,
    );
  });

  it('limits each grouped domain lane to 15 operations', () => {
    expect(
      () => new BusinessOperationRegistry(Array.from({ length: 16 }, (_, index) => operation(index, 'domain'))),
    ).toThrow(/超过上限 15/);
  });

  it('groups AutoServe work-order operations by connection, domain, and read lane', () => {
    const registry = new BusinessOperationRegistry(businessOperations);
    const listed = registry.list({ connection: 'auto-dev', domain: 'work_order' });

    expect(registry.direct()).toEqual([]);
    expect(registry.grouped()).toEqual([
      expect.objectContaining({
        toolName: 'business__auto-dev__work_order__read',
        connection: 'auto-dev',
        domain: 'work_order',
        lane: 'read',
        operations: [workOrderSummarySince, workOrderTraceByWaybillNo],
      }),
      expect.objectContaining({
        toolName: 'business__auto-prod__work_order__read',
        connection: 'auto-prod',
        domain: 'work_order',
        lane: 'read',
        operations: [workOrderProdSummarySince, workOrderProdTraceByWaybillNo],
      }),
    ]);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'work_order.summary_since.auto-dev', connection: 'auto-dev', mode: 'read', exposure: 'domain',
        business_pack_id: 'autoserver', business_pack_version: '1.0.1', business_operation_hash: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({ id: 'work_order.trace_by_waybill_no.auto-dev', connection: 'auto-dev', mode: 'read', exposure: 'domain' }),
    ]));
    expect(JSON.stringify(listed)).not.toContain('SELECT');
  });

  it('filters by connection before all other business catalog filters', () => {
    const other = defineBusinessOperation({
      ...operation(3),
      id: 'order.other_source',
      name: 'other_source',
      connection: 'voicehub-test',
    });
    const registry = new BusinessOperationRegistry([operation(1), other]);
    expect(registry.list({ connection: 'auto-fat', domain: 'order' }).map((item) => item.id)).toEqual(['order.op_1']);
    expect(registry.list({ connection: 'voicehub-test', keyword: '操作' }).map((item) => item.id)).toEqual(['order.other_source']);
  });

  it('keeps domain aggregation separated by connection', () => {
    const first = operation(1, 'domain');
    const second = defineBusinessOperation({ ...operation(2, 'domain'), connection: 'voicehub-test' });
    const groups = new BusinessOperationRegistry([first, second]).grouped();
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.connection).sort()).toEqual(['auto-fat', 'voicehub-test']);
    expect(new Set(groups.map((group) => group.toolName)).size).toBe(2);
  });

  it('rejects invalid business connection, bounds, SQL kind, and mode metadata at startup', () => {
    const invalidConnection = defineBusinessOperation({ ...operation(1), connection: 'Bad Alias' });
    const invalidRows = defineBusinessOperation({ ...operation(1), maxRows: 1001 });
    const invalidParameters = defineBusinessOperation({ ...operation(1), input: z.object({ other: z.string() }) });
    const invalidKind = defineBusinessOperation({ ...operation(1), sql: 'UPDATE orders SET id = :id WHERE id = :id', maxRows: 1 });
    const invalidMode = defineBusinessOperation({
      ...operation(1), mode: 'update', sql: 'INSERT INTO orders (id) VALUES (:id)',
      maxRows: undefined, maxAffectedRows: 1, retrySafe: undefined,
    });
    expect(() => new BusinessOperationRegistry([invalidConnection])).toThrow(/connection/);
    expect(() => new BusinessOperationRegistry([invalidRows])).toThrow(/maxRows/);
    expect(() => new BusinessOperationRegistry([invalidParameters])).toThrow(/input schema/);
    expect(() => new BusinessOperationRegistry([invalidKind])).toThrow(/固定 SQL/);
    expect(() => new BusinessOperationRegistry([invalidMode])).toThrow(/固定 SQL/);
  });

  it('rejects direct, grouped discriminator, group-group, and direct-group tool collisions', () => {
    const directCollision = defineBusinessOperation({ ...operation(2), id: 'order.same_tool', name: 'op_1' });
    expect(() => new BusinessOperationRegistry([operation(1), directCollision])).toThrow(/工具名/);

    const duplicateDiscriminator = defineBusinessOperation({ ...operation(2, 'domain'), id: 'order.same_discriminator', name: 'op_1' });
    expect(() => new BusinessOperationRegistry([operation(1, 'domain'), duplicateDiscriminator])).toThrow(/operation=op_1/);

    const groupOne = defineBusinessOperation({ ...operation(1, 'domain'), domain: 'b__c', id: 'b__c.one', connection: 'a' });
    const groupTwo = defineBusinessOperation({ ...operation(2, 'domain'), domain: 'c', id: 'c.two', connection: 'a__b' });
    expect(() => new BusinessOperationRegistry([groupOne, groupTwo])).toThrow(/工具名/);

    const direct = defineBusinessOperation({ ...operation(3), connection: 'a', domain: 'b', id: 'b.direct', name: 'c__read' });
    expect(() => new BusinessOperationRegistry([direct, groupOne])).toThrow(/工具名/);
  });

  it('proves required scalar and bounded scalar-list schemas match SQL placeholders', () => {
    const compatible = defineBusinessOperation({
      ...operation(1),
      input: z.object({
        id: z.string(),
        enabled: z.boolean(),
        count: z.number().safe(),
        note: z.union([z.string(), z.null()]),
        ids: z.array(z.string()).min(1).max(100),
      }),
      sql: 'SELECT id FROM orders WHERE id = :id AND enabled = :enabled AND item_count = :count AND note = :note AND id IN (:...ids) LIMIT 1',
    });
    expect(() => new BusinessOperationRegistry([compatible])).not.toThrow();
    expect(parseBusinessParameters(compatible, {
      id: '1', enabled: true, count: 2, note: null, ids: ['1', '2'],
    })).toEqual({ id: '1', enabled: true, count: 2, note: null, ids: ['1', '2'] });
  });

  it('ignores colon-like text in SQL literals, backticks, and comments during registry validation', () => {
    const quoted = defineBusinessOperation({
      ...operation(1),
      input: z.object({ id: z.string() }),
      sql: `
        SELECT ':single' AS literal_value, \`:backtick\` AS identifier_value
        FROM orders
        WHERE id = :id
        # :hash_comment
        AND 1 = 1 -- :dash_comment
        /* :block_comment */
        LIMIT 1
      `,
    });
    expect(() => new BusinessOperationRegistry([quoted])).not.toThrow();
    expect(compileNamedParameters(quoted.sql, { id: '1' }).values).toEqual(['1']);
  });

  it('rejects executable comments in fixed business SQL at registry startup', () => {
    const hidden = defineBusinessOperation({
      ...operation(1),
      sql: 'SELECT id FROM orders WHERE id = :id /*!50000 UNION SELECT password FROM mysql.user */ LIMIT 1',
    });
    try {
      new BusinessOperationRegistry([hidden]);
      throw new Error('expected executable-comment rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect(error).toMatchObject({ category: 'config_error', code: 'EXECUTABLE_COMMENT_FORBIDDEN' });
    }
  });

  it('rejects bare carriage returns in fixed business SQL at registry startup', () => {
    const hidden = defineBusinessOperation({
      ...operation(1),
      sql: 'SELECT id FROM orders WHERE id = :id -- comment\r LIMIT 1',
    });
    try {
      new BusinessOperationRegistry([hidden]);
      throw new Error('expected bare-carriage-return rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect(error).toMatchObject({ category: 'config_error', code: 'BARE_CARRIAGE_RETURN_FORBIDDEN' });
    }
  });

  it('rejects optional, nested, transformed, coerced, and scalar/list-incompatible inputs at startup', () => {
    const cases = [
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.string().optional() }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.string().default('1') }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.object({ value: z.string() }) }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.string().transform((value) => value.length) }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.coerce.string() }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.number() }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.array(z.string()).min(1).max(100) }) }),
      defineBusinessOperation({ ...operation(1), input: z.object({ id: z.string() }), sql: 'SELECT id FROM orders WHERE id IN (:...id) LIMIT 1' }),
      defineBusinessOperation({
        ...operation(1), input: z.object({ id: z.array(z.object({ value: z.string() })).min(1).max(100) }),
        sql: 'SELECT id FROM orders WHERE id IN (:...id) LIMIT 1',
      }),
    ];
    for (const candidate of cases) expect(() => new BusinessOperationRegistry([candidate])).toThrow(/input schema|列表参数|标量参数/);
  });

  it('defends the runtime boundary from exotic parsed parameter values', () => {
    const exotic = defineBusinessOperation({
      ...operation(1),
      input: z.object({ id: z.string().transform(() => ({ nested: true })) }),
    });
    expect(() => parseBusinessParameters(exotic, { id: '1' })).toThrow(/解析结果无效/);
  });

  it('accepts 128-character MCP names and rejects longer direct and grouped names', () => {
    const directBoundary = defineBusinessOperation({
      ...operation(1), connection: 'a', domain: 'd'.repeat(64), id: `${'d'.repeat(64)}.one`, name: 'n'.repeat(49),
    });
    expect(businessDirectToolName(directBoundary)).toHaveLength(128);
    expect(() => new BusinessOperationRegistry([directBoundary])).not.toThrow();
    const directTooLong = defineBusinessOperation({ ...directBoundary, id: `${'d'.repeat(64)}.two`, name: 'n'.repeat(50) });
    expect(() => new BusinessOperationRegistry([directTooLong])).toThrow(/128|MCP/);

    const groupBoundary = defineBusinessOperation({
      ...operation(1, 'domain'), connection: `a${'c'.repeat(63)}`, domain: 'g'.repeat(46), id: `${'g'.repeat(46)}.one`,
    });
    expect(new BusinessOperationRegistry([groupBoundary]).grouped()[0]?.toolName).toHaveLength(128);
    const groupTooLong = defineBusinessOperation({ ...groupBoundary, domain: 'g'.repeat(47), id: `${'g'.repeat(47)}.one` });
    expect(() => new BusinessOperationRegistry([groupTooLong])).toThrow(/128|MCP/);
  });

  it('validates and compiles the work-order summary parameters', () => {
    const input = workOrderSummarySince.input.parse({ created_after: '2026-08-01 00:00:00' }) as SqlParameters;
    const compiled = compileNamedParameters(workOrderSummarySince.sql, input);
    const validated = validateQuerySql(compiled.sql, ['auto_server_fat'], workOrderSummarySince.maxRows ?? 5);

    expect(compiled.values).toEqual(['2026-08-01 00:00:00', '2026-08-01 00:00:00']);
    expect(compiled.usedParameters).toEqual(['created_after']);
    expect(validated.kind).toBe('select');
    expect(validated.tables).toContain('work_order');
    expect(() => workOrderSummarySince.input.parse({ created_after: '2026-08-01' })).toThrow();
  });

  it('validates and compiles the bounded waybill trace without sensitive raw payload fields', () => {
    const input = workOrderTraceByWaybillNo.input.parse({ waybill_no: 'KY-20260826-001' }) as SqlParameters;
    const compiled = compileNamedParameters(workOrderTraceByWaybillNo.sql, input);
    const validated = validateQuerySql(compiled.sql, ['auto_server_fat'], workOrderTraceByWaybillNo.maxRows ?? 200);

    expect(compiled.values).toEqual(['KY-20260826-001', 'KY-20260826-001', 'KY-20260826-001']);
    expect(validated.kind).toBe('select');
    expect(validated.tables).toEqual(expect.arrayContaining([
      'work_order', 'work_order_operation_record', 'flow_instance', 'flow_task',
      'flow_his_task', 'ky_work_order_receive_record', 'ky_maintenance_result_push_record',
    ]));
    expect(workOrderTraceByWaybillNo.sql).toContain('LIMIT 200');
    expect(workOrderTraceByWaybillNo.sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY section/i);
    expect(workOrderTraceByWaybillNo.sql).toMatch(/WHERE section_rank <= CASE section/i);
    expect(workOrderTraceByWaybillNo.sql).toMatch(/CAST\([^)]*\.id AS CHAR\) AS record_id,\s*[^,]*\.id AS sort_id/i);
    expect(workOrderTraceByWaybillNo.sql).toMatch(/ORDER BY occurred_at DESC, section, sort_id DESC/i);
    expect(workOrderTraceByWaybillNo.sql).not.toMatch(/ORDER BY occurred_at DESC, section, record_id DESC/i);
    const sectionCaps = Object.fromEntries(
      [...workOrderTraceByWaybillNo.sql.matchAll(/WHEN '([^']+)' THEN (\d+)/g)]
        .map((match) => [match[1], Number(match[2])]),
    ) as Record<string, number>;
    expect(sectionCaps).toEqual({
      work_order: 1,
      operation: 40,
      flow_instance: 10,
      flow_task: 30,
      flow_his_task: 50,
      ky_receive: 30,
      ky_push: 39,
    });
    expect(Object.values(sectionCaps).reduce((total, cap) => total + cap, 0)).toBeLessThanOrEqual(200);
    expect(workOrderTraceByWaybillNo.sql).not.toMatch(/token_text|raw_payload|last_raw_payload|request_payload|response_body/i);
    expect(() => workOrderTraceByWaybillNo.input.parse({ waybill_no: '  ' })).toThrow();
  });
});
