# 业务脚本运行时与可观测闭环设计

状态：已实现，AutoServer 工作空间验收配置见该项目 `.mysql-agent/` 目录  
更新日期：2026-09-15

## 1. 决策摘要

本项目保留现有通用 MySQL 能力和固定 SQL 业务操作，在业务包中新增受限脚本操作，用一个成熟业务工具完成多次查询、条件判断、并行读取和结果整理。

产品形态采用“程序全局安装、MCP 按工作空间运行”。Codex/DSH 进入项目时启动同一份程序，传入该项目的 workspace descriptor；Server 只装载当前工作空间允许的业务包、逻辑数据源和环境 binding。业务调用只传订单号等业务参数，不再让 Agent 选择物理连接 alias。

脚本执行框架选用 Vercel Labs 的 [`run`](https://run-sdk.dev/docs/introduction)。它在 Node.js worker thread 中为每次调用创建新的 QuickJS 上下文。脚本只能访问宿主显式注入的函数，默认不能访问 Node.js、文件系统、环境变量、模块和网络。业务脚本使用普通 JavaScript 或去除类型标注后执行的 TypeScript，不引入自研 DSL。

`run` 是较新的实现，不视为不可替换的基础设施。项目在它外面定义自己的 `BusinessScriptRuntime` 接口；业务包、能力注册、审计和 MCP 工具都不直接依赖 `run` 的类型。若后续安全评估或维护状态不满足要求，可以替换沙箱实现，不改变业务包协议。

首期只允许脚本组合已经发布的只读 `BusinessOperation`。脚本不能提交任意 SQL，也不能调用 shell、HTTP、文件系统或其他 MCP Server。

```text
                           workspace business pack
                         ┌─────────────────────────┐
                         │ pack.yml                │
Codex / DSH              │ sql/*.sql              │
    │                    │ scripts/*.ts           │
    ▼                    └────────────┬────────────┘
MySQL MCP Server                      │ 校验、版本化、原子装载
    │                                 ▼
    ├─ 通用 SQL ───────────────► BusinessOperationRegistry
    │                                 ▲
    └─ 业务工具 ─► Script Runtime ────┘
                       │ 白名单调用
                       ▼
                 MySQL Runtime ─► MySQL
                       │
                       └─ workspace / trace / audit / candidate
```

## 2. 要解决的问题

当前业务包能把一条固定 SQL 变成稳定工具，但复杂场景仍需要 Agent 多次调用 MCP 工具并在模型侧判断。这样会增加工具往返、上下文消耗和选错步骤的概率。

目标是把已验证的业务过程也产品化：

- 一个业务意图尽量只触发一次 MCP 调用。
- SQL、数据源、参数和返回边界继续由服务端固定。
- 多个独立查询可以并行，但每个数据源最多使用两条物理连接。
- 条件判断和结果裁剪在插件内完成，避免把大量中间数据送回模型。
- 每个根调用和内部步骤都有 workspace、Trace 和审计记录。
- 执行数据可以反向发现值得沉淀的新业务工具，但模型不能直接发布生产资产。

## 3. 边界与非目标

### 3.1 本期范围

- 保留 `kind: sql`，兼容现有业务包。
- 新增 `kind: script`，只组合已注册的只读 MySQL 业务操作。
- 业务包可位于插件发布目录，也可位于工作空间目录。
- 新增工作空间隔离的 Trace、使用统计、候选分析和归档能力。
- 将每个 MCP 进程、每个数据源的 `pool_max` 默认值和最大值统一为 `2`。

### 3.2 明确不做

- 不搭建 Windmill、n8n、Temporal 或独立工作流平台。
- 不发明 YAML 工作流 DSL、自定义表达式语言或新的脚本语法。
- 不给脚本任意 SQL、shell、文件、环境变量、网络或动态模块能力。
- 不在 MySQL 插件中实现阿里云、ZTO CLI 等其他 provider。
- 不做跨 provider 分布式事务、长任务、人工审批编排或断点续跑。
- 不允许模型生成内容后直接写入生产业务包。

## 4. 业务包协议 v2

现有 v1 包按 `kind: sql` 处理，无需一次性迁移。v2 显式声明操作类型：

```yaml
schema_version: mysql-agent/business-pack/2
pack_id: order-center
version: 2.0.0

operations:
  - id: work_order.find_by_no
    kind: sql
    domain: work_order
    name: find_by_no
    title: 按单号查询工单
    description: 返回工单主状态和关键时间。
    use_when: 用户提供完整单号并询问工单详情时使用。
    datasource: autoserver
    environments: [test, prod]
    mode: read
    exposure: domain
    input:
      order_no: { type: string, min_length: 1, max_length: 64, trim: true }
    sql_file: sql/find_by_no.sql
    timeout_ms: 3000
    max_rows: 20
    retry_safe: true

  - id: work_order.diagnose
    kind: script
    domain: work_order
    name: diagnose
    title: 按单号诊断工单
    description: 汇总工单、任务和回传状态，并给出结构化诊断。
    use_when: 用户提供完整单号并询问未流转、未回传或状态异常原因时使用。
    datasource: autoserver
    environments: [test, prod]
    mode: read
    exposure: direct
    input:
      order_no: { type: string, min_length: 1, max_length: 64, trim: true }
    script_file: scripts/diagnose.ts
    uses:
      - work_order.find_by_no
      - work_order.list_tasks
      - work_order.list_push_records
    timeout_ms: 8000
    max_result_bytes: 262144
```

脚本使用普通异步代码：

```ts
const input = await workflow.input();

const [order, tasks, pushes] = await Promise.all([
  operations.call('work_order.find_by_no', { order_no: input.order_no }),
  operations.call('work_order.list_tasks', { order_no: input.order_no }),
  operations.call('work_order.list_push_records', { order_no: input.order_no }),
]);

if (order.row_count === 0) {
  return { status: 'not_found', order_no: input.order_no };
}

return {
  status: 'ok',
  order: order.rows[0],
  tasks: tasks.rows,
  pushes: pushes.rows,
};
```

`uses` 是强制授权清单，不只是文档。即使脚本动态拼出了另一个 operation ID，运行时也必须拒绝。单数据源脚本使用 `datasource`；需要跨库组合时，脚本显式声明 `datasources`。它依赖的全部 SQL 操作必须位于清单内、绑定到同一执行环境并使用只读模式。

## 5. 运行时结构

### 5.1 可替换接口

```ts
export interface BusinessScriptRuntime {
  validate(definition: ScriptOperationDefinition): Promise<ValidationReport>;
  execute(request: ScriptExecutionRequest): Promise<ScriptExecutionResult>;
  close(): Promise<void>;
}
```

首个适配器为 `RunBusinessScriptRuntime`，内部调用 `run`。加载器、registry 和 MCP Server 只依赖上述接口。

### 5.2 宿主能力

首期只注入两个 namespace：

```text
workflow.input()                       获取经过 Schema 校验的输入
operations.call(operationId, input)   调用 uses 白名单内的固定业务操作
```

`operations.call` 不是 MCP 回调，也不会再次经过 Agent。它直接调用进程内 `BusinessOperationRegistry`，继续复用现有参数校验、SQL policy、连接池、超时、重试、结果限量和审计逻辑。

```text
一次 MCP 调用
    │
    ▼
创建 root span
    │
    ▼
创建 QuickJS context
    │
    ├─ operations.call(A) ─► child span A ─► 固定 SQL A
    ├─ operations.call(B) ─► child span B ─► 固定 SQL B
    └─ 本地判断与裁剪
    │
    ▼
校验最终结果 ─► 写入 root audit ─► 返回 Agent
```

### 5.3 `run` 配置基线

初始限制应比框架默认值更严格，再根据真实 Trace 调整：

| 限制 | 首期值 | 说明 |
| --- | ---: | --- |
| `timeoutMs` | 10 秒 | 业务包可以下调，不能上调 |
| `memoryLimitBytes` | 32 MiB | 单个 QuickJS context |
| `maxSourceBytes` | 64 KiB | 阻止超大脚本 |
| `maxResultBytes` | 256 KiB | 先于 MCP 总结果上限生效 |
| `maxConsoleOutputBytes` | 8 KiB | 日志只用于诊断，不进入业务结果 |
| host function 总调用数 | 16 | 控制组合复杂度 |
| `maxInFlightBridgeRequests` | 2 | 与 MySQL pool 上限一致 |
| 进程级 worker 数 | 2 | 避免每个 stdio 进程扩张线程和内存 |

不配置 `moduleLoader`，使用 function-body 模式。脚本不能 `import`，也不能获得 `process`、`require`、`Buffer`、`fetch`、WebSocket、定时器、`eval` 或 `Function`。

宿主函数仍属于可信代码。它必须重新校验 operation ID、输入、连接、读写模式、workspace 和结果大小，不能因为脚本位于沙箱中就跳过权限判断。

## 6. 连接池和并发

所有连接配置的 `pool_max` 默认值和允许最大值从 `10` 改为 `2`。升级 migration 将现存大于 `2` 的配置收敛为 `2`，并递增连接 revision，使旧池排空后按新上限创建。

```text
脚本 Promise.all(最多 2 个在途 host call)
                  │
                  ▼
             MySQL bulkhead
        active <= 2, queue <= 8
                  │
                  ▼
          mysql2 pool.max = 2
```

脚本可以并行发起独立读取，但并行度不等于连接数。第三个及后续步骤进入有界队列；超过排队时间返回明确的 busy/queue-timeout 错误。容量按下式评估：

```text
MCP 进程数 × 每进程已使用的数据源数 × 2 条物理连接
```

因此仍需监控任务初始化、进程残留和宿主重连，不能只看单个连接池上限。

## 7. 逻辑数据源与环境目标

### 7.1 决策

生产和测试应该属于同一个逻辑数据源，但不能合并为同一条物理连接记录：

```text
逻辑数据源 autoserver
    ├─ test ─► 物理连接 auto-dev  ─► 测试库账号、地址、权限、连接池
    └─ prod ─► 物理连接 auto-prod ─► 生产库账号、地址、权限、连接池
```

业务 SQL、脚本、参数 Schema 和工具说明只定义一次。环境 binding 决定实际使用哪个连接。生产和测试继续使用独立账号、权限、超时、连接池、熔断状态和审计维度。

当前 `autoserver` 业务包已经让同一 operation 同时绑定 `auto-dev` 和 `auto-prod`，所以 SQL 文件本身没有重复。缺少的是连接之间的逻辑关系、明确的环境语义和生产访问策略。本次改造补齐这三层，不推翻现有能力。

这种结构与常见工具一致：dbt 在一个 profile 中定义 dev、staging、prod 等 target，但每个 target 保留独立连接和凭据；Google MCP Toolbox 也把 source 与 tool 分开定义；生产环境再通过独立权限和保护规则收紧访问。共同原则是“复用逻辑，隔离执行目标”。

### 7.2 连接模型

现有 `connections.alias` 继续作为物理连接主键，并新增两个必填元数据：

```text
datasource_id   逻辑数据源，例如 autoserver
environment     dev | test | staging | prod | custom
```

不能根据 `auto-dev`、`auto-prod` 等 alias 后缀推断环境。旧记录迁移时使用 `datasource_id=alias`、`environment=custom`，再由用户显式归组，避免把历史命名误判为权限事实。

`connection_list` 按逻辑数据源分组展示，但仍返回每个环境对应的物理 alias、`access_mode` 和启用状态。连接密码继续只存在全局 SQLite；工作空间配置只引用 alias。

### 7.3 工作空间绑定

同一项目可以同时声明多个逻辑数据源，以及每个数据源的测试和生产 binding：

```yaml
default_environment: test
environments:
  test:
    datasource_bindings:
      autoserver: auto-dev
      proofline: auto-proofline
  prod:
    datasource_bindings:
      autoserver: auto-prod
    access_mode: read_only
    expose_as_explicit_tool: true
```

解析链固定为：

```text
business operation
    ─► datasource_id + environment
    ─► workspace binding
    ─► physical connection alias
    ─► connection policy and MySQL account
```

`environment` 不能作为脚本自由传入的普通参数。当前 Codex/DSH 没有统一的可信环境切换凭证，因此首期根据工作空间策略生成目标绑定工具。默认数据源和默认环境使用短名称；额外暴露的生产环境必须显示 `prod`：

```text
business__work_order__diagnose          默认绑定 autoserver/test
business__prod__work_order__diagnose    显式绑定 autoserver/prod
```

两个工具复用同一个 operation 定义，输入都只有 `order_no` 等业务字段，没有 `connection`、`datasource` 或 `environment`。工作空间可以只暴露 test，也可以同时暴露只读 prod。生产写入不能通过环境参数切换，必须使用单独授权入口和宿主审批。

一次脚本调用只能绑定一个环境，所有 `operations.call` 子步骤继承该环境。脚本可以组合当前工作空间中的多个逻辑数据源，但每个依赖 operation 必须在 `uses` 中声明，且其 `datasource_id` 必须出现在脚本的 `datasources` 清单中。例如：

```yaml
id: work_order.compare_proofline
kind: script
datasources: [autoserver, proofline]
environments: [test]
uses:
  - work_order.find_by_no
  - proofline.execution.find_by_order_no
```

跨环境对比必须声明为独立、只读、可审计的特殊业务操作；默认禁止同一脚本同时读取 test 和 prod。

### 7.4 Schema 漂移

同一 SQL 能否复用取决于 Schema 契约，不取决于环境名字。业务操作发布前必须分别在允许的 test/prod binding 上校验表、字段和返回结构。某个环境不兼容时，只禁用该环境的工具，不影响其他环境。

不要在 SQL 或脚本中堆积 `if (environment === 'prod')` 来掩盖长期 Schema 分叉。若两套库已形成不同业务契约，应发布两个 operation 版本或明确的环境 override，并在 Trace 中记录最终 hash。

## 8. 工作空间级运行与归档

### 8.1 安装范围和运行范围

插件包只安装一份，但运行实例按工作空间创建：

```text
全局安装的 mysql-agent 程序
    ├─ AutoServer workspace MCP process
    │      └─ AutoServer packs + bindings + tools
    └─ VoiceHub workspace MCP process
           └─ VoiceHub packs + bindings + tools
```

这不是把 npm/plugin 文件复制进每个项目。项目只保存 `.mysql-agent/workspace.yml`、业务包和项目级 MCP 启动配置。启动配置把 descriptor 的绝对路径传给全局程序。每个进程独立维护内存 registry 和懒加载连接池，共享的 SQLite 仍按 workspace 分区。

Codex/DSH 没有提供 workspace descriptor 时，Server 只能进入 `admin` 或兼容 `global` 模式，不能自动扫描当前目录并猜测项目。显式传入 descriptor 是工作空间隔离和工具裁剪的可信起点。

### 8.2 两种运行模式

同一程序提供两种工具面：

| 模式 | 用途 | 默认可见工具 |
| --- | --- | --- |
| `admin` | 配置物理连接和全局状态 | `connection_add/update/list/remove`、管理查询 |
| `workspace` | 日常项目会话 | 当前项目业务工具、绑定后的 Schema/SQL 工具、当前 workspace 的历史与 Trace |

`connection_add`、`connection_update` 和 `connection_remove` 没有删除。它们保留在 `admin` 模式，负责管理跨工作空间的物理连接。`workspace` 模式不直接暴露这些底层工具，而是提供只作用于当前项目的高层数据源配置工具。

两个入口仍启动同一个 MCP Server 程序，不是两套插件实现：

```text
mysql-agent-mcp --mode workspace --workspace /project/.mysql-agent/workspace.yml
mysql-agent-mcp --mode admin     --workspace /project/.mysql-agent/workspace.yml
```

两种模式都通过 MCP 工具操作。CLI 参数只决定工具面和工作空间，不要求用户用命令行手工写连接。

工作空间必须声明 `default_datasource` 和 `default_environment`。业务工具始终由 operation 自身和 workspace binding 选定一个或多个目标；默认 `sql_query`、`schema_search`、`schema_describe` 由工作空间注入默认目标，因此工具输入不再需要 `connection`：

```text
sql_query(sql, parameters?, max_rows?, timeout_ms?)
schema_search(keyword?, limit?, refresh?)
business__work_order__diagnose(order_no)
```

若项目使用多个逻辑数据源，默认工具仍只绑定一个目标。其他数据源通过名称明确的目标绑定工具暴露，不能让 Agent 传入任意物理 alias：

```text
sql_query                         默认 autoserver/test
schema_search                     默认 autoserver/test
sql_query__proofline              绑定 proofline/test
schema_search__proofline          绑定 proofline/test
business__work_order__diagnose    operation 自带 autoserver 目标
business__order__proof_compare    operation 自带 autoserver + proofline 目标
```

工作空间启动校验必须保证每个单目标工具能唯一解析到一个 `datasource_id + environment + connection_alias`，并保证每个组合工具声明的全部数据源都有唯一 binding。任一依赖缺失时，该组合工具不注册；Server 不能退回默认库代替缺失数据源。

### 8.3 数据源添加与绑定

数据源选择从“每次查询”移动到“项目初始化或配置变更”阶段。工作空间模式提供以下高层工具：

```text
workspace_datasource_add       创建工作空间自有连接并立即绑定
workspace_datasource_bind      绑定管理员已创建且允许共享的连接
workspace_datasource_list      查看当前项目的逻辑数据源和环境
workspace_datasource_update    更新当前项目自有连接
workspace_datasource_remove    解除 binding；按所有权决定是否删除物理连接
workspace_validate             校验全部 binding 和业务操作是否可解析
```

典型首次配置只需要一次高层调用：

```text
用户：给当前项目增加 AutoServer 测试数据源
    │
    ▼
workspace_datasource_add(
  datasource_id = autoserver,
  environment = test,
  alias = auto-dev,
  host / port / username / password / database,
  access_mode = read_write,
  make_default = true
)
    │
    ├─ 写入全局 SQLite 的物理 connection
    ├─ 写入当前 workspace.yml 的 binding
    ├─ 校验唯一解析和权限边界
    └─ 原子重载当前 workspace registry
```

工具结果不返回密码。添加配置本身不主动建立 MySQL 连接；第一次真实查询才进行建连。若用户希望复用已有物理连接，则先由 `admin` 模式把连接标记为可共享，再调用 `workspace_datasource_bind`。工作空间不能枚举或绑定未授权的全局连接。

物理连接增加所有权字段：

```text
owner_scope = workspace:<workspace_id>   只允许本工作空间维护
owner_scope = global                     由 admin 维护，可按策略共享
```

工作空间删除数据源时先解除 binding。只有物理连接归当前工作空间所有、没有其他引用并且用户确认删除时，Server 才删除 connection；否则只解除当前项目的关系。

生产数据源遵循更严格的设置流程。`workspace_datasource_add` 默认只允许 `dev/test/staging`。新增或修改 `prod` 连接必须进入 `admin` 模式，再将批准的只读连接绑定到工作空间。这个限制发生在服务端，不能用 Agent 参数绕过。

SQLite 与 `workspace.yml` 无法组成单一数据库事务。高层工具必须先完成全量预检，再使用临时文件加原子 rename 更新 workspace 配置；中途失败时撤销本次新建的 SQLite connection。若补偿也失败，返回明确的 `partial_configuration` 和可恢复步骤，不能报告添加成功。

### 8.4 存储决策

默认继续共享一个 `state.db`，但审计数据按工作空间强制分区。这样既保留连接配置和 migration 的统一管理，也能按项目检索、生成候选、导出和归档。

每个工作空间包含：

```text
.mysql-agent/
├── workspace.yml
└── business-packs/
    └── <pack>/...
```

`workspace.yml` 示例：

```yaml
schema_version: mysql-agent/workspace/1
workspace_id: auto-server
label: AutoServer
runtime_mode: workspace
default_datasource: autoserver
default_environment: test
environments:
  test:
    datasource_bindings:
      autoserver: auto-dev
      proofline: auto-proofline
  prod:
    datasource_bindings:
      autoserver: auto-prod
    access_mode: read_only
    expose_as_explicit_tool: true
business_pack_paths:
  - ./business-packs
audit_retention_days: 30
```

`workspace_id` 是稳定逻辑标识，不使用绝对路径。数据库只额外保存规范化 root 的 hash，用于排查错误装载；默认不保存原始绝对路径。项目移动目录后仍属于同一工作空间。

### 8.5 工作空间解析顺序

1. Codex 或 DSH 的项目级 MCP 配置通过 CLI 参数或环境变量显式传入 workspace descriptor。
2. 若宿主支持相应 MCP 版本的 Roots，可把它作为兼容性提示，但不把 Roots 当授权边界或唯一标识。MCP 的 2026 draft 已把 Roots 标记为 deprecated，因此新设计不能依赖它长期存在。
3. 两者都不存在时使用 `global`，只加载插件内置业务包。

当前 MCP 不保证提供 Codex/DSH 的任务 ID，因此 `task_id` 只能是可选字段。归档的可靠主键是 `workspace_id + occurred_at`，不是会话 ID。

若某项目需要文件级或合规级物理隔离，项目配置必须使用独立 `MYSQL_AGENT_HOME`。这会同时隔离 SQLite、连接配置、审计和 Schema 快照，不与默认共享库混用。

### 8.6 查询和归档规则

- `history_search` 默认注入当前 `workspace_id`，不允许脚本或 Agent 伪造另一个工作空间。
- `trace_search`、`usage_summary` 和 `business_candidate_analyze` 同样默认限定当前工作空间。
- 历史和 Trace 可以按 `datasource_id`、`environment` 继续过滤；默认返回当前工作空间内的全部数据源。
- 管理员跨工作空间查询是独立配置能力，不在普通业务工具中暴露 `workspace_id=*`。
- 在线表保留最近 30 天的详细 span；归档按工作空间、环境和月份生成摘要或导出文件。
- 归档任务完成并校验数量与 hash 后，才可清理在线明细。

## 9. Trace 与审计模型

现有 `execution_audit` 保留，它继续记录每次真实 SQL 执行的摘要。新增根调用和步骤表，并给 SQL 审计补充关联字段：

```text
execution_runs
  run_id                 UUIDv7，本地根调用记录 ID
  workspace_id
  task_id                nullable，宿主明确提供时才记录
  trace_id               32 位小写十六进制
  root_span_id           16 位小写十六进制
  operation_id
  operation_kind         sql | script | generic_sql
  datasource_ids / environment / connection_aliases
  pack_id / pack_version / operation_hash / script_hash
  started_at / ended_at / duration_ms / queue_duration_ms
  status / error_category / result_bytes

execution_spans
  span_id                16 位小写十六进制
  trace_id
  parent_span_id
  workspace_id
  operation_id
  datasource_id / environment / connection_alias
  step_index
  started_at / ended_at / duration_ms / queue_duration_ms
  status / error_category / result_bytes

execution_audit          现有表新增
  workspace_id
  trace_id
  span_id
  run_id
  datasource_id
  environment
```

`trace_id` 和 `span_id` 采用 OpenTelemetry/W3C 格式。现有 `execution_id` 不删除，它仍表示一条插件 SQL 审计记录；不要把 UUIDv7 强行改写成 Trace ID。

一条脚本内部的所有步骤可以准确继承同一个 `trace_id`。两个独立 MCP Server 之间只有在宿主显式传递 trace context 时才能形成精确父子关系。当前 Codex/DSH 若分别调用 MySQL 和阿里云工具但不传 context，只能按时间、workspace 和任务信息做弱关联，不能宣称属于同一条 Trace。

新增只读工具：

```text
trace_search(trace_id?, run_id?, operation_id?, since?, until?, limit?)
usage_summary(operation_id?, since?, until?, group_by?)
business_candidate_analyze(since?, until?, min_count?, limit?)
```

普通结果和审计仍不保存密码、绑定参数值、完整 SQL 或查询结果。

## 10. 高频模式发现和生产闭环

默认审计只有 SQL hash，足以统计相同调用，无法解释不同临时 SQL 是否属于同一种模式。为发现候选业务能力，增加显式开启的 `discovery` 模式：

- 保存去字面量、去注释和规范化后的 SQL template 或 fingerprint。
- 保存参数的名称、类型和是否列表，不保存参数值。
- 保存涉及的表、列、语句类型、workspace、environment、前后调用顺序和耗时。
- 不保存查询结果、请求报文、凭据、token 或原始业务 ID。
- 明细按工作空间限定保留期，默认 30 天。

闭环如下：

```text
执行与审计
    │
    ▼
按 workspace + environment 聚合 fingerprint 和调用序列
    │
    ▼
规则筛选：频次、重复步骤、失败率、耗时、返回量
    │
    ▼
LLM 生成候选 pack / SQL / script / 工具说明
    │
    ▼
静态校验 ─► 测试数据源回放 ─► 契约测试
    │
    ▼
人工评审并发布版本
    │
    ▼
对比发布前后的调用数、耗时、错误率和 token 消耗
```

LLM 负责发现和生成候选，不拥有生产发布权。生产写入必须经过静态校验、测试数据源回放、契约测试和人工审批。发布记录保存候选来源窗口、评审人、包版本和 hash，形成可回滚证据。

候选评分首期使用可解释规则，不让模型凭感觉决定优先级：

```text
score = 调用频次
      + 重复步骤数权重
      + 可减少的 MCP 往返权重
      + 失败率改善空间
      - 高基数/低复用惩罚
      - 敏感数据风险惩罚
```

## 11. 动态装载和版本切换

当前业务包只在进程启动时加载。目标实现支持安全重载，但不承诺宿主一定热刷新工具列表：

1. 发现 workspace 包目录变化。
2. 把候选版本加载到独立 registry。
3. 校验 YAML、路径、SQL、脚本、依赖图、工具命名和 hash。
4. 对脚本执行无数据库的编译/沙箱 smoke。
5. 全部通过后原子替换 registry generation。
6. 在途调用继续使用旧 generation；完成后释放。
7. 校验失败时保留 last-known-good，并写入加载事件。

只修改 SQL 或脚本实现且工具名和 Schema 不变时，可以在后续调用中使用新 generation。新增、删除工具或修改输入 Schema 时，Server 发送工具列表变更通知；若 Codex/DSH 缓存目录，仍需重新连接或新建任务。实现不能把“文件已重载”等同于“当前会话已看到新工具”。

## 12. 与未来阿里云工具的关系

阿里云能力不进入 `mysql-agent`。未来单独开发 `aliyun-agent`，使用官方 CLI/OpenAPI 和独立权限边界、进程、审计及 provider adapter。

可以复用的是脚本运行契约，而不是 MySQL 实现：

```text
@company/agent-business-runtime
  ├─ sandbox adapter (`run`)
  ├─ workspace context
  ├─ trace/audit interfaces
  ├─ pack loader contracts
  └─ capability registry contracts

mysql-agent                         aliyun-agent
  ├─ MySQL operation provider         ├─ Aliyun operation provider
  ├─ MySQL policy/pool                ├─ Profile/RAM/region policy
  └─ MySQL business packs             └─ Aliyun business packs
```

这样不会在阿里云工具中重写脚本解析、隔离和 Trace 逻辑，也不会把两个权限域塞进同一个 MCP 进程。若以后确实需要跨 provider 的单次业务工具，再单独建立 `business-agent` 编排服务，并通过窄接口调用两个 provider；这不属于首期改造。

## 13. 分阶段实施

### 阶段 A：容量、环境和工作空间基础

- 把 `DEFAULT_POOL_MAX`、`MAX_POOL_MAX`、MCP Schema 和 SQLite 默认值改为 `2`。
- 增加 migration，将已有 `pool_max > 2` 的配置收敛并递增 revision。
- 给物理连接增加 `datasource_id` 和 `environment`，旧连接按 `custom` 安全迁移。
- 实现 workspace 的环境 binding 和目标绑定工具命名。
- 支持一个 workspace 绑定多个逻辑数据源；默认通用工具和其他目标绑定工具分开注册。
- 增加 `admin`/`workspace` 运行模式；工作空间模式隐藏连接变更工具。
- 增加 `workspace_datasource_*` 高层配置工具，底层 `connection_*` 继续保留在 admin 模式。
- 增加 connection 所有权和可共享策略，区分解除 binding 与删除物理连接。
- 让业务、Schema 和默认通用查询由 workspace 注入目标，不再接收物理 alias。
- 引入 `WorkspaceContext` 和显式 workspace descriptor。
- 为现有审计补充 `workspace_id`，所有检索默认限定当前工作空间。

验收：旧状态库可原地升级；任一物理连接最多两条连接；测试和生产账号、连接池与审计保持隔离；两个工作空间的审计互不可见；单数据源和跨数据源业务工具的输入都不含 alias；缺少任一 binding 时组合工具失败关闭；工作空间看不到底层 `connection_*`，但能通过 `workspace_datasource_*` 完成受限配置；配置部分失败不会被报告为成功。

### 阶段 B：Trace 和统计

- 新增 `execution_runs`、`execution_spans` 及索引。
- 给直接 SQL、固定 SQL 和 Schema 查询统一创建 root span。
- 新增 `trace_search` 与 `usage_summary`。
- 增加保留期清理和按 workspace 导出接口。

验收：一次直接业务查询产生一条完整 root；错误、超时、取消和排队都能定位；归档数量与 hash 可核对。

### 阶段 C：脚本业务操作

- 引入 `BusinessScriptRuntime` 接口和 `run` 适配器。
- 实现业务包 v2、`kind: script`、`uses` 和依赖图校验。
- 注入 `workflow.input` 与 `operations.call`。
- 增加超时、内存、source、result、bridge 和 worker 限制。
- 为每个子操作创建 child span。

验收：脚本无法访问 Node/文件/网络/任意 SQL；并行调用不突破两条连接；相同输入得到稳定结构；子步骤可完整追踪。

### 阶段 D：候选发现和安全重载

- 增加 opt-in discovery fingerprint。
- 新增 `business_candidate_analyze`。
- 实现候选生成、测试回放、审批、发布和回滚记录。
- 实现 registry generation 原子切换与 last-known-good。

验收：失败的业务包不会污染在线 registry；模型生成内容不能跳过审批；发布前后指标可比较。

## 14. 验收指标

| 指标 | 基线 | 目标 |
| --- | --- | --- |
| 一个成熟业务诊断的 MCP 调用数 | Agent 多次调用 | 1 次 |
| 单进程、单数据源物理连接上限 | 10 | 2 |
| 生产/测试业务目标 | 一份 operation 按无关联 alias 暴露 | 一份 operation + 逻辑数据源 + 隔离 binding |
| Agent 环境选择 | 依赖 alias/描述 | 目标绑定工具；脚本不能自由切换 |
| 业务工具的数据源选择 | Agent 传入或从工具名判断 connection | workspace 自动注入唯一 binding |
| 一个工作空间多个数据源 | Agent 手动选择多个 alias | operation 声明依赖，workspace 分别绑定 |
| 连接管理可见性 | 与业务工具同一工具面 | admin/workspace 分离 |
| 工作空间新增数据源 | 新增连接后仍需手工改 binding | 一个高层工具创建并绑定，后续调用免选库 |
| 脚本可调用范围 | 无 | 仅 `uses` 白名单 |
| 工作空间审计隔离 | 无 workspace 字段 | 默认强制隔离 |
| 组合调用可追踪性 | 只有 SQL 审计 | root + child spans + SQL audit |
| 业务资产更新 | 重启加载 | 原子 generation；目录变化按宿主能力刷新 |
| 高频能力发现 | 人工观察 | workspace 级统计 + LLM 候选 + 人工发布 |

性能验收至少记录脚本冷启动、热执行 p50/p95/p99、worker 拒绝数、bridge 并发、MySQL active/queued、SQLite 写等待、结果字节数和内存峰值。业务验收必须使用代表性测试数据完成一次真实查询；仅通过 typecheck、单元测试或 MCP 握手不算业务成功。

## 15. 风险和退路

| 风险 | 控制 | 退路 |
| --- | --- | --- |
| `run` 仍较新 | 锁定版本、安全测试、Runtime 接口隔离 | 替换 QuickJS 适配器，业务包协议不变 |
| 脚本组合造成并发放大 | bridge=2、worker=2、pool=2、有界队列 | 禁用并行，只顺序执行 |
| 动态工具目录被宿主缓存 | 工具列表通知、generation 记录、明确提示重连 | 新任务/重启 MCP 连接 |
| discovery 泄露业务值 | 默认关闭、只存归一模板和参数形状、短保留期 | 关闭 discovery，仅按 operation/hash 统计 |
| workspace 来源不可靠 | 显式配置优先，不把 Roots 当授权 | 使用 `global` 或独立 `MYSQL_AGENT_HOME` |
| Agent 误用生产环境 | 独立 binding、显式 prod 工具、生产只读账号 | 工作空间不暴露 prod；写入使用独立授权入口 |
| 工作空间误加载全局连接 | 显式 descriptor、启动时唯一解析、隐藏连接管理 | 失败关闭，不退回任意 alias |
| SQLite 已写入但 workspace 文件失败 | 全量预检、临时文件、原子 rename、补偿删除 | 返回 `partial_configuration` 并保留恢复证据 |
| 模型生成错误生产脚本 | 测试回放、人工审批、版本 hash、可回滚 | 保持 last-known-good |

## 16. 参考

- [`run` introduction](https://run-sdk.dev/docs/introduction)
- [`run` sandbox model](https://run-sdk.dev/docs/foundations/sandbox)
- [`run` host functions](https://run-sdk.dev/docs/foundations/host-functions)
- [`run` resource limits](https://run-sdk.dev/docs/advanced/limits)
- [`run` concurrency](https://run-sdk.dev/docs/advanced/concurrency)
- [OpenTelemetry Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [MCP Roots 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)
- [dbt profiles and targets](https://docs.getdbt.com/docs/local/profiles.yml)
- [Google MCP Toolbox configuration](https://github.com/googleapis/mcp-toolbox#configuration)
- [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
