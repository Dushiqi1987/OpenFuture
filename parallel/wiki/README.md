# OpenFuture 并行线 Wiki 主题编译

面向固定版 `@zosmaai/pi-llm-wiki@0.12.5` 的 stdio 适配器与独立验收套件。它把多份已捕获资料编译成一个带逐段出处的主题草稿，支持发布前 diff、单来源新增/替换/撤销的增量重编译，以及只返回本项目已发布且活跃页面的检索/读取过滤。

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

# 单元/集成测试：默认 10 通过 + 1 跳过（真实契约需显式开启）
"$NODE" --test "test/**/*.test.mjs"

# 带真实契约的完整测试（11/11）
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
await adapter.publish("topic-runtime", { confirm: true }); // 显式确认后才写
const recall = await adapter.recall("并行交付", { maxResults: 5 });
const page = await adapter.readPublished("syntheses/openfuture-并行交付架构");
await adapter.revokeSource("src-arch", { reason: "资料过期" });
await adapter.close();
```

主要方法：

| 方法 | 作用 |
| --- | --- |
| `WikiAdapter.open({baseDir, projectId, topic, serverPath, nodePath})` | 建/复用逐项目临时 vault，启动 stdio 客户端并 bootstrap |
| `defineTopic({id,title,thesis,keywords,sourceIds})` | 登记主题及其来源集合 |
| `captureSource({logicalId,title,text,revision,metadata})` | 捕获一份资料；同 hash 不重复捕获；替换时撤销旧 packet |
| `compile(topicId)` | 用主题关键词选取段落，生成逐段引用的 synthesis 草稿 |
| `planPublish(topicId)` | 与当前发布页/快照做行级 diff，返回 `pending_review` |
| `publish(topicId,{confirm:true})` | 显式发布，写 `wiki/syntheses/<slug>.md` 并保存快照 |
| `revokeSource(logicalId,{reason})` | 撤销来源，重编译受影响主题；无来源的主题变为 revoked |
| `recall(query,{maxResults})` | 调用真实 `wiki_recall`，过滤后返回本项目已发布活跃页 |
| `readPublished(idOrPath)` | 只读本项目 vault 内已发布活跃页 |
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

- 真实：`acceptance/real/latest.json`、`acceptance/real/latest.md` — **21/21 通过**
- stub：`acceptance/stub/latest.json`、`acceptance/stub/latest.md` — **21/21 通过**
- 测试：真实契约开启时 `11/11` 通过（含 `real pi-llm-wiki 0.12.5 stdio contract`）；默认离线运行 `10` 通过、`1` 跳过。
- `self-check --server <real>`：Node 24.21.0、真实入口存在、隔离 vault bootstrap/关闭均 PASS。

真实验收覆盖：

1. bootstrap 生成 `.llm-wiki/config.json`，服务端标识 `llm-wiki`。
2. 三份合成资料捕获为 `SRC-...` packet 与已发布 source 页面，且只路由到列出来源的主题。
3. `wiki_ingest` 报告所有 packet 已合成（适配器不依赖服务端模型）。
4. `wiki_lint` 在真实 vault 布局上运行。
5. 主题草稿含逐段 `[n]` 引用，证据 DTO 可 JSON 序列化且 locator 可回查。
6. 首次发布显示全新增 diff 且状态为 `pending_review`；确认后才写页面。
7. `wiki_recall` 只返回本项目已发布活跃页，带 preview。
8. 新增第 4 份资料只更新其主题；替换来源撤销旧 packet、只按 r2 重编译；撤销唯一来源使主题 revoked 并退出检索。
9. 无关主题页在另一主题撤销后字节不变。
10. 越界 personal/foreign 页、越界读取路径均被拒绝且不泄露正文；两个项目 recall 互不串数据。

真实报告中的关键证据（详见 `acceptance/real/latest.md`）：

- 首次发布：`{"added":100,"removed":0}`。
- 新增来源：`{"added":42,"removed":5}`。
- 替换来源：旧 `SRC-2026-11-09-002` → 新 `SRC-2026-11-09-005`，`{"added":14,"removed":14}`。
- 撤销后：`rejected.notPublished = 1`，主题页 revoke，无关页字节不变。
- 越界过滤：`{"outsideVault":1}`，且返回体中不含外来正文。
- 跨项目：`{"alphaMatches":0,"betaMatches":2}`。

## 4. 目录

```text
parallel/wiki/
  package.json
  README.md
  src/
    adapter.mjs       # 领域适配器：捕获、编译、发布、撤销、过滤
    acceptance.mjs    # 21 项独立验收场景与报告
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
  - 非 Windows 路径/权限行为未测。
- 验收使用 `mkdtemp` 临时目录并在结束后清理；报告里的临时路径可能已不存在，这是预期行为。

## 6. 合入说明

提交范围仅 `parallel/wiki/`，相对种子 `1338eca` 为新增文件。请 Codex 审查后由主线串行合入；本分支不推送、不自行合并。
