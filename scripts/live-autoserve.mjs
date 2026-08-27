import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const stateHome = process.env.MYSQL_AGENT_HOME;
const waybillNo = process.env.AUTOSERVE_WAYBILL_NO;
if (!stateHome || !waybillNo) {
  throw new Error('MYSQL_AGENT_HOME and AUTOSERVE_WAYBILL_NO are required');
}

const client = new Client({ name: 'dsh-autoserve-live-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { ...process.env, MYSQL_AGENT_HOME: stateHome },
  stderr: 'pipe',
});
const expectedSections = new Set([
  'work_order', 'operation', 'flow_instance', 'flow_task', 'flow_his_task', 'ky_receive', 'ky_push',
]);
const forbidden = /token_text|raw_payload|last_raw_payload|request_payload|response_body/i;

try {
  await client.connect(transport);
  const catalog = await client.callTool({
    name: 'list_business_operations', arguments: { connection: 'auto-dev', domain: 'work_order', limit: 100 },
  });
  if (catalog.isError || !JSON.stringify(catalog.structuredContent).includes('work_order.trace_by_waybill_no')) {
    throw new Error('AutoServer waybill trace operation is missing from the auto-dev catalog');
  }
  const result = await client.callTool({
    name: 'business__auto-dev__work_order__read',
    arguments: { operation: 'trace_by_waybill_no', input: { waybill_no: waybillNo } },
  });
  if (result.isError) throw new Error(`waybill trace failed: ${JSON.stringify(result.content)}`);
  const data = result.structuredContent ?? {};
  if (data.business_pack_id !== 'autoserver' || data.business_pack_version !== '1.0.1'
    || typeof data.business_operation_hash !== 'string' || !data.business_operation_hash.startsWith('sha256:')) {
    throw new Error(`business pack identity is missing: ${JSON.stringify(data)}`);
  }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0 || rows.length > 200 || data.row_count !== rows.length) {
    throw new Error(`unexpected bounded row contract: rows=${rows.length}, row_count=${String(data.row_count)}`);
  }
  const sections = new Set(rows.map((row) => row.section));
  for (const section of expectedSections) {
    if (!sections.has(section)) throw new Error(`fixture is missing expected section ${section}`);
  }
  for (const row of rows) {
    if (!expectedSections.has(row.section) || typeof row.record_id !== 'string' || !('occurred_at' in row) || !('data' in row)) {
      throw new Error(`invalid trace row contract: ${JSON.stringify(row)}`);
    }
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const previousTime = previous.occurred_at ?? '';
    const currentTime = current.occurred_at ?? '';
    if (previousTime < currentTime) throw new Error(`trace ordering regressed at row ${index}`);
    if (previousTime === currentTime && previous.section > current.section) throw new Error(`section ordering regressed at row ${index}`);
    if (previousTime === currentTime && previous.section === current.section && BigInt(previous.record_id) < BigInt(current.record_id)) {
      throw new Error(`numeric record ordering regressed at row ${index}`);
    }
  }
  if (forbidden.test(JSON.stringify(data))) throw new Error('trace result contains a forbidden raw or credential-like field');
  const history = await client.callTool({
    name: 'history_search', arguments: { execution_id: data.execution_id, limit: 1 },
  });
  const records = history.structuredContent?.records;
  if (history.isError || !Array.isArray(records) || records.length !== 1
    || records[0].business_operation_hash !== data.business_operation_hash
    || records[0].client_name !== 'dsh') {
    throw new Error(`business execution was not found in audit history: ${JSON.stringify(history.content)}`);
  }
  process.stdout.write(`AutoServer live acceptance passed: ${rows.length} rows, ${sections.size} sections\n`);
} finally {
  await client.close().catch(() => undefined);
}
