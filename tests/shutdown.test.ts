import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('stdio shutdown', () => {
  it('exits a real MCP child process within a bounded time after SIGTERM', async () => {
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const stateHome = mkdtempSync(join(tmpdir(), 'mysql-agent-shutdown-child-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: project,
      env: { ...process.env, MYSQL_AGENT_HOME: stateHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    let initialized!: () => void;
    const initializedResponse = new Promise<void>((resolveInitialized) => { initialized = resolveInitialized; });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.split('\n').some((line) => {
        try { return (JSON.parse(line) as { id?: unknown }).id === 1; } catch { return false; }
      })) initialized();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' } },
      })}\n`);
      await Promise.race([
        initializedResponse,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`child did not initialize: ${stderr}`)), 2_000)),
      ]);
      expect(child.exitCode, stderr).toBeNull();
      const startedAt = performance.now();
      child.kill('SIGTERM');
      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`child did not exit: ${stderr}`)), 2_000)),
      ]);
      expect(result).toEqual({ code: 0, signal: null });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdin.destroy();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});
