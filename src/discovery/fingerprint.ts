import { createHash } from 'node:crypto';

import type { SqlParameters } from '../types.js';

type ScanState = 'normal' | 'single' | 'double' | 'backtick' | 'line_comment' | 'block_comment';

function numericLiteralEnd(sql: string, start: number): number | null {
  const previous = sql[start - 1] ?? '';
  if (/[A-Za-z0-9_$]/.test(previous)) return null;
  let index = start;
  if (sql[index] === '.' && !/\d/.test(sql[index + 1] ?? '')) return null;
  if (sql[index] === '0' && /[xX]/.test(sql[index + 1] ?? '') && /[0-9A-Fa-f]/.test(sql[index + 2] ?? '')) {
    index += 2;
    while (/[0-9A-Fa-f]/.test(sql[index] ?? '')) index += 1;
    return index;
  }
  while (/\d/.test(sql[index] ?? '')) index += 1;
  if (sql[index] === '.') {
    index += 1;
    while (/\d/.test(sql[index] ?? '')) index += 1;
  }
  if (/[eE]/.test(sql[index] ?? '')) {
    let exponent = index + 1;
    if (sql[exponent] === '+' || sql[exponent] === '-') exponent += 1;
    if (/\d/.test(sql[exponent] ?? '')) {
      index = exponent + 1;
      while (/\d/.test(sql[index] ?? '')) index += 1;
    }
  }
  return index > start ? index : null;
}

/**
 * Produces a one-way shape identifier. The normalized SQL is deliberately not
 * returned or persisted: discovery only needs equality, never reconstruction.
 */
export function sqlFingerprint(sql: string): string {
  let state: ScanState = 'normal';
  let normalized = '';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (state === 'line_comment') {
      if (char === '\n') { state = 'normal'; normalized += ' '; }
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') { state = 'normal'; index += 1; normalized += ' '; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const delimiter = state === 'single' ? "'" : '"';
      if (char === '\\' && next) index += 1;
      else if (char === delimiter && next === delimiter) index += 1;
      else if (char === delimiter) { state = 'normal'; normalized += '?'; }
      continue;
    }
    if (state === 'backtick') {
      normalized += char;
      if (char === '`' && next === '`') { normalized += next; index += 1; }
      else if (char === '`') state = 'normal';
      continue;
    }
    if (char === '#') { state = 'line_comment'; continue; }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) { state = 'line_comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block_comment'; index += 1; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '`') { state = 'backtick'; normalized += char; continue; }
    const numericEnd = (/\d/.test(char) || char === '.') ? numericLiteralEnd(sql, index) : null;
    if (numericEnd !== null) {
      normalized += '?';
      index = numericEnd - 1;
      continue;
    }
    normalized += char;
  }
  normalized = normalized
    .replace(/\b(?:null|true|false)\b/gi, '?')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=<>+*/-])\s*/g, '$1')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function scalarType(value: unknown): string {
  if (value === null) return 'null';
  return typeof value;
}

export function parameterShape(parameters: SqlParameters | undefined): Record<string, { type: string; list: boolean }> {
  return Object.fromEntries(Object.entries(parameters ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    if (Array.isArray(value)) {
      const types = [...new Set(value.map(scalarType))].sort();
      return [name, { type: types.join('|') || 'empty', list: true }];
    }
    return [name, { type: scalarType(value), list: false }];
  }));
}
