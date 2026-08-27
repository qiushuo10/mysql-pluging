import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const stateHome = await mkdtemp(join(tmpdir(), 'mysql-agent-stdio-'));
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { MYSQL_AGENT_HOME: stateHome },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const required = [
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
  ];
  for (const name of required) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  for (const removed of ['business__work_order__summary_since', 'business__work_order__trace_by_waybill_no']) {
    if (tools.some((tool) => tool.name === removed)) throw new Error(`Legacy direct business tool is still exposed: ${removed}`);
  }
  const result = await client.callTool({ name: 'connection_list', arguments: {} });
  if (result.isError) throw new Error('connection_list failed during stdio smoke test');
  process.stdout.write(`stdio MCP smoke passed with ${tools.length} tools\n`);
} finally {
  await client.close().catch(() => undefined);
  await rm(stateHome, { recursive: true, force: true });
}
