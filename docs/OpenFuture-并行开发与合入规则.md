# OpenFuture 并行开发与合入规则

2026-11-09 · v0.2/v0.3 执行补充

主线是 `D:\OpenFuture`。主会话独占主线，先完成 A 批项目壳和界面，再做 B0 项目记忆策略、隔离和串行集成。RAG、Wiki、Dreaming 分别在三个独立本地 Git 副本开发。工作区外的源码与旧候选仅用于参考。由 Codex 核对各路差异、接口和验收后安排合入。

| 会话 | 唯一可写实现目录 | 交付 |
|---|---|---|
| 主线 | `D:\OpenFuture` | A 批与 B0，共享 IPC、界面、项目存储、权限、凭证、构建和最终验收。B1–B3 接入由主线串行执行 |
| RAG | `D:\OpenFuture-parallel\rag\parallel\rag` | Docling 导入原型、证据块定位、QMD 混合检索、排序测试与 Windows 本地回退 |
| Wiki | `D:\OpenFuture-parallel\wiki\parallel\wiki` | pi-llm-wiki stdio 适配、独立暂存 vault、主题页 diff、逐段证据、读侧项目隔离 |
| Dreaming | `D:\OpenFuture-parallel\dream\parallel\dream` | 五阶段状态、授权会话取证、裁决校验、可重试作业、草稿发布契约与撤销回归 |

各路只提交相对于同一个种子快照的增量。允许在各自副本生成被忽略的 `node_modules` 和 `.scratch`，用于独立测试；依赖清单、文档、夹具和验收结果都写在各自的实现目录。现有 `src`、根依赖清单、锁文件和主线都由主线负责。禁止在其他工作区安装或运行开发命令，禁止使用共享正式用户目录、真实凭证及外部服务默认路由。不要把整个副本或生成物拷入主线。

## 统一接入原则

- 主线通过适配器传入项目身份、有效来源、取消信号和本地依赖配置。适配器只产出结果或待审计划，读侧校验与提交事务由主线持有。输入中每条证据使用 `projectId, sourceId, sourceRevision, evidenceId, locator` 标识。locator 用带类型的页码、行号或字符区间表示。
- 跨进程 DTO 使用 JSON 可序列化的数据。原生模块、模型权重、Python 与 MCP worker 只在各自工作区独立验证。外部运行环境未就绪时给出可识别状态和回退证据。不得让故障阻塞对话。
- RAG 返回可核验候选与出处；Wiki 返回主题页草稿、证据和基线修订；Dreaming 返回可审核操作及证据依赖。三路均提供一份 README，写明入口、输入／输出、依赖、调用顺序、验收命令和剩余项。
- 合入前比较种子到各路增量并限制到对应目录。主线以 A/B0 最新可运行状态为基线，先 RAG，再 Wiki，再 Dreaming；每次接入单独跑对应功能和既有 OF-01 至 OF-05 回归。碰到接口冲突只由主线改共享实现。独立合入和失败可回退均须保留前一个候选。

## 已派发的 DSH 会话

- 主线 `1e39c0df-7226-40e0-a0ed-e06caf44bbe9` 仍在开发 A。原 v0.3 排队消息已补充 A/B0 与串行集成职责。
- RAG `aa822678-089d-4989-a3d7-0eae486b9c94`，分支 `worker/rag`，测试端口 19731／19741。
- Wiki `458dec53-4089-4f0e-a2fc-4ea7f412744f`，分支 `worker/wiki`，测试端口 19732／19742。
- Dreaming `a041fb17-1133-4896-ad9c-3f2918e7fb8e`，分支 `worker/dream`，测试端口 19733／19743。
- 三个独立副本基于 `1338eca`，无远程仓库。2026-11-09 14:23（新加坡时间）确认三路已出现模型和工具活动，首轮路径检查均无越界改动。
- 新增多 Agent 独立线 `baa162a0-13ca-4a64-9cd8-cfb21e2cab6d`，工作区 `D:/OpenFuture-parallel/multiagent`，分支 `worker/multiagent`，仅交付 `parallel/multiagent/`，端口 19734／19744。按[多 Agent 协作设计 v0.4](OpenFuture-多Agent协作设计-v0.4.md)实施。
- 新增短期上下文独立线 `f0a60c5e-5aa8-488f-8d7b-fd0909695767`，工作区 `D:/OpenFuture-parallel/context`，分支 `worker/context`，仅交付 `parallel/context/`，端口 19735／19745。按[短期上下文适配设计 v0.5](OpenFuture-短期上下文与BillionContext适配-v0.5.md)实施。
