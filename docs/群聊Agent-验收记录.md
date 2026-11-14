# 群聊 Agent 验收记录（2026-11-12）

本记录覆盖「主研 + 评审 + 主持」串行群聊能力的落地验收：协议、运行时、工具、设置项、渲染面板与两条离线验证路径。

## 1. 范围

- 工具：`start_group_chat(goal, constraints?, focus?, rounds?)`
- 运行时：`src/agent-host/group-chat.ts` 的 `GroupChatRuntime`
- 协议：`GroupChatEvent`（`start` / `message` / `end`）经 `AgentStreamEvent.type === 'group'` 推给渲染层
- 设置：`PublicSettings.groupChat` → `OPENFUTURE_GROUP_CHAT=1|0`
- UI：输入框上方的群聊面板（`.group-strip`）

## 2. 环境

| 项 | 值 |
| --- | --- |
| Node | v24.21.0（`…/dsh-primary-runtime/dependencies/node/bin/node.exe`），TS 直接以 type stripping 运行 |
| Pi SDK | `@earendil-works/pi-coding-agent@1.5.0` |
| 模型 | 本地 mock（`tools/mock-model/server.mjs`，`MOCK_GROUP_CHAT=1`，端口运行时随机） |
| 系统 | Windows，Electron 45.2.3 |

## 3. 类型与构建

```bash
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json   # exit 0
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.web.json    # exit 0
node node_modules/electron-vite/bin/electron-vite.js build               # exit 0
```

## 4. runtime 层冒烟（`node tools/group-chat-smoke.mjs`）

脚本自起 mock（随机端口）、临时 agent 目录与父会话，直接驱动 `GroupChatRuntime`：

```text
[consensus path]
status=consensus rounds=2 messages=5 in 3343ms
  #1 lead/work      tools=0 chars=139
  #2 critic/critique tools=0 chars=83
  #3 lead/response  tools=0 chars=147
  #4 critic/critique tools=0 chars=83
  #5 chair/chair    tools=0 chars=98
  ok  status is consensus
  ok  stage order work -> critique -> response -> critique -> chair
  ok  chair starts with 【共识】
  ok  lead speaks twice and critic twice
  ok  start/message/end events emitted

[unresolved path]
status=unresolved rounds=1 messages=3 in 2202ms
  ok  status is unresolved
  ok  stops after the single round (work, critique, chair)
  ok  chair starts with 【未收敛】

[session linkage]
  role session files: 6
  ok  two runs created six role sessions
  ok  all role sessions carry parentSession

total group chat time: 5545ms
SMOKE TEST PASSED
```

含义：

- 共识路径在评审同意、主研表态同意后由主持出【共识】，共 5 条消息；
- 未收敛路径（`rounds=1` + 评审阻断）由主持出【未收敛】，状态 `unresolved`；
- 两次群聊共 6 个角色会话文件，头部 `parentSession` 都指向父会话，说明角色会话挂在主会话树；
- 每次群聊结束释放角色会话（下一次从干净上下文开始），会话文件保留在 `<sessionDir>/group/*.jsonl`。

## 5. 桌面端到端（`pnpm build && node tools/e2e-group-chat.mjs`）

脚本用隔离的 `OPENFUTURE_USER_DATA` 启动真实 Electron，配好 mock 模型后通过 CDP 在 composer 输入任务并回车，走真实 UI 会话创建路径，最后读取事件与 DOM：

```text
[agent-host] group chat enabled criticTools=6
[agent-host] tools=[…,"start_group_chat","delegate_tasks"] active=[…]
events captured -> 90
summary -> {
  "types": ["status","user-message","assistant-start","assistant-message","tool-start","group","tool-end","text-delta","settled"],
  "groupEvents": 7,
  "status": "consensus",
  "roles": ["主研","评审","主持"],
  "stages": ["work","critique","response","critique","chair"],
  "panelVisible": true,
  "panelText": "群聊 · 为 OpenFuture 增加串行群聊能力 | 已达成共识 · 2/2 轮 | …",
  "finalMentionsSummary": true,
  "errors": []
}
E2E PASSED
```

- 主 Agent 正确调用了 `start_group_chat`（mock 只在父会话工具表包含该工具时才发工具调用，角色会话不会递归）；
- 7 个群聊事件 = `start` + 5 条 `message` + `end`；
- 面板渲染出 5 条发言，标题显示目标与「已达成共识 · 2/2 轮」；
- 最终回答包含「群聊已结束」，即工具结果回填主对话；
- 截图：`docs/assets/group-chat-e2e.png`。

### 5.1 工具栏「群聊」手动入口（`E2E_GROUP_MANUAL=1 node tools/e2e-group-chat.mjs`）

不使用模型自主调用，改为点击 composer 左侧工具栏的「群聊」胶囊按钮，弹窗填目标与轮数后启动：

```text
manual entry -> clicked
[agent-host] open session mode=off
[agent-host] group chat enabled criticTools=6
[mock] … stream=true messages=2   （×5：主研/评审/回应/评审/主持）
events captured -> 7
summary -> {
  "types": ["group"],
  "sessionIds": ["01a1ce4f-…"],
  "groupEvents": 7,
  "status": "consensus",
  "stages": ["work","critique","response","critique","chair"],
  "panelVisible": true,
  "panelText": "群聊 · 为 OpenFuture 增加串行群聊能力 | 已达成共识 · 2/2 轮 | … #1 工作汇报 主研 … #5 共识 主持",
  "rows": ["#1 工作汇报 主研 …", "…", "#5 共识 主持 …"],
  "errors": []
}
E2E PASSED
```

- 入口按钮调 `openfuture:group-chat:start`（`host.startGroupChat`），不再等模型决定是否调 `start_group_chat`；开启前会先 `openConversation` 确保主会话已打开（`host.startGroupChat` 需要 `sessionId`，事件也按它过滤）；
- 面板只在 host 的 `start` 事件到达时创建，避免「乐观占位」的 `chatId` 与真实 `chatId` 不一致导致后续 `message`/`end` 被丢弃（首版即踩到此坑，面板停在「讨论中 · 0/2 轮」）；
- 5 条发言顺序与自动路径一致，结论仍会回到主对话（手动入口下主 Agent 不强制回显，`finalMentionsSummary` 仅对自动路径断言）；
- 截图：`docs/assets/group-chat-manual-e2e.png`。

### 5.2 冷启动凭据修复（2026-11-12）

用户实测（真实模型 `openfuture/qwen3.7-flash`）出现「群聊 · … 失败 · 0/3 轮 / 等待主研开工…」：

- 根因：`src/main/ipc.ts` 只在 `sessionSend` 里调用 `host.setCredential(...)`。手动入口 `openfuture:group-chat:start` 直接 `host.startGroupChat(...)`，若用户自 host 启动/重启后还没发过普通消息，host 的 `ModelRuntime` 没有 runtime key；角色子会话拿到 `models.json` 里的占位 key，DashScope 立即返回 `401 Incorrect API key provided`，assistant 消息 `stopReason='error'`、正文为空，于是 0 轮失败。
- 修复：`groupChatStart` 处理器在 `host.startGroupChat` 之前按 `sessionSend` 的方式推送凭据（`store.getActiveCredential()` → `host.setCredential(...)`）；注释说明角色会话共用 host runtime、首次 prompt 前必须推 key。
- 可观测性：`group-chat.ts` 的 `speak()` 在空文本时把 `stopReason`/`errorMessage` 写进错误文案，面板不再只显示「等待主研开工…」；渲染层 `GroupChatView.error` 在 `end` 事件里保留该文案，失败时列表底部展示。
- 验证（冷启动路径，`.scratch/repro-real-group.mjs`，`REPRO_COLD=1` 时不先发普通消息）：

```text
end events -> [{"type":"end","chatId":"gc-f8eceeba","status":"unresolved","rounds":2,"durationMs":176405}]
panel -> "群聊 · 讨论…就业方向 | 未收敛 · 2/2 轮 | #1 工作汇报 主研 5 次工具 …"
```

回归：`node tools/e2e-group-chat.mjs` / `E2E_GROUP_MANUAL=1 node tools/e2e-group-chat.mjs` 均 `E2E PASSED`；`node tools/group-chat-smoke.mjs` `SMOKE TEST PASSED`（5593ms）；两套 `tsc --noEmit` 与 `electron-vite build` 通过。

### 5.3 面板显示与等待反馈（2026-11-12）

- 现象：面板里的长发言在 700 字处被截成「…」，看起来像「显示不全」。
- 原因：渲染层 `previewGroupText()` 固定截断 700 字符。
- 修复：改为完整渲染（`clampGroupBody`，仅 4 万字符保护并提示「完整内容见会话文件」）；每条发言体内部滚动（`.group-message-body{max-height:340px;overflow-y:auto}`），面板高度提升到 `min(54vh, 540px)`。
- 校验（真实模型）：`body lengths -> rows 3380/1373/4018/1547/1566`，与 group 事件里的 `message.text.length` 完全一致，即不再截断。
- 等待反馈：真实模型首条发言约 36–44 秒、整场约 3 分钟，原先一直显示「等待主研开工…」。现在显示阶段提示（`groupPhaseHint`）与已等待秒数（`formatGroupElapsed`），计数栏运行中显示「已用 1m12s」。
- 实测时间线（`qwen3.7-flash`，冷启动）：`start 0s → 工作汇报 44.4s → 质疑 60.6s → 回应 113.8s → 质疑 136.0s → 主持 177.8s`。
- 截图：`docs/assets/group-chat-full-panel.png`（真实模型，第 3 条「回应」完整渲染、卡片内滚动）。

### 5.4 侧边栏群聊面板与成员模型（`node tools/e2e-group-panel.mjs`）

侧边栏新增「群聊」入口，面板分三块：历史讨论列表、成员与模型、额外模型与讨论记录。

| 断言 | 实测 |
| --- | --- |
| 侧边栏 `.dsh-nav` 点击后出现 `.group-chats-modal` | 通过 |
| 表单新增额外模型档案（名称/接口地址/模型 ID/API Key） | `gm-82750b25` |
| 「评审」下拉绑定该档案 | `groupChatModels.critic === gm-82750b25` |
| 群聊状态与发言数 | `consensus`，5 条（work/critique/response/critique/chair） |
| 历史落盘 | `listGroupChats` 返回 1 条，`getGroupChat().messages === 5`，成员快照保留评审绑定 |
| 宿主解析角色模型 | 日志 `[agent-host] group models lead=primary critic=profile chair=primary` |
| Agent 错误 | 无 |

- 截图：`docs/assets/group-chat-panel.png`（面板：历史列表 + 三角色模型下拉 + 额外模型表单）、`docs/assets/group-chat-panel-run.png`（绑定评审模型后的讨论结果）。
- 实现要点：额外模型写进 `models.json` 的独立 provider（`openfuture-g-<id>`），密钥写 `config/secrets/group-<id>.bin`（safeStorage）；保存/删除档案会重启 Agent 进程以重载 provider 列表，角色绑定通过 `groupChatStart` RPC 随请求下发、不重启；历史由主进程 `GroupChatStore` 折叠 `group` 事件写到 `<userData>/config/group-chats/*.json`。
- 已知取舍：成员绑定是全局默认，不是每场群聊单独配置；面板里的历史记录不能在 UI 里删除（文件可手动清理）。

## 6. 设置项链路

| 环节 | 行为 |
| --- | --- |
| 设置对话框勾选/取消「启用群聊 Agent」 | 与 PowerShell、子 Agent 合并成一次 `openfuture:tools:set-access` |
| `parseSetToolAccessInput` | `groupChat` 必须是布尔，否则报「群聊 Agent 开关必须是布尔值」 |
| `settings-store` | `setGroupChat()` 落盘；`hostEnvironment()` 注入 `OPENFUTURE_GROUP_CHAT` |
| 宿主重启 | 保存后自动 `host.restart()`；下次 `openSession` 依据开关创建运行时 |
| 关闭时 | 不注册 `start_group_chat`，模型工具表里看不到该能力 |

## 7. 未覆盖

- 真实模型下的群聊质量：目前只跑过 1 次真实任务（`qwen3.7-flash`，2 轮 / 176s，状态 `unresolved`，双方未收敛）；建议再用强模型跑 2–3 个任务，观察评审是否给出带证据的质疑、结论是否收敛。
- 评审换模型：已支持额外模型档案与按角色绑定（见 5.4），但尚未在真实模型上验证「主研千问 + 评审 DeepSeek」这类跨厂商组合；mock 只验证了协议与解析路径。
- 写操作：当前主研也只有只读工具；写路径由主对话在群聊结论之后执行。
- 并发群聊：同一主会话同时只能有一个群聊在跑（`stop` 会级联取消）。
