import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const stateHome = process.env.MYSQL_AGENT_HOME;
if (!stateHome) throw new Error('MYSQL_AGENT_HOME is required');

const entry = process.env.MYSQL_AGENT_ENTRY ?? new URL('../dist/index.js', import.meta.url).pathname;
const targets = [
  { alias: 'auto-dev', datasource_id: 'autoserver', environment: 'test', access_mode: 'read_write' },
  { alias: 'auto-prod', datasource_id: 'autoserver', environment: 'prod', access_mode: 'read_only' },
  { alias: 'auto-proofline', datasource_id: 'proofline', environment: 'test', access_mode: 'read_only' },
];

const client = new Client({ name: 'codex-autoserve-workspace-configure', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, '--mode', 'admin'],
  env: { ...process.env, MYSQL_AGENT_HOME: stateHome },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const before = await client.callTool({ name: 'connection_list', arguments: { include_disabled: true } });
  if (before.isError) throw new Error(`connection_list failed: ${JSON.stringify(before.content)}`);
  const known = new Map((before.structuredContent?.connections ?? []).map((item) => [item.alias, item]));
  for (const target of targets) {
    if (!known.has(target.alias)) throw new Error(`required datasource ${target.alias} is missing`);
    const response = await client.callTool({
      name: 'connection_update',
      arguments: {
        ...target,
        owner_scope: 'global',
        shareable: true,
        pool_max: 2,
      },
    });
    if (response.isError) throw new Error(`connection_update ${target.alias} failed: ${JSON.stringify(response.content)}`);
  }
  const after = await client.callTool({ name: 'connection_list', arguments: { include_disabled: true } });
  if (after.isError) throw new Error(`connection_list verification failed: ${JSON.stringify(after.content)}`);
  const verified = new Map((after.structuredContent?.connections ?? []).map((item) => [item.alias, item]));
  for (const target of targets) {
    const item = verified.get(target.alias);
    if (!item || item.datasourceId !== target.datasource_id || item.environment !== target.environment
      || item.ownerScope !== 'global' || item.shareable !== true || item.poolMax !== 2
      || item.accessMode !== target.access_mode) {
      throw new Error(`datasource metadata verification failed for ${target.alias}`);
    }
  }
  process.stdout.write(`AutoServer datasource metadata configured: ${targets.length} bindings, pool_max=2\n`);
} finally {
  await client.close().catch(() => undefined);
}
