import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadWorkspaceContext, parseRuntimeOptions, WorkspaceManager } from '../src/workspace/context.js';

const roots: string[] = [];

function workspaceFile(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mysql-agent-workspace-'));
  roots.push(root);
  mkdirSync(join(root, '.mysql-agent', 'packs'), { recursive: true });
  const path = join(root, '.mysql-agent', 'workspace.yml');
  writeFileSync(path, source);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace descriptor', () => {
  it('strictly parses v1 and resolves pack paths relative to descriptor', () => {
    const path = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: auto-server
label: AutoServer
runtime_mode: workspace
default_datasource: autoserver
default_environment: test
environments:
  test:
    datasource_bindings: { autoserver: auto-dev }
business_pack_paths: [./packs]
audit_retention_days: 45
`);
    const context = loadWorkspaceContext(path);
    expect(context.workspaceId).toBe('auto-server');
    expect(context.businessPackPaths).toEqual([join(context.descriptorDirectory, 'packs')]);
    expect(context.environments.get('test')).toEqual(expect.objectContaining({ accessMode: 'read_write' }));
    expect(context.rootHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed for unknown fields and missing default binding', () => {
    const unknown = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: one
label: One
runtime_mode: workspace
default_datasource: app
default_environment: test
environments: { test: { datasource_bindings: { app: app-test } } }
password: forbidden
`);
    expect(() => loadWorkspaceContext(unknown)).toThrow(/不符合/);

    const missing = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: two
label: Two
runtime_mode: workspace
default_datasource: app
default_environment: test
environments: { test: { datasource_bindings: {} } }
`);
    expect(() => loadWorkspaceContext(missing)).toThrow(/缺少 binding/);

    const absolutePack = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: three
label: Three
runtime_mode: workspace
default_datasource: app
default_environment: test
environments: { test: { datasource_bindings: { app: app-test } } }
business_pack_paths: [/tmp/packs]
`);
    expect(() => loadWorkspaceContext(absolutePack)).toThrow(/必须是相对 descriptor/);

    const writableProd = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: four
label: Four
runtime_mode: workspace
default_datasource: app
default_environment: test
environments:
  test: { datasource_bindings: { app: app-test } }
  prod:
    datasource_bindings: { app: app-prod }
    access_mode: read_write
business_pack_paths: []
`);
    expect(() => loadWorkspaceContext(writableProd)).toThrow(/不符合 mysql-agent\/workspace\/1/);
  });

  it('merges concurrent updates from two managers without losing a binding', async () => {
    const path = workspaceFile(`
schema_version: mysql-agent/workspace/1
workspace_id: concurrent
label: Concurrent
runtime_mode: workspace
default_datasource: app
default_environment: test
environments:
  test: { datasource_bindings: { app: app-test } }
  staging: { datasource_bindings: {} }
business_pack_paths: []
`);
    const first = new WorkspaceManager(path);
    const second = new WorkspaceManager(path);
    await Promise.all([
      first.setBinding('reporting', 'staging', 'reporting-stage'),
      second.setBinding('warehouse', 'staging', 'warehouse-stage'),
    ]);
    const current = loadWorkspaceContext(path);
    expect(current.environments.get('staging')?.datasourceBindings).toEqual({
      reporting: 'reporting-stage', warehouse: 'warehouse-stage',
    });
  });
});

describe('runtime CLI', () => {
  it('parses flags with precedence over environment', () => {
    expect(parseRuntimeOptions(['--mode', 'workspace', '--workspace', './project.yml'], {
      MYSQL_AGENT_MODE: 'admin', MYSQL_AGENT_WORKSPACE: '/ignored.yml',
    })).toEqual({ mode: 'workspace', workspacePath: expect.stringMatching(/project\.yml$/) });
    expect(parseRuntimeOptions([], {})).toEqual({ mode: 'global', workspacePath: undefined });
  });

  it('does not guess cwd when workspace descriptor is absent', () => {
    expect(() => parseRuntimeOptions(['--mode', 'workspace'], {})).toThrow(/必须显式提供/);
    expect(() => parseRuntimeOptions(['--bogus'], {})).toThrow(/未知参数/);
  });
});
