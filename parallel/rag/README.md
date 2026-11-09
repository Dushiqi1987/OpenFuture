# OpenFuture 并行线 RAG：PDF 解析 + QMD 混合检索 + 证据回表

本目录是 `D:\OpenFuture-parallel\rag` 独立种子（`1338eca`）上的 RAG 并行交付件，唯一可写范围为
`parallel/rag/`。目标是为 OpenFuture 主线提供可独立验收的检索侧原型：Docling 解析入口、
固定版 QMD 2.8.3 的混合检索适配、可回表的证据块、来源修订/撤销，以及 Top-K/Top-N 与
两种证据排序（A 降序 / B 两端）的对照数据。**本目录不启动主线、不写正式配置、不推送、不自合入。**

## 1. 当前状态（2026-11-09）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 电子 PDF 解析（页/块/页码定位） | 已实现并可测 | 零依赖 PDF 兜底解析器，解析 `fixtures/spec-cn-en.pdf`（3 页、跨页表格、中英混排） |
| Docling 本地 worker | 已实现协议，未在真 Docling 上跑 | `src/docling/worker.py` + `client.ts`，用 stub worker 覆盖协议与失败路径；本机未安装 docling |
| 扫描 PDF / OCR 标记 | 已实现门控 | 无文本层页面标记 `ocr:"required"`、质量低、0 chunk，并在检索中排除 |
| 结构感知分块 | 已实现 | 标题感知、页内切分、400–700 tokens 上限、`chunkId`/`contentHash`/页内偏移 |
| QMD 2.8.3 适配 | 已实现 API 适配，用 fake SDK 验收 | 动态 import；`createStore/update/embed/search/searchLex/searchVector`；真包需原生模块和模型，本工作区不下载 |
| 词法基线 / 向量 / RRF / 重排 | 已实现 | FTS5 trigram + CJK 二元词法打分；RRF k=60；位置带权重混排；哈希向量为本地替身 |
| 证据回表 | 已实现 | 返回前校验 projectId、sourceId、active revision、chunkId、contentHash、页码/字符区间 |
| 撤销 / 替换 / 重启 | 已实现并可测 | 撤销立即不可检索；同 sourceId 重导入生成新 revision 并清掉旧 revision 的 chunk；重启后可用 |
| 离线/仅关键词回退 | 已实现 | QMD 不可用时 `engine:"local-lexical"` 且带明确 `reason`，检索不阻塞 |
| HTTP 适配层 | 已实现 | 127.0.0.1:19731（备用 19741），默认仅本地回环 |
| 答案生成 | 未实现（非本线职责） | 本线只交付可验证证据，不生成自然语言答案 |

## 2. 目录

```
parallel/rag/
  src/
    types.ts           统一 DTO / RagAdapter 接口 / 错误码
    adapter.ts         LocalRagAdapter（主线唯一入口）
    server.ts          本地 HTTP 适配层（19731/19741）
    chunk.ts           结构感知分块、token 估算、chunkId
    markdown.ts        Markdown 解析（合成资料入口）
    score.ts           词法打分、哈希向量、短语/型号保护
    retrieve.ts        Top-K → RRF → 重排 → Top-N → A/B 排序 → 回表
    store.ts           node:sqlite 存储（sources/chunks/chunks_fts）
    docling/
      pdf.ts           零依赖 PDF 解析兜底（含 ToUnicode / 页树 / 内容流）
      client.ts        Docling worker 协议客户端（JSON over stdio）
      worker.py        真 Docling worker（DocumentConverter + HybridChunker）
    qmd/index.ts       QMD 2.8.3 适配与仅关键词回退
  test/                17 个 node:test 用例（fake QMD / stub Docling）
  test/fakes/          qmd-fake.mjs、docling_stub.py
  fixtures/            合成中英 PDF、扫描 PDF、手册、8 条查询
  scripts/
    exec-node.mjs      Node 24 启动器（Electron-as-node 兜底）
    make_fixtures.py   可复现合成资料生成器
    acceptance.mjs     独立验收（指标 + 门控 + A/B + 报告）
  README.md
```

## 3. 环境与命令

用 Node 24 运行以下命令。`scripts/exec-node.mjs` 优先使用 `RAG_NODE`，其次使用当前 Node，
并在 Node 22 上添加 `--experimental-strip-types` 和 `--experimental-sqlite`。
本机 Python 为 `F:\python\python.exe`（3.10.4），fixtures 生成需要 reportlab + Pillow。

```bash
cd parallel/rag

# 1) 生成/校验合成资料（输出可复现，sha256 稳定）
python scripts/make_fixtures.py

# 2) 单元/集成测试（17 个）
npm test

# 3) 独立验收（本地、隔离数据、fake QMD；约 2 秒）
node scripts/exec-node.mjs scripts/acceptance.mjs
#   RAG_ACCEPT_K=30 RAG_ACCEPT_N=5 可调
#   RAG_QMD_MODULE=file:///.../qmd-real-entry.mjs 可切到真实 QMD

# 4) HTTP 服务（默认 127.0.0.1:19731）
node scripts/exec-node.mjs src/server.ts
#   RAG_PORT=19741 切换备用端口；数据目录默认 .scratch/data/server
#   RAG_QMD_MODULE=file:///D:/.../test/fakes/qmd-fake.mjs 可让服务使用 fake SDK
```

验收产物写入 `parallel/rag/.scratch/run/acceptance-<stamp>/`（`.scratch/` 被根 `.gitignore` 忽略）：
`acceptance-report.json` 与 `acceptance-report.md`。本 README 第 6 节引用的是实际跑出的结果。

## 4. 接口

### 4.1 TypeScript 适配器（主线入口）

`src/types.ts` 定义 `RagAdapter`，`src/adapter.ts` 的 `createRagAdapter(options)` 返回实现：

```ts
interface RagAdapter {
  initialize(): Promise<RagDiagnostics>
  importSource(input: ImportInput): Promise<ImportResult>
  replaceSource(sourceId: string, input: ImportInput): Promise<ImportResult>
  revokeSource(sourceId: string): Promise<SourceRecord | null>
  listSources(): Promise<SourceRecord[]>
  search(input: SearchInput): Promise<SearchResult>
  diagnostics(): Promise<RagDiagnostics>
  close(): Promise<void>
}
```

构造参数（全部由主线传入，本线不读正式配置）：

| 参数 | 说明 |
| --- | --- |
| `dataDir` | 项目隔离数据目录（SQLite + QMD corpus） |
| `projectId` | 项目身份；所有 evidence 都携带 |
| `qmdModule` | QMD 入口模块 URL/path；缺省 `@tobilu/qmd`（未安装时自动回退） |
| `python` / `doclingWorker` | Docling 解释器与 worker 路径 |
| `useDocling` | 强制启用/禁用 Docling；不可用时仍可走兜底解析 |
| `timeoutMs` | Docling 子进程超时（默认 180 s） |

**证据回表语义**：`search()` 返回的每条 `Evidence` 都带
`projectId, sourceId, sourceRevision, chunkId, contentHash, fileName, locator{page,charStart,charEnd}, heading, score, engine`。
返回前会再次校验：source 仍 active、revision 未过期、chunkId 仍属于该 revision，否则丢弃并计入
`diagnostics.staleDropped/revokedDropped`。撤销或替换后旧证据立即不可返回。

### 4.2 HTTP（本地调试/验收用）

| 方法/路径 | 请求 | 说明 |
| --- | --- | --- |
| `GET /health` | - | 进程与适配器诊断 |
| `GET /diagnostics` | - | sources/chunks/indexBytes/qmd 状态 |
| `GET /sources` | - | 来源与 revision 列表 |
| `POST /import` | `{"path":"<absolute>","sourceId":"optional"}` | 解析→分块→入库→QMD 同步 |
| `POST /revoke` | `{"sourceId":"..."}` | 撤销并删除 chunk |
| `POST /search`（别名 `/query`） | `{"query":"...","k":30,"n":5,"layout":"A","mode":"auto","tokenBudget":2000}` | 混合检索 + 证据 |

示例：

```bash
curl -s -X POST http://127.0.0.1:19731/import \
  -H 'content-type: application/json' \
  -d "{\"path\":\"D:/OpenFuture-parallel/rag/parallel/rag/fixtures/spec-cn-en.pdf\"}"

curl -s -X POST http://127.0.0.1:19731/search \
  -H 'content-type: application/json' \
  -d '{"query":"OF-2200 Pro 最大吞吐量是多少","n":5,"layout":"B"}'
```

约束：仅监听 `127.0.0.1`；请求体上限 1 MiB；`path` 必须为绝对路径；`k` 1–100、`n` 1–12。
默认端口 19731，`RAG_PORT=19741` 作为第二端口（服务冲突时可手动切换；测试用例会验证 19741 回退）。

### 4.3 Docling worker 协议

`runDocling()` 以 `python -X utf8 worker.py` 启动子进程，stdin 写入一个 JSON 请求：

```json
{"path":"D:/.../spec.pdf","fileName":"spec.pdf","ocr":true,"hybridChunking":true,"maxTokens":700}
```

stdout 最后一行 JSON 信封：

```json
{"ok":true,"version":"2.x","document":{"parser":"docling","pages":[...],"blocks":[...]},"hybridChunks":[...]}
```

失败时 `{"ok":false,"error":{"code":"DOCLING_UNAVAILABLE|PARSE_FAILED|READ_FAILED","message":"..."}}`。
`probeDocling()` 只做 `importlib.metadata.version('docling')`，永不抛错；不可用时适配器回退到
`src/docling/pdf.ts` 并在 source warnings 中记录原因（本次验收实际走的就是这条回退路径）。

## 5. 检索与排序

- **候选**：`k` 默认 30，取词法（FTS5 trigram + CJK 二元打分）、本地哈希向量、QMD 词法/向量并集；
  少于 3 字符的 CJK 词不会进入 FTS5 trigram，由 JS 二元打分补偿。
- **融合**：RRF `1/(60+rank+1)`，对 #1/#2–3 加小权重；可选 QMD `store.search` 结果按 `qmd://collection/path`
  反查回本地 `chunkId`。
- **重排**：词法覆盖 0.6、精确短语、向量 0.15、型号/参数保护 0.15；按名次分带混入原序
  （rank≤3 权重 0.75，4–10 为 0.6，其余 0.4）。
- **去重/过滤**：`contentHash` 去重、低相关（score<0.08 且词法覆盖<0.05）丢弃、已撤销/过期/跨项目丢弃。
- **Top-N**：默认 `n=5`，按 token 预算（默认 2000）截断。
- **两种证据布局**：A = 相关度降序；B = 两端交替 `#1, #N, #2, #N-1, …`，集合不变、顺序不同，
  便于对照“模型实际收到”的上下文。

## 6. 实际验收证据（本机、合成数据、无外网）

### 6.1 测试

```
$ node scripts/exec-node.mjs --test test/*.test.ts
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms ~2000
```

覆盖：PDF 页/块/页码定位；扫描件 OCR 门控；Markdown 偏移；分块页内约束；来源 supersede/replace/revoke；
检索金标页召回与 A/B 顺序；Docling stub 协议与失败路径；QMD fake 正常/失败回退；HTTP 导入/检索/撤销。

### 6.2 验收指标（`scripts/acceptance.mjs`，2026-11-09）

环境：Node 24.21.0；QMD 模块 = `test/fakes/qmd-fake.mjs`（按 2.8.3 API 实现的模拟 SDK）；Docling 不可用
（`No package metadata was found for docling`，走 PDF 兜底）；数据目录 `.scratch/run/acceptance-*/data`。

导入：

| 文件 | sourceId | revision | chunks | OCR 页 |
| --- | --- | --- | ---: | --- |
| `fixtures/spec-cn-en.pdf` | spec-cn-en | b8300b3e5715 | 7 | 0 |
| `fixtures/handbook-cn-en.md` | handbook-cn-en | 6752ca77f6bc | 5 | 0 |
| `fixtures/scan-cn-en.pdf` | scan-cn-en | f46986a336ab | 0 | 2（标记 OCR 必需） |

检索（7 条非扫描查询，K=30，N=5，金标=来源文件+页；扫描查询用于门控，不进入分母）：

| 模式 | Recall@5 | nDCG@5 | MRR | 引用页准确率 | p50 延迟 |
| --- | ---: | ---: | ---: | ---: | ---: |
| hybrid（词法+向量+RRF+重排） | 100.0% | 0.736 | 0.648 | 100.0% | 2 ms |
| 词法基线 | 100.0% | 0.752 | 0.667 | 100.0% | 2 ms |

- 索引大小：`indexBytes=102400`（SQLite 页数×页大小），sources=4（含已撤销 spec），chunks=5。
- A/B：同一证据集合 `sameSet=true`；A 为 `#1→#2→#3→#4→#5`，B 为 `#1→#5→#2→#4→#3`（见报告表格）。
- 门控全部通过：扫描件无文本→0 chunk 且检索不返回其内容；撤销 spec 后仅剩 handbook 命中；
  把 handbook 的“7 年→9 年、30 秒→45 秒”替换后旧短语不可检索、新短语可检索；重启后 sources/chunks 保持、
  已撤销 spec 不再命中；把 QMD 模块指向不存在路径时 `engine=local-lexical`、`reason` 明确、检索仍工作。
- 解释：合成语料故意在规格书与手册间复用部分事实（保修/功耗/重试），且本机向量是确定性哈希替身而非
  语义模型，因此本表只能证明**链路与排序机制**，不能当作真实语义检索质量结论。替换成真实 QMD 模型后
  应重跑同一脚本对比。

完整报告：`parallel/rag/.scratch/run/acceptance-2026-11-09T08-21-32/acceptance-report.{json,md}`（被忽略）。

### 6.3 数据与回表

- 每个 chunk 含 `projectId, sourceId, sourceRevision, chunkId, ordinal, page, charStart, charEnd, heading, kind, text, tokenCount, contentHash`。
- `chunkId` 形如 `spec-cn-en#rb8300b3e5715#004`；revision 为文件 SHA-256 前 12 位。
- 撤销：source 置 `revoked` 并删除 chunk；替换：同 sourceId 新 revision，旧 revision 的 chunk 清理；
  重启：从 SQLite 恢复，QMD corpus 按 active chunk 重建。
- QMD 索引身份写入 `<dataDir>/qmd/<projectId>/identity.json`：`{qmd:"2.8.3", embedModel, chunking:"rag-chunk-v1"}`，
  corpus 文件名为 `<sourceId>--r<rev>--<nnn>.md`，`map.json` 保存 path→chunkId 供回表。

## 7. 端口、隔离与安全

- 只用 19731；服务被占用时可用 19741。测试只绑定 `127.0.0.1`，不对外监听。
- 所有数据在 `parallel/rag/.scratch/`（被忽略），不写用户目录、不读真实凭证、不发外部请求。
- 真 QMD 需要下载模型（embedding ~300 MB 起）且含原生模块，本隔离工作区**不执行**；适配器只做
  API 调用与失败回退。Docling 同理：worker 与协议已备好，等主线环境安装后可直接切换。
- 不修改副本 `src/`、根 manifest、lockfile 或其他并行目录；不推送、不合入主线。

## 8. 待接入主线 / 下一步

1. 在主线合入时注入真实 `projectId`、active source 列表、取消信号与本地依赖配置；导入提交事务仍由主线持有。
2. 安装并验证 Docling（含 OCR 引擎）与真实 QMD 2.8.3（embedding/reranker/模型路径），用
   `RAG_QMD_MODULE`/`RAG_USE_DOCLING` 重跑 `acceptance.mjs`，替换第 6 节模拟数据。
3. 主线证据面板接入 A/B 布局与“检索到什么 / 模型收到什么”两段展示；本线只提供 `selected` 与 `hits`。
4. 可选：向量后端从哈希替身切到 QMD embedding 后，调整重排权重并补充真实 nDCG 基线。
5. 目前答案准确率未评分（本线不生成答案）；接主线后可用引用证据回答再进行端到端评测。

## 9. 提交范围

本地分支 `worker/rag`，相对种子 `1338eca` 仅新增/修改 `parallel/rag/` 下的代码、fixtures、测试、脚本与本 README；
`.scratch/` 与 `node_modules/` 不提交。等待 Codex 审查后由主线串行合入。
