import { describe, expect, it } from 'vitest';

import { PluginError, mapMysqlError } from '../src/errors.js';
import { normalizeWritePluginError } from '../src/mysql/service.js';

describe('write outcome mapping', () => {
  it('marks pre-send overload as not sent', () => {
    const error = normalizeWritePluginError(
      new PluginError({ category: 'connection_error', code: 'BUSY', message: 'busy', retryable: true }),
      'auto-fat',
      false,
    );
    expect(error.writeOutcome).toBe('not_sent');
    expect(error.retryable).toBe(true);
  });

  it('marks a post-send timeout as unknown and non-retryable', () => {
    const error = normalizeWritePluginError(
      new PluginError({ category: 'timeout', code: 'QUERY_TIMEOUT', message: 'timeout', retryable: true }),
      'auto-fat',
      true,
    );
    expect(error.category).toBe('write_outcome_unknown');
    expect(error.writeOutcome).toBe('unknown');
    expect(error.retryable).toBe(false);
  });

  it('keeps explicit MySQL failures known', () => {
    const mysqlError = Object.assign(new Error('duplicate'), { errno: 1062, code: 'ER_DUP_ENTRY' });
    const error = mapMysqlError(mysqlError, 'auto-fat', 'known_failed', 1);
    expect(error.category).toBe('sql_error');
    expect(error.writeOutcome).toBe('known_failed');
  });
});
