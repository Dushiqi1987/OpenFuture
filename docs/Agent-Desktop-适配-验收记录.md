# Agent Desktop 适配验收记录（2026-11-15）

## 目标

在保留 windows-mcp（截图 + 坐标）后端的同时，接入 **vercel-labs/agent-desktop**（无障碍树 + `@snapshot:ref`）作为第二套 Computer Use 后端：

- 更快、更确定：一次 `snapshot` 拿到整棵可访问性树与稳定 ref，后续 `click/type/press` 直接作用于 ref，不需要视觉模型或像素坐标。
- 与现有 `computer_*` 工具通道并存，用 `computer_desktop_*` 前缀区分，互不影响。
- 由用户在设置里显式开启，二进制按需下载到 `<userData>/tools/agent-desktop/`。

## 上游项目

| 项 | 值 |
| --- | --- |
| 仓库 | `vercel-labs/agent-desktop`（★23.8k） |
| 协议 | Apache-2.0 |
| 实现 | Rust CLI，通过系统无障碍树读写 UI |
| 版本 | 固定 `1.3.1`（`AGENT_DESKTOP_VERSION`） |
| 分发 | GitHub Release 原生包：`agent-desktop-v1.3.1-x86_64-pc-windows-msvc.tar.gz`（约 1.8 MB） |

> npm 包 `agent-desktop@1.3.1` 只是一个 Node 启动器（postinstall 再下载原生二进制），因此应用直接下载原生 tarball，避免依赖用户全局 npm 与生命周期脚本。

## 实现

| 层 | 文件 | 变更 |
| --- | --- | --- |
| 桥接 | `src/main/agent-desktop.ts`（新增） | `AgentDesktopBridge`：`install()` 下载/解压/验证、`run()` 执行 CLI 并解析 JSON envelope、`call()` 映射 12 个工具、`listTools()` 返回工具定义 |
| 协议 | `src/shared/protocol.ts` | `PublicSettings.agentDesktop`、`SetToolAccessInput.agentDesktop`、`AgentDesktopState`、`agentDesktopState` / `agentDesktopInstall` 通道与 API |
| 设置 | `src/main/settings-store.ts` | `agentDesktop` 字段，默认 `false`，随 `setToolAccess` 持久化 |
| 主进程 | `src/main/index.ts` | 创建桥接；`computer_desktop_*` 分支路由到桥接；`computerTools()` 合并 windows-mcp 与 Agent Desktop；桌面开关也触发 host 打开 computer 工具 |
| IPC | `src/main/ipc.ts` | 状态 / 安装两个 handler；安装完成后 `host.restart()`；工具访问开关透传 |
| preload | `src/preload/index.ts` | `agentDesktopState()`、`installAgentDesktop()` |
| 设置界面 | `src/renderer/src/SettingsDialog.tsx` | 「工具与权限」新增开关、安装状态与「安装 / 重新安装」按钮 |
| mock | `tools/mock-model/server.mjs` | `MOCK_DESKTOP=1` 时调用 `computer_desktop_status`，有结果后回显 |

### 工具映射

| 工具 | CLI |
| --- | --- |
| `computer_desktop_status` | `status` |
| `computer_desktop_apps` / `_windows` | `list-apps` / `list-windows` |
| `computer_desktop_snapshot` / `_find` / `_get` | `snapshot` / `find` / `get` |
| `computer_desktop_click` / `_type` / `_press` / `_scroll` | `click` / `type --stdin` / `press` / `scroll` |
| `computer_desktop_screenshot` / `_launch` | `screenshot --output` / `launch` |

ref 只在一次快照内有效，工具描述里明确要求「UI 变化后重新 snapshot」，避免模型复用过期 ref。

## 验证

### 桥接冒烟 `node tools/agent-desktop-smoke.mjs`

```
install -> 下载 Agent Desktop 1.3.1…
installed -> {"version":"1.3.1","path":"…\\tools\\agent-desktop\\agent-desktop.exe"}
status -> {"permissions":{"accessibility":{"state":"granted"},…},"platform":"windows",…}
snapshot target -> ChatGPT.exe
snapshot -> { "app": "ChatGPT.exe", "complete": true, "ref_count": 25, "snapshot_id": "snckg5mxo72pi", …
tools -> 12 computer_desktop_status,computer_desktop_apps,…,computer_desktop_launch
AGENT DESKTOP SMOKE PASSED
```

### 桌面端到端 `node tools/e2e-agent-desktop.mjs`

```
desktop state before -> {"installed":false,…,"supported":false}
install clicked
desktop installed in settings
desktop state after -> {"installed":true,"version":"1.3.1",…,"supported":true}
message sent
tool row -> "computer_desktop_status · {}"
tool body -> "参数{}结果{… \"platform\": \"windows\", \"ref_count\": …"
answer -> "…桌面工具返回：{…}"
E2E PASSED
```

截图：

- `docs/assets/agent-desktop-settings.png`：设置里显示已安装 v1.3.1。
- `docs/assets/agent-desktop-e2e.png`：会话中 `computer_desktop_status` 步骤展开后显示平台与权限。

回归：`node tools/settings-smoke.mjs`、`node tools/e2e-steps.mjs` 通过；`tsc` 两套与 `electron-vite build` 通过。

## 与 windows-mcp 的分工

| 场景 | 建议后端 |
| --- | --- |
| 需要结构化控件、稳定 ref、逐步操作（表单、菜单、浏览器） | Agent Desktop |
| 需要像素级截图、画布、游戏、无法暴露无障碍信息的应用 | windows-mcp |
| 只是偶尔看一眼桌面状态 | Agent Desktop（冷启动快得多） |

两个后端可以同时开启；工具名不冲突（`computer_*` vs `computer_desktop_*`），模型按描述自行选择。

## 已知限制

- Agent Desktop 依赖系统无障碍权限（Windows 上首次使用需允许）；权限被拒时工具会返回明确错误。
- `snapshot` 的 ref 与窗口实例绑定，窗口重建后旧 ref 失效。
- CLI 版本随应用固定为 1.3.1，升级需要改 `AGENT_DESKTOP_VERSION` 并重新验证。
- 桥接层不做逐次点击确认；高风险操作仍应依赖任务级提示词与人工监督。

## 复现

```bash
pnpm build
node tools/agent-desktop-smoke.mjs
node tools/e2e-agent-desktop.mjs
```
