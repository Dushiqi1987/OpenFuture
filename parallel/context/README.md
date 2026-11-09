# OpenFuture 短期上下文 v0.5 — S0/S1 最小复现

本目录是 `D:\OpenFuture-parallel\context` 的隔离开发增量，用于在**不改主线、不加载 DSH 正式配置、不使用真实凭证**的前提下，验证 OpenFuture 短期上下文 v0.5 的 S0/S1 最小路径。

- 工作区分支：`worker/context`
- 基础快照：`1338eca`（`1338eca68e438900f5509316ce4fb31c05a6a911`）
- 唯一写入目录：`parallel/context/`
- 测试端口：mock S0 `19745`，mock S1 `19735`
- 所有模型端点均为 `127.0.0.1` 本地 mock，不访问外部服务
- 本目录只交付本地分支增量；**未推送、未合入主线**

## 结论摘要

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| S0：Pi 1.5.0 原生压缩基线 | **PASS** | 自动压缩 3 次；原始 JSONL 保留；重启可继续；新会话隔离 |
| S1：`billion-context-pi@0.1.83` 进程内宿主 | **PASS（功能）** | 真实 `compress` 2 次、`decompress`、`search_context`；sidecar 2 个 block；重启保留；原生压缩 0 次 |
| S1b：`acp-kernel@0.0.101` 宿主自持原型 | **PASS（单测）** | 撤销、工具配对、持久化/重启、会话隔离、损坏/写失败/异常回退、重复投递抑制 |
| 全套测试 | **9/9 PASS** | `npm test` |
| S1a 权限撤销接缝 | **未验证/有风险** | ACP 自行重建摘要输入，宿主后置 `context` 过滤只能影响出站；需 S1b 或上游接缝 |

> S0、S1 的真实运行结果来自本机 Node 22.20.0；早期用默认 Node 14 无法启动 Pi 1.5.0。所有“PASS”都可复核到 `reports/` 下对应 run 报告（报告被 `.gitignore` 忽略，不进入提交，但保留在本地）。

## 版本与许可证

依赖版本固定在 `package.json` / `package-lock.json`：

| 包 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.0 | MIT | Pi 宿主、会话、原生压缩 |
| `billion-context-pi` | 0.1.83 | MIT | S1a ACP 进程内扩展 |
| `acp-kernel` | 0.0.101 | MIT | S1b 宿主投影/压缩内核 |
| `typebox` | 1.3.27 | MIT | 工具参数 schema |

许可证文本以各包 `node_modules/<pkg>/package.json` 与随包 `LICENSE` 为准；本原型不复制或再分发其源码。

## 目录

```text
parallel/context/
  package.json / package-lock.json   锁定版本与脚本
  fixtures/
    synthetic.mjs                    合成会话与哨兵事实
    mock-model/server.mjs            本地 OpenAI 兼容 mock（SSE/JSON）
  src/
    s0/native-baseline.mjs           S0：Pi 原生压缩基线
    s1/acp-probe.mjs                 S1a：进程内 ACP 扩展探针
    runtime/
      atomic-json.mjs                原子 JSON + 校验值
      revocation.mjs                 撤销集合
      projection.mjs                 Pi 消息 ↔ CoreMessage 投影、出站过滤
      state-store.mjs                sidecar 路径、身份校验
      kernel-host.mjs                S1b：宿主持有的压缩/撤销/回退
  tests/
    kernel-host.test.mjs             S1b 单测
    s0-native.test.mjs               S0 验收测试
    s1-acp.test.mjs                  S1 验收测试
  reports/                           本地运行报告（不提交）
```

## 复现命令

需要 Node.js >= 22.19.0。本机可用：

```bash
export PATH="/f/VibelutionRuntimes/node-v22.20.0-win-x64:$PATH"
```

安装（已执行，`--ignore-scripts` 避免第三方安装脚本）：

```bash
npm install --ignore-scripts --no-audit --no-fund
```

运行：

```bash
npm run s0          # S0 原生基线
npm run s1:acp      # S1 进程内 ACP 探针
npm run test:unit   # S1b 单测
npm test            # unit + S0 + S1 全部
```

也可以单独启动 mock（通常由脚本自动启动，不需要手工）：

```bash
npm run mock        # 127.0.0.1:19745
```

脚本会自行启动/停止本目录的 mock 进程；不要在其他工作区运行。

## S0 实际结果

命令：`npm run s0`

- 独立 run：`2026-11-09T07-23-56-345Z`
- 报告：`reports/s0-baseline-2026-11-09T07-23-56-345Z.json`
- 最新 `npm test` run：`2026-11-09T08-07-04-256Z`（同 PASS）
- 模型：`openfuture-mock/synthetic-s0`，`contextWindow=1600`，`reserveTokens=512`，`keepRecentTokens=500`
- 5 轮合成对话、1 个失败工具结果
- 自动压缩：**3 次**（threshold/overflow），session 共 **20 entries**
- 原始 JSONL 仍可读，`PROJECT_PATH=` 与 `NEXT_TASK_SENTINEL=` 仍在
- `CompactionEntry.firstKeptEntryId` 可解析
- 摘要保留项目路径、模型 ID、API 合同、下一步任务
- 重启后 entries/compactions 保持，并继续一轮对话
- 新 session 不继承旧 blocks，隔离检查通过

说明：S0 的“原始历史仍可读”指原始 `.jsonl` 文件；Pi 的模型上下文只保留摘要 + 最近窗口。这是 baseline 的预期行为，不是缺陷。

## S1 实际结果

命令：`npm run s1:acp`

- 独立完整 run：`2026-11-09T08-05-30-459Z`
- 报告：`reports/s1-acp-2026-11-09T08-05-30-459Z.json`
- 宿主：`pi@1.5.0` 的 `createAgentSession` + `DefaultResourceLoader`
- 扩展：`createAcpExtension({enabled:true, delegate:false, autoUpdate:false, hostSession:false, preserveRecentMessages:1, coreOverrides:{preserveRecentTokens:0, compress:{minCompressRange:500}}})`
- 工具：`compress`、`decompress`、`search_context`、`acp_status`、`acp_cache`；无 `acp_delegate*`
- 真实压缩：`compress` 2 次 → sidecar 2 个 block（`b1`、`b2`）
- `decompress` 恢复原文，`search_context` 命中 `s1-synthetic-checkpoint`
- 原生 Pi compaction：ACP 接管后实际完成 **0 次**；Pi 仍发出 15 次 `compaction_start`，均被 ACP 取消（`aborted:true`）
- 重启后工具、sidecar、摘要仍保留
- 合成会话 8 轮，端口 `19735`
- 最新 `npm test` run：`2026-11-09T08-07-07-435Z`（19 项 checks 全 true）

首次触发压缩时曾遇到内核默认 `preserveRecentTokens=5000` 覆盖整个合成会话，导致 range 全在保护区内被拒；探针用 `preserveRecentTokens:0` 与 `minCompressRange:500` 仅用于小样本验收，**不是生产默认值**。

## S1b：为什么还需要 acp-kernel

S1a 证明 `billion-context-pi` 可以作为 Pi 1.5.0 的进程内扩展接管压缩，但它有两个与本任务安全目标相关的限制：

1. ACP 的 `context` handler 从 session log 自行重建工作集并生成摘要输入。宿主额外注册的 `context` 过滤器只能影响 ACP **之后**的出站消息，无法保证撤销内容在**摘要生成输入**阶段就被移除。
2. ACP 设计为单一上下文所有者；若 OpenFuture 还要在宿主侧持有证据过滤/授权投影，两者的所有权边界不清晰。

因此本目录同时保留 S1b `KernelHost` 原型：宿主自己把 Pi 消息投影为 `CoreMessage`，在投影前与出站前各执行一次撤销过滤，再调用 `acp-kernel` 的 `processTurn`/`applyCompression`。当前 S1b 由单测覆盖，尚未接入 Pi 实跑；这是下一步，不是已完成项。

S1b 单测覆盖：

- 有效 `toolCall`/`toolResult` 配对保留
- 撤销后同时移除 call 与 result，避免孤儿结果
- 压缩 + sidecar 持久化 + 重启恢复
- 不同 project/session 的 blocks 与 revision 隔离
- 撤销使 block 失效，`decompress` 返回 `REVOKED_BLOCK`
- sidecar 损坏、写失败、kernel 异常时回退 native，返回原 Pi messages
- 相同消息第二次处理返回 `duplicateSuppressed`

## 验收矩阵

| 要求 | S0 | S1a | S1b 单测 | 备注 |
| --- | --- | --- | --- | --- |
| 跨自动压缩阈值 | PASS（3 次） | PASS（2 次真实 compress） | PASS | S1 原生压缩被接管为 0 |
| 原历史可读 | PASS（读 JSONL） | PASS（重启 session 文件保留） | PASS | S1a 的 sidecar 不替代 JSONL |
| 近期未完成任务可继续 | PASS | PASS（重启后继续） | PASS | 合成 `NEXT_TASK_SENTINEL` |
| 重启 | PASS | PASS | PASS | S1a 重启后工具/sidecar/summary 保留 |
| 会话隔离 | PASS（新 session） | 未覆盖（单 session） | PASS（不同 project/session） | 需补 S1a 双会话 |
| 撤销 | 未覆盖 | 未覆盖 | PASS | ACP 无可用的摘要输入前接缝 |
| 有效工具结果 | PASS（失败工具） | PASS（工具循环） | PASS（配对断言） | |
| 失败回退 | 未注入 | 未注入 | PASS（sidecar/内核异常） | 429/超时/停止仍待跑 |
| 重复压缩 | PASS（3 次） | PASS（2 个 block） | PASS | |
| A/B 成本对比 | 未做 | 未做 | 未做 | 需要同任务、同模型、分端点采样 |

## 关键实现事实

- `DefaultResourceLoader` 构造后必须 `await loader.reload()`，否则 `extensionFactories` 不会执行，`extensionsResult` 为空且无错误。
- `noTools:"builtin"` 下扩展工具不会自动激活；需要 `session.setActiveToolsByName([...])`。
- `createAgentSession` 的 `tools` 白名单与扩展注册是两层；mock 捕获中的 `tools` 是工具名数组，不是 OpenAI 原始 schema。
- Pi 原生压缩阈值：`contextTokens > contextWindow - reserveTokens`；默认 `reserveTokens=16384`、`keepRecentTokens=20000`。
- `CompactionEntry` 写入 session JSONL；原始 entry 不会被删除。
- ACP 工具范围参数是 `startId/endId`；kernel 的 `applyCompression` 参数是 `startRef/endRef`，两者不要混用。
- ACP 每个 session 一个 `.jsonl.acp.json` sidecar；无 sidecar 时从 transcript 重放。
- 合成 mock 通过在 system prompt 中识别 `context summarization assistant` / `<conversation>` 区分摘要请求。

## 已知限制 / 未完成

- 未接入 Windows 桌面 EXE，未执行 OF-01~OF-05；这些需要主线审查后在正式 Agent Host 中做。
- 未做 A/B 成本对比、真实项目数据、真实模型端点。
- 未在 S1a 中验证撤销过滤；ACP 的内部摘要输入不可由宿主前置过滤。S1b 是为此准备的替代路径，但仍需接入 Pi 实跑。
- 未注入 429、超时、用户停止、进程中断等故障；目前只有 sidecar 损坏/写失败/内核异常的 S1b 单测。
- S1a 只有单会话，未做双会话隔离；S0 与 S1b 已覆盖隔离。
- sidecar 是原型格式（格式版本 1），未定义跨版本迁移与正式锁协议。
- 报告与 `.scratch/` 不提交；提交内容为源码、测试、锁文件与本文档。

## 交付边界

- 只修改 `parallel/context/`；未修改 `src/`、根配置、DSH 正式配置或其他工作区。
- 未安装证书、未改模型端点、未推送、未合入主线。
- 本地分支 `worker/context` 的增量为本目录全部未跟踪文件；提交由本分支完成，主线审查后再决定是否接入。
