import { randomUUID } from 'node:crypto';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

type ToolHandler = (
  args: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => CallToolResult | Promise<CallToolResult>;

/** Process-local admission gate and in-flight counter for every MCP tool call. */
export class ToolShutdownGate {
  private accepting = true;
  private active = 0;
  private readonly abortController = new AbortController();
  private readonly idleWaiters = new Set<() => void>();

  install(server: McpServer): void {
    const original = server.registerTool.bind(server) as unknown as (
      name: string, config: unknown, callback: ToolHandler,
    ) => RegisteredTool;
    server.registerTool = ((name: string, config: unknown, callback: ToolHandler) =>
      original(name, config, this.wrap(callback))) as typeof server.registerTool;
  }

  stopAccepting(): void { this.accepting = false; }

  abortInFlight(): void {
    this.accepting = false;
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  snapshot(): { accepting: boolean; active: number; aborted: boolean } {
    return { accepting: this.accepting, active: this.active, aborted: this.abortController.signal.aborted };
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.idleWaiters.add(onIdle);
    });
  }

  private wrap(handler: ToolHandler): ToolHandler {
    return async (args, extra) => {
      if (!this.accepting) {
        const structuredContent = {
          schema_version: 'mysql-agent/result/1', execution_id: randomUUID(), status: 'error',
          category: 'internal_error', code: 'SERVER_SHUTTING_DOWN',
          message: 'MySQL Agent 正在关闭，已拒绝新的工具调用。', retryable: true, retry_after_ms: 1_000,
        };
        return {
          isError: true, structuredContent,
          content: [{ type: 'text', text: `SERVER_SHUTTING_DOWN: ${structuredContent.message}` }],
        };
      }
      this.active += 1;
      const signal = AbortSignal.any([extra.signal, this.abortController.signal]);
      try {
        return await handler(args, { ...extra, signal });
      } finally {
        this.active -= 1;
        if (this.active === 0) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
      }
    };
  }
}
