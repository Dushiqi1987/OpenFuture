# Dreaming 并行线：会话沉淀原型

本目录是 OpenFuture Dreaming 并行开发线的独立交付，基于工作区种子 `1338eca`（分支 `worker/dream`）。它是**可运行的本地原型 + 契约实现**，尚未接入主线，也未推送或合入 `main`。

- 只写本目录：`parallel/dream/`。
- 零运行时依赖：Node.js ESM + JSDoc，Node `>=22`。
- 使用合成 Pi 会话、本地确定性 mock 模型、假 bearer token、隔离临时目录。
- 测试端口：`19733`；mock 模型只监听 `127.0.0.1`。
- 后台调度器默认关闭；即使打开也只会停在 `review`，绝不自动发布。

## 1. 已实现范围

| 阶段 | 实现 |
| --- | --- |
| Ingest | 授权且完成的 Pi 会话、文档/Wiki 材料；保留原始会话；过滤系统提示、reasoning、旧注入、草稿分支、撤销消息、重复工具结果；同一内容幂等，内容变化递增 revision |
| Light | 从证据抽取候选偏好/决策/纠正/开放问题，校验真实证据、来源 revision、角色 basis；隔离注入文本 |
| REM | 按主题跨会话聚类，保留双方值、来源、时间、反例；纠正可消解冲突，未消解冲突进入计划 |
| Deep | 结构化 `keep/fix/merge/drop/promote`，逐 op 校验目标 revision、证据、冲突覆盖、类型 basis、删除比例；模型只建议 |
| Promote/Publish | 展示 diff + L3 预览；发布人显式批准且 token 绑定 `planHash`；校验仍基于同一 base revision；原子写版本 + 审计，再切换 active |
| Verify | 发布前引用/删除比例/重复/L3 预算检查；发布后重新验证实体、引用、撤销、L3 漂移；回答引用校验；失败可从 checkpoint 重试 |
| 运行时 | 单次/每日调用与 token 预算、可取消信号、按阶段 checkpoint、失败重试、降级标记、调度器默认关闭 |

## 2. 入口与调用顺序

```js
import {
  DreamingPipeline, EvidenceRegistry, FileDreamStore, ModelClient
} from './parallel/dream/src/index.mjs'

const store = new FileDreamStore({ root: '/isolated/data/root' })
const registry = new EvidenceRegistry(projectId)
const pipeline = new DreamingPipeline({
  store,
  registry,
  model: new ModelClient({
    baseUrl: 'http://127.0.0.1:19733',
    token: fakeRuntimeToken
  }),
  policyProvider: async ({ projectId }) => ({
    authorized: true,
    projectId,
    revokedSourceIds: []
  }),
  l3Budget: { maxLines: 40, maxBytes: 4096, maxTokens: 800 }
})

const job = await pipeline.start({
  projectId,
  sessions: [authorizedCompletedSession],
  materials: [optionalDocumentOrWiki],
  trigger: 'manual'
})
// job.status === 'review' && job.plan.status === 'pending-approval'

const published = await pipeline.publish(job.id, {
  approvedBy: 'publisher@example.invalid',
  approvalToken: job.plan.planHash
})

const l3 = await pipeline.getL3(projectId)
const answer = await pipeline.answer({ projectId, query: 'review queue' })
const verification = await pipeline.verifyProject(projectId)
```

`pipeline.start()` 返回 `review` 作业；`pipeline.publish()` 是原型的提交路径。主线接入时应由主线持有事务和 read-side 校验，worker 只产生计划/结果（见第 7 节）。

### 主要 API

- `new EvidenceRegistry(projectId)`：`addSource`、`addEvidence`、`addSessionMessage`、`revokeSource`、`verifyRef`、`listEvidence`。
- `ingest({ registry, projectId, sessions, materials, originalsDir })`：底层导入，也可由 pipeline 调用。
- `new DreamingPipeline(options)`：`start`、`getJob`、`listJobs`、`run`、`resume`、`cancel`、`reject`、`publish`、`rollback`、`getL3`、`answer`、`verifyProject`。
- `new FileDreamStore({ root })`：文件版本库；`getActive`、`getVersion`、`listVersions`、`commit`、`readAudit`、`simulateCrashAfterVersion`。
- `new ModelClient(...)` / `HeuristicModel` / `FallbackModel`：模型适配；真实 HTTP provider 失败时可由 fallback 返回 `degraded: true`。
- `new DreamingScheduler(...)`：显式注册且授权后才会调度；`enabled` 默认 `false`。
- `startMockModelServer()`：仅用于本地测试，默认端口 `19733`，token 运行时生成。

## 3. 输入契约

### 证据身份

所有结论必须引用不可变证据：

```js
{
  projectId, sourceId, sourceRevision, evidenceId,
  locator: { type: 'page' | 'lines' | 'chars' | 'message', ... },
  quote, quoteHash
}
```

本 worker 额外支持 `message` locator（`sessionId/messageId/charRange`）用于 Pi 消息；主线共享类型需要接纳该扩展，或在 adapter 中映射为 chars + message id 双重定位。

### 会话输入

调用方提供已完成且授权的会话：

```js
{
  sessionId, sourceId, projectId, status: 'completed',
  authorization: { authorized: true, projectId, allowedBranchIds: [] },
  branches: [{ id: 'main', status: 'completed' }],
  messages: [
    { id, role: 'user' | 'tool' | 'assistant', text, branchId?, kind?, injected?, revoked?, toolCallId? }
  ]
}
```

被排除的内容不会进入证据表：未授权/跨项目/未完成会话、系统提示、reasoning/thought、旧注入、草稿或未授权分支、撤销消息、重复工具结果。

### 版本与 L3

版本包含 `entries`、`conflicts`、`l3 {text,stats,hash}`、`approval`、`publishId`、`planHash`、父版本。L3 只渲染 `promoted === true` 且当前断言证据仍可读的条目，三元组预算默认 `40 行 / 4096 bytes / 800 tokens`；超预算会阻塞计划，而不是静默截断。

条目区分：

- `evidenceRefs`：全部 provenance（历史来源，撤销后会被过滤但不会让条目复活）。
- `assertionRefs`：支撑当前值的证据；**任一断言证据失效，条目即不可读**。这是撤销和 rollback 不复活事实的核心。

## 4. Verify 与安全不变量

- 模型输出只是建议；候选/ ops / payload 全部重新校验，伪造 evidence id、过期 revision、注入文本会被拒绝。
- 发布要求 `{ approvedBy, approvalToken === plan.planHash }`，并再次检查 base revision、所有 op 证据、条目断言证据、冲突覆盖、删除比例和 L3。重复 publishId 幂等；同一 plan 重放不会产生第二个版本。
- 版本写入顺序：临时文件 + fsync + rename → audit → active pointer；崩溃后可恢复孤立版本；`simulateCrashAfterVersion` 覆盖该路径。
- `rollback` 不是“恢复旧快照”：它从目标版本复制条目，再用**当前** registry 过滤断言证据，生成新版本（`kind:'rollback'`）。因此已撤销事实不会因回滚复活。
- `getL3` / `answer` 每次从当前 registry 重建，撤销后立即消失；`verifyProject` 报告 invalidated 条目、L3 漂移和冲突状态。
- 回答的 citations 还需通过 `verifyAnswerCitations`；`answer.citationCheck.ok` 为 false 时调用方不应把答案当作可信引用。
- 调度器默认关闭；每轮重新读取项目策略、并发/间隔/每日任务限制，使用取消信号；不会自动批准或发布。

## 5. 运行与验收证据

环境：Windows，Node.js **v22.20.0**（主机默认 `node` 为 v14，不能运行本原型；本次实际使用
`/f/VibelutionRuntimes/node-v22.20.0-win-x64/node.exe`）。

### 5.1 全部测试

```bash
cd parallel/dream
node --test test/acceptance.test.mjs test/budget.test.mjs test/http-model.test.mjs \
  test/ingest.test.mjs test/ops.test.mjs test/publishing.test.mjs \
  test/scheduler.test.mjs test/verify.test.mjs
```

实际结果（2026-11-09，本机 Node 22.20.0）：

```text
1..24
# tests 24
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1399.565
```

按文件：

| 测试文件 | 覆盖 | 通过 |
| --- | --- | --- |
| `test/acceptance.test.mjs` | B3 全链路 | 1/1 |
| `test/ingest.test.mjs` | 授权/排除/幂等/新 revision/原始会话落盘 | 4/4 |
| `test/ops.test.mjs` | 假证据/重复目标/改主题/删除比例/冲突覆盖 | 3/3 |
| `test/publishing.test.mjs` | 批准/幂等/陈旧计划/重载/崩溃恢复 | 4/4 |
| `test/verify.test.mjs` | 假证据/过期 revision/L3 预算 | 3/3 |
| `test/budget.test.mjs` | 单次与每日预算/重试耗尽/取消 | 4/4 |
| `test/http-model.test.mjs` | 19733 端口 mock、鉴权、HTTP 全链路 | 1/1 |
| `test/scheduler.test.mjs` | 默认关闭/未授权/间隔/每日限制/只到 review | 4/4 |

### 5.2 B3 验收场景

`test/acceptance.test.mjs` 与 `node tools/demo.mjs` 使用合成数据：

- 会话 1（授权、完成）：Markdown 导出决策、local-first 偏好、开放问题、工具事实、release channel；夹带 system prompt、reasoning 纠正、注入消息、重复工具结果、撤销消息、草稿分支。
- 会话 2（授权、完成）：把 review queue 纠正为 cloud-first，同时提出 JSON 导出冲突。
- 未授权会话/跨项目会话/未完成会话：包含 `UNAUTHORIZED_LEAK_SENTINEL`，必须不出现。
- 材料：文档 lines/page locator、Wiki chars locator。

验证过的行为：旧版本在批准前可用；错误批准 token 被拒绝；批准后新版本生效；纠正覆盖旧偏好；导出冲突保留双方 provenance；撤销会话 1 后相关条目不可读；回滚到 revision 2 后 local-first 与 cloud-first 都不复活；审计包含 init/publish/rollback。

### 5.3 Demo（端口 19733）

```bash
cd parallel/dream
node tools/demo.mjs
```

实际输出摘要（token 为运行时假凭证，不落盘）：

```text
{"event":"mock-model","port":19733,"url":"http://127.0.0.1:19733","tokenLength":24,...}
{"event":"round-1","status":"review","planStatus":"pending-approval","ops":5,"rejectedOps":0,"candidates":5,"degraded":false}
{"event":"publish-1","status":"applied","revision":2,"verificationOk":true,...}
{"event":"answer-1","matched":true,"answer":"- review queue: local-first [mem_...]","citationsOk":true}
{"event":"round-2","status":"review","planStatus":"pending-approval","ops":6,...}
{"event":"publish-2","status":"applied","revision":3,"answer":"- review queue: cloud-first [mem_...]","citationsOk":true}
{"event":"revoke-source-1","verifyOk":false,"invalidated":4,...}
{"event":"rollback","status":"applied","revision":4,"kind":"rollback","excluded":5,...}
{"event":"audit","actions":["init:r1","publish:r2","publish:r3","rollback:r4"]}
{"event":"demo-ok",...}
```

单独启动 mock 模型供手工调试：

```bash
node tools/mock-model.mjs
# 或：MOCK_MODEL_PORT=19733 MOCK_MODEL_TOKEN=test-token node tools/mock-model.mjs
```

`package.json` 的脚本（本机 PATH 中没有 npm，本次一律用上面的 `node --test` 直接执行）：

```bash
npm test          # 使用显式文件列表，避免 Node 22.20 把目录当模块
npm run test:http # 只跑 19733 HTTP 链路
npm run demo
npm run mock-model
```

没有安装/运行任何额外 npm 依赖；`node_modules` 不需要。

## 6. 目录

```text
parallel/dream/
  package.json
  README.md
  types.d.ts
  src/
    errors.mjs util.mjs evidence.mjs sessions.mjs heuristics.mjs
    model-client.mjs rem.mjs candidates.mjs l1.mjs l3.mjs ops.mjs
    plan.mjs store.mjs publishing.mjs verify.mjs budget.mjs
    pipeline.mjs scheduler.mjs mock-server.mjs synthetic.mjs index.mjs
  test/
    helpers.mjs acceptance.test.mjs ingest.test.mjs ops.test.mjs
    publishing.test.mjs verify.test.mjs budget.test.mjs
    http-model.test.mjs scheduler.test.mjs
  tools/
    demo.mjs mock-model.mjs
```

## 7. 待接入项（未完成，不应视为已交付主线）

1. **共享协议映射**：本 worker 的 DTO 与主线 `DreamJob/DreamOp/Version` 共享类型尚未逐字段对齐；`fix/promote` 的 `payload.subject/value` 和 `meta.assertionEvidenceIds` 是本原型扩展，需要主线 adapter 显式映射或扩展共享类型。
2. **Pi 会话读取器**：目前调用方传入已完成会话；尚未实现从 Pi 数据库/导出文件增量读取、分支图解析、真实会话 ID 映射。
3. **主线提交事务**：原型 `FileDreamStore` + `publish` 是本地参考实现，不是主线的版本库/事务；接入时 read-side 授权、冲突检查和 active 切换必须由主线执行。
4. **UI 审批与 diff 展示**：批准 token 由调用方传入；尚未接主线的发布人身份、审批 UI、diff/L3 预览展示。
5. **真实模型 provider**：mock 是确定性启发式，不是 LLM；需要真实 provider 适配、超时/限流/成本计量，并保留 fallback 的 `degraded` 可识别状态。
6. **Wiki 写入**：只生成 `proposeWikiDraft` 草稿，未写 Wiki，也未做 Wiki 页面级 diff/审批。
7. **调度器接线**：`DreamingScheduler` 默认关闭，未接应用生命周期、持久化任务队列或跨进程锁；当前锁仅进程内。
8. **共享证据 locator**：`message` locator 是本原型扩展；共享类型目前是 page/lines/chars，需扩展或 adapter 降级。
9. **多进程并发**：文件 store 的锁只覆盖单进程；多实例同时 publish 需要数据库事务/CAS 或文件锁增强。
10. **真实数据迁移/回滚演练**：仅在合成数据上验证；未对生产规模会话、超大 L3、真实撤销审计和已有主线版本做兼容性测试。

## 8. 设计取舍与已知限制

- **零依赖、单文件模块**：优先本地可审计与离线可运行；没有用数据库/队列/向量库，REM 采用确定性主题分组而非语义聚类。
- **断言证据 vs provenance**：条目可读性取决于当前断言证据；撤销历史来源不会让条目假活。未消解冲突会保留在版本中，既有已批准值仍可被读取，直到发布人批准消解计划。
- **发布是计划绑定**：批准 token 即 `planHash`；任何显示文本/条目字段/payload 改动都会改变 hash 并导致拒绝。重复 publishId 只允许同一 plan。
- **回滚是新版本**：审计永远追加，不删除历史；回滚目标本身可能因当前撤销而部分失效，返回 `excluded` 并在 L3 中不出现。
- **模型不可信**：adjudicator/ extractor 输出不直接写库；`model-statement` 不能单独形成偏好/决策/规则/教训，必须由用户/tool 证据支撑。
- **调度不是自动发布**：scheduler 只创建 `review` 作业；发布仍需人工批准。

## 9. 本地分支与合入状态

- 工作区种子：`1338eca`。
- 当前分支：`worker/dream`。
- 本增量只应包含 `parallel/dream/`；未修改根目录的 `src/`、根配置或其他工作区。
- 未推送远端，未自行合入主线。等待 Codex 审查，由主线串行合入。
