import { PARAMETER_NAME_PATTERN } from '../constants.js';
import { PluginError } from '../errors.js';
import type { SqlParameterValue, SqlParameters, SqlScalar } from '../types.js';

export interface CompiledSql {
  sql: string;
  values: SqlScalar[];
  usedParameters: string[];
}

export interface NamedParameterToken {
  name: string;
  kind: 'scalar' | 'list';
  start: number;
  end: number;
}

type LexerState = 'normal' | 'single' | 'double' | 'backtick' | 'line_comment' | 'block_comment';

interface SqlLexicalScan {
  parameters: NamedParameterToken[];
  executableCommentIndex: number | null;
}

function argumentError(code: string, message: string): never {
  throw new PluginError({ category: 'argument_error', code, message });
}

function validateScalar(value: unknown, name: string): asserts value is SqlScalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return;
  argumentError(
    'INVALID_PARAMETER_VALUE',
    `参数 ${name} 必须是字符串、安全整数、布尔值、null 或这些类型的一维数组。`,
  );
}

function validateParameters(parameters: SqlParameters): void {
  const names = Object.keys(parameters);
  if (names.length > 200) argumentError('TOO_MANY_PARAMETERS', '单次调用最多允许 200 个命名参数。');
  for (const [name, value] of Object.entries(parameters)) {
    if (!PARAMETER_NAME_PATTERN.test(name)) {
      argumentError('INVALID_PARAMETER_NAME', `参数名 ${name} 不符合命名规则。`);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) argumentError('EMPTY_LIST_PARAMETER', `列表参数 ${name} 不能为空。`);
      if (value.length > 100) argumentError('LIST_PARAMETER_TOO_LARGE', `列表参数 ${name} 最多包含 100 项。`);
      value.forEach((item) => validateScalar(item, name));
    } else {
      validateScalar(value, name);
    }
  }
}

function scanSqlLexically(sql: string): SqlLexicalScan {
  let state: LexerState = 'normal';
  const tokens: NamedParameterToken[] = [];
  let executableCommentIndex: number | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';

    if (state === 'single') {
      if (char === '\\' && next) {
        index += 1;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }
    if (state === 'double') {
      if (char === '\\' && next) {
        index += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'backtick') {
      if (char === '`') state = 'normal';
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
      const marker = sql[index + 2] ?? '';
      if (marker === '!' || (marker.toLowerCase() === 'm' && sql[index + 3] === '!')) {
        executableCommentIndex ??= index;
      }
      state = 'block_comment';
      index += 1;
      continue;
    }

    if (char !== ':' || sql[index - 1] === ':') {
      continue;
    }

    const list = sql.slice(index + 1, index + 4) === '...';
    const nameStart = index + (list ? 4 : 1);
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(nameStart));
    if (!match) continue;

    const name = match[0];
    tokens.push({ name, kind: list ? 'list' : 'scalar', start: index, end: nameStart + name.length });
    index = nameStart + name.length - 1;
  }
  return { parameters: tokens, executableCommentIndex };
}

/** Discovers bind tokens with the same quote/comment rules used by SQL compilation. */
export function discoverNamedParameters(sql: string): NamedParameterToken[] {
  return scanSqlLexically(sql).parameters;
}

/** Detects MySQL/MariaDB executable comments only when they occur in normal SQL code. */
export function containsExecutableComment(sql: string): boolean {
  return scanSqlLexically(sql).executableCommentIndex !== null;
}

export function compileNamedParameters(sql: string, parameters: SqlParameters = {}): CompiledSql {
  validateParameters(parameters);
  let output = '';
  let cursor = 0;
  const values: SqlScalar[] = [];
  const used = new Set<string>();
  const usedLists = new Set<string>();

  for (const token of discoverNamedParameters(sql)) {
    output += sql.slice(cursor, token.start);
    const { name } = token;
    if (!(name in parameters)) argumentError('MISSING_PARAMETER', `缺少 SQL 参数 ${name}。`);
    const value = parameters[name] as SqlParameterValue;
    used.add(name);

    if (token.kind === 'list') {
      if (!Array.isArray(value)) argumentError('LIST_PARAMETER_REQUIRED', `参数 ${name} 必须使用一维数组。`);
      if (usedLists.has(name)) argumentError('REPEATED_LIST_PARAMETER', `列表参数 ${name} 只能展开一次。`);
      usedLists.add(name);
      output += value.map(() => '?').join(', ');
      values.push(...value);
    } else {
      if (Array.isArray(value)) argumentError('SCALAR_PARAMETER_REQUIRED', `参数 ${name} 不能作为普通标量使用。`);
      output += '?';
      values.push(value);
    }
    cursor = token.end;
  }
  output += sql.slice(cursor);

  const unused = Object.keys(parameters).filter((name) => !used.has(name));
  if (unused.length > 0) argumentError('UNUSED_PARAMETER', `存在未使用的 SQL 参数：${unused.join(', ')}。`);

  return { sql: output, values, usedParameters: [...used] };
}
