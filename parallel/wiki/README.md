# OpenFuture 并行线 Wiki 主题编译

面向固定版 `@zosmaai/pi-llm-wiki@0.12.5` 的 stdio 适配器与独立验收套件。它把多份已捕获资料编译成一个带逐段出处的主题草稿，支持发布前 diff、单来源新增/替换/撤销的增量重编译，以及只返回本项目已发布且活跃页面的检索/读取过滤。发布必须绑定一份审核计划；来源替换/撤销后旧主题页转为 `stale`，读取与检索会按当前活跃 packet/revision 校验证据；路径校验在词法边界之外再做 realpath 物理边界检查。

- 状态：本地实现、stub 验收与真实 0.12.5 验收均通过；等待 Codex 审查，由主线串行合入。
- 分支：`worker/wiki`，基于种子 `1338eca68e438900f5509316ce4fb31c05a6a911`。
- 可写交付目录：`parallel/wiki/`。本目录之外的 `src`、根配置和其他工作区未改动。
- 不推送、不自行合入主线。

## 1. 入口与命令

需要 Node.js >= 22。本机 PATH 中的 `node` 可能是旧版本，验收使用打包运行时：

```bash
NODE="/c/Users/杜世旗/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
cd parallel/wiki

# 运行时与隔离 vault 自检（默认 stub；加 --server 可指向真实包）
"$NODE" src/cli.mjs self-check
"$NODE" src/cli.mjs self-check --server "<real>/dist/mcp/index.js"

# 单元/集成测试：默认 14 通过 + 1 跳过（真实契约需显式开启）
"$NODE" --test "test/**/*.test.mjs"

# 带真实契约的完整测试（15/15）
PI_LLM_WIKI_SERVER="<real>/dist/mcp/index.js" \
  "$NODE" --test "test/**/*.test.mjs"

# 独立验收：stub（离线、无外部依赖）
"$NODE" src/cli.mjs accept --out acceptance/stub

# 独立验收：真实 pi-llm-wiki 0.12.5
"$NODE" src/cli.mjs accept \
  --server "<real>/dist/mcp/index.js" \
  --out acceptance/real
```

`accept` 默认使用 `test/fixtures/stub-wiki-server.mjs`，也可读取环境变量 `PI_LLM_WIKI_SERVER`。`--keep` 保留临时 vault，`--base <dir>` 指定临时根目录，`--out <dir>` 指定报告目录。报告写入 `<out>/latest.json` 与 `<out>/latest.md`，失败时进程退出码为 1。

### JS API

```js
import { WikiAdapter } from "./src/adapter.mjs";

const adapter = await WikiAdapter.open({
  baseDir: "D:/tmp/openfuture-wiki",
  projectId: "proj-alpha",
  topic: "Alpha 合成知识库",
  serverPath: "<real>/dist/mcp/index.js",
});

adapter.defineTopic({
  id: "topic-runtime",
  title: "OpenFuture 并行交付架构",
  thesis: "主线与并行工作区分离，证据随草稿流转。",
  keywords: ["并行", "工作区", "交付"],
  sourceIds: ["src-arch", "src-workflow"],
});

await adapter.captureSource({ logicalId: "src-arch", title: "架构说明", text, revision: "r1" });
const draft = await adapter.compile("topic-runtime");
const plan = await adapter.planPublish("topic-runtime"); // pending_review，不写发布页
// 发布必须带上同一份计划的 planId；计划已消费、过期或来源指纹变化都会拒绝。
await adapter.publish("topic-runtime", { confirm: true, planId: plan.planId });
const recall = await adapter.recall("并行交付", { maxResults: 5 });
const page = await adapter.readPublished(plan.pageId); // 例如 syntheses/openfuture-并行交付架构-c7100903
await adapter.revokeSource("src-arch", { reason: "资料过期" });
// 撤销/替换后，旧主题页变为 stale，readPublished 返回 not_published，
// 即使伪造 frontmatter 也会因证据 packet/revision 不匹配返回 stale_evidence。
await adapter.close();
```

主要方法：

| 方法 | 作用 |
| --- | --- |
| `WikiAdapter.open({baseDir, projectId, topic, serverPath, nodePath})` | 建/复用逐项目临时 vault，启动 stdio 客户端并 bootstrap |
| `defineTopic({id,title,thesis,keywords,sourceIds})` | 登记主题及其来源集合 |
| `captureSource({logicalId,title,text,revision,metadata})` | 捕获一份资料；同 hash 不重复捕获；替换时撤销旧 packet |
| `compile(topicId)` | 用主题关键词选取段落，生成逐段引用的 synthesis 草稿 |
| `planPublish(topicId)` | 重新编译并生成审核计划，返回 `pending_review`、`planId`、`draftHash`、`beforeHash`、`pageHash`、`snapshotHash`、`sourceFingerprint`、`pageId` 与 diff；不写发布页 |
| `publish(topicId,{confirm:true,planId})` | 校验计划与最新来源/现页后显式发布；无计划、计划已消费或已过期分别报 `REVIEW_PLAN_REQUIRED` / `STALE_REVIEW_PLAN` |
| `revokeSource(logicalId,{reason})` | 撤销来源，受影响主题页转 `stale`/`inactive` 并作废旧计划；无来源的主题变为 revoked |
| `recall(query,{maxResults})` | 调用真实 `wiki_recall`，按物理路径、状态和活跃证据过滤，preview 由本地已验证正文生成 |
| `readPublished(idOrPath)` | 只读本项目 vault 内、物理边界内、已发布活跃且证据仍匹配当前来源的页面 |
| `status()` / `lint()` / `rebuildMeta()` | 透传真实 `wiki_status` / `wiki_lint` / `wiki_rebuild_meta` |

### 证据 DTO

每条引用同时写入页面 frontmatter 的 canonical `sources` 和扩展字段 `evidence`：

```json
{
  "evidenceId": "EV-topic-runtime-src-arch-0",
  "projectId": "proj-alpha",
  "topicId": "topic-runtime",
  "sourceId": "SRC-2026-11-09-001",
  "sourceRevision": "r1",
  "logicalSourceId": "src-arch",
  "title": "OpenFuture 并行交付架构说明（合成）",
  "locator": { "type": "char_range", "start": 0, "end": 64 },
  "quote": "OpenFuture 采用主线与并行工作区分离的交付架构"
}
```

DTO 全部为 JSON 可序列化值；locator 使用带类型的字符区间，便于主线做原文回查。正文每个主题段落以 `[n]` 标注，文末“证据与出处”逐条列出 packet、逻辑来源@修订、字符区间和引文。

## 2. 真实契约（0.12.5）

真实包来自 npm，安装在已被根 `.gitignore` 忽略的 `.scratch/real-wiki/`，不进入提交：

```bash
node <pnpm.cjs> add @zosmaai/pi-llm-wiki@0.12.5 \
  @earendil-works/pi-coding-agent@1.5.0 \
  --ignore-scripts --config.auto-install-peers=false \
  --config.strict-peer-dependencies=false
```

- 服务端入口：`<...>/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js`
- 传输：stdio，每行一个 JSON-RPC；`initialize` 使用 `protocolVersion: "2025-06-18"`。
- 已实测工具：`wiki_bootstrap`、`wiki_capture_source`、`wiki_ingest`、`wiki_lint`、`wiki_recall`、`wiki_status`、`wiki_rebuild_meta`。
- 真实响应为 text content，无 `structuredContent`；客户端解析 `Source captured: SRC-...` 和 JSON 文本。
- 真实 `wiki_recall` 会合并项目 vault 与 personal vault；适配器在客户端再次按路径和 frontmatter 过滤，避免 personal/foreign/撤销页泄露。

隔离方式：每个项目 `<baseDir>/<projectId-hash>/{vault,home}`，子进程环境固定为 `WIKI_ROOT=vault`、`WIKI_HOME=home`、`HOME/USERPROFILE=home` 和假 `APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME`；假 home 中不放正式 personal vault。验收时另外用真实 `wiki_bootstrap` 初始化一个 personal vault 并放入带 `project_id: proj-beta` 的页面，专门验证越界拒绝。

## 3. 实际跑过的验收

运行时间：2026-11-09（Asia/Singapore）。报告：

- 真实：`acceptance/real/latest.json`、`acceptance/real/latest.md` — **27/27 通过**
- stub：`acceptance/stub/latest.json`、`acceptance/stub/latest.md` — **27/27 通过**
- 测试：真实契约开启时 `15/15` 通过（含 `real pi-llm-wiki 0.12.5 stdio contract`）；默认离线运行 `14` 通过、`1` 跳过。
- `self-check --server <real>`：Node 24.21.0、真实入口存在、隔离 vault bootstrap/关闭均 PASS。

真实验收覆盖：

1. bootstrap 生成 `.llm-wiki/config.json`，服务端标识 `llm-wiki`。
2. 三份合成资料捕获为 `SRC-...` packet 与已发布 source 页面，且只路由到列出来源的主题。
3. `wiki_ingest` 报告所有 packet 已合成（适配器不依赖服务端模型）。
4. `wiki_lint` 在真实 vault 布局上运行。
5. 主题草稿含逐段 `[n]` 引用，证据 DTO 可 JSON 序列化且 locator 可回查。
6. 首次发布显示全新增 diff 且状态为 `pending_review`；确认后才写页面。
7. `wiki_recall` 只返回本项目已发布活跃页，preview 由本地已验证正文生成，不采用服务端 preview。
8. 新增第 4 份资料只更新其主题；替换来源撤销旧 packet、只按 r2 重编译；撤销唯一来源使主题 revoked 并退出检索。
9. 无关主题页在另一主题撤销后字节不变。
10. 越界 personal/foreign 页、越界读取路径均被拒绝且不泄露正文；两个项目 recall 互不串数据。
11. 无审核计划、已消费计划、来源变化后的旧计划均被拒绝（`REVIEW_PLAN_REQUIRED` / `STALE_REVIEW_PLAN`）。
12. 替换来源后旧主题页立即 `not_published`，替换前创建的计划作废。
13. 撤销来源后旧主题页不可读；即使把 frontmatter 伪造回 published/active，也因 packet/revision 与当前活跃来源不符返回 `stale_evidence`，recall 计入 `rejected.staleEvidence`。
14. `wikiDir` 下指向外部目录的 Windows junction 被 realpath 物理边界拒绝：`readPublished` 返回 `outside_vault`，recall 不返回外部正文。
15. 同名主题使用不同 `topicId` 时获得稳定且唯一的页面 ID，不互相覆盖。

真实报告中的关键证据（详见 `acceptance/real/latest.md`）：

- 首次发布：`{"added":100,"removed":0}`；页面 ID `syntheses/openfuture-并行交付架构-c7100903`，内容 hash `19d58410...`。
- 新增来源：`{"added":42,"removed":5}`。
- 同名主题：基础页 `...-c7100903`，别名页 `...-f3480382`，两者均可读且 `topic_id` 正确。
- 替换来源：旧 `SRC-2026-11-09-002` → 新 `SRC-2026-11-09-005`，`{"added":14,"removed":14}`；旧页 `not_published`，旧计划 `REVIEW_PLAN_REQUIRED`。
- 撤销后：`{"read":"not_published","tampered":"stale_evidence","rejected":{"notPublished":2,"staleEvidence":1}}`，无关页字节不变。
- junction 越界：`{"read":"outside_vault","rawCount":1,"outsideVault":1}`，且不返回外部正文。
- 跨项目：`{"alphaMatches":0,"betaMatches":2}`。

### 发布审核与旧证据防护

- `planPublish(topicId)` 每次都重新编译，不复用缓存草稿；返回的 `planId` 绑定 `draftHash`、`beforeHash`、当前页/快照 hash 和来源指纹。
- `publish` 必须同时带 `confirm:true` 与 `planId`；没有计划、计划已消费、计划与当前页/来源指纹不一致时分别返回 `REVIEW_PLAN_REQUIRED` / `STALE_REVIEW_PLAN`。成功发布后计划立即失效，不能重放。
- 来源替换或撤销时，受影响主题页被改写为 `status: stale`、`state: inactive`（带 `review_reason`），同时删除该主题的草稿与计划；未受影响主题页保持字节不变。
- `readPublished` 和 `recall` 除了检查 `status/state/project_id`，还会把页面里的 canonical `sources` 与 `evidence` 逐条对照当前活跃来源：packet、revision、evidenceId 任一不匹配即拒绝（`stale_evidence`）。
- 两条读取路径都先做词法边界检查，再用 `realpath` 做物理边界检查；junction/symlink 指向外部目录时返回 `outside_vault`，且错误对象不携带外部正文。
- recall 的 `preview` 从已通过校验的本地页面正文生成，服务端返回的 preview 字段不会被透传；stub 特意注入 `SERVER_PREVIEW_SENTINEL` 验证这一点。
- 同名主题的页面 ID 为 `syntheses/<slug>-<topicId hash8>`，同一 `topicId` 重复定义时保持不变，不同 `topicId` 不会互相覆盖。

## 4. 目录

```text
parallel/wiki/
  package.json
  README.md
  src/
    adapter.mjs       # 领域适配器：捕获、编译、发布、撤销、过滤
    acceptance.mjs    # 27 项独立验收场景与报告
    cli.mjs           # self-check / accept
    compiler.mjs      # 段落切分、关键词选取、引用与草稿
    diff.mjs          # 行级 LCS diff
    fixtures.mjs      # 合成中文资料与主题
    frontmatter.mjs   # 无依赖 YAML 子集解析/序列化
    mcp-client.mjs    # stdio JSON-RPC 客户端
    util.mjs          # 路径/哈希/原子写等
    vault.mjs         # 逐项目 vault、假 home、状态文件
  test/
    fixtures/stub-wiki-server.mjs
    contract.test.mjs
    adapter.test.mjs
    compiler.test.mjs
    diff.test.mjs
    frontmatter.test.mjs
    isolation.test.mjs
    review-safety.test.mjs
  acceptance/
    real/latest.{json,md}
    stub/latest.{json,md}
```

运行产物（临时 vault、`.scratch`、`node_modules`）均在忽略目录，不提交。

## 5. 依赖、端口与限制

- 交付代码零运行时 npm 依赖；真实契约测试需要可选安装 0.12.5 及其 peer `@earendil-works/pi-coding-agent`。
- 适配器是 stdio 子进程，不监听端口。工作区保留端口 **19732**（第二端口 **19742**）未使用，避免与其他会话冲突。
- 未实测/未接入：
  - 服务端模型合成 lane：本适配器使用确定性的本地编译，`wiki_ingest` 只用于确认真实契约，不依赖服务端模型产出。
  - QMD/embedding 语义检索：真实 lint 显示 QMD ready，但验收使用 lexical recall。
  - OpenFuture 主进程接线：适配器只返回结果/待审计划；读侧校验、发布事务与 UI 仍由主线持有，需按 `projectId, sourceId, sourceRevision, evidenceId, locator` 映射。
  - 真实 personal vault 的长期内容：验收只放入一个合成的 foreign 页面验证隔离。
  - 审核计划只保存在当前进程内存：进程重启后必须重新 `planPublish`；这是刻意避免持久化审批状态，不是持久队列。
  - 来源替换/撤销采用“整页隐藏待复核”（`stale`/`inactive`），没有实现保留未受影响段落的页内部分保留；主线可在复核后重新编译并发布。
  - 页面 ID 绑定 `topicId`；同一主题改标题不会自动重命名已发布页，避免旧链接失效。
  - realpath/junction 边界只在 Windows 上实测；POSIX symlink 与非 Windows 权限行为未测。
- 验收使用 `mkdtemp` 临时目录并在结束后清理；报告里的临时路径可能已不存在，这是预期行为。

## 6. 合入说明

提交范围仅 `parallel/wiki/`，相对种子 `1338eca` 为新增文件。请 Codex 审查后由主线串行合入；本分支不推送、不自行合并。
