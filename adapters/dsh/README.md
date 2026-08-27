# DSH adapter

Build the package, then make the `mysql-agent-mcp` binary available to the DSH process with `npm link` or an installed package. Copy DSH's `standard` Agent preset to a user preset, then add the MCP client block from `agent.cordis.example.yml` to that preset's `agent.cordis.yml`. Do not edit DSH's shipped presets.

DSH exposes the tools as `mcp__mysql__<tool-name>`. The MCP process uses the same `MYSQL_AGENT_HOME` and SQLite state format as the Codex plugin.

Set `MYSQL_AGENT_BUSINESS_PACKS` in the MCP client's `env` when the DSH preset should use an editable local business-pack directory. The server reads that directory once when the MCP child starts; restart the DSH MCP connection after editing a pack.

The server places bounded result JSON in both MCP `content` and `structuredContent`. This is required for DSH Native sessions, where the model-facing tool result is rendered from `content`.
