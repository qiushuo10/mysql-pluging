import { Buffer } from 'node:buffer';
import nodeSqlParser from 'node-sql-parser';

import { MAX_SQL_BYTES } from '../constants.js';
import { PluginError } from '../errors.js';
import type { StatementKind } from '../types.js';
import { containsExecutableComment } from './parameters.js';

type AstNode = Record<string, unknown>;
type LexerState = 'normal' | 'single' | 'double' | 'backtick' | 'line_comment' | 'block_comment';

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
const JSON_TABLE_NAME = 'JSON_TABLE';
const JSON_TABLE_SOURCE_ALIAS = '__mysql_agent_json_table_source';

function reject(code: string, message: string): never {
  throw new PluginError({ category: 'argument_error', code, message });
}

function isIdentifierCharacter(char: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(char);
}

function hasKeywordAt(sql: string, index: number, keyword: string): boolean {
  if (sql.slice(index, index + keyword.length).toUpperCase() !== keyword) return false;
  const previous = sql[index - 1] ?? '';
  const next = sql[index + keyword.length] ?? '';
  return (!previous || !isIdentifierCharacter(previous)) && (!next || !isIdentifierCharacter(next));
}

function skipTrivia(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/.test(sql[index] ?? '')) {
      index += 1;
      continue;
    }
    if (sql[index] === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      return end === -1 ? sql.length : skipTrivia(sql, end + 2);
    }
    if (sql[index] === '#' || (sql[index] === '-' && sql[index + 1] === '-' && /\s/.test(sql[index + 2] ?? ''))) {
      const end = sql.indexOf('\n', index + 1);
      return end === -1 ? sql.length : skipTrivia(sql, end + 1);
    }
    break;
  }
  return index;
}

interface JsonTableCall {
  closeIndex: number;
  sourceExpression: string;
}

function scanJsonTableCall(sql: string, openIndex: number): JsonTableCall | null {
  let state: LexerState = 'normal';
  let depth = 1;
  let firstComma = -1;
  let hasColumnsClause = false;

  for (let index = openIndex + 1; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';

    if (state === 'single' || state === 'double' || state === 'backtick') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === '\\' && state !== 'backtick' && next) {
        index += 1;
      } else if (char === delimiter && next === delimiter) {
        index += 1;
      } else if (char === delimiter) {
        state = 'normal';
      }
      continue;
    }
    if (state === 'line_comment') {
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }

    if (char === "'") {
      state = 'single';
      continue;
    }
    if (char === '"') {
      state = 'double';
      continue;
    }
    if (char === '`') {
      state = 'backtick';
      continue;
    }
    if (char === '#') {
      state = 'line_comment';
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) {
      state = 'line_comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block_comment';
      index += 1;
      continue;
    }
    if (char === ';') return null;
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        if (firstComma === -1 || !hasColumnsClause) return null;
        const sourceExpression = sql.slice(openIndex + 1, firstComma).trim();
        return sourceExpression ? { closeIndex: index, sourceExpression } : null;
      }
      continue;
    }
    if (depth === 1 && char === ',' && firstComma === -1) {
      firstComma = index;
      continue;
    }
    if (depth === 1 && firstComma !== -1 && hasKeywordAt(sql, index, 'COLUMNS')) {
      const columnsOpen = skipTrivia(sql, index + 'COLUMNS'.length);
      if (sql[columnsOpen] === '(') hasColumnsClause = true;
    }
  }
  return null;
}

/**
 * node-sql-parser 5.4 cannot parse MySQL 8 JSON_TABLE table functions. Rewrite only
 * the parser copy to a derived table while preserving the source expression so
 * forbidden functions, nested reads, and cross-database references remain visible
 * to the existing AST safety checks. The original SQL is still sent to MySQL.
 */
function sqlForParser(sql: string): string {
  let state: LexerState = 'normal';
  let output = '';
  let cursor = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';

    if (state === 'single' || state === 'double' || state === 'backtick') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === '\\' && state !== 'backtick' && next) {
        index += 1;
      } else if (char === delimiter && next === delimiter) {
        index += 1;
      } else if (char === delimiter) {
        state = 'normal';
      }
      continue;
    }
    if (state === 'line_comment') {
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }

    if (char === "'") {
      state = 'single';
      continue;
    }
    if (char === '"') {
      state = 'double';
      continue;
    }
    if (char === '`') {
      state = 'backtick';
      continue;
    }
    if (char === '#') {
      state = 'line_comment';
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) {
      state = 'line_comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block_comment';
      index += 1;
      continue;
    }

    if (!hasKeywordAt(sql, index, JSON_TABLE_NAME)) continue;
    const openIndex = skipTrivia(sql, index + JSON_TABLE_NAME.length);
    if (sql[openIndex] !== '(') continue;
    const call = scanJsonTableCall(sql, openIndex);
    if (!call) continue;

    output += sql.slice(cursor, index);
    output += `(SELECT ${call.sourceExpression} AS ${JSON_TABLE_SOURCE_ALIAS})`;
    cursor = call.closeIndex + 1;
    index = call.closeIndex;
  }
  return output + sql.slice(cursor);
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
    const ast = parser.astify(sqlForParser(sql), { database: 'MySQL' }) as unknown;
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
    tableList = parser.tableList(sqlForParser(sql), { database: 'MySQL' });
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

function validateSelect(ast: AstNode, maxSelectLimit: number, requireLimit: boolean): void {
  assertReadTreeSafe(ast);
  if (requireLimit) {
    const limit = numericLimit(ast);
    if (limit === null) {
      reject('SELECT_LIMIT_REQUIRED', '通用 SELECT 必须包含数字字面量 LIMIT；COUNT 等单行聚合请使用 LIMIT 1。');
    }
    if (limit < 1 || limit > maxSelectLimit) {
      reject('SELECT_LIMIT_EXCEEDED', `SELECT LIMIT 必须在 1 到 ${maxSelectLimit} 之间。`);
    }
  }
}

export function validateQuerySql(
  compiledSql: string,
  allowedDatabases: string[],
  maxSelectLimit: number,
): SqlValidation {
  const ast = parse(compiledSql);
  assertAllowedDatabases(ast, allowedDatabases);
  const type = String(ast.type ?? '').toLowerCase();
  if (type === 'select') {
    validateSelect(ast, maxSelectLimit, true);
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
    validateSelect(expr as AstNode, maxSelectLimit, false);
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
