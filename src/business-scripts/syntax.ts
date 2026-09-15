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

/** QuickJS parses the real function body while the false branch prevents source execution. */
export async function validateBusinessScriptSyntax(id: string, source: string): Promise<void> {
  try {
    const result = await syntaxRunner.run({
      source: `if (false) {\n${source}\n}\nreturn null;`,
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
