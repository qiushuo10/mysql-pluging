#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SHUTDOWN_TIMEOUT_MS } from './constants.js';
import { createMysqlMcpApplication, type MysqlMcpApplication } from './mcp/server.js';

let application: MysqlMcpApplication | undefined;
let closing = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  if (application) await Promise.race([application.close(), deadline]);
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  application = createMysqlMcpApplication();
  const transport = new StdioServerTransport();
  application.server.server.onclose = () => {
    void shutdown();
  };
  await application.server.connect(transport);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event: 'mcp_start_failed', message: error instanceof Error ? error.message : 'unknown' })}\n`,
  );
  await shutdown(1);
}
