import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const stateHome = process.env.MYSQL_AGENT_HOME;
if (!stateHome) throw new Error('MYSQL_AGENT_HOME is required');

const entry = process.env.MYSQL_AGENT_ENTRY ?? new URL('../dist/index.js', import.meta.url).pathname;
const workspace = process.env.AUTOSERVER_WORKSPACE
  ?? '/Users/qiushuo/Downloads/project/third-project/auto_server/.mysql-agent/workspace.yml';
const client = new Client({ name: 'codex-autoserve-workspace-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, '--mode', 'workspace', '--workspace', workspace],
  env: { ...process.env, MYSQL_AGENT_HOME: stateHome },
  stderr: 'pipe',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const names = tools.map((tool) => tool.name);
  for (const required of [
    'sql_query', 'schema_search', 'workspace_validate', 'workspace_business_reload',
    'business__work_order__diagnose_by_waybill_no', 'trace_search', 'usage_summary',
    'business_candidate_analyze',
  ]) assert(names.includes(required), `required workspace tool is missing: ${required}`);
  for (const forbidden of ['connection_add', 'connection_update', 'connection_remove', 'connection_list']) {
    assert(!names.includes(forbidden), `admin tool leaked into workspace mode: ${forbidden}`);
  }
  const businessTool = tools.find((tool) => tool.name === 'business__work_order__diagnose_by_waybill_no');
  assert(!/connection|datasource|environment/.test(JSON.stringify(businessTool?.inputSchema)), 'business input leaks infrastructure selection');
  assert(!names.some((name) => name.includes('auto-dev') || name.includes('auto-prod')), 'physical alias leaked into tool names');

  const validation = await client.callTool({ name: 'workspace_validate', arguments: {} });
  assert(!validation.isError && validation.structuredContent?.valid === true, `workspace_validate failed: ${JSON.stringify(validation.content)}`);
  assert(validation.structuredContent?.workspace_id === 'auto-server', 'unexpected workspace identity');

  const sources = await client.callTool({ name: 'workspace_datasource_list', arguments: {} });
  assert(!sources.isError, `workspace_datasource_list failed: ${JSON.stringify(sources.content)}`);
  const bindings = sources.structuredContent?.datasources ?? [];
  assert(bindings.some((item) => item.datasource_id === 'autoserver' && item.environment === 'test'), 'autoserver/test binding missing');
  assert(bindings.some((item) => item.datasource_id === 'proofline' && item.environment === 'test'), 'proofline/test binding missing');

  const fixtureArguments = {
    sql: "SELECT order_no, external_order_no FROM work_order WHERE external_order_no IS NOT NULL AND external_order_no <> '' ORDER BY id DESC LIMIT 1",
    parameters: {},
    max_rows: 1,
  };
  const fixture = await client.callTool({ name: 'sql_query', arguments: fixtureArguments });
  assert(!fixture.isError, `test fixture lookup failed: ${JSON.stringify(fixture.content)}`);
  const fixtureRows = fixture.structuredContent?.rows ?? [];
  assert(fixtureRows.length === 1, 'BUSINESS_PRECONDITION_FAILED: auto-dev has no work order with an external order number');
  const waybillNo = fixtureRows[0].external_order_no ?? fixtureRows[0].order_no;
  assert(typeof waybillNo === 'string' && waybillNo.length > 0, 'BUSINESS_PRECONDITION_FAILED: fixture number is empty');
  const repeatedFixture = await client.callTool({ name: 'sql_query', arguments: fixtureArguments });
  assert(!repeatedFixture.isError, `repeated discovery query failed: ${JSON.stringify(repeatedFixture.content)}`);

  const diagnosis = await client.callTool({
    name: 'business__work_order__diagnose_by_waybill_no',
    arguments: { waybill_no: waybillNo },
  });
  assert(!diagnosis.isError, `business diagnosis failed: ${JSON.stringify(diagnosis.content)}`);
  const data = diagnosis.structuredContent ?? {};
  const output = data.output ?? {};
  assert(data.kind === 'business_script' && output.status === 'ok', 'business script did not return an ok diagnosis');
  assert(data.business_pack_id === 'autoserver-workspace' && data.business_pack_version === '2.0.0', 'unexpected business pack identity');
  assert(typeof data.business_operation_hash === 'string' && data.business_operation_hash.startsWith('sha256:'), 'operation hash missing');
  assert(typeof data.script_hash === 'string' && data.script_hash.startsWith('sha256:'), 'script hash missing');
  assert(typeof data.trace_id === 'string' && typeof data.run_id === 'string', 'trace identity missing');
  assert(output.order?.external_order_no === waybillNo || output.order?.order_no === waybillNo, 'diagnosis returned a different work order');
  assert(output.step_counts?.order === 1, 'diagnosis did not execute the order step');
  assert(Array.isArray(output.recent_operations) && Array.isArray(output.external_events), 'diagnosis output contract is invalid');

  const traces = await client.callTool({ name: 'trace_search', arguments: { run_id: data.run_id, limit: 10 } });
  assert(!traces.isError && traces.structuredContent?.record_count === 1, 'business trace was not found');
  const trace = traces.structuredContent.records[0];
  assert(trace.operation_kind === 'script' && trace.status === 'ok', 'business root trace is not successful');
  assert(Array.isArray(trace.spans) && trace.spans.length === 4, `expected root plus 3 child spans, got ${trace.spans?.length ?? 0}`);
  assert(trace.spans.filter((span) => span.parent_span_id !== null).every((span) => span.status === 'ok'), 'one or more child spans failed');

  const usage = await client.callTool({
    name: 'usage_summary', arguments: { operation_id: 'work_order.diagnose_by_waybill_no', group_by: 'operation' },
  });
  assert(!usage.isError && usage.structuredContent?.groups?.some((group) => group.count >= 1 && group.error_count === 0), 'usage summary did not include the successful business call');

  const candidates = await client.callTool({ name: 'business_candidate_analyze', arguments: { min_count: 2, limit: 10 } });
  assert(!candidates.isError && Array.isArray(candidates.structuredContent?.candidates), 'discovery candidate analysis failed');
  assert(!JSON.stringify(candidates.structuredContent).includes(waybillNo), 'discovery persisted a parameter value');

  const reload = await client.callTool({ name: 'workspace_business_reload', arguments: {} });
  assert(!reload.isError, `no-op business reload failed: ${JSON.stringify(reload.content)}`);
  assert(reload.structuredContent?.added_tools === 0 && reload.structuredContent?.updated_tools === 0
    && reload.structuredContent?.removed_tools === 0, 'unchanged business pack was not a no-op reload');

  process.stdout.write(`AutoServer workspace live acceptance passed: tools=${names.length}, spans=${trace.spans.length}, operations=${output.recent_operations.length}, external_events=${output.external_events.length}\n`);
} finally {
  await client.close().catch(() => undefined);
}
