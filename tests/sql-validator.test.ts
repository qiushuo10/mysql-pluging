import { describe, expect, it } from 'vitest';

import { PluginError } from '../src/errors.js';
import { validateQuerySql, validateWriteSql } from '../src/sql/validator.js';

describe('SQL validation', () => {
  it('allows bounded reads and rejects unbounded or locking reads', () => {
    expect(validateQuerySql('SELECT id FROM orders WHERE id = ? LIMIT 20', ['auto_server_fat'], 20).kind).toBe(
      'select',
    );
    expect(() => validateQuerySql('SELECT * FROM orders', ['auto_server_fat'], 20)).toThrow(/LIMIT/);
    expect(() => validateQuerySql('SELECT COUNT(*) AS total FROM orders', ['auto_server_fat'], 20)).toThrow(
      /COUNT.*LIMIT 1/,
    );
    expect(() => validateQuerySql('SELECT * FROM orders LIMIT 21', ['auto_server_fat'], 20)).toThrow(/1 到 20/);
    expect(() => validateQuerySql('SELECT * FROM orders FOR UPDATE LIMIT 1', ['auto_server_fat'], 20)).toThrow(
      /锁定读/,
    );
    expect(() =>
      validateQuerySql(
        'WITH locked AS (SELECT * FROM orders FOR UPDATE) SELECT * FROM locked LIMIT 1',
        ['auto_server_fat'],
        20,
      ),
    ).toThrow(/锁定读/);
    expect(() => validateQuerySql("SELECT GET_LOCK('x', 1) LIMIT 1", ['auto_server_fat'], 20)).toThrow(
      /GET_LOCK/,
    );
    expect(() => validateQuerySql('SELECT @x := 1 LIMIT 1', ['auto_server_fat'], 20)).toThrow(/会话变量/);
  });

  it('fails closed for multiple statements and cross-database access', () => {
    expect(() => validateQuerySql('SELECT 1 LIMIT 1; SELECT 2 LIMIT 1', ['auto_server_fat'], 20)).toThrow(
      /一条 SQL/,
    );
    expect(() =>
      validateQuerySql('SELECT * FROM prod.orders LIMIT 1', ['auto_server_fat'], 20),
    ).toThrow(/不允许访问数据库 prod/);
    expect(() =>
      validateQuerySql('SHOW COLUMNS FROM prod.orders', ['auto_server_fat'], 20),
    ).toThrow(/不允许访问数据库 prod/);
  });

  it('supports MySQL 8 JSON_TABLE reads without weakening AST safety checks', () => {
    const sql = `
      SELECT
        COUNT(*) AS link_count,
        COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(ref.j, '$.caseKey'))) AS distinct_baseline_cases
      FROM asset_nodes n
      JOIN JSON_TABLE(
        n.metadata_json,
        '$.relatedBaselineCases[*]' COLUMNS (j JSON PATH '$')
      ) ref ON TRUE
      WHERE n.created_in_version_id = ? AND n.type = 'CASE'
      LIMIT 1
    `;
    expect(validateQuerySql(sql, ['auto_server_fat'], 1)).toEqual({
      kind: 'select',
      tables: ['asset_nodes'],
    });

    expect(() => validateQuerySql(sql.replace('LIMIT 1', ''), ['auto_server_fat'], 1)).toThrow(/LIMIT/);
    expect(() => validateQuerySql(
      "SELECT * FROM JSON_TABLE(LOAD_FILE('/tmp/input.json'), '$[*]' COLUMNS (j JSON PATH '$')) ref LIMIT 1",
      ['auto_server_fat'],
      1,
    )).toThrow(/LOAD_FILE/);
    expect(() => validateQuerySql(
      "SELECT * FROM JSON_TABLE((SELECT payload FROM prod.secrets LIMIT 1), '$[*]' COLUMNS (j JSON PATH '$')) ref LIMIT 1",
      ['auto_server_fat'],
      1,
    )).toThrow(/不允许访问数据库 prod/);
    expect(() => validateQuerySql(
      "SELECT * FROM JSON_TABLE(doc, '$[*]' COLUMNS (j JSON PATH '$')) ref; SELECT 2 LIMIT 1",
      ['auto_server_fat'],
      1,
    )).toThrow(/一条 SQL/);
  });

  it('does not rewrite JSON_TABLE text in literals or malformed calls', () => {
    expect(validateQuerySql("SELECT 'JSON_TABLE(doc)' AS sample LIMIT 1", ['app'], 1).kind).toBe('select');
    expect(() => validateQuerySql(
      "SELECT * FROM JSON_TABLE(doc, '$[*]') ref LIMIT 1",
      ['app'],
      1,
    )).toThrow(expect.objectContaining({ code: 'SQL_PARSE_ERROR' }));
  });

  it('allows INSERT and field-bounded UPDATE/DELETE only', () => {
    expect(validateWriteSql('INSERT INTO orders(order_no) VALUES (?)', ['auto_server_fat']).kind).toBe('insert');
    expect(validateWriteSql('UPDATE orders SET status = ? WHERE id = ?', ['auto_server_fat']).kind).toBe('update');
    expect(validateWriteSql('DELETE FROM orders WHERE id = ? LIMIT 1', ['auto_server_fat']).kind).toBe('delete');
    expect(() => validateWriteSql('UPDATE orders SET status = ?', ['auto_server_fat'])).toThrow(/WHERE/);
    expect(() => validateWriteSql('DELETE FROM orders WHERE 1 = 1', ['auto_server_fat'])).toThrow(/WHERE/);
    expect(() =>
      validateWriteSql('INSERT INTO orders(order_no) SELECT order_no FROM old_orders', ['auto_server_fat']),
    ).toThrow(/INSERT SELECT/);
  });

  it('rejects MySQL and MariaDB executable comments before AST safety validation', () => {
    const hiddenReads = [
      'SELECT 1 /*!50000 UNION SELECT password FROM mysql.user */ LIMIT 1',
      'SELECT 1 /*!50000, SLEEP(5) */ LIMIT 1',
      "SELECT 1 /*!50000, LOAD_FILE('/etc/passwd') */ LIMIT 1",
      'SELECT 1 /*m!100000 UNION SELECT password FROM mysql.user */ LIMIT 1',
    ];
    for (const sql of hiddenReads) {
      try {
        validateQuerySql(sql, ['app'], 1);
        throw new Error('expected executable-comment rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect((error as PluginError).code).toBe('EXECUTABLE_COMMENT_FORBIDDEN');
      }
    }
    expect(() => validateWriteSql(
      'INSERT INTO app.orders (id) VALUES (1) /*!80000 ON DUPLICATE KEY UPDATE id=id+1 */',
      ['app'],
    )).toThrow(/可执行注释/);
  });

  it('does not treat executable-comment marker text inside literals as executable', () => {
    expect(validateQuerySql(
      "SELECT '/*!50000 UNION SELECT 1 */' AS mysql_text, '/*M! SLEEP(5) */' AS maria_text LIMIT 1",
      ['app'],
      1,
    ).kind).toBe('select');
  });

  it('rejects bare carriage returns that create parser-differential line-comment endings', () => {
    const hiddenLimit = [
      'SELECT id FROM orders -- comment\r LIMIT 1',
      'SELECT id FROM orders # comment\r LIMIT 1',
    ];
    const hiddenWhere = [
      'UPDATE orders SET status = 1 -- comment\r WHERE id = 1',
      'UPDATE orders SET status = 1 # comment\r WHERE id = 1',
      'DELETE FROM orders -- comment\r WHERE id = 1',
      'DELETE FROM orders # comment\r WHERE id = 1',
    ];
    for (const sql of hiddenLimit) {
      expect(() => validateQuerySql(sql, ['app'], 1)).toThrow(expect.objectContaining({
        code: 'BARE_CARRIAGE_RETURN_FORBIDDEN',
      }));
    }
    for (const sql of hiddenWhere) {
      expect(() => validateWriteSql(sql, ['app'])).toThrow(expect.objectContaining({
        code: 'BARE_CARRIAGE_RETURN_FORBIDDEN',
      }));
    }
  });

  it('allows CRLF line endings when the required LIMIT or WHERE follows', () => {
    expect(validateQuerySql('SELECT id FROM orders -- comment\r\n LIMIT 1', ['app'], 1).kind).toBe('select');
    expect(validateQuerySql('SELECT id FROM orders # comment\r\n LIMIT 1', ['app'], 1).kind).toBe('select');
    expect(validateWriteSql('UPDATE orders SET status = 1 -- comment\r\n WHERE id = 1', ['app']).kind).toBe('update');
    expect(validateWriteSql('UPDATE orders SET status = 1 # comment\r\n WHERE id = 1', ['app']).kind).toBe('update');
    expect(validateWriteSql('DELETE FROM orders -- comment\r\n WHERE id = 1', ['app']).kind).toBe('delete');
    expect(validateWriteSql('DELETE FROM orders # comment\r\n WHERE id = 1', ['app']).kind).toBe('delete');
  });
});
