# OpenFuture 多 Agent 协作原型（v0.4 / M0）

本目录是 `D:\OpenFuture-parallel\multiagent` 副本内的独立交付，对应分支 `worker/multiagent`（基础快照 `1338eca`）。目标是在不改动主线与其它并行会话的前提下，验证：

1. Super-Agent 把一个多意图请求拆成可追溯的研究、后端、前端、测试任务；
2. 每个角色有独立角色卡、工具/写入范围/记忆视图权限，运行时再次核定；
3. 调度器按依赖和并发上限启动任务，研究/后端可并行，前端等待合同，测试等待前后端产物与集成门；
4. 任务之间通过可审计收件箱通信（请求/回复/合同/评审/阻塞），重复消息幂等，循环等待被拒绝；
5. 每个任务有独立 agent 身份、独立产物版本和运行事件；失败、超时、429、停止、恢复都有明确状态；
6. 测试角色在独立集成副本上验收，冲突不覆盖，验收证据可追溯。

当前状态：**M0 已完成并通过独立验收**；M1（Pi 子会话适配）与 M2（桌面集成契约）在本目录继续增量实现。

---

## 1. 环境与命令

- Node.js **>= 22.19**（本机验证：24.21.0，可直接运行 `.ts`，无需 ts-node/tsx）。
- 运行时零第三方依赖；`typescript`/`@types/node` 仅用于可选的类型检查，不属于运行依赖。
- 本机 PATH 里的 `node` 可能是旧版（14.x）。请显式使用 Node 24：

```bash
NODE24="C:/Users/杜世旗/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# 全部 M0 测试（24 项）
"$NODE24" --test --test-concurrency=1 parallel/multiagent/test/*.test.ts

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

`package.json` 的脚本假定 `node` 已是 ≥22.19；若本机默认 node 较旧，请用上面的绝对路径直接执行。M0 没有启动任何网络服务，端口 19734/19744 留给 M1/M2。

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
├─ test/                  node:test 测试与 fixture
├─ scripts/acceptance.ts  独立验收 runner
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

## 6. 已验证证据（2026-11-09）

测试：

```text
24 tests, 24 pass, 0 fail, ~4.0s
tsc --noEmit: clean
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

测试覆盖：单问题单 Agent、多问题可追溯、权限裁剪/拒绝、四角色端到端、研究+后端并行、前端依赖合同、测试依赖集成门、收件箱幂等/超时/循环、同文件写冲突、429 重试、任务超时、用户停止、测试失败保留代码与归因、断点恢复、重复 run 拒绝。

---

## 7. 限制与后续

M0 的边界（也是评审时需要明确的）：

- worker 是确定性模拟实现，不是真实模型调用；不验证模型质量，只验证生命周期、依赖、权限、消息和证据链。
- 规划器是规则/关键词实现，不具备语义理解；复杂需求应走 `needs-confirmation` 或后续 Super-Agent 模型。
- 存储为单机 JSON 快照，未实现多进程锁/数据库；并发限制在单 runtime 进程内。
- 产物是文本/JSON，未做内容安全扫描；集成构建检查目前验证 JSON 可解析与清单一致，不是完整编译。
- 未合并主线、未推送；不修改 `src/`、根配置或其它会话目录。

后续增量：

- **M1（端口 19734）**：PiTaskRunner 为每个子任务创建独立 Pi session/上下文，向本地 mock Pi 端点验证并行流式、失败、取消、工具范围、跨角色消息和断点恢复。
- **M2（端口 19744）**：桌面集成契约，交接任务板事件、项目级记忆视图、版本化产物和测试整合接口；不直接接 UI/项目/模型中心，等待主线审查。
