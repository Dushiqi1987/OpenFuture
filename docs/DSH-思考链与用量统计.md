# DSH 风格思考链与用量统计

## 目标

把原先“每条 assistant 消息一个头像、每步工具调用就折叠一次”的对话流，改成 DSH 风格的连续思考链：

- 一个用户回合后的所有连续 assistant 消息合并成一个 turn；
- 每个 turn 只显示一个 OpenFuture 头像；
- 思考、工具调用和中间说明在链中常显，不折叠；
- 最终回答单独显示在链下方；
- 在输入框上方显示上下文使用率、Token 速度和前缀缓存命中率。

## 数据流

Pi 的 `AssistantMessage` 包含 `usage` 和可选的 `durationMs`。OpenFuture 在 `agent-host` 的 `toChatMessage` 中把 usage 提取成协议里的 `MessageUsage`，因此：

- 实时 `message_end` 事件携带 usage；
- 打开历史会话时也从 JSONL 恢复 usage；
- 前端不依赖额外 RPC。

## 指标公式

设：

- `promptTokens = input + cacheRead + cacheWrite`
- `contextWindow` 取当前模型配置，缺省 128000
- `durationMs` 为该次响应耗时

则：

- 上下文使用率 = `promptTokens / contextWindow`
- Token 速度 = `output / (durationMs / 1000)`，单位 tok/s
- 前缀缓存命中率 = `cacheRead / promptTokens`

没有 usage 时显示 `—`，避免把“未知”显示成 0%。统计在请求结束后更新，不做流式估算。

## 验证

- Qwen3.7 Flash，单轮：raw usage `input=517, output=37, cacheRead=1536, cacheWrite=0, durationMs=1056`
- 推导：上下文 1.6%、速度 35.0 tok/s、缓存命中 74.8%
- 刷新并重新打开历史会话后三项仍在
- 正式配置下显示 `上下文 2.0% · 2.6K/131.1K`、`速度 80.4 tok/s`、`缓存命中 58.2%`

证据见 `.scratch/v02b-usage-stats.json`、`.scratch/v02b-usage-stats.png`、`.scratch/v02b-usage-formal.png`（`.scratch/` 不入库）。

## 已知限制

- 没有 usage 时不显示估算值。
- 缓存写入（cacheWrite）参与上下文计算，但暂未单独展示。
- 速度是响应结束后的平均值，不包含首 token 延迟。
