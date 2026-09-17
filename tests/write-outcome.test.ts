import { describe, expect, it } from 'vitest';

import { PluginError, describePluginError, mapMysqlError, sanitizeMysqlMessage } from '../src/errors.js';
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

  it('falls back to the Error message when sqlMessage is absent', () => {
    const mysqlError = Object.assign(new Error("Unknown column 'third_code' in 'field list'"), {
      errno: 1054,
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22',
    });
    const error = mapMysqlError(mysqlError, 'auto-prod', 'not_applicable', 1);
    expect(error).toMatchObject({
      mysqlCode: 1054,
      mysqlErrorName: 'ER_BAD_FIELD_ERROR',
      mysqlMessage: "Unknown column 'third_code' in 'field list'",
      sqlState: '42S22',
    });
  });

  it('embeds the MySQL reason and identity in the agent-facing message', () => {
    const mysqlError = Object.assign(new Error('bad field'), {
      errno: 1054,
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22',
      sqlMessage: "Unknown column 'e.deleted' in 'where clause'",
    });
    const error = mapMysqlError(mysqlError, 'auto-fat', 'not_applicable', 1);
    expect(error.message).toContain("MySQL 拒绝了当前 SQL：Unknown column 'e.deleted' in 'where clause'");
    expect(error.message).toContain('ER_BAD_FIELD_ERROR, errno 1054, SQLSTATE 42S22');
    expect(describePluginError(error)).toBe(error.message);
  });

  it('embeds the MySQL reason for authentication and permission failures too', () => {
    const authentication = mapMysqlError(Object.assign(new Error('denied'), {
      errno: 1045,
      code: 'ER_ACCESS_DENIED_ERROR',
      sqlState: '28000',
      sqlMessage: "Access denied for user 'agent'@'10.0.0.1' (using password: YES)",
    }), 'auto-fat', 'not_applicable', 1);
    expect(authentication.category).toBe('authentication_error');
    expect(authentication.message).toContain("Access denied for user 'agent'@'10.0.0.1' (using password: YES)");
    expect(authentication.message).toContain('errno 1045');

    const permission = mapMysqlError(Object.assign(new Error('denied'), {
      errno: 1142,
      code: 'ER_TABLEACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: "SELECT command denied to user 'agent'@'%' for table 'orders'",
    }), 'auto-fat', 'not_applicable', 1);
    expect(permission.category).toBe('permission_error');
    expect(permission.message).toContain("SELECT command denied to user 'agent'@'%' for table 'orders'");
    expect(permission.message).toContain('ER_TABLEACCESS_DENIED_ERROR, errno 1142, SQLSTATE 42000');
  });
});
