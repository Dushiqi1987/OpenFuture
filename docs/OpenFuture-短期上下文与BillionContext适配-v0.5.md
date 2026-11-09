# OpenFuture 短期记忆与上下文管理 · v0.5 验证设计

2026-11-09 · Windows 桌面 · 独立开发线

## 1. 当前 Pi 能力与适配结论

OpenFuture 固定使用 `@earendil-works/pi-coding-agent@1.5.0`。当前 Agent Host 创建 Pi SessionManager 并使用 Pi 原生会话投影。Pi 默认启用自动压缩，达到 `contextWindow - reserveTokens` 时可总结较旧的上下文，保留最近内容和可用的文件操作线索。Pi 的默认预留是 16,384 token，近期保留 20,000 token，可按模型调整。压缩记录追加到会话 JSONL，后续模型请求使用摘要和近期消息，原始记录仍可供历史与审计读取。Pi 还支持分支摘要和有限的窗口溢出恢复。应用当前没有独立的上下文管理面板。[Pi 压缩参考](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)

Billion Context 提供主动分块压缩、压缩块查找、按需恢复和用量状态。主仓同时提供 Pi 与 DSH 接入。其 Pi 原生安装形态仍有代理、供应商注册与可选委派工具，需要验证宿主环境；单独的 `billion-context-pi` 提供进程内 `createAcpExtension` 和 `createRuntime` 宿主入口；`acp-kernel` 提供压缩与状态管理内核，可在需要更精细控制时复用。把三者分别当作待评估的接入面，择一交付。[Billion Context](https://github.com/ranxianglei/billion-context) · [Pi 宿主适配合同](https://github.com/ranxianglei/billion-context-pi/blob/master/docs/host-adapter.md) · [ACP Kernel](https://github.com/ranxianglei/acp-kernel)

本机已确认 Pi SDK 可以导入，且 SessionManager 实际导出 `buildContextEntries`、`getSessionId` 和 `getSessionFile`。OpenFuture 已在 `src/agent-host/index.ts` 通过 `DefaultResourceLoader.extensionFactories` 加载自有记忆扩展，具备显式加载应用内适配器的接缝。应用仍维持工作区扩展自动发现关闭。此结论支持立项做原型，实际压缩、兼容性和质量须由可重复的 Windows 测试确认。

## 2. 产品设计

会话菜单新增「上下文管理」，模式为 **Pi 标准**与**高级压缩（实验）**。默认 Pi 标准，允许按项目设默认值、按会话覆盖。面板显示模型上下文窗口、估计占用、压缩次数、近期保留、摘要块与可检索范围。提供手动压缩、查看原文和受限恢复入口。原始历史仍由 Pi JSONL 提供，摘要与原文在 UI 明确区分。

短期上下文始终归当前项目和 Pi 会话，分支间可见性以当前投影为准。它与 RAG、Wiki、Dreaming 以及 L3 发布隔离。短期压缩产物默认不进入项目知识库。用户明确导入原会话时，取证从授权的原始消息读取，压缩摘要只可用于导航。多 Agent 模式的每个子会话都独立压缩；父任务需要共享的上下文由多 Agent 的消息或产物机制传递。

## 3. 实现与接入边界

1. **S0 原生基线。** 在固定 Pi 版本上使用本地模拟模型跑长会话。记录原生压缩触发点、落盘与恢复、摘要与保留边界、输入 token（估算及服务端用量分别标注）、延迟和事实保留。对话夹具含项目路径、模型 ID、API 合同、工具失败、撤销标记和最近尚未完成的任务。
2. **S1 进程内原型。** 首选验证 `billion-context-pi` 的公开宿主适配入口，在独立桌面或最小 Pi SDK 宿主上显式安装工厂。版本以 npm 包和提交记录为准。通过工具开关只保留上下文管理能力，排除其自带的 `acp_delegate*`。若整套扩展会重建消息并绕过 OpenFuture 的权限过滤，或缺少稳定的非代理接缝，则复用 `acp-kernel` 的必要能力，由 OpenFuture 持有投影、工具与状态适配。优先不改模型端点，不安装证书、全局插件和外部代理，不读取或复用 DSH 正式配置。验证时只用本地模拟端点和假凭证。
3. **S2 单一压缩所有者。** 同一运行只能由一个策略改写上下文。Pi 标准始终可用。实验模式初始化成功并完成会话兼容检查后，才可接管自动压缩。适配失败、状态损坏或超时则恢复 Pi 原生路径；若当前会话已有特殊块，先从合法的原始投影重建并重新检查预算，保留原文和可诊断状态。模式切换在运行边界生效。
4. **S3 权限过滤与上下文完整性。** 在摘要生成输入和最终出站两端执行项目及证据过滤。派生摘要保留来源修订标识，旧内容撤销后使相关块失效；无法安全定位时让相关块重算或不出站。压缩、查找和恢复均不得重引入失效证据。维护工具调用与结果的配对、系统指令、当前用户问题、用户/助手角色与有效顺序。L3 和检索工具结果沿用当前安全约束，禁止摘要重新晋升文档中的注入指令。
5. **状态与恢复。** sidecar 或独立数据库按 `projectId / sessionId / branch lineage / revision` 存储或校验。写入原子化，保存格式版本、块覆盖范围、证据引用和校验值；并发写入需要互斥或版本检查。回到旧分支、重启、恢复历史会话时重新绑定。索引只可查已授权且当前可见的原始消息。状态与日志默认只记录必要诊断，禁止写入密钥、完整授权头或跨项目内容。
6. **部署与许可。** 用户界面、文档或关于页应按实际引入版本保留许可证与要求的署名链接。Billion Context 主仓许可含可见产品的附加署名条款，适配时还需核对所用版本的独立 Pi 包、ACP 内核与传递依赖许可证。记载锁定版本、上游提交与依赖变更，关闭自动安装与隐式更新行为。[Billion Context 许可](https://github.com/ranxianglei/billion-context/blob/master/LICENSE) · [ACP Kernel 源码与许可](https://github.com/ranxianglei/acp-kernel)

## 4. 验收

| 试验 | 通过条件 |
|---|---|
| Pi 标准回归 | 同一长会话跨过自动压缩阈值，原历史可读，近期未完成任务可继续，重启后恢复 |
| 实验压缩 | 模拟模型触发分块压缩，查询、按需恢复、后续工具调用与重复压缩可用；上下文预算有剩余，窗口限制未被突破 |
| A/B 对照 | 同一模型与同一任务比较原生和实验的累计出站输入、峰值 token、摘要额外调用、延迟、事实与约束保留。节省以测量结果为准，不预设收益 |
| 撤销与分支 | A/B 项目、原会话/分支/子会话使用不同哨兵。压缩或恢复不越权，撤销后摘要与旧工具结果均不出站 |
| 故障回退 | 适配器未加载、sidecar 损坏、摘要失败、超时、停止和 429 时，普通对话可恢复，保留原 JSONL，禁止双重压缩和错误重复派发 |
| Windows 桌面 | 可运行 EXE 内完成开关、原生与实验模式、历史恢复和现有 OF-01 至 OF-05 安全回归；未跑项目列为待验证 |

## 5. 并行开发边界

工作区 `D:\OpenFuture-parallel\context`，分支 `worker/context`，基础快照 `1338eca`。实现、测试、依赖说明和验收报告仅写入 `parallel/context/`。测试端口 19735／19745。先交 S0、S1 的最小原型及证据，再推进 S2、S3。主线审查后才接入桌面 Agent Host 和正式配置。

## DSH 派发记录

- 新会话 `f0a60c5e-5aa8-488f-8d7b-fd0909695767` 收到任务消息 8，已观察到模型和工具活动。S0／S1 尚待实际交付和独立验收。
