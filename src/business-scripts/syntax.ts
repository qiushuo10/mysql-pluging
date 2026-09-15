import { stripTypeScriptTypes } from 'node:module';

import { createRunner } from 'run';

import { PluginError } from '../errors.js';

const syntaxRunner = createRunner({
  limits: {
    timeoutMs: 1_000,
    memoryLimitBytes: 16 * 1_048_576,
    maxSourceBytes: 65_536,
    maxResultBytes: 1_024,
    maxConsoleOutputBytes: 1,
    maxBridgeRequests: 1,
    maxInFlightBridgeRequests: 1,
  },
});

const wrapperPrefix = 'async function __mysql_agent_syntax_only__() {\n';
const wrapperSuffix = '\n}';
const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Compiles the real async function body twice, without ever invoking it. */
export async function validateBusinessScriptSyntax(id: string, source: string): Promise<void> {
  try {
    // Node's TypeScript stripper understands the same function-body TypeScript accepted by
    // the runtime. Strip mode preserves offsets, so the exact untrusted body can be sliced
    // back out and compiled directly. A body cannot escape an enclosing false branch unless
    // it contains an unmatched brace; direct AsyncFunction compilation rejects that first.
    const stripped = stripTypeScriptTypes(`${wrapperPrefix}${source}${wrapperSuffix}`, { mode: 'strip' });
    if (!stripped.startsWith(wrapperPrefix) || !stripped.endsWith(wrapperSuffix)) {
      throw new Error('TypeScript stripping changed the validation wrapper');
    }
    const body = stripped.slice(wrapperPrefix.length, -wrapperSuffix.length);
    void new AsyncFunction(body);
    const result = await syntaxRunner.run({
      source: `if (false) {\n${body}\n}\nreturn null;`,
      sourceType: 'function-body',
      limits: { timeoutMs: 1_000, maxResultBytes: 1_024 },
      hostFunctions: {},
    });
    if (result.status !== 'completed') throw new Error('syntax validation was interrupted');
  } catch (error) {
    throw new PluginError({
      category: 'config_error', code: 'BUSINESS_SCRIPT_SYNTAX_INVALID',
      message: `业务脚本 ${id} 未通过 QuickJS 语法校验。`, cause: error,
    });
  }
}
