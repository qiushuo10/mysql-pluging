import { Buffer } from 'node:buffer';
import nodeSqlParser from 'node-sql-parser';

import { MAX_SQL_BYTES } from '../constants.js';
import { PluginError } from '../errors.js';
import type { StatementKind } from '../types.js';
import { containsExecutableComment } from './parameters.js';

type AstNode = Record<string, unknown>;

export interface SqlValidation {
  kind: StatementKind;
  tables: string[];
}

const { Parser } = nodeSqlParser;
const parser = new Parser();
const ALLOWED_SHOW = new Set(['tables', 'columns', 'fields', 'index', 'indexes', 'status', 'table status']);
const FORBIDDEN_READ_FUNCTIONS = new Set([
  'BENCHMARK',
  'GET_LOCK',
  'IS_FREE_LOCK',
  'IS_USED_LOCK',
  'LOAD_FILE',
  'MASTER_POS_WAIT',
  'RELEASE_LOCK',
  'SLEEP',
]);

function reject(code: string, message: string): never {
  throw new PluginError({ category: 'argument_error', code, message });
}

function parse(sql: string): AstNode {
  if (!sql.trim()) reject('EMPTY_SQL', 'SQL 不能为空。');
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) reject('SQL_TOO_LARGE', 'SQL 不能超过 65536 字节。');
  if (/\r(?!\n)/.test(sql)) {
    reject('BARE_CARRIAGE_RETURN_FORBIDDEN', 'SQL 不允许未组成 CRLF 的单独回车符。');
  }
  if (containsExecutableComment(sql)) {
    reject('EXECUTABLE_COMMENT_FORBIDDEN', '不允许 MySQL 或 MariaDB 可执行注释。');
  }
  try {
    const ast = parser.astify(sql, { database: 'MySQL' }) as unknown;
    if (Array.isArray(ast)) reject('MULTIPLE_STATEMENTS', '一次只能执行一条 SQL。');
    if (!ast || typeof ast !== 'object') reject('UNSUPPORTED_SQL', '无法识别当前 SQL。');
    return ast as AstNode;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError({
      category: 'argument_error',
      code: 'SQL_PARSE_ERROR',
      message: '无法按 MySQL 语法解析当前 SQL。',
      cause: error,
    });
  }
}

function tablesFor(sql: string, allowedDatabases: string[]): string[] {
  let tableList: string[];
  try {
    tableList = parser.tableList(sql, { database: 'MySQL' });
  } catch (error) {
    throw new PluginError({
      category: 'argument_error',
      code: 'SQL_TABLE_PARSE_ERROR',
      message: '无法确认当前 SQL 访问的数据库和表。',
      cause: error,
    });
  }
  const tables: string[] = [];
  for (const entry of tableList) {
    const [, database, table] = entry.split('::');
    if (database && database !== 'null' && !allowedDatabases.includes(database)) {
      throw new PluginError({
        category: 'permission_error',
        code: 'DATABASE_NOT_ALLOWED',
        message: `当前数据源不允许访问数据库 ${database}。`,
      });
    }
    if (table && table !== 'null') tables.push(database && database !== 'null' ? `${database}.${table}` : table);
  }
  return [...new Set(tables)];
}

function assertAllowedDatabases(node: unknown, allowedDatabases: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => assertAllowedDatabases(item, allowedDatabases));
    return;
  }
  const record = node as AstNode;
  const database = record.db;
  if (typeof database === 'string' && database && !allowedDatabases.includes(database)) {
    throw new PluginError({
      category: 'permission_error',
      code: 'DATABASE_NOT_ALLOWED',
      message: `当前数据源不允许访问数据库 ${database}。`,
    });
  }
  Object.values(record).forEach((value) => assertAllowedDatabases(value, allowedDatabases));
}

function numericLimit(ast: AstNode): number | null {
  const limit = ast.limit as AstNode | null | undefined;
  const values = limit?.value;
  if (!Array.isArray(values) || values.length === 0) return null;
  const last = values.at(-1);
  if (!last || typeof last !== 'object') return null;
  const value = (last as AstNode).value;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function containsColumn(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsColumn);
  const record = node as AstNode;
  if (record.type === 'column_ref') return true;
  return Object.values(record).some(containsColumn);
}

function functionName(node: AstNode): string | null {
  const name = node.name;
  if (!name || typeof name !== 'object') return null;
  const parts = (name as AstNode).name;
  if (!Array.isArray(parts)) return null;
  return parts
    .map((part) => (part && typeof part === 'object' ? String((part as AstNode).value ?? '') : ''))
    .filter(Boolean)
    .join('.')
    .toUpperCase();
}

function assertReadTreeSafe(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(assertReadTreeSafe);
    return;
  }
  const record = node as AstNode;
  if (record.type === 'select') {
    if (record.locking_read) reject('LOCKING_READ_FORBIDDEN', '通用查询不允许 FOR UPDATE 或其他锁定读。');
    const into = record.into as AstNode | null | undefined;
    if (into?.keyword || into?.type === 'into') {
      reject('SELECT_INTO_FORBIDDEN', '通用查询不允许 INTO OUTFILE 或 INTO DUMPFILE。');
    }
  }
  if (record.type === 'assign' || record.type === 'var') {
    reject('SESSION_STATE_FORBIDDEN', '通用查询不允许读取或修改 MySQL 会话变量。');
  }
  if (record.type === 'function') {
    const name = functionName(record);
    if (name && FORBIDDEN_READ_FUNCTIONS.has(name)) {
      reject('READ_FUNCTION_FORBIDDEN', `通用查询不允许调用 ${name}。`);
    }
  }
  Object.values(record).forEach(assertReadTreeSafe);
}

function validateSelect(ast: AstNode, maxRows: number, requireLimit: boolean): void {
  assertReadTreeSafe(ast);
  if (requireLimit) {
    const limit = numericLimit(ast);
    if (limit === null) {
      reject('SELECT_LIMIT_REQUIRED', '通用 SELECT 必须包含数字字面量 LIMIT；COUNT 等单行聚合请使用 LIMIT 1。');
    }
    if (limit < 1 || limit > maxRows) {
      reject('SELECT_LIMIT_EXCEEDED', `SELECT LIMIT 必须在 1 到 ${maxRows} 之间。`);
    }
  }
}

export function validateQuerySql(
  compiledSql: string,
  allowedDatabases: string[],
  maxRows: number,
): SqlValidation {
  const ast = parse(compiledSql);
  assertAllowedDatabases(ast, allowedDatabases);
  const type = String(ast.type ?? '').toLowerCase();
  if (type === 'select') {
    validateSelect(ast, maxRows, true);
    return { kind: 'select', tables: tablesFor(compiledSql, allowedDatabases) };
  }
  if (type === 'show') {
    const keyword = String(ast.keyword ?? '').toLowerCase();
    if (!ALLOWED_SHOW.has(keyword)) reject('SHOW_FORBIDDEN', `不允许执行 SHOW ${keyword || 'UNKNOWN'}。`);
    return { kind: 'show', tables: tablesFor(compiledSql, allowedDatabases) };
  }
  if (type === 'desc') {
    return { kind: 'describe', tables: tablesFor(compiledSql, allowedDatabases) };
  }
  if (type === 'explain') {
    const expr = ast.expr;
    if (!expr || typeof expr !== 'object' || (expr as AstNode).type !== 'select') {
      reject('EXPLAIN_FORBIDDEN', '通用查询只允许 EXPLAIN SELECT。');
    }
    validateSelect(expr as AstNode, maxRows, false);
    return { kind: 'explain', tables: tablesFor(compiledSql, allowedDatabases) };
  }
  reject('QUERY_STATEMENT_REQUIRED', 'sql_query 只允许 SELECT、SHOW、DESCRIBE 或 EXPLAIN SELECT。');
}

export function validateWriteSql(compiledSql: string, allowedDatabases: string[]): SqlValidation {
  const ast = parse(compiledSql);
  assertAllowedDatabases(ast, allowedDatabases);
  const type = String(ast.type ?? '').toLowerCase();
  if (type !== 'insert' && type !== 'update' && type !== 'delete') {
    reject('WRITE_STATEMENT_REQUIRED', 'sql_execute 只允许 INSERT、UPDATE 或 DELETE。');
  }
  if (type === 'insert') {
    if (ast.on_duplicate_update) reject('UPSERT_FORBIDDEN', '通用 INSERT 不允许 ON DUPLICATE KEY UPDATE。');
    const values = ast.values as AstNode | null | undefined;
    if (values?.type !== 'values') reject('INSERT_SELECT_FORBIDDEN', '通用 INSERT 不允许 INSERT SELECT。');
  } else {
    if (!ast.where || !containsColumn(ast.where)) {
      reject('WHERE_REQUIRED', `${type.toUpperCase()} 必须包含引用字段的 WHERE 条件。`);
    }
  }
  return { kind: type, tables: tablesFor(compiledSql, allowedDatabases) } as SqlValidation;
}
