import { describe, expect, it } from 'vitest';

import { connectionAddSchema, connectionUpdateSchema } from '../src/mcp/schemas.js';

const baseConnection = {
  alias: 'auto-prod',
  host: '127.0.0.1',
  username: 'agent',
  password: 'secret',
  database: 'auto_server',
};

describe('connection schemas', () => {
  it('applies safe defaults without inferring environment from the alias', () => {
    expect(connectionAddSchema.parse(baseConnection)).toEqual(expect.objectContaining({
      alias: 'auto-prod',
      environment: 'custom',
      owner_scope: 'global',
      shareable: false,
      pool_max: 2,
    }));
  });

  it('accepts bounded non-secret datasource metadata', () => {
    expect(connectionAddSchema.parse({
      ...baseConnection,
      datasource_id: 'autoserver-main',
      environment: 'prod',
      owner_scope: 'workspace:autoserver',
      shareable: true,
    })).toEqual(expect.objectContaining({
      datasource_id: 'autoserver-main',
      environment: 'prod',
      owner_scope: 'workspace:autoserver',
      shareable: true,
    }));
  });

  it('rejects invalid datasource metadata and pool sizes above two', () => {
    expect(connectionAddSchema.safeParse({ ...baseConnection, datasource_id: 'Invalid ID' }).success).toBe(false);
    expect(connectionAddSchema.safeParse({ ...baseConnection, environment: 'production' }).success).toBe(false);
    expect(connectionAddSchema.safeParse({ ...baseConnection, owner_scope: '' }).success).toBe(false);
    expect(connectionAddSchema.safeParse({ ...baseConnection, pool_max: 3 }).success).toBe(false);
  });

  it('does not inject defaults into omitted update fields', () => {
    const update = connectionUpdateSchema.parse({ alias: 'auto-prod', description: 'updated' });
    expect(update).not.toHaveProperty('environment');
    expect(update).not.toHaveProperty('owner_scope');
    expect(update).not.toHaveProperty('shareable');
    expect(update).not.toHaveProperty('pool_max');
  });
});
