# 并行子 Agent 验收记录

- 验收日期：2026-11-11
- 验收对象：`delegate_tasks`（agent-host 内 in-process 并行子会话）及其产品化设置项
- 结论：**通过**。类型检查、构建、离线冒烟、桌面端到端四层全部通过；设置项 → 宿主环境 → 子会话创建链路可复现。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows（MSYS Bash） |
| Node | 24.21.0（`/c/Users/杜世旗/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`；PATH 默认的 node 是 v14，不能直接用于 typecheck/build） |
| Electron | 45.2.3（`node_modules/electron/dist/electron.exe`） |
| 模型 | `tools/mock-model/server.mjs`（OpenAI 兼容 SSE，离线） |
| 子 Agent 设置 | 启用，并发 2（通过 `config/settings.json` 预置） |

## 2. 类型检查与构建

```bash
node <node24> node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json
node <node24> node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.web.json
node <node24> node_modules/electron-vite/bin/electron-vite.js build
```

结果：两条 `tsc` 均 exit 0；构建产物 `out/main/agent-host.js`、`out/main/index.js`、`out/renderer/*` 正常生成。

## 3. 离线冒烟（runtime 层）

命令：`node tools/subagent-smoke.mjs`（自带 mock，动态端口）

| 断言 | 结果 |
| --- | --- |
| 3 个任务状态 | 全部 `done` |
| 结果正文 | 分别含 ALPHA / BETA / GAMMA |
| 并发生效 | wall=2265ms < 0.8×串行总时长（5247ms；串行实测 6559ms） |
| 进度事件 | 9 次，覆盖 `queued` → `running` → `done` |
| 父子会话 | 子会话 JSONL 首行 header 含 `parentSession`，3/3 |
| 退出码 | 0（脚本在 `finally` 中关闭 mock 并 `process.exit`，不留挂起句柄） |

结论：`SubagentRuntime` 的队列、并发、超时/取消、结果截断、父子会话文件与事件回调均符合设计。

## 4. 桌面端到端（Electron + CDP）

命令：`node tools/e2e-subagent.mjs`（脚本内部启动 mock 与构建后的 Electron 应用，mock 与 CDP 端口在运行时动态分配，避免与本机代理冲突）

流程：

1. 以 `OPENFUTURE_USER_DATA=.scratch/e2e-userdata` 启动应用，预置工作区、项目、会话，`subagents: true`、`subagentConcurrency: 2`。
2. 通过 `window.openfuture.saveModel()` 指向 mock 端点，触发 agent-host 重启。
3. `Page.reload` 后等待 bootstrap 渲染会话，聚焦输入框用 `Input.insertText` + Enter 走真实发送路径（首条消息由 UI 创建 Pi 会话）。
4. mock 在 `MOCK_TOOL_CALL=delegate` 模式下返回 `delegate_tasks` 工具调用；子会话因不注册该工具而退回文本。
5. 采集 `window.openfuture.onAgentEvent` 全量事件并截图。

实测结果：

```
[agent-host] subagents enabled concurrency=2 maxTasks=4 parent=...\sessions\2026-11-11T15-24-45-322Z_....jsonl
[agent-host] tools=[...,"automation_cancel","delegate_tasks"] active=[...]
events captured -> 92
types: status, user-message, assistant-start, assistant-message, tool-start,
       subagent, tool-end, text-delta, settled
subagentCount: 6   statuses: queued,queued,running,running,done,done
titles: 视角 A / 视角 B
stripVisible: true
stripText: 并行子 Agent | 2/2 完成 | × | 视角 A | 0.7s | 视角 B | 0.7s
finalMentionsSummary: true   errors: []   → E2E PASSED
```

截图：`docs/assets/subagent-e2e.png`（会话中可见「并行子 Agent 2/2 完成」进度条与汇总回答）。

结论：`delegate_tasks` 在真实桌面进程内端到端打通——工具注册、并行子会话、进度事件、渲染层进度条、汇总回答、会话落盘全部符合预期。

## 5. 设置项链路

| 环节 | 证据 |
| --- | --- |
| 持久化 | `config/settings.json` 中 `subagents` / `subagentConcurrency` 被 `settings-store.ts` 读回（缺失时 `subagents` 默认 true、并发默认 3，非法值回落 3） |
| 宿主环境 | `hostEnvironment()` 输出 `OPENFUTURE_SUBAGENTS=1`、`OPENFUTURE_SUBAGENT_CONCURRENCY=2` |
| 子进程 | `AgentHost` 以 `{...process.env, ...environment()}` 启动，日志 `subagents enabled concurrency=2` 与设置值一致 |
| 重启 | 保存工具与权限后 `host.restart()`，UI 提示「Agent 进程已重启」 |
| 角色继承 | 子会话 `createLiveMemoryExtension('off', undefined, false, agentRole)`，以当前会话角色身份作答 |

## 6. 未覆盖 / 已知限制

- 未做真实模型（非 mock）下的多轮长任务压测；超时 180s、单结果 12K 字符上限未在真实负载下验证。
- 子 Agent 与主 Agent 共享工作区：并行写同一批文件存在覆盖风险，未提供 worktree 隔离。
- `stop` 会级联取消全部子会话（先 `abortAll()` 再 `session.abort()`），但子会话内部工具调用的中断粒度依赖 Pi 的 abort 语义，未逐工具验证。
- 设置项变更依赖 agent-host 重启生效，不能在会话中途热切换。
