import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { MAX_RESULT_BYTES } from '../src/constants.js';
import { PluginError } from '../src/errors.js';
import { MODEL_TEXT_MAX_CHARS, modelVisibleData } from '../src/mcp/server.js';
import { boundQueryResult } from '../src/mysql/service.js';

function queryEnvelope(columns: Array<{ name: string; database_type: string }>, rows: Array<Record<string, unknown>>) {
  return {
    schema_version: 'mysql-agent/result/1',
    execution_id: 'test-execution',
    status: 'ok',
    kind: 'query',
    connection: 'auto-dev',
    database: 'auto_server_fat',
    business_operation_id: null,
    columns,
    rows,
    row_count: rows.length,
    truncated: false,
    duration_ms: 1,
    attempt_count: 1,
  };
}

describe('Agent-facing result bounds', () => {
  it('trims rows after including wide column metadata and the complete query envelope', () => {
    const columns = Array.from({ length: 300 }, (_, index) => ({
      name: `column_${index}_${'n'.repeat(900)}`,
      database_type: `TYPE_${'t'.repeat(100)}`,
    }));
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ id: index, payload: 'r'.repeat(900) }));
    const bounded = boundQueryResult(queryEnvelope(columns, rows));

    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.row_count).toBe(bounded.rows.length);
    expect(bounded.row_count).toBeLessThan(rows.length);
    expect(bounded.columns).toEqual(columns);
  });

  it('returns a clear result-limit error when fixed query metadata alone exceeds the cap', () => {
    const columns = Array.from({ length: 1_200 }, (_, index) => ({
      name: `column_${index}_${'n'.repeat(1_000)}`,
      database_type: 'VARCHAR',
    }));
    try {
      boundQueryResult(queryEnvelope(columns, []));
      throw new Error('expected result-limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).category).toBe('result_limit');
      expect((error as PluginError).code).toBe('QUERY_RESULT_METADATA_LIMIT');
    }
  });

  it('bounds model-visible columns and rows while leaving structured data untouched', () => {
    const data = queryEnvelope(
      Array.from({ length: 100 }, (_, index) => ({ name: `column_${index}_${'n'.repeat(1_000)}`, database_type: 'VARCHAR' })),
      Array.from({ length: 100 }, (_, index) => ({ id: index, payload: 'r'.repeat(1_000) })),
    );
    const visible = modelVisibleData(data);

    expect(JSON.stringify(visible).length).toBeLessThanOrEqual(MODEL_TEXT_MAX_CHARS);
    expect(visible.content_truncated).toBe(true);
    expect((visible.columns as unknown[]).length).toBeLessThan(data.columns.length);
    expect(data.columns).toHaveLength(100);
    expect(data.rows).toHaveLength(100);
  });
});
