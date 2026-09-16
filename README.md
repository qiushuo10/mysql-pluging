# MySQL Agent Plugin

一个面向 AI Agent 的本地 MySQL MCP Server。它让 Codex、DeepSeek Harness（DSH）等 MCP 客户端通过命名数据源、安全边界和版本化业务 SQL 操作 MySQL，而不是让模型反复猜表结构、临时拼接 SQL、管理连接与重试。

项目当前以中文文档为主，核心协议与 MCP 客户端无关。

## 为什么做这个项目

传统 MySQL CLI 适合人手动执行命令，却没有解决 Agent 场景中的几个关键问题：

- 每次调用都重新理解连接、表结构和上下文，调用次数多，结果也不稳定。
- 模型临时生成 SQL，容易查错环境、遗漏过滤条件，或返回过量数据。
- 连接池、超时、重试、并发和配置切换被推给 Agent 编排，既浪费上下文，也增加失败点。
- 一段已经验证过的业务查询很难沉淀成“什么场景调用、输入什么、返回什么”的可复用能力。
- 数据库权限、SQL 限制和审计如果只写在提示词里，无法形成真正的执行边界。

这个项目把复杂度收进 MCP Server：Agent 通常只需要选择数据源并调用一次工具；连接复用、安全校验、结果限量和审计由本地运行时处理。对于稳定业务场景，可以把 SQL、参数、目标数据源和使用说明打包成版本化业务操作，让 Agent 复用经过验证的查询，而不是每次重新发明 SQL。

## 项目目标

1. **让正常查询尽量只调用一次。** 连接池、超时、并发控制和有限重试由插件负责。
2. **把安全规则放在执行层。** SQL 类型、数据库白名单、`LIMIT`、`WHERE`、参数绑定和写入影响行数都由服务端校验。
3. **把业务知识变成可复用工具。** 业务包同时声明 SQL、参数 Schema、适用场景、结果边界和目标连接。
4. **同时服务多个 Agent 宿主。** Codex 与 DSH 启动同一套 stdio MCP Server，共享协议与本地状态格式。
5. **保留可追溯性。** 审计只记录执行摘要和哈希，不保存 SQL 参数值或历史结果集。

## 核心能力

- 使用 SQLite 管理多个命名 MySQL 数据源。
- 按需创建并复用 `mysql2` 连接池，启动时不连接 MySQL。
- 分离只读查询与写入工具，写操作发送后不自动重试。
- 使用命名参数绑定，拒绝多语句、危险注释和越界 SQL。
- 通过固定的 `information_schema` 查询提供 Schema 搜索与局部关系描述。
- 使用进程内 L1 与 SQLite L2 Schema 缓存减少重复元数据查询。
- 从 YAML + SQL 加载版本化业务包，并生成按数据源和业务域隔离的工具。
- 支持工作空间 descriptor、逻辑数据源/环境 binding，以及可热加载的 Business Pack v2 SQL + 受限脚本组合。
- 为工作空间调用记录根 Trace、子步骤、使用统计和脱敏的高频 SQL 候选；每个数据源连接池上限为 2。
- 提供不含密码、参数值、完整 SQL 和结果集的本地审计检索。
- 同时返回 MCP `content` 与 `structuredContent`，兼容不同客户端的结果消费方式。

## 工作方式

```text
Codex plugin ─┐
              ├─ stdio MCP Server ─ MySQL runtime ─ MySQL
DSH adapter ──┘          │
                         ├─ SQLite：连接、审计、Schema 快照
                         └─ Business Packs：场景、参数、SQL、边界
```

插件启动时只打开本地 SQLite、执行 migration 并注册工具。第一次调用 SQL、Schema 或业务操作时才建立 MySQL 连接。同一进程内，相同数据源共享连接池；每次工具调用仍保持无会话状态，不能依赖临时表、用户变量或跨调用事务。

## 快速开始

要求 Node.js 24 或更高版本。

```bash
git clone https://github.com/qiushuo10/mysql-pluging.git
cd mysql-pluging
npm ci
npm run validate
```

`npm run validate` 会执行类型检查、单元测试、构建和 stdio MCP 握手，不会连接 MySQL。

本地启动：

```bash
npm run build
MYSQL_AGENT_HOME=/path/to/mysql-agent-state node dist/index.js
```

`stdout` 只承载 MCP 协议，运行日志写入 `stderr`。默认本地状态目录为 `~/.mysql-agent/`。

### Codex

仓库根目录包含 `.codex-plugin/plugin.json` 与 `.mcp.json`。先运行 `npm run build`，再从本地仓库加载插件；MCP 入口会启动 `dist/index.js`。

### DSH

构建后通过 `npm link` 或本地安装包暴露 `mysql-agent-mcp` 命令，再把 [DSH MCP 配置示例](adapters/dsh/agent.cordis.example.yml) 合并到用户自己的 Agent preset。不要修改 DSH 随包提供的 preset。

## 管理数据源

数据源由 Agent 通过 MCP 工具管理，不需要单独的管理界面：

```text
connection_add
connection_update
connection_list
connection_remove
```

新增数据源只写入本地 SQLite，不会主动连接 MySQL。第一次真实查询负责建连并返回连接错误。

建议为 Agent 创建独立的最小权限 MySQL 账号，并通过以下配置形成双重边界：

- MySQL 账号权限决定数据库最终允许执行什么。
- `allowed_databases` 限定单个数据源可访问的数据库。
- `access_mode` 将数据源设为 `read_only` 或 `read_write`。
- `enabled` 可以临时停用某个数据源。

> [!WARNING]
> 当前版本按产品约定把数据库密码明文保存在本地 SQLite。目录权限设为 `0700`，数据库文件尽量设为 `0600`，但这不等于加密。请只使用专用、最小权限账号，不要提交 `state.db`，也不要在日志、Issue 或截图中暴露连接参数。

## 如何选择工具

推荐顺序如下：

1. 已有固定业务场景时，优先调用 `business__<connection>__<domain>__read|write`。
2. 不确定业务操作时，用 `list_business_operations` 查询指定数据源的目录。
3. 不知道表名时，用 `schema_search` 搜索。
4. 选定少量表后，用 `schema_describe` 查看字段、索引与局部关系。
5. 没有匹配业务操作时，再使用 `sql_query` 做临时只读查询。
6. 只有用户明确要求修改数据时才使用 `sql_execute`。

完整工具集：

```text
connection_add
connection_update
connection_list
connection_remove
history_search
schema_search
schema_describe
sql_query
sql_execute
list_business_operations
business__<connection>__<domain>__read|write
business__<connection>__<domain>__<name>
```

## 通用 SQL

SQL 与参数分开传递。标量使用 `:name`，非空列表使用 `:...names`：

```sql
SELECT id, order_no, status
FROM orders
WHERE order_no = :order_no
LIMIT 20
```

```json
{
  "connection": "app-test",
  "sql": "SELECT id, order_no, status FROM orders WHERE order_no = :order_no LIMIT 20",
  "parameters": {
    "order_no": "ORDER-001"
  },
  "max_rows": 20
}
```

通用查询的 `max_rows` 默认值和最大值均为 1000，用于限制最终返回行数。通用 `SELECT` 必须包含 1..200 的字面量 `LIMIT`，不再要求 `LIMIT <= max_rows`；例如 `max_rows: 5` 与 `LIMIT 20` 可同时使用，最多返回 5 行并标记截断。通用 `UPDATE` 和 `DELETE` 必须包含字段条件 `WHERE`，并受影响行数上限约束。项目不支持通用 DDL、多语句或跨调用事务。

MySQL `BIGINT`、雪花 ID 等可能超过 JavaScript 安全整数范围的值，必须在 `parameters` 中按 JSON 字符串传入：

```json
{
  "parameters": {
    "id": "2093644105678462977"
  }
}
```

不要把这类 ID 作为 JSON number 传入。数字一旦被 JavaScript 舍入，插件无法恢复原始尾数，因此会在 SQL 发送前返回 `UNSAFE_INTEGER_PARAMETER`，要求调用方从原始字符串重新取值。

## 业务包

业务包用于把稳定业务查询发布成 Agent 能理解的固定能力。每个业务包位于 `business-packs/<pack>/`，包含一个 `pack.yml` 和若干 `.sql` 文件。

```yaml
schema_version: mysql-agent/business-pack/1
pack_id: order-center
version: 1.0.0
operations:
  - id: order.find_by_no
    domain: order
    name: find_by_no
    title: 按订单号查询订单
    description: 返回订单状态和履约状态。
    use_when: 用户提供完整订单号并询问订单状态时使用。
    connections: [app-test]
    mode: read
    exposure: domain
    input:
      order_no:
        type: string
        min_length: 1
        max_length: 64
        trim: true
    sql_file: sql/find_by_no.sql
    max_rows: 20
    retry_safe: true
```

Server 启动时一次性加载全部业务包。修改业务包后需要重启 MCP 连接。任一 YAML、SQL、路径、参数或工具名校验失败都会阻止 Server 启动，避免只加载一半配置。

仓库内的 `business-packs/autoserver` 展示了一个真实规模的只读业务包：相同业务操作绑定到独立的数据源工具，结果按区段分别限量，并排除凭据与大体积原始报文字段。它不包含数据库地址、账号、密码或业务数据；不需要该示例时可以删除，或通过 `MYSQL_AGENT_BUSINESS_PACKS=/absolute/path` 加载自己的业务包目录。

## 安全边界

本项目采用失败关闭策略：无法可靠解析或验证的 SQL 不会执行。主要约束包括：

- 参数使用 prepared statement 绑定，不做字符串插值。
- 通用查询只允许单条、受限的只读语句。
- 写入与只读调用分离；写入发送后不自动重试。
- 禁止 MySQL/MariaDB executable comments 和裸 `CR`，避免解析器与数据库执行语义不一致。
- Schema 查询使用服务端固定 SQL，不向 Agent 开放任意元数据查询。
- 返回行数、文本大小、并发数、排队时间和查询时间都有上限。
- 密码不会出现在连接列表、工具结果或审计摘要中。

这些限制不能替代数据库权限。生产环境应使用只读账号或经过严格授权的写入账号，并在部署前审查自定义业务包。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npm run test:stdio
```

一次执行全部检查：

```bash
npm run validate
```

AutoServer 实库验收是可选项，不包含在 `validate` 中，也不保存凭据：

```bash
MYSQL_AGENT_HOME=/path/to/mysql-agent-state \
AUTOSERVE_WAYBILL_NO=your-fixture-waybill \
npm run test:live:autoserve
```

## 项目结构

```text
.
├── src/                    # MCP、MySQL runtime、SQL 校验、SQLite 与业务包加载
├── tests/                  # 单元测试与 MCP 集成测试
├── business-packs/         # 版本化业务 SQL 包
├── skills/mysql-agent/     # Agent 工具选择与安全工作流
├── adapters/dsh/           # DSH 接入示例
├── docs/                   # 协议、技术方案与架构评审
├── scripts/                # 构建、stdio 冒烟和可选实库验收
├── .codex-plugin/          # Codex 插件清单
└── .mcp.json               # stdio MCP 配置
```

深入阅读：

- [协议与运行时设计](docs/protocol-and-runtime.md)
- [技术方案](docs/technical-design.md)
- [速度与稳定性架构评审](docs/speed-stability-review.md)
- [业务脚本运行时与可观测闭环设计](docs/business-script-runtime-design.md)
- [DSH 适配说明](adapters/dsh/README.md)

## 当前限制

- 需要 Node.js 24+，并使用 Node 内置 SQLite。
- 本地数据库密码目前为明文存储。
- 每个 MCP 进程拥有独立的 MySQL 连接池；不同宿主只共享 SQLite 状态。
- 不支持 DDL、多语句、跨调用事务、临时表或会话变量。
- 业务包在启动时加载，不监听运行时文件变化。

## 贡献

欢迎提交 Issue 和 Pull Request。修改执行边界、SQL 校验、写入语义或缓存逻辑时，请同时添加回归测试，并确保 `npm run validate` 通过。

## License

[MIT](LICENSE)
