# MySQL Agent Plugin 技术方案

状态：第一版已实现并通过本地验证
更新日期：2026-08-26

## 1. 结论

项目采用“一个 TypeScript 核心、一个 MCP Server、两个宿主适配层”的结构：

```text
Codex plugin ─┐
              ├─ stdio MCP Server ─ MySQL runtime ─ MySQL
DSH adapter ──┘          │
                         ├─ SQLite 本地状态与 Schema L2 快照
                         └─ 启动时本地业务包 registry
```

Codex 和 DSH 不各自实现 MySQL 逻辑。两端加载同一个 MCP Server，共享工具协议、内置业务 SQL、错误模型和本地 SQLite 数据。宿主适配层只负责安装、启动、Skill 暴露和工具范围配置。

第一版优先使用 stdio MCP，不先引入本地 HTTP 服务。每个宿主会启动自己的常驻 MCP 进程；同一进程内的多个 Agent 调用共享连接池。两个宿主进程共享 SQLite 文件，但不共享内存连接池。

连接池等待、读重试、AST 校验、通用写入上限和跨任务进程数量已经按[速度与稳定性架构评审](speed-stability-review.md)收口并落入实现。

## 2. 已确认的产品决策

1. 同时支持 Codex 和 DSH。
2. 支持多个命名 MySQL 连接，例如 `auto-dev`、`auto-fat`、`voicehub-test`。
3. 执行数据库操作时，Agent 通过连接别名或内置业务能力选择目标库；只有连接管理工具接收 host、user、password。
4. 密码不使用 macOS Keychain，直接以明文存入本地 SQLite。
5. SQLite 只保存本机状态，不随插件包、Git 或查询结果分发。
6. 插件既提供通用 MySQL 原子能力，也提供从本地版本化业务包启动时加载的固定 SQL 能力。
7. 每个业务能力在 TypeScript 代码中固定 SQL、参数 schema、目标连接和使用场景。模型只传业务参数，不重新拼接 SQL。
8. Skill 不保存 SQL。Skill 只编排一个或多个内置业务能力，并规定判断步骤与输出方式。
9. 速度和稳定性必须通过基准与故障测试证明，不能用“进程启动成功”代替真实查询验证。
10. 不提供独立的测试连接入口。Agent 直接执行真实查询，插件维护连接，失败时返回连接错误。
11. 连接新增、修改、查看和删除都通过插件工具完成，不提供独立的管理端。
12. 第一版的通用 SQL 覆盖查询、新增、修改和删除；内置业务 SQL 也可以声明为这四类操作。Agent 侧的通用 SQL 入口统一为只读和写入两个工具。
13. 第一版不提供通用 DDL、多语句、跨调用事务或无 `WHERE` 写入绕过能力。
14. Schema 发现是只读的固定元数据能力，不开放任意 `information_schema` SQL，也不把系统库加入业务白名单。

## 3. 技术栈

### 3.1 推荐实现

- Node.js 24+；Node.js 24 LTS 是发布基线，当前本机 Node.js 26 用作兼容验证。
- TypeScript。
- `@modelcontextprotocol/sdk`：实现 MCP Server。
- `mysql2/promise`：MySQL 协议、参数绑定和连接池。
- `cockatiel`：为数据库调用提供有界重试、指数退避、熔断和超时策略。
- `@rocicorp/lock`：用异步读写锁协调连接配置切换和在途调用。
- `node-sql-parser`：解析 MySQL AST、识别根语句、表范围、`WHERE` 和查询行数限制。
- `node:sqlite`：保存连接、明文密码、迁移版本和审计摘要。
- `zod`：配置、业务操作、工具输入和返回结构校验。
- Vitest：单元测试与集成测试。

### 3.2 框架职责边界

| 问题 | 采用的框架 | 插件代码只负责 |
| --- | --- | --- |
| MCP 生命周期和工具协议 | `@modelcontextprotocol/sdk` | 注册工具和映射业务结果 |
| MySQL 物理连接池 | `mysql2/promise` | 把连接配置转换为 pool options |
| 重试、退避、熔断、超时和 bulkhead | `cockatiel` | 分类可重试错误并设置策略参数 |
| 配置切换与在途调用协调 | `@rocicorp/lock` | 按连接别名选择对应的 `RWLock` |
| 参数和返回 schema | `zod` | 定义产品协议 |
| SQL 结构检查 | `node-sql-parser` | 定义允许的语句和表范围 |
| 本地配置存储 | `node:sqlite` | migration 和 repository 查询 |

插件不实现连接池、等待队列、重试循环、退避计时器、熔断状态机、超时调度器或异步读写锁。仍需保留的自有代码只有产品语义：连接别名、配置 `revision`、业务 SQL registry、读写权限、MySQL 错误分类、写请求 `NOT_SENT/SENT` 边界、返回值归一化和脱敏。

不额外引入 ORM。通用 SQL 和本地业务包 SQL 都需要保留原始 SQL、prepared parameters 和 AST 校验；ORM 会增加一层抽象，却不能替代这些能力。

### 3.3 选择 TypeScript 的理由

1. DSH 本身运行在 Node.js/Cordis 上，官方 MCP Client 直接支持 stdio 子进程。
2. Codex 通过 MCP 协议接入，与 Server 的实现语言无关。
3. `mysql2/promise` 提供成熟的连接池和参数化执行能力；`cockatiel` 统一处理重试、退避、熔断和超时。
4. `node:sqlite` 不需要额外的本地原生模块安装，降低插件安装和升级失败率。
5. 一个 npm 工程可以同时产出 MCP Server、Codex 插件适配和 DSH bundle。

旧 Python CLI 中的连接别名、结构化输出、错误分类和历史记录可以迁移；每次命令重新启动进程、重新建立连接和依赖正则判断 SQL 的实现不直接复用。

## 4. 代码结构

建议结构：

```text
mysql-agent/
├── package.json
├── src/
│   ├── config/              # 路径、schema migration、SQLite repository
│   ├── mysql/               # runtime registry、executor、policy、error mapping
│   ├── business-queries/    # 业务定义、校验与执行 registry
│   ├── business-packs/      # 本地业务包加载器
│   └── mcp/                 # MCP server、基础工具、业务工具
├── skills/                  # Codex/DSH 共用工作流知识
├── adapters/
│   ├── codex/mysql-agent/   # .codex-plugin/plugin.json、.mcp.json
│   └── dsh/                 # npm bundle、cordis.patch.yml、示例 preset
├── tests/
└── docs/
```

核心逻辑不能依赖 Codex 或 DSH 的私有上下文。宿主差异只出现在 `adapters/`。

## 5. Codex 与 DSH 接入

### 5.1 Codex

Codex 适配包包含：

```text
adapters/codex/mysql-agent/
├── .codex-plugin/plugin.json
├── .mcp.json
└── skills/
```

`.mcp.json` 通过 stdio 启动编译后的 MCP Server。`plugin.json` 只声明实际存在的 MCP 和 Skill 目录。正式生成时使用 `plugin-creator` 校验插件结构。

### 5.2 DSH

当前本机验证版本为 `@deepseek-ai/dsh@0.1.1-rc.2`。它内置 `@deepseek-ai/dsh-mcp-client`，支持 `stdio` 与 `streamable-http`，能把 MCP 工具注册成 `mcp__<serverName>__<toolName>`，并提供超时、指数退避重连和工具列表重新同步。

DSH 适配层使用官方 MCP Client 启动同一 MCP Server：

```yaml
- id: mcp-mysql-agent
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mysql
    transport: stdio
    command: node
    args: ['/absolute/path/to/mysql-agent-mcp.mjs']
    toolCallTimeoutMs: 60000
    failOnStartupError: true
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

正式发行时不能依赖开发机绝对路径。DSH npm bundle 应通过自身安装位置解析 MCP Server 入口，并用 `cordis.patch.yml` 写入 profile。

若只允许某个 DSH Agent 使用 MySQL，应将 MCP Client 行挂载到该 Agent 的 `agent.cordis.yml`，或使用 `ctx.tools.restrict` 控制可见范围。工具可见性不是数据库权限；真正的权限仍由插件配置和 MySQL 账号决定。

### 5.3 共享与差异

共享内容：

- MCP Server。
- 工具输入、输出和错误契约。
- 内置业务 SQL 定义。
- `SKILL.md` 工作流。
- SQLite 数据文件。

宿主专有内容：

- Codex 的 `.codex-plugin/plugin.json`、`.mcp.json` 和 marketplace 安装信息。
- DSH 的 npm bundle、Cordis patch、profile 与 Agent Preset 配置。

## 6. SQLite 本地状态

### 6.1 路径

默认目录：

```text
~/.mysql-agent/
├── state.db
├── state.db-wal
└── state.db-shm
```

支持 `MYSQL_AGENT_HOME` 覆盖路径，方便测试隔离。目录权限设置为 `0700`，数据库及派生文件尽量设置为 `0600`。密码仍是明文；权限设置只避免其他本机账号直接读取，不等于加密。

### 6.2 表结构

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE connections (
  alias TEXT PRIMARY KEY,
  description TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 3306,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  default_database TEXT NOT NULL,
  allowed_databases_json TEXT NOT NULL DEFAULT '[]',
  charset TEXT NOT NULL DEFAULT 'utf8mb4',
  access_mode TEXT NOT NULL DEFAULT 'read_write',
  connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
  query_timeout_ms INTEGER NOT NULL DEFAULT 30000,
  pool_max INTEGER NOT NULL DEFAULT 10,
  idle_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE execution_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  client_name TEXT NOT NULL,
  connection_alias TEXT NOT NULL,
  business_operation_id TEXT,
  statement_kind TEXT NOT NULL,
  sql_hash TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  row_count INTEGER,
  affected_rows INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  write_outcome TEXT,
  status TEXT NOT NULL,
  error_category TEXT,
  mysql_error_code INTEGER
);

CREATE TABLE schema_snapshots (
  format_version INTEGER NOT NULL,
  cache_key TEXT PRIMARY KEY,
  connection_alias TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  default_database TEXT NOT NULL,
  allowed_databases_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
```

默认审计不保存密码、绑定参数值、完整 SQL或查询结果。临时 SQL 只保存规范化 hash；业务操作还保存 `business_operation_id`、业务包 ID、版本和操作 hash。`history_search` 只检索这些摘要，不能回放旧结果。

### 6.3 配置体验

连接管理本身就是插件能力。用户在 Codex 或 DSH 中要求新增、修改、查看或删除连接，由 Agent 调用对应 MCP 工具：

```text
connection_add(alias, host, port?, username, password, database, ...)
connection_update(alias, host?, port?, username?, password?, database?, ...)
connection_list()
connection_remove(alias)
```

`connection_add` 和 `connection_update` 接收密码并写入 SQLite，但任何工具结果都不能返回密码。`connection_list` 只返回别名、描述、地址、用户名、默认数据库、访问模式和启用状态。

采用这种入口后，密码会经过模型输入、MCP 工具参数和宿主调用轨迹。当前产品边界接受测试环境密码的这一风险；SQLite 明文存储并不能消除传输和轨迹中的暴露。

新增连接时只写 SQLite，不创建连接池。更新连接后，插件递增配置 revision，把该别名的旧连接池标记为 draining；下一次真实调用按新配置建连。删除连接时先删除 SQLite 配置，再停止旧池接收新调用；在途调用结束后关闭旧池。整个过程不额外执行独立的连接测试。

SQLite 使用 WAL、`busy_timeout` 和短事务。Codex 与 DSH 同时运行时可以共享连接配置；连接配置更新后，MCP Server 通过 revision 失效对应连接池。

状态迁移在 `BEGIN IMMEDIATE` 内按 v1、v2、v3 顺序执行，支持旧 v1/v2 原地升级和重复启动；检测到高于当前实现的 migration 版本时失败关闭，不尝试降级读取。

### 6.4 Schema 快照生命周期

Schema 不在进程启动时加载。第一次调用 `schema_search` 或 `schema_describe` 时，插件用现有 `mysql2` pool 和 `ConnectionRuntime` 执行固定的 `information_schema.tables`、`columns`、`statistics`、`key_column_usage` 与 `referential_constraints` 查询。每条查询都用绑定值限制在连接的 `allowed_databases`，不经过通用 `sql_query` 校验，也不创建额外连接池。

规范化快照以“连接别名 + revision + 默认库 + 排序后的 allowed databases”为键。L1 进程内新鲜期约 5 分钟，L2 `state.db` 新鲜期约 30 分钟；同一进程的并发首次加载由 in-flight Promise 合并。连接更新或删除会清理持久快照，revision 变化也使旧键不可达。未知表或未知列错误会使当前 revision 快照失效，但不会自动重放写请求。

持久快照带独立 `format_version`，读取和写入前都严格校验完整嵌套结构；未知版本、错误 JSON、错误结构和未来 `loaded_at` 会删除并绕过。四组元数据查询共享 16 MiB 累计预算，规范化快照再次执行同一大小检查；单次 `schema_search` 或 `schema_describe` 完整结构化结果上限为 1 MiB，超限要求调用方收紧关键词、数量或关系深度。

元数据执行与普通查询共用 bulkhead、超时、熔断和只读重试策略，并支持取消。内部查询和 Agent 输出均有行数、字节数、表数与关系数上限，避免把完整大型 schema 注入模型上下文。

## 7. 内置业务 SQL

### 7.1 定义

业务 SQL 放在本地版本化业务包中。`pack.yml` 声明输入 schema、目标连接、使用场景和执行限制，SQL 放在同一包目录内的 `.sql` 文件：

```yaml
schema_version: mysql-agent/business-pack/1
pack_id: order-center
version: 1.0.0
operations:
  - id: order.find_by_no
    domain: order
    name: find_by_no
    title: 按订单号查询订单
    description: 查询订单状态、金额和履约状态。
    use_when: 用户给出订单号并询问订单状态时使用。
    connections: [auto-fat]
    mode: read
    input:
      order_no: { type: string, min_length: 1, max_length: 64, trim: true }
    sql_file: sql/find_by_no.sql
    timeout_ms: 3000
    max_rows: 20
```

默认加载发布包中的 `business-packs/`；`MYSQL_AGENT_BUSINESS_PACKS` 可指定另一绝对目录。业务 SQL 不存入 SQLite，也不能由 Agent 参数提供。`mode` 支持 `read`、`insert`、`update` 和 `delete`。

### 7.2 运行方式

MCP Server 启动时完成以下工作：

1. 一次性读取所有非隐藏业务包目录中的 `pack.yml` 和包内 SQL 文件。
2. 校验输入 schema、连接别名和 SQL 元数据；SQL 引用的属性必须是必填、无 transform/coercion 的安全标量或 1–100 项一维安全标量数组。
3. 将命名参数编译成驱动参数绑定。
4. 业务操作默认按“数据源 + 业务域 + 读写通道”生成分组 MCP 工具；仅对显式 `exposure: 'direct'` 的操作生成独立工具。注册前校验最终 direct/group 名称符合 MCP 字符集且不超过 128 个字符。
5. 用 `title + description + use_when` 生成模型可见描述，并计算包含包版本、目标连接、输入定义和 SQL 的 SHA-256 操作 hash。
6. 用 `parameters` 生成工具输入 JSON Schema。
7. 执行时只接受已声明参数，拒绝缺失和多余字段。

模型调用业务工具时只传业务参数，不传 SQL：

```json
{
  "order_no": "A202608260001"
}
```

建议原始工具名使用稳定形式，例如 `business__auto-fat__order__find_by_no`。DSH 最终展示为 `mcp__mysql__business__auto-fat__order__find_by_no`；Codex 使用 MCP Server 声明的工具名。

### 7.3 业务 SQL 与 Skill 的边界

- 一条固定业务 SQL：本地业务包生成的业务工具负责。
- 多条业务工具的先后顺序、判断条件和最终解释格式：Skill 负责。
- 尚未沉淀的临时排查：通用查询工具负责。

例如“分析订单为什么没有派单”可以由 Skill 依次调用订单、派单任务和供应商状态三个内置业务工具。Skill 不包含、读取或拼接 SQL。

### 7.4 业务 SQL 更新

新增、删除或修改业务 SQL 应走业务包版本变更、静态校验、单元测试和集成测试。每个 MCP 进程只在启动时加载一次；修改文件后必须重启 MCP 连接。任一业务包校验失败都会使启动整体失败，不会部分注册。运行时不提供文件监听、热重载或 Agent 写入业务 SQL 的能力。

## 8. MCP 工具面

### 8.1 复杂度结论

查询、新增、修改和删除是四类数据库能力，不必对应四个 Agent 工具。`insert`、`update` 和 `delete` 的输入结构几乎相同，全部暴露会增加重复描述和选错工具的机会。

第一版采用“能力四类、通用入口两类”：

- `sql_query`：只执行查询。
- `sql_execute`：执行新增、修改或删除，插件解析 SQL 后确定实际操作类型。

插件内部仍保留查询、新增、修改和删除四种执行策略、校验规则、审计类型和返回结果。这个收敛只简化 Agent 入口，不减少数据库能力。

完整字段、MCP 消息、连接池状态机、重连和端到端执行过程见 [协议与运行时设计](protocol-and-runtime.md)。

对外基础工具如下：

```text
connection_add(alias, host, port?, username, password, database, ...)
connection_update(alias, host?, port?, username?, password?, database?, ...)
connection_list()
connection_remove(alias)
sql_query(connection, sql, parameters?, max_rows?, timeout_ms?)
sql_execute(connection, sql, parameters?, timeout_ms?)
schema_search(connection, keyword?, limit?, refresh?)
schema_describe(connection, tables, include_relations?, relation_depth?, include_inferred_relations?, refresh?)
list_business_operations(connection, domain?, keyword?)
business__<connection>__<domain>__<name>(...declared parameters)
business__<connection>__<domain>__read|write({ operation, input })
```

连接管理工具是插件入口的一部分。它们修改本地 SQLite 状态；`connection_remove` 应声明为有破坏性的工具，由宿主按自身确认策略处理。

不提供独立的 `test_connection`。连接建立、连接池维护、失效连接淘汰和恢复都由插件内部完成。Agent 直接调用查询或业务工具；连接最终不可用时，当前调用返回 `connection_error`。

`sql_query` 和 `sql_execute` 是通用兜底能力。模型应优先选择匹配场景的内置业务工具；已有业务工具时不重新生成 SQL。

### 8.2 Schema 发现与 ER 准确性边界

`schema_search` 只返回匹配表及匹配列的紧凑摘要。`schema_describe` 接受 1–20 个默认库表名或 `allowed_database.table`，只展开 0–2 层相关子图，绝不返回整个 schema 或 DDL。

真实关系只来自 MySQL 声明外键并标记 `source: "foreign_key"`。可选推断只在保守的 `xxx_id -> candidate_table.id` 名称匹配、主键存在且类型兼容时产生，标记 `source: "inferred"`、`confidence` 和 `reason`。推断默认关闭，不能用于声称数据库存在外键约束。

### 8.3 SQL 与参数的边界

通用工具把 SQL 模板和参数值分开传递。例如：

```json
{
  "connection": "auto-fat",
  "sql": "UPDATE users SET status = :status WHERE id = :id",
  "parameters": {
    "status": "disabled",
    "id": 123
  }
}
```

插件将命名参数编译为 MySQL 驱动的占位符和有序参数数组，SQL 文本与参数值分别交给驱动，不把参数值拼进 SQL 字符串。插件拒绝缺失参数、多余参数和参数类型不符。

参数绑定只适用于值，不能代替表名、字段名、排序方向或 SQL 关键字。因此有两个控制级别：

- 通用工具：Agent 决定 SQL 结构和参数值；插件负责参数绑定、语句分类和执行限制。
- 业务工具：SQL 结构、目标连接和允许参数都固定在启动时加载的业务包中；Agent 只能提供业务参数。这是稳定性最高的入口。

### 8.3 工具如何触发

模型根据用户意图和工具描述选择入口：读取调用 `sql_query`；新增、修改或删除调用 `sql_execute`。内置业务工具通过 `title`、`description` 和 `useWhen` 说明使用场景，模型在匹配时优先调用它。

不能只相信模型选对了工具。MCP Server 在执行前重新解析 SQL 根语句并校验工具类型；例如把 `DELETE` 传给 `sql_query`，或把 `SELECT` 传给 `sql_execute`，都返回 `argument_error`。AST 解析前先由共享 lexer 拒绝 MySQL/MariaDB 可执行注释（`/*!...*/`、`/*M!...*/`），防止数据库执行 parser 当作普通注释忽略的隐藏 SQL；字符串和反引号内容保持可用。预检还拒绝任何未组成 CRLF 的单独回车符，关闭 MySQL 与 parser 对 `--`/`#` 行注释结束位置的差异。校验必须识别注释、CTE 和字符串字面量，不能只用首单词正则判断。

### 8.4 写操作确认与服务端保护

工具使用 MCP annotations 向宿主声明副作用：`sql_query` 标为只读；`sql_execute` 保守地标为非只读且可能破坏数据。内置业务工具按其 `mode` 生成更精确的标注。支持审批的宿主可以据此决定是否弹出确认；annotations 只是提示，不能保证宿主一定执行审批，也不能替代服务端校验。

推荐的第一版确认策略：

- 用户明确要求新增或修改时，由宿主确认后执行一次；没有明确写入意图时，Agent 只能查询或先向用户说明变更内容。
- 删除每次都走宿主确认，确认信息包含连接别名、目标表、条件摘要和操作类型。
- 禁止通用工具执行无 `WHERE` 的 `UPDATE` 或 `DELETE`。第一版不提供可由 Agent 自行设置的绕过参数。
- 不接受 `confirmed: true` 这类由 Agent 自己传入的字段作为用户确认凭证。需要强确认时，凭证必须由模型无法伪造的宿主审批层产生。

如果宿主无法提供可信审批事件，插件仍执行语句类型、单语句和 `WHERE` 限制，但产品不能声称已经获得用户确认。当前安装的 DSH MCP Client 文档没有声明交互式审批能力，DSH 适配阶段需要实测；若确实不支持，要么接受“用户明确写入指令后直接执行”的策略，要么另加可信的宿主审批适配，不能让 Agent 自己模拟确认。

通用执行规则：

- `sql_query` 只接受查询类 SQL。
- `sql_execute` 只接受单条 `INSERT`、`UPDATE` 或 `DELETE`。
- `UPDATE` 和 `DELETE` 必须包含 `WHERE`。
- 两个通用工具都使用参数绑定，拒绝多语句输入。
- `INSERT`、`UPDATE` 和 `DELETE` 成功后提交，任何写操作都不自动重试。

统一成功结果：

```json
{
  "status": "ok",
  "connection": "auto-fat",
  "database": "auto_server_fat",
  "business_operation_id": "order.find_by_no",
  "columns": ["order_no", "status", "amount", "provider_status"],
  "rows": [],
  "row_count": 0,
  "truncated": false,
  "duration_ms": 18
}
```

通用写操作成功结果返回影响行数；`insert` 还返回自增 ID：

```json
{
  "status": "ok",
  "connection": "auto-fat",
  "operation": "insert",
  "affected_rows": 1,
  "last_insert_id": 12345,
  "duration_ms": 12
}
```

统一错误类别：

```text
argument_error
config_error
connection_error
authentication_error
timeout
sql_error
permission_error
result_limit
write_outcome_unknown
internal_error
```

错误结果不得包含密码、完整连接串、完整 SQL 或绑定参数值。MySQL 执行失败时，正文和结构化结果都返回经过单行化、长度限制及参数值脱敏的驱动错误信息，并保留 MySQL 符号错误名、数字错误码和 SQLSTATE，避免客户端只显示宽泛错误。

如果写请求已经发给 MySQL，但连接在确认结果前中断，插件返回 `write_outcome_unknown`。插件不能声称失败，也不能自动重试；调用方需要通过后续查询确认实际状态。

## 9. 性能设计

1. MCP Server 是常驻进程，不为每次查询启动 Python 或 Node 进程。
2. 每个连接别名维护独立、懒加载的 `mysql2` 连接池；每个池最多建立 10 条物理连接。
3. 配置变化只关闭受影响的池，不重建全部连接。
4. 业务操作定义在启动时注册，不在每次调用时重新解析配置文件。
5. 使用服务端参数绑定，不进行字符串拼接。
6. 默认限制返回行数和单次调用体积，避免大结果拖慢模型上下文。
7. SQLite 配置读取使用短查询；Cockatiel bulkhead 串行提交审计写入并限制排队数量。

必须记录并比较：

- MCP 冷启动时间。
- 第一次查询时间。
- 连接池热查询 p50、p95、p99。
- 1、10、20、50、60 个并发调用下的延迟、错误率、排队数和实际连接数。
- Codex 与 DSH 同时运行时的 SQLite 写入冲突率。

## 10. 稳定性设计

1. MCP 层、MySQL 层和业务 SQL 层分别分类错误。
2. `mysql2` 管理物理连接的创建、复用和空闲回收；Cockatiel bulkhead 管理有界等待。插件销毁已确认失效的连接，不把坏连接放回池中。
3. `cockatiel` 只对明确可重试的只读请求执行一次有边界重试，并按连接别名维护熔断策略。
4. 写操作不自动重试，避免执行结果不确定时重复写入。
5. `cockatiel` 统一执行调用超时；每个连接、业务操作和调用仍可声明不同上限，查询另有最大行数。
6. MCP Server 捕获顶层异常并返回结构化错误，不因单次 SQL 错误退出。
7. SQLite schema 使用显式 migration；升级前备份只复制数据库状态，不输出到日志。
8. DSH 使用其 MCP Client 的断线重连；Codex 侧以进程退出和重新拉起测试为准。
9. 启动健康不代表业务成功；验收必须执行真实 `SELECT 1` 和代表性业务查询。

## 11. 测试与验收

### 11.1 单元测试

- SQLite migration 与并发访问。
- 业务操作定义、命名、模式和参数校验。
- SQL 参数绑定。
- 错误分类与脱敏。
- 连接配置变更后的连接池失效。

### 11.2 集成测试

- 使用临时 MySQL 容器执行真实查询。
- 执行真实 `INSERT`、`UPDATE` 和 `DELETE`，验证影响行数与自增 ID。
- 连接断开后恢复。
- 超时、认证失败、未知库和 SQL 错误。
- 最大行数与结果截断。
- Codex/DSH 两个 MCP Client 同时连接。
- MCP Server 崩溃后的宿主恢复。

### 11.3 业务操作契约测试

每个发布的业务操作至少提供：

- 正常输入。
- 空值或非法参数。
- 无结果。
- 多结果与截断。
- 表或字段变更时的失败信息。

## 12. 分阶段实施

### 阶段 A：运行时骨架

- TypeScript 工程、SQLite migration 和连接管理 MCP 工具。
- MCP Server、连接池和 `connection_add`、`connection_update`、`connection_list`、`connection_remove`、`sql_query`、`sql_execute`。
- 错误模型、脱敏和基础测试。

### 阶段 B：内置业务 SQL

- `defineBusinessOperation` 注册 API 和集中 registry。
- 业务 SQL 编译为 MCP 工具。
- 示例业务查询与契约测试。

### 阶段 C：双宿主适配

- Codex 插件清单和本地 marketplace 验证。
- DSH bundle、profile patch 和 Agent Preset 示例。
- 同一 SQLite 状态下的双宿主验收。

### 阶段 D：性能与故障验证

- 冷启动、热查询和并发基准。
- MySQL 断线、MCP 崩溃、SQLite 锁竞争测试。
- 根据数据调整连接池、超时和审计队列。

## 13. 尚待确认

1. 项目和插件的正式名称；本文暂用 `mysql-agent`。
2. SQLite 明文密码是否需要提供手动导入旧 `mysql-cli` 配置的迁移命令。
3. 写操作是否全部要求逐次确认，以及 DSH 是否能提供可信的交互式审批事件。

## 14. 依据

- OpenAI 插件包可以包含 `.codex-plugin/plugin.json`、`.mcp.json` 和 Skills：<https://developers.openai.com/plugins/build/plugins>
- OpenAI 将 MCP Server 定义为实时数据和受控工具层，将 Skills 定义为可复用工作流层：<https://developers.openai.com/plugins/concepts/skills>
- OpenAI 建议只暴露当前任务相关的工具、保持工具说明简洁，并明确 autonomy 与 approval 边界：<https://developers.openai.com/api/docs/guides/latest-model>
- MCP 工具通过 `inputSchema` 定义结构化参数，并可用 annotations 描述只读和破坏性语义：<https://modelcontextprotocol.io/specification/2025-11-25/schema>
- MySQL Prepared Statement 要求单条 SQL，并将参数标记绑定到值；参数标记不能替代表名或字段名：<https://dev.mysql.com/doc/c-api/26.7/en/mysql-stmt-prepare.html>
- 当前安装的 DSH MCP Client 文档：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/README.zh.md`
- 旧 CLI 只作为早期实现参考，不属于本仓库的产品契约。
