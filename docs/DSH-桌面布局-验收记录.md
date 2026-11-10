# DSH 风格桌面布局与交互 — 验收记录

## 目标

把 OpenFuture 的主界面改成 DSH 风格的桌面布局，并让新布局中的主要按钮真正可用；同时评估 `dsh-windows-mcp` 的 Computer Use 适配路径。

参考：

- `docs/assets/dsh-shell-dark.png`
- `docs/assets/dsh-shell-light.png`

## 已实现

### 侧栏（342px）

- 移除旧的 48px 图标栏和 248px 项目栏的双栏组合，改为单列 DSH 侧栏。
- 顶部 `应用 / 编辑` 菜单：
  - 应用：新建项目、模型与密钥、项目记忆、诊断日志、关于。
  - 编辑：复制当前对话、全选输入框、保存草稿。
- 品牌区、`＋ 新会话`、`插件 / 自动化任务 / 更多`。
- 工作区搜索、排序（名称/最近）、新建工作区。
- 工作区列表沿用项目注册表：目录不可用、归档、重命名、打开文件夹、重新定位、恢复。
- 每个工作区可展开查看会话与新建会话。
- 底部用户区、主题切换、项目记忆、诊断日志、设置。

### 主区

- 顶部工作区/用途、会话标题，以及 `对话 / 轨迹 / 上下文` 标签：
  - 对话：原消息流与常显思考链。
  - 轨迹：当前会话保存的思考、工具名与时间。
  - 上下文：工作区、项目用途、上下文使用率、缓存命中与入口按钮。
- DSH 欢迎空状态：品牌标记、工作区名、路径、用途、`新会话`。
- Composer：
  - `＋`：新建工作区、新会话、项目记忆、诊断日志、模型与密钥。
  - 工作区下拉：切换项目。
  - 用途下拉：RAG / Wiki / Dreaming / 关闭（旧组合保留为高级 legacy）。
  - Computer Use 开关与说明面板。
  - 模型按钮打开模型与密钥设置。
  - 圆形发送按钮。
- 底部通栏状态栏：轮数/步数、tok/s、累计 token、缓存命中、上下文占用环。
- 浅色/深色主题沿用原有 `data-theme` 与 localStorage。

### 按钮映射

| 控件 | 行为 |
| --- | --- |
| 应用 / 编辑 | 顶部菜单 |
| 新会话 | 在当前工作区创建并打开草稿 |
| 插件 | 插件面板（项目记忆 / Computer Use / 协作运行） |
| 自动化任务 | Dreaming 与质量检查入口 |
| 更多 | 主题、设置、日志、关于 |
| 工作区搜索/排序/新建 | 搜索项目、名称/最近排序、新建项目 |
| 工作区行 | 切换项目并打开上次会话 |
| 用途下拉 | `setProjectMemoryPreset` 持久化 |
| 模型 | 打开 `SettingsDialog` |
| Computer Use | 打开适配说明与开关 |
| 发送 | 原发送链路 |

## 验证

测试实例：CDP 9257，正式 Qwen3.7 Flash 配置，隔离检查不写入用户配置。

- 侧栏宽度 342px；旧 `.rail` 数量 0；无横向溢出。
- 状态栏宽度与主区一致（1549px 窗口下 1207px），文本无截断。
- 标签切换：
  - 轨迹：5 个轨迹条目。
  - 上下文：4 个信息卡。
- 用途切换：RAG → Wiki → RAG 均成功，`memory-chip` 与通知同步；API 持久化。
- Computer Use：面板打开、开关切换、localStorage `openfuture-computer-use` 写入、关闭后恢复。
- 主题：light/dark 切换正常，`rgb(247,248,250)` / `rgb(9,13,18)`。
- 截图：`docs/assets/dsh-shell-dark.png`、`docs/assets/dsh-shell-light.png`。

## Computer Use 适配结论

`dsh-windows-mcp` 是 DSH 专用 carrier bundle，依赖 DSH Desktop 的内置 MCP bridge 与 `uvx windows-mcp@0.8.8 serve`，不能直接作为 OpenFuture 插件加载。

当前 OpenFuture 已实现：

- Computer Use 开关、权限说明、安装命令复制、插件文档入口。
- 未安装 `uv/uvx` 时明确提示，不虚假暴露工具。

尚未实现：

- OpenFuture 自己的 MCP stdio 客户端与 `windows-mcp` 工具桥接。
- 截图/点击/输入等 18 个工具到 agent-host 的映射。

后续若安装 `uv`，可在 `agent-host` 侧新增 MCP client，按 Computer Use 开关动态注册工具；这是独立的安全敏感改动，需要单独验收。

## 构建

- typecheck：node/web 通过。
- `electron-vite build`：
  - renderer `index-DkbWxbzj.js` 721.80 kB
  - CSS `index-BM3Gyoh-.css` 73.85 kB
  - main `index.js` 76.33 kB；memory-host 136.17 kB；agent-host 46.90 kB；preload 7.13 kB
- 未重新打包 EXE；当前验证运行开发构建。

## 已知限制

- 工作区列表仍带会话子列表，比 DSH 原版更密；后续可改成“最近会话”抽屉。
- 插件/自动化面板目前是功能入口，不是完整插件市场/调度器。
- Computer Use 仅 UI 与状态说明，实际工具桥接未接入。
- 主题浅色下的部分旧组件仍沿用旧变量；已覆盖主 shell 与 composer。
