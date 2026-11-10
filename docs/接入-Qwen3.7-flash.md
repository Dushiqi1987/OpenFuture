# 百炼 Qwen3.7-flash 接入记录

## 配置

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model ID: qwen3.7-flash
Context Window: 128000
Max Output Tokens: 65536
Reasoning: true
```

## 首次失败

使用 `maxTokens=8192` 时返回：

```text
400: max_completion_tokens [8192] must be greater than thinking_budget [32768]
```

这是 Qwen thinking 模型的服务端参数约束，不是凭证或网络问题。

## 解决

把最大输出 token 设为 `65536`（大于默认 thinking_budget 32768），重启后正常流式返回 `QWEN_OK`，思考链可见。

## 证据

- `.scratch/qwen-smoke.json`
- 正式 app 实测上下文/速度/缓存统计正常

## 建议

模型中心应对开启 thinking 的 Qwen 模型自动给足最大输出，或在界面暴露 thinking_budget，避免用户首次配置即报 400。
