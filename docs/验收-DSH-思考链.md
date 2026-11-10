# DSH 风格思考链验收记录

## 验收范围

- 连续 assistant 消息合并为一个 turn；
- 一个 turn 仅一个头像；
- 思考、工具调用、中间说明常显，不折叠；
- 流式期间链持续更新并自动跟随底部；
- 历史会话重开后呈现一致；
- 不影响停止、草稿、引用和最终回答。

## 自动化与现场检查

| 检查 | 结果 |
| --- | --- |
| mock 单轮工具调用 | 1 个 assistant article、1 个头像、1 条 chain、`ls` chip 可见 |
| Qwen 多轮历史 | 11 个 assistant 轮次对应 11 个头像，不是每步一个 |
| 正式 Qwen 流式 8 次采样 | `.agent-chain` 始终为 1，`<details>` 为 0 |
| 思考长度变化 | 73 → 274 → 448 字符，链未折叠 |
| 状态头 | `正在思考 / 调用工具1 步` → `思考与工具1 步` |
| 结束后 | 链仍显示，最终正文在链下方 |

## 证据

- `.scratch/v02b-chain-live.json`
- `.scratch/v02b-chain-ui-result.json`
- `.scratch/v02b-chain-tool.json`
- 截图：`v02b-chain-live.png`、`v02b-chain-ui-expanded.png`、`v02b-chain-tool.png`

## 实现位置

- `src/renderer/src/App.tsx`：`buildChatItems`、`buildAssistantTurn`、`AssistantTurnView`
- `src/renderer/src/styles.css`：`.agent-chain-head`、`.chain-rail`、`.chain-step`、`.chain-tool`

## 已知限制

- 思考链常显会占用较多垂直空间，当前 `.chain-rail` 最大高度 420px 并内部滚动。
- 速度/上下文统计在请求结束后更新，流式期间不估算。
