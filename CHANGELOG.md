# Changelog

## Unreleased

### Added

- DSH 风格常显思考链：连续 assistant 消息合并为一个 turn，一个头像，工具/思考实时展示；
- 输入框上方上下文使用率、Token 速度、前缀缓存命中率；
- Qwen3.7-flash 接入与 thinking_budget 约束记录；
- 项目级记忆策略持久化与重启回放（B0）；
- GitHub 发布与验收文档。

### Changed

- 强调色从青绿改为浅蓝；
- 删除思考链 `<details>` 折叠交互，改为常显链；
- `memory-host.setMode` 首个项目设置时自动建 workspace 行。

### Fixed

- 同一目录重复选择定位已有项目，而不是报错；
- 草稿切换后被旧对象覆盖；
- 首次发送标题停留在“新对话”；
- 无模型时无法创建空对话。

## v0.2 A

- 三栏项目化外壳、项目树、独立项目对话、旧 workspace 迁移、主题、tooltip、目录缺失恢复。

## v0.3 B0

- 项目级记忆策略与隔离：RAG/Wiki/Dreaming/关闭，旧组合保留为高级。

## P3.4

- OF-01～OF-05 安全整改。

## P3.3

- QMD 可选词法检索、pi-llm-wiki MCP 检索与 FTS5 回退。

## P3.2

- 会话取证、错笔记纠正、证据撤销守卫、system 注入复验。

## P3.1

- 撤销状态过滤、grep 正则 Worker、历史工具结果清理。

## P3

- 质量门、Token 预算、空闲调度。

## P2

- Dreaming 裁决/发布/回滚/撤销、L3 注入。

## P1

- 记忆层 L0–L2、RAG/Wiki/组合、引用。

## P0.1 / P0

- 桌面底座、流式对话、凭证绑定、工具边界。
