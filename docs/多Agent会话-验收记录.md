# 多 Agent 会话模式验收记录

日期：2026-11-11

## 需求

用户要求新增一个功能按钮，进入“多 Agent 模式”；每个 Agent 继承现有会话能力，给会话加角色名和角色提示词，例如：

- 名称：赋能财经智能体
- 角色提示：我是一个财经助理，回答需严谨并提示风险

本实现是轻量的“多个命名角色会话”，不引入 `v0.4` 的 Super-Agent 任务图/收件箱/并行调度。

## 实现

### 数据模型

- `ProjectConversation` 增加 `agentName`、`agentPrompt`；有这两个字段的会话即为 Agent。
- `AgentSummary` 用于“多 Agent”面板跨项目列出 Agent。
- `ProjectStore.updateConversation` 支持设置/清空角色；清空名称会把会话恢复为普通对话。
- `ProjectStore.listAgents` 返回所有带角色的会话。
- `ProjectStore.deleteConversation` 只删除项目注册表中的对话，Pi 会话 JSONL 保留。

### 角色注入

- `AgentHost.open` 增加 `agentRole`，RPC `open` 透传到 agent-host。
- `openSession` 校验角色并传给 `createLiveMemoryExtension`。
- `before_agent_start` 返回完整 system prompt：
  - 记忆关闭时也注入角色；
  - 角色放在系统提示最前面，并包含“你不是 Pi/编码助手”的身份约束；
  - 记忆开启时，在角色之后追加 `<memory_context>`。
- 修复了 `dispatch` 的 `case 'open'` 漏传 `agentRole`（以及 `automationTools`）的问题；该遗漏导致主进程已取到角色、agent-host 却收到 `undefined`。

### UI

- 侧栏新增「多 Agent」入口。
- 面板包含 Agent 卡片、创建/编辑/删除/打开。
- 创建表单：角色名、所属项目、角色提示词；创建后自动打开。
- 聊天 header 显示 `◈ <角色名> · 角色`，composer placeholder 显示“以 <角色名> 身份输入…”。

## 验证

- 正式 Qwen3.7 Flash，记忆模式关闭，新建 Agent 会话。
- 创建 `赋能财经智能体`，提示词为“你是一名资深财经助理……”；发送“请用一句话说明你是谁、你的职责是什么”。
- 回复：

  > 我是**赋能财经智能体**，一名资深财经助理，专注于财务分析、公司及市场研究，为用户提供严谨的财经决策支持。

- 旧会话（角色注入修复前创建）仍可能沿用历史中的 Pi 身份；新建 Agent 会话正常。
- 已验证 `agentsList`、角色持久化、角色 badge、删除重复测试会话。
- 截图：`docs/assets/agent-mode.png`；测试结果：`.scratch/agent-mode-result.json`。

## 构建

- `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json`
- `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.web.json`
- `node node_modules/electron-vite/bin/electron-vite.js build`

产物：

- `out/main/agent-host.js`（含角色注入）
- `out/main/index.js`（含 agentsList/deleteConversation）
- `out/preload/index.js`
- `out/renderer/assets/index-*.js` / `index-*.css`

## 限制

- 角色提示作为 system prompt 注入；模型仍可能受历史会话中旧身份影响，建议新 Agent 使用新会话。
- 删除 Agent 只删注册表，不删 Pi JSONL。
- “多 Agent”是命名角色会话，不是并行多 Agent 协作；后者仍在 `parallel/multiagent` 原型中。
- 未新增安装包。
