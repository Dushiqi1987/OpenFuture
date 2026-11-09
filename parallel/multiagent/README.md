# OpenFuture 多 Agent 协作原型（v0.4 / M0+M1+M2）

本目录是 `D:\OpenFuture-parallel\multiagent` 副本内的独立交付，对应分支 `worker/multiagent`（基础快照 `1338eca`）。目标是在不改动主线与其它并行会话的前提下，验证：

1. Super-Agent 把一个多意图请求拆成可追溯的研究、后端、前端、测试任务；
2. 每个角色有独立角色卡、工具/写入范围/记忆视图权限，运行时再次核定；
3. 调度器按依赖和并发上限启动任务，研究/后端可并行，前端等待合同，测试等待前后端产物与集成门；
4. 任务之间通过可审计收件箱通信（请求/回复/合同/评审/阻塞），重复消息幂等，循环等待被拒绝；
5. 每个任务有独立 agent 身份、独立产物版本和运行事件；失败、超时、429、停止、恢复都有明确状态；
6. 测试角色在独立集成副本上验收，冲突不覆盖，验收证据可追溯。

当前状态：**M0 已完成并通过独立验收；M1 Pi 适配与 19734 mock 已完成；M2 桌面集成契约桥（端口 19744）已完成并通过 8 项合同测试**。尚未合并主线、未推送，等待评审。

---

## 1. 环境与命令

- Node.js **>= 22.19**（本机验证：24.21.0，可直接运行 `.ts`，无需 ts-node/tsx）。
- 运行时零第三方依赖；`typescript`/`@types/node` 仅用于可选的类型检查，不属于运行依赖。
- 本机 PATH 里的 `node` 可能是旧版（14.x）。请显式使用 Node 24：

```bash
NODE24="C:/Users/杜世旗/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# 全部 M0+M1+M2 测试（37 项）
"$NODE24" --test --test-concurrency=1 parallel/multiagent/test/*.test.ts

# 仅 M0（24 项）、仅 M1（5 项）或仅 M2（8 项）
"$NODE24" --test --test-concurrency=1 parallel/multiagent/test/m0-*.test.ts
"$NODE24" --test --test-concurrency=1 parallel/multiagent/test/m1-pi.test.ts
"$NODE24" --test --test-concurrency=1 parallel/multiagent/test/m2-desktop.test.ts

# 单独启动 M1 mock Pi 端点（默认 127.0.0.1:19734；PI_MOCK_PORT 可覆盖）
"$NODE24" parallel/multiagent/scripts/mock-pi-server.ts

# 单独启动 M2 桌面契约桥（默认 127.0.0.1:19744）
"$NODE24" parallel/multiagent/scripts/desktop-bridge.ts \\
  --root <项目根目录> --port 19744 [--token <本地 token>]

# 独立验收（不 import 测试 helper，自己建临时项目并断言）
"$NODE24" parallel/multiagent/scripts/acceptance.ts
"$NODE24" parallel/multiagent/scripts/acceptance.ts --json
"$NODE24" parallel/multiagent/scripts/acceptance.ts --keep   # 保留临时运行目录便于检查

# 类型检查（需先把 tsc 装到 .scratch/tools，见下）
"$NODE24" .scratch/tools/node_modules/typescript/bin/tsc \
  -p parallel/multiagent/tsconfig.json \
  --typeRoots .scratch/tools/node_modules/@types
```

可选安装类型检查工具（不会进入交付目录）：

```bash
"$NODE24" F:/nodejs/node_modules/npm/bin/npm-cli.js \
  --prefix .scratch/tools install typescript@5.9.3 @types/node@24.19.2
```

`package.json` 的脚本假定 `node` 已是 ≥22.19；若本机默认 node 较旧，请用上面的绝对路径直接执行。M0 测试不启动网络服务；M1 测试会自动在 `127.0.0.1:19734` 启停 mock Pi 端点；M2 测试会自动在 `127.0.0.1:19744` 启停合同桥。测试只使用临时项目根目录与假凭证，不接触共享运行时目录。

---

## 2. 目录

```text
parallel/multiagent/
├─ src/core/
│  ├─ types.ts            共享类型、状态机、事件与内联常量
│  ├─ errors.ts           TeamError / TaskFailureError / 错误归一化
│  ├─ util.ts             Clock、sleep、Semaphore、哈希、ID 工厂
│  ├─ roles.ts            四张角色卡、权限交集与路径作用域
│  ├─ plan.ts             Super-Agent 规则拆解、计划校验
│  ├─ artifacts.ts        内容寻址产物、合同/测试报告校验、diff 校验
│  ├─ inbox.ts            可审计收件箱（幂等、等待、循环检测）
│  ├─ scheduler.ts        依赖就绪、并发槽、任务暂停/恢复
│  ├─ engine.ts           TeamRuntime：执行、重试、超时、停止、恢复
│  ├─ integration.ts      独立集成副本、冲突检测、集成证据
│  ├─ board.ts            面向 UI/CLI 的任务板投影
│  ├─ worker.ts           Worker / WorkerContext 接口
│  └─ simulated-worker.ts M0 四角色模拟 Pi worker
├─ src/pi/
│  ├─ types.ts            版本化 Pi session 协议与事件
│  ├─ client.ts           零依赖 HTTP/SSE 客户端
│  └─ worker.ts           PiWorker / piWorkerFactory 适配器
├─ src/desktop/
│  ├─ types.ts            桌面合同包络、记忆与测试报告类型
│  ├─ memory.ts           off/rag/wiki 记忆投影与敏感片段脱敏
│  └─ server.ts           M2 HTTP 合同桥（任务板/事件/产物/记忆/测试）
├─ test/                  node:test 测试与 fixture
├─ scripts/
│  ├─ acceptance.ts       独立验收 runner（M0）
│  ├─ mock-pi-server.ts   本地 mock Pi 端点（端口 19734）
│  └─ desktop-bridge.ts   独立桌面合同桥（端口 19744）
├─ docs/desktop-contract-v1.md   M2 合同、错误码与验收命令
├─ package.json
└─ tsconfig.json
```

运行时数据写在项目根的 `.runtime/runs/<runId>/snapshot.json`（测试/验收使用临时根目录，不写入仓库）。产物默认位于项目根 `artifacts/<runId>/<taskId>/`，集成副本位于 `integrationRoot` 下的 run 子目录。

---

## 3. 计划与权限

`SuperAgent.plan()` 先对请求做轻量意图分类，再决定单 Agent 或多 Agent：

- 只有单个问题且不需要交付物 → `single-agent`；
- 全部是问答/分析，或只有一个工作类意图 → `single-agent`；
- 多问题（研究、后端、前端、测试集成等）→ 生成计划，`sourceQuestions` 的每个问题都映射到 intent 和 task；
- 低置信度或计划校验失败 → `needs-confirmation`，不静默执行。

计划校验（`validatePlan`）覆盖：schema、ID 唯一、问题可追溯、依赖存在且无环、角色有效、记忆视图、写范围合法且属于项目策略、只读角色不得声明写范围、测试角色保留 `test` 工具、任务间写范围不重叠、产物生产者/祖先/版本可解析、预算与并发上限。

角色卡默认值（`roles.ts`）：

| 角色 | 工具 | 写范围 | 记忆 | 备注 |
| --- | --- | --- | --- | --- |
| researcher | read, network | 无 | rag | 报告必须带出处；网络受 `allowResearchNetwork` 控制 |
| backend | read, write, network, shell, git, test | `src/server/**`, `contracts/**`, `tests/server/**` | rag | 先产出并固定 OpenAPI 合同 |
| frontend | read, write, shell, test | `src/web/**`, `tests/web/**` | off | 必须消费后端合同 |
| tester | read, shell, git, test | 无 | rag | `integrationOnly`，只在集成副本上验收 |

最终权限 = 角色卡 ∩ 项目策略（工具、写路径、记忆视图），并受 `integrationOnly` 约束。裁剪项记录在 `EffectivePermissions.trimmed`，越权写入直接拒绝。`matchesScope(pattern, path)` 的参数顺序是“先模式、后路径”，`validateFileChanges` 已按此顺序调用。

---

## 4. 调度、收件箱与状态

- 并发上限默认 3（硬上限 3）；`Scheduler` 只把依赖全部满足且状态为 planned/ready 的任务交给 worker。
- worker 等待消息时任务进入 `needs_input` 并释放并发槽；收到回复后重新申请槽位，超过上限则排队唤醒。
- 每次尝试都有独立 `attempt` 和 `AbortController`；超时、用户停止、任务取消分别落为 `task-timeout` / `run-stopped` / `task-cancelled`。
- 可重试错误（如 429）按退避重试；耗尽次数或不可重试则任务失败并取消下游，失败信息交给 Super-Agent 汇总。
- 收件箱消息持久化到 run 快照：`request` 缺省携带自身 correlationId；回复/合同/评审必须显式带 correlationId；`clientMessageId` 幂等；跨项目、未注册 agent、角色歧义、循环等待均被拒绝。
- 每次运行/任务/产物/集成事件都有单调 `seq`，快照原子写入，可用于断点恢复与 UI 投影。
- `TeamRuntime.resume()` 会把中断的 running/needs_input 尝试标为 `run-recovered`，在剩余次数内重新排队；已终态的 run 直接返回结果。

### 任务状态

`planned → ready → running → (needs_input) → succeeded → reviewed → integrated`，另有 `failed` / `cancelled`。M0 中代码类任务成功后由集成门标记 `integrated`，测试任务保持 `succeeded`。

---

## 5. 产物、集成与验收

- `ArtifactStore` 按内容寻址（sha256），发布时校验合同（OpenAPI 3.x）与测试报告（JSON，status 为 passed/failed/blocked），读取时再次校验哈希。
- `validateFileChanges` 拒绝绝对路径、`..`、`.git`、重复路径、越项目/越角色写范围、超大文件、非法 baseHash。
- `IntegrationRunner` 在本 run 的独立目录中重建基线、按任务应用 diff；同一路径被两个任务写入即 `duplicate-write`，baseHash 不符即 `base-hash-mismatch`，冲突时保留首份内容并阻塞。
- 集成检查：baseline-manifest、write-ownership、artifact-hashes、contract-consistency、diffs-applied、integration-build、tester-report。状态为 `passed` / `blocked` / `failed`，并生成文件数、产物 URI、集成 revision 等证据。
- 测试任务在集成门 `passed` 之后才启动；测试失败不会删除已经集成的代码，错误和负责角色会出现在任务板与最终结果中。

---

## 6. M1 Pi 适配与 19734 mock

M1 在 M0 的 `Worker` 边界上增加真实子会话生命周期。协议是版本化的 HTTP/SSE 合同（`PI_PROTOCOL_VERSION = '1.0'`），当前由同目录的 mock 端点实现，后续可把同一 `PiSessionSpec` 映射到真实 Pi SDK，而不改调度器、权限和收件箱。

- **每任务独立 session**：`PiSessionSpec` 显式携带 `projectId / runId / taskId / agentId / attempt / baseRevision`，以及角色工具、写范围、记忆视图、模型、轮次/Token/超时预算。适配器不跨任务复用 session。
- **流式生命周期**：`POST /v1/sessions` 创建，`GET /v1/sessions/:id/events` 读取 SSE；`message.delta`/`progress` 进入任务进度，`session.completed` 返回 `TaskResult`，`session.failed` 按 retryable 映射，`session.cancelled` 与用户 abort 分离。
- **工具边界**：工具必须在 `permissions.tools` 内；`write` 目标必须通过 `WorkerContext.canWrite`；`read` 目标必须匹配项目读策略。越界请求先回 `tool.result ok=false`，再以不可重试的 `pi-tool-denied` / `pi-write-denied` / `pi-read-denied` 结束该 session。M1 只校验并回执 shell/git/network/test 请求，实际执行仍归 Pi workspace；文件变更继续由引擎的 `validateFileChanges` 二次校验。
- **跨角色消息**：Pi 的 `inbox.send` / `inbox.wait` 直接映射到 M0 收件箱；等待期间任务释放并发槽，恢复后重新占槽；请求/回复使用同一 correlationId。
- **断点恢复**：适配器把 `pi-session:<id>` 写入任务进度；可重试失败或流断开后，下一次 attempt 优先 `resume` 同一 session（失败/completed 的 409 会退化为新 session），mock 支持事件序号重放。`fail-once` 与 `disconnect-once` 两种场景分别覆盖 429 重试和断开重连。
- **mock 端点**：`scripts/mock-pi-server.ts` 监听 `127.0.0.1:19734`，提供 health、debug stats、创建/恢复/取消/输入/SSE 路由；场景包括 `simple`、`parallel`、`message-researcher`、`message-backend`、`tool-denied`、`fail-once`、`disconnect-once`、`long`。测试结束自动关闭，不复用其它会话进程。

M1 覆盖（`test/m1-pi.test.ts`）：并行双 session 与跨角色请求/回复、工具越权拒绝、429 后新 session 重试、用户停止取消长流、断流后同一 session 恢复。

## 7. M2 桌面集成契约桥与 19744

M2 把持久化 run 以版本化合同交给桌面壳，**不启动 agent、不合并、不接 UI/项目/模型中心**。实现位于 `src/desktop/`，合同说明见 [`docs/desktop-contract-v1.md`](docs/desktop-contract-v1.md)。

- **合同**：`DESKTOP_CONTRACT_VERSION = '1.0'`；`GET /v1/contract` 返回能力与端点清单；所有 JSON 响应统一 `schemaVersion/kind/projectId/runId/generatedAt/data` 包络。
- **任务板与事件**：`GET /v1/runs/:id/board` 投影四角色泳道、意图与 `question → intent → task` 可追溯链；`GET /v1/runs/:id/events` 分页重放，SSE 端点支持 `after`/`Last-Event-ID` 与 `follow=0|1`，终态自动 `stream.end`。
- **版本化产物**：列表返回 `version/kind/sha256/bytes/uri`；元数据端点校验 `verified`；内容端点通过 `ArtifactStore.read` 校验哈希后再发送，并带 `x-artifact-sha256`/`x-artifact-version` 头。
- **记忆视图**：`off` 返回空，`rag` 返回目标/问题/决策/产物摘录/失败归因，`wiki` 增加意图与任务进度；单 run 与项目级 `/v1/memory` 均带 refs 与 `sha256`。原始 Pi 对话不进入记忆，常见 token/Bearer/api-key 片段替换为 `[redacted]`。
- **测试整合**：`POST /v1/runs/:id/tests` 接收外部测试报告（status、checks、taskId、framework、evidence），校验后原子写入 `<runDir>/desktop-tests/`，不修改 RunStore 快照；`GET` 聚合已发布 `test-report` 产物与外部报告。
- **安全边界**：默认 `127.0.0.1:19744`；非回环地址必须配置 token；token 存在时数据端点要求 Bearer，`/v1/health` 与 `/v1/contract` 保持公开。
- **验收**：`test/m2-desktop.test.ts` 在 19744 起停真实 HTTP 服务，覆盖公开合同/健康、401、运行列表与任务板可追溯、事件分页与 SSE、产物哈希、记忆 off/rag/项目级、外部测试报告校验/持久化/列表、未知 run 404。

## 8. 已验证证据（2026-11-09）

测试：

```text
M0: 24 tests, 24 pass, 0 fail, ~4.0s
M1:  5 tests,  5 pass, 0 fail, ~2.7s（mock Pi 端点 127.0.0.1:19734）
M2:  8 tests,  8 pass, 0 fail, ~0.64s（合同桥 127.0.0.1:19744）
全部: 37 tests, 37 pass, 0 fail, ~7.0s
tsc --noEmit: clean
```

M1 证据要点：

```text
并行:      两个独立 session，maxActive>=2，request/reply 共享 pi:research
工具边界:  越权 write → pi-tool-denied，attempt=1，不重试
重试:      rate-limited → attempt=2，新 session 完成
取消:      long 流 + runtime.stop → run cancelled，mock cancelled>=1
恢复:      disconnect-once → pi-stream-disconnected → resume 同一 session 完成，stats.resumes>=1
```

M2 证据要点：

```text
合同:       /v1/contract 1.0，13 个端点、10 项能力可查询
任务板:     4 任务 / 4 泳道 / 4 条 traceability，backend+frontend 已 integrated
事件:       seq 从 1 连续，分页可续，SSE 以 stream.end 正常关闭，Last-Event-ID 可续传
产物:       元数据 verified=true，内容字节 sha256 与引用一致
记忆:       rag 含 goal/question/artifact 与 refs；off 为空；项目级跨 run 可查
测试整合:   非法报告 400；合法报告 201、ownerRole=tester、落盘 desktop-tests/
安全:       无 token 访问数据端点 401；未知 run 404 run-not-found
独立冒烟:   desktop-bridge.ts 在 19744 启动，health/contract/runs 均 200
```

独立验收（临时项目，四角色合成场景）：

```text
run:        completed
tasks:      4（researcher succeeded / backend integrated / frontend integrated / tester succeeded）
integration: passed, 6 files, revision 403b4dda62ca09330486bb51b85de19e8e5ab19ac28e510c949abbca21293904
messages:   6, artifacts: 6, events: 69
checks:     21/21 PASS（可追溯、研究/后端重叠、前端合同屏障、测试集成屏障、
            请求/回复 correlation 与引用、产物哈希、事件序号、并发上限、无失败任务）
```

测试覆盖：单问题单 Agent、多问题可追溯、权限裁剪/拒绝、四角色端到端、研究+后端并行、前端依赖合同、测试依赖集成门、收件箱幂等/超时/循环、同文件写冲突、429 重试、任务超时、用户停止、测试失败保留代码与归因、断点恢复、重复 run 拒绝；M1 另覆盖 Pi 并行流、工具越权、限流重试、取消与断流恢复；M2 另覆盖合同/健康公开、Bearer 401、任务板与 traceability、事件分页/SSE、产物 hash、off/rag/项目记忆、外部测试报告校验/落盘/列表与 404。

---

## 9. 限制与后续

当前边界（也是评审时需要明确的）：

- M0 的 worker 是确定性模拟实现，不是真实模型调用；不验证模型质量，只验证生命周期、依赖、权限、消息和证据链。
- M1 当前实现的是版本化 HTTP/SSE 适配器与本地 mock，不直接依赖 Pi SDK；真实 Pi 接入点、SDK 版本差异和实际工具沙箱仍需在主线评审后验证。
- M1 对 shell/git/network/test 工具只做权限校验与回执，不在适配器内实际执行；真实执行必须发生在 Pi workspace，文件变更仍由引擎按 diff 再校验。
- 规划器是规则/关键词实现，不具备语义理解；复杂需求应走 `needs-confirmation` 或后续 Super-Agent 模型。
- 存储为单机 JSON 快照，未实现多进程锁/数据库；并发限制在单 runtime 进程内。
- 产物是文本/JSON，未做内容安全扫描；集成构建检查目前验证 JSON 可解析与清单一致，不是完整编译。
- M2 只服务单个项目根；SSE 的 `follow=1` 是 100ms 快照轮询，不是运行时实时总线；外部测试报告不会自动改变任务状态，也不替代独立验收。
- 合同桥默认无 TLS、无多用户鉴权；token 只用于本地回环边界，不应暴露到公网。
- 未合并主线、未推送；不修改 `src/`、根配置或其它会话目录。

后续增量：

- **M1（端口 19734）**：已完成 mock 端点上的并行流式、失败重试、取消、工具范围、跨角色消息与断点恢复；下一步在主线评审后替换为真实 Pi session 适配。
- **M2（端口 19744）**：已完成合同桥、任务板/事件/产物/记忆/测试整合与 8 项合同测试；下一步在主线审查后接入桌面壳的真实项目/模型中心，不在本副本内实现 UI。
