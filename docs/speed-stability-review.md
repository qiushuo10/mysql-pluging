# MySQL Agent Plugin 速度与稳定性评审

状态：评审结论已合并到第一版实现
更新日期：2026-08-26

## 1. 结论

现有方向可以保留：TypeScript、stdio MCP、`mysql2` 连接池、Cockatiel 弹性策略、SQLite 本地状态和启动时加载的本地业务 SQL 包都适合当前版本。

第一版在实现前完成了以下五项调整，用来避免不可取消的排队、错误重试、SQL 语义变化、误伤大量数据或连接数失控：

1. 把等待队列从 `mysql2` 移到 Cockatiel bulkhead。
2. 收紧读请求发送后的自动重试。
3. AST 只做校验，不重新生成任意 SQL。
4. 给通用 `UPDATE` 和 `DELETE` 增加影响行数上限。
5. 按 MCP 进程数计算总连接预算，不能假定多个 Codex Agent 一定共享一个进程。

## 2. 必须修改

### 2.1 避免不可取消的连接池排队

当前设计使用：

```ts
waitForConnections: true,
queueLimit: poolMax * 4
```

`mysql2` 的内部等待队列只有数量上限，没有单项等待超时和 AbortSignal。Cockatiel 可以让外层调用超时，但底层 `getConnection()` 仍可能留在队列里；它稍后拿到连接时会产生迟到回调或连接泄漏风险。

推荐改为：

```ts
mysql2 pool:
  waitForConnections: false
  connectionLimit: 10
  queueLimit: 0

Cockatiel bulkhead:
  concurrency: 10
  queue: 40
  queue_timeout_ms: 1000
```

Cockatiel 负责有界、可取消的等待。进入 bulkhead 后再调用 `pool.getConnection()`，此时 mysql2 池不应出现正常排队。队列满或等待超时返回稳定的 `busy` 错误，不归类为数据库断线，也不触发熔断。

### 2.2 只重试能证明幂等的读取

“SQL 已发送后断链就自动重试一次”对任意 `SELECT` 过宽。锁定读、写文件、用户变量、带副作用的函数或无法识别的 MySQL 扩展都不能按普通幂等读取处理。

第一版采用以下边界：

- 获取连接前失败：查询和写入都可以重新获取一次，因为 SQL 尚未发送。
- 通用 `sql_query` 发送后断链：默认不自动重试。
- 业务包固定读取：只有配置声明 `retry_safe: true` 且启动校验通过，发送后才重试一次。
- 写入发送后：永不自动重试，继续返回 `write_outcome_unknown`。

这会减少一次“看起来很智能”的恢复，但能避免隐蔽的重复副作用。Agent 仍可在收到明确的查询失败后重新决定是否再次查询。

### 2.3 AST 校验不能改变 SQL 语义

当前设计计划把 SQL 转成 AST、修改 AST，再重新生成 SQL。该过程可能改变 MySQL 扩展语法、注释、优化器 hint、CTE、UNION 或占位符位置。

推荐边界：

1. 命名参数 lexer 把参数编译为 `?` 和有序值数组。
2. parser 只判断单语句、根类型、访问表、锁定读、输出文件、`WHERE` 和 `LIMIT`。
3. 通过校验后，执行原始编译 SQL，不执行 `sqlify()` 生成的 SQL。
4. 通用根 `SELECT` 必须自带 `LIMIT`，且不得高于服务端上限；缺失时返回可修正的参数错误。
5. `SHOW`、`DESCRIBE` 和 `EXPLAIN` 使用独立白名单。
6. parser 不认识的语法失败关闭，不退化到正则直接执行。

业务 SQL 在版本化业务包里固定，可以在启动和发布前验证 `LIMIT`；因此这个限制主要影响通用兜底查询。

### 2.4 通用写入需要影响行数保险

只检查存在 `WHERE` 不够，`WHERE 1=1` 或条件写错仍可能修改整张表。

推荐为通用 `sql_execute` 增加服务端固定上限：

- 通用 `UPDATE`、`DELETE` 默认最多影响 100 行。
- Agent 可以传入更小的 `max_affected_rows`，不能提高服务端上限。
- 执行器开启事务，执行后检查 `affectedRows`；超过上限立即回滚并返回 `result_limit`。
- 提交失败或连接中断仍按 `write_outcome_unknown` 处理。
- 需要超过 100 行的业务操作必须写成固定业务包工具，在配置中声明并评审上限。

这会给通用更新和删除增加一次事务提交往返，但写操作的正确性优先于这几毫秒。

### 2.5 总连接数按进程计算

连接池只在一个 MCP 子进程内共享。总连接上限为：

```text
MCP 进程数 × 已使用的连接别名数 × 每别名 pool_max
```

DSH 当前的 MCP Client 会为一个插件实例维护一个受监督的 stdio 子进程。Codex 公开文档没有给出“所有任务共享同一 stdio MCP 进程”的稳定保证，因此第一版不能把该假设写成容量承诺。

推荐第一版继续使用 stdio，不先增加本地 daemon；同时：

- 每个数据源的 `pool_max` 默认且最大为 10。
- 物理连接按需建立，启动时不预建 10 条；默认 `maxIdle` 为 2，`idleTimeout` 为 60 秒。
- 在 Codex 同时启动 1、5、10 个任务时实测 MCP 进程数和 MySQL 连接数。
- 如果多个 MCP 进程使同一数据源的总连接数超过测试库预算，再升级为单一本地 daemon + Unix socket/Streamable HTTP，在整台机器上共享同一个 10 连接池。

### 2.6 一个子进程可以承接并发请求，但必须有界

一个 MCP Client 实例启动一个 stdio 子进程，该子进程承接这个 Client 后续的全部工具调用。业务 SQL 的数量不会增加子进程数量；30 条或 100 条业务 SQL 只是同一进程中注册了更多处理器。

“一个子进程”不等于“所有请求串行执行”。MCP TypeScript SDK 会异步分发每个请求，Node.js 事件循环可以同时等待多个 MySQL I/O；真正允许进入数据库的并发量由连接别名级 Cockatiel bulkhead 和 `mysql2` pool 共同限制。

每个连接别名单独维护：

```text
active = pool_max = 10
queued = pool_max * 4 = 40
queue_timeout_ms = 1000
```

处理规则：

1. 前 10 个请求进入 MySQL 执行。
2. 后 40 个请求在 Cockatiel 中按 FIFO 等待。
3. 第 51 个及以后的请求立即返回 `busy`；已排队请求等待超过 1 秒也返回 `busy`。
4. `busy` 不触发熔断，不自动扩容连接池，也不自动启动新子进程。
5. 读取可依据 `retry_after_ms` 由 Agent 决定是否重试；写入不能因为 `busy` 之外的未知结果自动重试。
6. 不同连接别名使用独立 bulkhead 和连接池，避免一个慢库占满所有数据库执行槽位。

第一版不实现多 worker 子进程。MySQL 调用主要是异步网络 I/O，过早增加 worker 会成倍放大连接池、SQLite 并发写入和故障恢复复杂度。只有压测证明单进程 CPU（SQL 解析、参数校验或大结果序列化）成为瓶颈后，才评估 worker 或单一本地 daemon。

## 3. 建议调整

### 3.1 写操作每次执行驱动 ping

按“空闲超过 30 秒才 ping”需要额外维护连接最后使用时间，而且不能消除 ping 成功后立刻断线的竞态。第一版可以采用更简单的规则：

- 读取不执行额外 ping，保持热路径低延迟。
- 每次写入借到连接后执行一次驱动 `ping()`。
- ping 失败时 SQL 仍是 `NOT_SENT`，销毁连接并重新获取一次。

写入多一次往返，但能显著减少使用陈旧空闲连接时出现的未知结果。

### 3.2 限制 prepared statement 缓存

Agent 可能生成大量结构不同的临时 SQL。`mysql2.execute()` 会按物理连接缓存 prepared statement。连接配置应设置较小的 `maxPreparedStatements`，建议从 256 开始，通过压测调整，避免长期运行后占用过多客户端内存和 MySQL statement handle。

### 3.3 SQLite 启动和写入边界

两个宿主可能同时启动并执行 migration。实现必须：

- 使用 Node.js 24 LTS 作为发布基线，Node.js 26 只作为兼容测试目标。
- 使用 `BEGIN IMMEDIATE` 串行 migration，并在事务内检查 schema version。
- 开启 WAL、`busy_timeout=5000` 和短事务。
- 配置写入必须等待提交成功。
- 执行历史可以异步批量写入，但必须明确是 best-effort history，不称为强审计；队列满时只丢历史记录，不影响数据库调用结果。

选择内置 `node:sqlite` 可以避免原生扩展安装和 Node ABI 问题。其 API 仍处于 release-candidate 稳定级别，因此需要把 SQLite migration、并发和损坏恢复加入兼容测试矩阵。

### 3.4 防止池化连接残留状态

通用工具继续禁止 `SET`、`CALL`、DDL、临时表、多语句、跨调用事务和锁定读。若以后增加代码实现的复合事务，必须在 `finally` 中完成 commit 或 rollback；rollback 失败时销毁连接，不能 release 回池。

第一版不启用每次 release 都执行 `COM_RESET_CONNECTION`。它会增加往返并清空 prepared statement 状态。通过语句白名单和失败时销毁连接保持隔离；故障测试如果证明仍有状态污染，再开启 mysql2 的 `resetOnRelease`。

### 3.5 按数据源和业务域收敛业务 SQL 工具

30 不是 MCP 的技术上限，而是模型选择准确率、工具描述占用和首轮延迟的治理阈值。第一版采用分层目录，不走两个极端：既不无限保持“一条 SQL 一个工具”，也不把全部能力塞进一个无类型的 `business_execute(operation_id, parameters)`。

当前规则：

- 业务操作默认按“数据源 + 业务域 + 读写通道”收敛，例如 `business__auto-fat__order__read`。
- 单个分组工具最多包含 15 个 operation；超过后按子域继续拆分。
- 只有确需顶层独立入口的高频操作才显式设置 `exposure: 'direct'`，direct 工具全局最多 30 个。
- 同一个业务操作只出现在一个入口中，避免模型在重复能力之间犹豫。

域工具仍然保持强类型，而不是让 Agent 拼装 SQL：

```json
{
  "operation": "find_order_by_no",
  "input": {
    "order_no": "SO202608260001"
  }
}
```

服务端先校验 `operation` 枚举和模型可见的 `input` 联合，再用所选操作的独立 schema 严格复验 `input`，最后映射到启动时业务包中固定的 SQL、参数绑定、只读或写入策略、超时和影响行数上限。这样减少对外工具数，同时保留每项业务操作的参数约束。

## 4. 仍需产品确认或实测

| 项目 | 当前建议 | 冻结条件 |
| --- | --- | --- |
| stdio 还是单一本地 daemon | 第一版 stdio | 实测 Codex 任务并发下的进程数和总连接数 |
| 业务工具数量 | 默认按数据源、业务域和读写通道收敛；必要时显式 direct | 用 30、60、100 个真实业务操作测试模型选中率、首轮延迟和 schema 大小 |
| 执行历史 | best-effort，不阻塞调用 | 明确不承担合规审计职责 |
| DSH 写操作审批 | 服务端规则始终生效 | 实测宿主能否提供不可伪造的审批事件；否则不能声称已获确认 |
| `node-sql-parser` 兼容性 | fail closed | 用目标 MySQL 版本的真实 SQL 语料跑兼容测试 |
| 熔断阈值 | 连续 3 次连接失败，冷却 5–30 秒 | 故障注入证明不会因单条慢 SQL或语法错误打开 circuit |

## 5. 速度验收门槛

速度指标分开计算宿主启动、插件开销、连接建立和 MySQL 执行，不能只看总耗时：

| 指标 | 第一版门槛 |
| --- | --- |
| MCP 冷启动到 `tools/list` 完成 | p95 小于 500 ms |
| 热调用插件开销，不含 MySQL 执行 | p95 小于 10 ms |
| 有空闲连接时的池获取 | p95 小于 5 ms |
| 同一固定业务 SQL 的热调用 | 比旧 CLI p95 至少降低 30% |
| 过载时的队列等待 | 不超过 1000 ms，随后快速失败 |
| 1、10、20、50、60 并发 | 分别记录 p50、p95、p99、错误率、排队数和实际连接数 |

旧 CLI 每次调用都新建并关闭 MySQL 连接。新插件的主要性能收益应来自常驻进程和连接复用，而不是减少安全校验。

## 6. 稳定性验收门槛

发布前至少通过：

1. 10 并发连续运行 30 分钟，无连接泄漏、未处理异常和 SQLite lock error。
2. MySQL 重启、TCP reset、空闲连接被服务端关闭后，下一次符合规则的调用恢复。
3. 连接池满时取消 100 次等待，MySQL 活跃连接数和队列长度回到基线。
4. 通用查询发送后断链没有隐式第二次执行。
5. 写入在发送前失败、明确失败、明确提交和结果未知四种状态均可复现。
6. 超过 `max_affected_rows` 的更新或删除全部回滚。
7. 两个 MCP 进程同时 migration、增改连接和写历史，没有配置丢失。
8. MCP 子进程连续崩溃 10 次时，DSH 按有界退避重启且不产生重叠子进程。
9. 日志、MCP 结果和 SQLite history 均不记录密码或参数值。
10. 使用 100 条真实目标库 SQL 验证 parser；无法识别的 SQL 全部失败关闭。
11. 对单一连接别名发起 60 个并发请求，验证最多 10 个执行、40 个排队，其余快速返回 `busy`，且物理连接数不超过 10。
12. 使用 30、60、100 个业务操作做工具选择基准，验证模型不会把相近 operation 或读写入口选错。

## 7. 架构冻结建议

先按第 2 节完成设计修订，再做一个只包含 `connection_add`、`sql_query`、连接池和故障注入的性能尖刺。该尖刺同时验证 Codex/DSH 子进程数量、mysql2 池取消、SQLite 并发和真实查询延迟。数据达标后再实现通用写入和业务 SQL registry。

这样可以先证明最核心的“常驻进程 + 连接复用”确实更快，也能在写能力加入前解决连接泄漏和错误重试。
