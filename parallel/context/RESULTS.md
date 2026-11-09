# 实际验收记录

本文件固化本次 S0/S1 最小复现的**实际执行结果**。原始报告在 `reports/` 下（被 `.gitignore` 忽略，保留在本地），session/capture 在 `.scratch/` 下。

- 日期：2026-11-09
- 工作区：`D:\OpenFuture-parallel\context`
- 分支：`worker/context`（HEAD `1338eca`，基础快照）
- Node：`v22.20.0`（`F:\VibelutionRuntimes\node-v22.20.0-win-x64\node.exe`）
- 端口：S0 mock `19745`；S1 mock `19735`
- 模型：本地 `127.0.0.1` OpenAI 兼容 mock，无外部请求

## 1. 最终全套测试

命令：

```bash
export PATH="/f/VibelutionRuntimes/node-v22.20.0-win-x64:$PATH"
npm test
```

结果：**9/9 PASS，0 fail，0 skipped**，耗时 `7100.32 ms`。

| # | 测试 | 结果 |
| --- | --- | --- |
| 1 | projection keeps a valid tool call/result pair | PASS |
| 2 | revocation before projection removes both halves of a tool pair | PASS |
| 3 | host compresses, persists, restarts, and keeps blocks isolated | PASS |
| 4 | revocation invalidates the block and never re-emits its sentinel | PASS |
| 5 | a corrupt sidecar falls back to native without throwing | PASS |
| 6 | a failed sidecar write switches the host to native | PASS |
| 7 | kernel failure falls back to the original Pi messages | PASS |
| 8 | S0 native baseline: compaction, retention, restart, isolation | PASS |
| 9 | S1 in-process ACP host: load, real compress, sidecar, restart | PASS |

`npm test` 同时生成了最新独立报告：

- S0：`reports/s0-baseline-2026-11-09T08-07-04-256Z.json`
- S1：`reports/s1-acp-2026-11-09T08-07-07-435Z.json`

## 2. S0 原生基线

命令：`npm run s0`

独立验收 run：`2026-11-09T07-23-56-345Z`（PASS，报告 `reports/s0-baseline-2026-11-09T07-23-56-345Z.json`）。
最新测试 run：`2026-11-09T08-07-04-256Z`（PASS，报告 `reports/s0-baseline-2026-11-09T08-07-04-256Z.json`）。

配置：

- 模型：`openfuture-mock/synthetic-s0`
- `contextWindow`: 1600
- `compaction`: `{enabled:true, reserveTokens:512, keepRecentTokens:500}`
- 5 轮合成用户消息，20 个 session entries
- 第 2 轮触发一次失败工具 `mock_probe`，错误码 `MOCK_TOOL_FAILURE_EXPECTED`

实测检查（全部 PASS）：

| check | 结果 |
| --- | --- |
| `session_started` | true |
| `first_user_entry_exists` | true |
| `auto_compaction_triggered` | 3 次 |
| `original_history_remains_readable` | 20 entries，JSONL 仍含 `PROJECT_PATH=` / `NEXT_TASK_SENTINEL=` |
| `first_kept_entry_id_resolves` | true |
| `summary_retains_facts` | 摘要含项目路径、模型 ID、API 合同、下一步任务 |
| `repeated_compaction_triggered` | 3 次 |
| `restart_preserves_entries` | 20 → 20，compactions 3 |
| `restart_can_continue` | true |
| `new_session_is_isolated` | true（新 session 文件不继承旧历史） |

Compaction entries（来自报告）：

| id | firstKeptEntryId | tokensBefore | summaryChars |
| --- | --- | --- | --- |
| `58293b06` | `880b3be3` | 1332 | 5060 |
| `9371af87` | `605cdece` | 2584 | 6049 |
| `0b1dfdff` | `ff6c4a99` | 2767 | 6072 |

注意：报告结束时 `getContextUsage()` 为 2624 / 1600（164%）。这是 mock 窗口极小、最后一轮继续追加消息造成的；压缩已发生 3 次且原始历史/重启均通过。它说明“压缩后仍可能溢出小窗口”，不应当解读为压缩完全消除了溢出。

## 3. S1a 进程内 ACP 扩展

命令：`npm run s1:acp`

- 首次只验证加载的 PASS：run `2026-11-09T07-45-15-757Z`（报告 `reports/s1-acp-2026-11-09T07-45-15-757Z.json`），但 `sidecarHasBlocks:false`，未证明实际压缩。
- 真实压缩 PASS：run `2026-11-09T07-56-26-971Z`（报告 `reports/s1-acp-2026-11-09T07-56-26-971Z.json`），1 个 block。
- decompress/search + 重复压缩 PASS：run `2026-11-09T08-05-30-459Z`（报告 `reports/s1-acp-2026-11-09T08-05-30-459Z.json`）。
- 最新 `npm test` run：`2026-11-09T08-07-07-435Z`（报告 `reports/s1-acp-2026-11-09T08-07-07-435Z.json`），PASS。

最终配置：

```js
createAcpExtension({
  enabled: true,
  delegate: false,
  autoUpdate: false,
  debug: true,
  modelContextLimit: 1600,
  hostSession: false,
  preserveRecentMessages: 1,
  coreOverrides: {
    preserveRecentTokens: 0,
    compress: { minCompressRange: 500 }
  }
})
```

实测结果（最新 run）：

| 指标 | 值 |
| --- | --- |
| 扩展数量 | 1 |
| 注册工具 | `compress`、`decompress`、`search_context`、`acp_status`、`acp_cache` |
| `acp_delegate*` | 无 |
| 真实 `compress` 调用 | 2 次 |
| sidecar blocks | 2 个 |
| `decompress` 调用 | 1 次，恢复原文成功 |
| `search_context` 调用 | 1 次，命中 block |
| 重复压缩 | 1 次（第二个 block） |
| 重启后工具 | 5 个保留 |
| 重启后 sidecar | 存在，2 个 block |
| 重启后摘要 | 可见 |
| Pi 原生压缩实际完成 | 0 次 |
| Pi compaction 事件 | 15 次 `compaction_start`，全部 `aborted:true`（ACP 取消） |
| 请求数 | 主流程 12，重启后 13 |
| session 消息数 | 25 |

所有 19 项 checks 均为 true：

`pi_host_detected`、`no_acp_delegate_tools`、`context_tools_registered`、`acp_refs_present`、`sidecar_written`、`native_compaction_not_owned_by_pi`、`compress_tool_executed`、`compressed_block_persisted`、`compressed_summary_visible`、`decompress_tool_executed`、`decompress_restores_content`、`search_tool_executed`、`search_finds_block`、`repeated_compression_executed`、`second_block_persisted`、`second_summary_visible`、`restart_keeps_adapter_tools`、`restart_keeps_sidecar`、`restart_keeps_compressed_summary`。

Sidecar：`2026-11-09T08-07-09-858Z_01a1bf58-cb21-7092-a5c0-d23cb8fbba81.jsonl.acp.json`，3254 bytes，2 blocks：

| block | topic | 范围 | direct messages | compressedTokens |
| --- | --- | --- | --- | --- |
| `b1` | `s1-synthetic-checkpoint` | `m00001`–`m00005` | 5 | 820 |
| `b2` | `s1-second-checkpoint` | `m00015`–`m00019` | 5 | 831 |

两个 block 的 `active` 均为 true，`producer` 为 `billion-context-pi@0.1.83`。

### 重要发现

1. `DefaultResourceLoader` 必须 `await loader.reload()`，否则 `extensionFactories` 不执行，`extensionCount=0` 且无错误。
2. `noTools:"builtin"` 不会自动激活扩展工具，需要 `session.setActiveToolsByName([...])`。
3. ACP 默认 `preserveRecentTokens=5000`，合成会话总量约 6600 tokens 时整个范围会被保护区覆盖，导致首次压缩被拒；验收时降到 0 才触发。生产不能用这个值。
4. ACP 会接管 Pi 原生压缩：Pi 仍产生 `compaction_start`，但 ACP 返回取消，事件为 `aborted:true`，实际完成 0 次。
5. `acp_refs_present` 的样本仍可能混入 system prompt 中的示例 refs；真实压缩调用解析的是 user 消息中的 `<acp>`，这一点比 check 本身更可靠。

## 4. S1b acp-kernel 宿主原型（仅单测）

命令：`npm run test:unit`

结果：**7/7 PASS**，约 `460 ms`。

覆盖：

- 有效 toolCall/toolResult 配对
- 撤销后同时移除 call/result
- 压缩 + sidecar 持久化 + 重启
- 不同 project/session 的 blocks/revision 隔离
- 撤销令 block 失效，`decompress` 返回 `REVOKED_BLOCK`
- 损坏 sidecar 回退 native
- sidecar 写失败回退 native
- kernel 抛错回退原始 Pi messages
- 相同消息第二次 process 返回 `duplicateSuppressed:true`

**未接入 Pi 实跑**。因此不能把本节的“撤销/回退”结果外推为 S1a 在 Pi 内的行为。

## 5. 未执行的验收

以下项目没有实际运行记录，不得写成 PASS：

- Windows 桌面 EXE / OF-01~OF-05
- S1a 双会话隔离（A/B 项目/会话哨兵）
- S1a 撤销后摘要与旧工具结果不出站
- 429、摘要超时、用户停止、进程中断的故障回退
- A/B 累计出站输入、峰值 token、摘要额外调用、延迟、事实保留对比
- 真实项目数据、真实模型端点、证书
- 主线接入与正式 DSH 配置

## 6. 复现命令清单

```bash
export PATH="/f/VibelutionRuntimes/node-v22.20.0-win-x64:$PATH"
cd D:/OpenFuture-parallel/context/parallel/context
npm install --ignore-scripts --no-audit --no-fund
npm run test:unit
npm run s0
npm run s1:acp
npm test
```

若只复核报告：

```bash
ls reports/
node -e "const r=require('./reports/s0-baseline-2026-11-09T08-07-04-256Z.json'); console.log(r.status, r.checks.filter(c=>!c.ok))"
node -e "const r=require('./reports/s1-acp-2026-11-09T08-07-07-435Z.json'); console.log(r.status, r.checks.filter(c=>!c.ok))"
```

（在 ESM 包内，`node -e` 用 `require` 仍可读 JSON；如失败改用 `JSON.parse(fs.readFileSync(...))`。）
