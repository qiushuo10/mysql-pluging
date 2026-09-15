import { describe, expect, it } from 'vitest';

import { PluginError, mapMysqlError, sanitizeMysqlMessage } from '../src/errors.js';
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

  it('keeps a shutdown cancellation after send explicitly unknown', () => {
    const error = normalizeWritePluginError(
      new PluginError({ category: 'timeout', code: 'REQUEST_CANCELLED', message: 'shutdown', retryable: false }),
      'auto-fat',
      true,
    );
    expect(error).toMatchObject({
      category: 'write_outcome_unknown', code: 'MYSQL_WRITE_OUTCOME_UNKNOWN',
      writeOutcome: 'unknown', retryable: false,
    });
  });

  it('keeps explicit MySQL failures known', () => {
    const mysqlError = Object.assign(new Error('duplicate'), {
      errno: 1062,
      code: 'ER_DUP_ENTRY',
      sqlState: '23000',
      sqlMessage: "Duplicate entry 'private-value' for key 'uk_account'",
    });
    const error = mapMysqlError(mysqlError, 'auto-fat', 'known_failed', 1);
    expect(error.category).toBe('sql_error');
    expect(error.writeOutcome).toBe('known_failed');
    expect(error.mysqlErrorName).toBe('ER_DUP_ENTRY');
    expect(error.mysqlMessage).toBe("Duplicate entry '[REDACTED]' for key 'uk_account'");
  });

  it('preserves actionable MySQL diagnostics and redacts bound values', () => {
    const mysqlError = Object.assign(new Error('bad field'), {
      errno: 1054,
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22',
      sqlMessage: "Unknown column 'e.deleted' in 'where clause'",
    });
    const error = mapMysqlError(mysqlError, 'auto-fat', 'not_applicable', 1);
    expect(error).toMatchObject({
      mysqlCode: 1054,
      mysqlErrorName: 'ER_BAD_FIELD_ERROR',
      mysqlMessage: "Unknown column 'e.deleted' in 'where clause'",
      sqlState: '42S22',
    });

    expect(sanitizeMysqlMessage(
      "Incorrect integer value: 'private-value' for column 'tenant_id' at row 1",
      ['private-value'],
    )).toBe("Incorrect integer value: '[REDACTED]' for column 'tenant_id' at row 1");
  });
});
