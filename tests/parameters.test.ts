import { describe, expect, it } from 'vitest';

import { PluginError } from '../src/errors.js';
import { sqlQuerySchema } from '../src/mcp/schemas.js';
import { compileNamedParameters, containsExecutableComment, discoverNamedParameters } from '../src/sql/parameters.js';

describe('compileNamedParameters', () => {
  it('binds scalar and list parameters without changing literals or comments', () => {
    const compiled = compileNamedParameters(
      "SELECT ':ignored' AS literal FROM orders WHERE id IN (:...ids) AND amount >= :amount -- :comment\nLIMIT 5",
      { ids: ['1', '2'], amount: 10.5 },
    );
    expect(compiled.sql).toContain("SELECT ':ignored'");
    expect(compiled.sql).toContain('id IN (?, ?)');
    expect(compiled.sql).toContain('amount >= ?');
    expect(compiled.sql).toContain('-- :comment');
    expect(compiled.values).toEqual(['1', '2', 10.5]);
  });

  it('rejects missing, unused, empty, and repeated list parameters', () => {
    expect(() => compileNamedParameters('SELECT :id LIMIT 1', {})).toThrow(PluginError);
    expect(() => compileNamedParameters('SELECT 1 LIMIT 1', { id: 1 })).toThrow(/未使用/);
    expect(() => compileNamedParameters('SELECT * FROM t WHERE id IN (:...ids) LIMIT 1', { ids: [] })).toThrow(/不能为空/);
    expect(() =>
      compileNamedParameters('SELECT * FROM t WHERE a IN (:...ids) OR b IN (:...ids) LIMIT 1', { ids: [1] }),
    ).toThrow(/只能展开一次/);
  });

  it('requires unsafe integers to be passed as strings', () => {
    const unsafeNumber = Number.MAX_SAFE_INTEGER + 1;
    const parsed = sqlQuerySchema.parse({
      connection: 'auto-dev',
      sql: 'SELECT :id LIMIT 1',
      parameters: { id: unsafeNumber },
    });
    expect(parsed.parameters.id).toBe(unsafeNumber);
    try {
      compileNamedParameters(parsed.sql, parsed.parameters);
      throw new Error('expected unsafe integer validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect(error).toMatchObject({ code: 'UNSAFE_INTEGER_PARAMETER', category: 'argument_error' });
      expect((error as Error).message).toContain('按 JSON 字符串传入');
      expect((error as Error).message).toContain('不能自动还原');
    }
    expect(compileNamedParameters('SELECT :id LIMIT 1', { id: '9007199254740993' }).values).toEqual([
      '9007199254740993',
    ]);
  });

  it('discovers only real tokens outside literals, identifiers, comments, and escaped quote content', () => {
    const sql = `
      SELECT ':single', "\\\":escaped_double", \`:backtick\`, 'it\\\'s :escaped_single'
      FROM orders
      WHERE id = :id AND status IN (:...statuses)
      # :hash_comment
      AND enabled = :enabled -- :dash_comment
      /* :block_comment */
      LIMIT 5
    `;
    expect(discoverNamedParameters(sql).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'id', kind: 'scalar' },
      { name: 'statuses', kind: 'list' },
      { name: 'enabled', kind: 'scalar' },
    ]);
    const compiled = compileNamedParameters(sql, { id: '1', statuses: ['OPEN'], enabled: true });
    expect(compiled.values).toEqual(['1', 'OPEN', true]);
    expect(compiled.sql).toContain("'it\\\'s :escaped_single'");
    expect(compiled.sql).toContain('/* :block_comment */');
  });

  it('detects executable comments only in normal SQL code', () => {
    expect(containsExecutableComment("SELECT 'safe\\\' /*! hidden */' AS text LIMIT 1")).toBe(false);
    expect(containsExecutableComment('SELECT `/*! identifier */` FROM orders LIMIT 1')).toBe(false);
    expect(containsExecutableComment('SELECT 1 -- /*! line comment */\nLIMIT 1')).toBe(false);
    expect(containsExecutableComment('SELECT 1 # /*M! line comment */\nLIMIT 1')).toBe(false);
    expect(containsExecutableComment('SELECT 1 /*!50000 UNION SELECT 2 */ LIMIT 1')).toBe(true);
    expect(containsExecutableComment('SELECT 1 /*M!100000 UNION SELECT 2 */ LIMIT 1')).toBe(true);
  });
});
