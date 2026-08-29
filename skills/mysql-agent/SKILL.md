---
name: mysql-agent
description: Use managed MySQL test data sources through the plugin for database inspection, parameterized reads or writes, and source-defined business operations.
---

# MySQL Agent

Use this plugin only for databases the user has placed in scope. Connections are named data sources managed by the plugin.

## Choose an entry

1. Prefer a matching `business__<connection>__<domain>__read|write` tool. Select its typed `operation` branch; the SQL, target data source, parameters, and limits are fixed in plugin code.
2. Use `list_business_operations` with the target connection when the right fixed business operation is unclear.
3. If the table is unknown, use `schema_search` on that connection.
4. After selecting one or more tables, use `schema_describe` for only those tables and the relevant relationship depth.
5. Then use `sql_query` for temporary investigation that has no matching business operation.
6. Use `sql_execute` only when the user has explicitly requested a data change.

Set `refresh: true` on `schema_search` or `schema_describe` when the user requires the current database structure or when recent DDL may have made the cached Schema snapshot stale. A refreshed result must report `cache.source: "mysql"`.

## SQL calls

- Pass SQL structure in `sql` and values in `parameters`. Use `:name` for a scalar and `:...names` for a non-empty list. Never interpolate values into SQL text.
- Pass MySQL `BIGINT`, snowflake IDs, and other potentially unsafe integers as JSON strings. Preserve string IDs returned by earlier tools; never convert them to numbers.
- Every generic `SELECT`, including `COUNT`, must include a numeric literal `LIMIT` no larger than `max_rows`. Use `LIMIT 1` for a single aggregate row. `SHOW` and `DESCRIBE` do not require a limit.
- Generic `UPDATE` and `DELETE` require a field-based `WHERE`; the plugin rolls back changes above the affected-row limit.
- Do not emulate transactions across tool calls. Each call is independent.

## Writes and failures

Before a write, state the data source, operation, target table, condition, and expected impact when the host asks for confirmation. Never manufacture an approval field.

Treat `write_outcome_unknown` as unresolved. Query the affected record to determine its state before considering another write. Retry `busy` only after the suggested delay; do not loop indefinitely.

Passwords may be accepted by `connection_add` or `connection_update`, but never repeat them in prose, logs, or summaries.
