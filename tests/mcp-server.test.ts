import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMysqlMcpApplication } from '../src/mcp/server.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('MySQL MCP server', () => {
  it('exposes the agreed tools and manages connections without opening MySQL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mysql-agent-mcp-'));
    homes.push(home);
    let schemaLoads = 0;
    const application = createMysqlMcpApplication({
      stateHome: home,
      schemaLoader: async (config) => {
        schemaLoads += 1;
        return {
          tables: [{
            database: config.database,
            name: 'orders',
            type: 'table',
            comment: 'Orders',
            columns: [{
              name: 'id', ordinal: 1, data_type: 'bigint', column_type: 'bigint', nullable: false,
              default: null, primary_key: true, comment: null,
            }],
            indexes: [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id'] }],
          }],
          relations: [],
        };
      },
    });
    const client = new Client({ name: 'codex-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'connection_add',
        'connection_update',
        'connection_list',
        'connection_remove',
        'history_search',
        'sql_query',
        'sql_execute',
        'schema_search',
        'schema_describe',
        'list_business_operations',
        'business__auto-dev__work_order__read',
        'business__auto-prod__work_order__read',
      ]),
    );
    expect(names).not.toContain('business__work_order__summary_since');
    expect(names).not.toContain('business__work_order__trace_by_waybill_no');
    expect(names).not.toContain('test_connection');

    const queryTool = tools.tools.find((tool) => tool.name === 'sql_query');
    expect(queryTool?.description).toContain(':name');
    expect(queryTool?.description).toContain('COUNT');
    expect(queryTool?.description).toContain('LIMIT 1');
    expect(JSON.stringify(queryTool?.inputSchema)).toContain('每个 SELECT');

    const businessOperations = await client.callTool({ name: 'list_business_operations', arguments: { connection: 'auto-dev' } });
    expect(businessOperations.isError).toBe(false);
    expect(JSON.stringify(businessOperations.content)).toContain('work_order.summary_since');
    expect(JSON.stringify(businessOperations.structuredContent)).not.toContain('SELECT');

    const catalogTool = tools.tools.find((tool) => tool.name === 'list_business_operations');
    expect((catalogTool?.inputSchema.required as string[])).toContain('connection');
    const autoServeTool = tools.tools.find((tool) => tool.name === 'business__auto-dev__work_order__read');
    expect(autoServeTool?.description).toContain('固定数据源 auto-dev');
    expect(JSON.stringify(autoServeTool?.inputSchema)).toContain('trace_by_waybill_no');
    expect(JSON.stringify(autoServeTool?.inputSchema)).toContain('summary_since');
    expect(autoServeTool?.annotations?.readOnlyHint).toBe(true);
    const autoServeProdTool = tools.tools.find((tool) => tool.name === 'business__auto-prod__work_order__read');
    expect(autoServeProdTool?.description).toContain('固定数据源 auto-prod');
    expect(autoServeProdTool?.annotations?.readOnlyHint).toBe(true);
    const describeTool = tools.tools.find((tool) => tool.name === 'schema_describe');
    expect(JSON.stringify(describeTool?.inputSchema)).toContain('relation_depth');
    expect(JSON.stringify(describeTool?.inputSchema)).toContain('refresh');
    expect(describeTool?.annotations?.readOnlyHint).toBe(true);

    application.service.query = async (request) => ({
      schema_version: 'mysql-agent/result/1',
      status: 'ok',
      kind: 'query',
      business_operation_id: request.businessOperationId ?? null,
      business_pack_id: request.businessPackId ?? null,
      business_pack_version: request.businessPackVersion ?? null,
      business_operation_hash: request.businessOperationHash ?? null,
      rows: [],
      row_count: 0,
    });
    const groupedSummary = await client.callTool({
      name: 'business__auto-dev__work_order__read',
      arguments: { operation: 'summary_since', input: { created_after: '2026-08-01 00:00:00' } },
    });
    expect(groupedSummary.isError).toBe(false);
    expect(groupedSummary.structuredContent).toEqual(expect.objectContaining({
      business_operation_id: 'work_order.summary_since.auto-dev',
      business_pack_id: 'autoserver',
      business_pack_version: '1.0.1',
      business_operation_hash: expect.stringMatching(/^sha256:/),
    }));
    const groupedProdSummary = await client.callTool({
      name: 'business__auto-prod__work_order__read',
      arguments: { operation: 'summary_since', input: { created_after: '2099-01-01 00:00:00' } },
    });
    expect(groupedProdSummary.isError).toBe(false);
    expect(groupedProdSummary.structuredContent).toEqual(expect.objectContaining({
      business_operation_id: 'work_order.summary_since.auto-prod',
      business_pack_id: 'autoserver',
      business_pack_version: '1.0.1',
      business_operation_hash: expect.stringMatching(/^sha256:/),
    }));
    const mismatchedBranch = await client.callTool({
      name: 'business__auto-dev__work_order__read',
      arguments: { operation: 'summary_since', input: { waybill_no: 'KY-20260826-001' } },
    });
    expect(mismatchedBranch.isError).toBe(true);

    const added = await client.callTool({
      name: 'connection_add',
      arguments: {
        alias: 'auto-fat',
        host: '127.0.0.1',
        username: 'agent',
        password: 'test-password',
        database: 'auto_server_fat',
      },
    });
    expect(added.isError).toBe(false);
    expect(JSON.stringify(added.structuredContent)).not.toContain('test-password');
    expect(JSON.stringify(added.content)).toContain('auto-fat');
    expect(JSON.stringify(added.content)).not.toContain('test-password');

    const listed = await client.callTool({ name: 'connection_list', arguments: {} });
    expect(listed.isError).toBe(false);
    expect(JSON.stringify(listed.structuredContent)).toContain('auto-fat');
    expect(JSON.stringify(listed.structuredContent)).not.toContain('test-password');
    expect(JSON.stringify(listed.content)).toContain('auto-fat');
    expect(JSON.stringify(listed.content)).toContain('auto_server_fat');
    expect(JSON.stringify(listed.content)).not.toContain('test-password');

    const searched = await client.callTool({
      name: 'schema_search',
      arguments: { connection: 'auto-fat', keyword: 'order', limit: 5 },
    });
    expect(searched.isError).toBe(false);
    expect(searched.structuredContent).toEqual(expect.objectContaining({
      schema_version: 'mysql-agent/result/1', kind: 'schema_search', connection: 'auto-fat', table_count: 1,
    }));
    expect(JSON.stringify(searched.structuredContent)).not.toContain('test-password');

    const refreshed = await client.callTool({
      name: 'schema_search',
      arguments: { connection: 'auto-fat', keyword: 'order', limit: 5, refresh: true },
    });
    expect(refreshed.isError).toBe(false);
    expect(refreshed.structuredContent).toEqual(expect.objectContaining({
      cache: expect.objectContaining({ source: 'mysql' }),
    }));
    expect(schemaLoads).toBe(2);

    const described = await client.callTool({
      name: 'schema_describe',
      arguments: { connection: 'auto-fat', tables: ['orders'], refresh: true },
    });
    expect(described.isError).toBe(false);
    expect(described.structuredContent).toEqual(expect.objectContaining({
      schema_version: 'mysql-agent/result/1', kind: 'schema_describe', requested_tables: ['auto_server_fat.orders'],
      cache: expect.objectContaining({ source: 'mysql' }),
    }));
    expect(schemaLoads).toBe(3);
    expect(JSON.stringify(described.structuredContent)).not.toContain('CREATE TABLE');

    application.store.recordAudit({
      executionId: 'd3b07384-d9a3-4c71-9f82-614928b97740',
      occurredAt: '2026-08-27T02:00:00.000Z',
      clientName: 'codex',
      connectionAlias: 'auto-fat',
      businessOperationId: 'work_order.summary_since.auto-fat',
      businessPackId: 'autoserver',
      businessPackVersion: '1.0.0',
      businessOperationHash: 'sha256:operation',
      statementKind: 'select',
      sqlHash: 'query-hash',
      durationMs: 18,
      rowCount: 5,
      affectedRows: null,
      attemptCount: 1,
      writeOutcome: 'not_applicable',
      status: 'ok',
      errorCategory: null,
      mysqlErrorCode: null,
    });
    const history = await client.callTool({
      name: 'history_search',
      arguments: { connection: 'auto-fat', status: 'ok', limit: 10 },
    });
    expect(history.isError).toBe(false);
    expect(history.structuredContent).toEqual(expect.objectContaining({
      kind: 'history_search', record_count: 1, result_replayable: false,
      records: [expect.objectContaining({
        execution_id: 'd3b07384-d9a3-4c71-9f82-614928b97740',
        business_pack_id: 'autoserver',
        sql_hash: 'query-hash',
      })],
    }));
    expect(JSON.stringify(history.structuredContent)).not.toContain('SELECT');

    await client.close();
    await application.close();
  });
});
