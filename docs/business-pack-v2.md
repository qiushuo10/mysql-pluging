# Business Pack v2 protocol

Business Pack v2 is available only when the MCP server starts in `workspace` mode. A v2 operation names logical datasources and environments; the workspace descriptor resolves those names to physical connection aliases. Tool inputs never contain `connection`, `datasource`, or `environment`.

## SQL operation

```yaml
schema_version: mysql-agent/business-pack/2
pack_id: order-center
version: 2.0.0
operations:
  - id: order.find
    kind: sql
    domain: order
    name: find
    title: Find order
    description: Return one order.
    use_when: Use when a complete order ID is available.
    datasource: autoserver
    environments: [test, prod]
    mode: read
    input:
      id: { type: string, min_length: 1, max_length: 64, trim: true }
    sql_file: sql/find.sql
    max_rows: 1
```

The same public operation ID is registered once per resolved environment. Missing bindings disable only that environment. `workspace_validate` reports every disabled target; the loader never substitutes the default datasource.

## Script operation

```yaml
  - id: order.diagnose
    kind: script
    domain: order
    name: diagnose
    title: Diagnose order
    description: Combine the order and proof records.
    use_when: Use for a one-call order diagnosis.
    datasources: [autoserver, proofline]
    environments: [test]
    mode: read
    exposure: direct
    input:
      id: { type: string, min_length: 1, max_length: 64, trim: true }
    script_file: scripts/diagnose.ts
    uses: [order.find, proof.find]
    timeout_ms: 8000
    max_result_bytes: 262144
```

Scripts are function bodies with top-level `await` and `return`. They receive only:

```ts
const input = await workflow.input();
const result = await operations.call('order.find', input);
return { result };
```

`uses` is an enforced allowlist. Every dependency must be a published v2 read-only SQL operation, resolve uniquely in the script environment, and use a datasource declared by the script. Scripts cannot call arbitrary SQL, another script, MCP, Node.js, modules, files, environment variables, timers, or the network.

Implementation files are resolved by real path and must remain inside the pack directory. A script is limited to 64 KiB source, 10 seconds, 32 MiB QuickJS memory, 256 KiB result, 16 total bridge calls, and two concurrent bridge calls. The runtime does not retry or relax a failed limit.

See [`examples/business-pack-v2`](../examples/business-pack-v2) for a complete pack.
