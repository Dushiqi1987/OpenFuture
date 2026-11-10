# Billion Context ACP 接入验收记录

日期：2026-11-10
分支：`main`
依赖：`billion-context-pi@0.1.83`、`typebox@1.3.27`

## 结论

OpenFuture 已把 `billion-context-pi` 的 ACP 扩展直接接入 agent-host。开启后，模型可使用 `compress`、`decompress`、`search_context`、`acp_status`、`acp_cache`，压缩块持久化到会话 sidecar 和 `acp.log`。默认开启；关闭后回到 Pi 原生压缩。

这不是 S1b 的 `KernelHost` 外部进程方案，而是用户选择的进程内 S1a 适配。它处理的是**对话上下文压缩**，不参与 L3/Wiki 的撤销过滤。

## 接入点

- `src/main/settings-store.ts`：`contextCompression` 默认 `true`；向 agent-host 传 `OPENFUTURE_ACP_CONTEXT=1/0`。
- `src/main/ipc.ts`：`setToolAccess` 接受 `contextCompression`，重启 agent-host。
- `src/agent-host/index.ts`：
  - `createAcpContextExtension(limit)` 动态加载 `billion-context-pi`，启用 `preserveRecentMessages:2`。
  - 把 `compress/decompress/search_context/acp_status/acp_cache` 加入本次会话的 tools allowlist，并激活。
  - 不使用旧的 `OPENFUTURE_ACP_MODULE` 外部钩子。
- `src/main/agent-host.ts`：启动子进程时删除继承的 `BILLION_CONTEXT_NATIVE`、`BILLION_CONTEXT_PROXY`，避免被误判为 DSH 原生宿主而禁用客户端压缩。
- `src/renderer/src/App.tsx`：插件面板新增“上下文压缩”开关，显示 `已启用 · ACP` / `Pi 原生`。

## 实测

会话：`01a1c491-fa07-73c4-a951-094595943450`
模型：`qwen3.7-flash`，上下文窗口 131072。

1. ACP 状态：
   - `ACTIVE SURFACE: pack=default v1.0.0 | host=billion-context-pi 0.1.83`
   - 压缩前：`46.4K tool (97%) | 1.5K text (3%)`，估算 50.7k（52%），provider 66.9k（68%）。
2. 手动压缩：模型调用 `compress`，范围 `m00001–m00189`。
   - 生成 `b1`：`40.9K → 360 tokens`，189 条消息。
   - `acp.log`：`tokensCompressed=40915 beforeTokens=48325 afterTokens=7785`。
   - 压缩后：`6.8K tool | 1.7K text | 360 summaries`，估算 13.1k（13%），provider 21.2k（22%）。
3. 检索：`search_context("Bilibili ffmpeg search")` 返回 10 条命中，首条为 `b1`。
4. 恢复：`decompress({blockId:"b1"})` 返回 189 条原始消息；`b1` 仍保持 active（读取式恢复，不销毁压缩块）。
5. 持久化：
   - sidecar：`%APPDATA%/OpenFuture/pi/agent/sessions/2026-11-10T08-27-43-496Z_01a1c491-fa07-73c4-a951-094595943450.jsonl.acp.json`
   - 日志：`%APPDATA%/OpenFuture/acp.log`

## 构建

- `out/main/agent-host.js` 51.82 kB
- `out/main/index.js` 87.85 kB
- `out/main/memory-host.js` 136.17 kB
- `out/preload/index.js` 7.13 kB
- `out/renderer/assets/index-DBFaZ8uT.js` 731.05 kB
- `out/renderer/assets/index-3Rholoey.css` 70.72 kB

## 限制

- 自动压缩仍由 billion-context 的阈值/增量策略触发；本次只验证手动 `compress`。长会话自动触发尚未单独计时。
- 压缩摘要本身由 ACP 生成；它只压缩对话消息，不会改动 L3/Wiki 的撤销状态。
- 关闭开关需要重启 agent-host；当前进行中的请求会中止。
- 未重打安装包，当前为开发构建验证。
