# MCP 服务与技能（Skills）验收记录（2026-11-14）

## 目标

在 OpenFuture 里直接管理两类「外部能力」，并让主 Agent 在会话中真正用上：

- **MCP 服务**：接入 Model Context Protocol 服务器（stdio / HTTP），工具以 `mcp__<服务>__<工具>` 暴露；
- **技能**：接入 Agent Skills 风格的 `SKILL.md` 指令包，模型按需读取正文，或用 `/skill:<名字>` 显式调用。

两者都不引入新进程模型：MCP 由 Pi 内置扩展在 agent-host 内连接，技能由 `DefaultResourceLoader` 在启动时扫描。

## 实现位置

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 协议 | `src/shared/protocol.ts` | `McpTransport`、`McpServerInput/Info`、`McpConfigState`、`SkillInfo`、`SaveSkillInput`，以及 7 个 IPC 通道 |
| 主进程 | `src/main/mcp-store.ts` | 读写 `<userData>/pi/agent/mcp.json`，原子写，名称/字段校验，写回时固定 `exposure: "direct"` |
| 主进程 | `src/main/skills-store.ts` | 读写 `<userData>/skills/<name>/SKILL.md`，frontmatter 解析与校验 |
| 主进程 | `src/main/ipc.ts` | 7 个处理器；增删改后调用 `host.reloadPlugins()` 让下一次会话重新加载 |
| 宿主 | `src/agent-host/index.ts` | `PI_CODING_AGENT_DIR` 指向 agentDir；注册内置 `mcp` 扩展；`additionalExtensionPaths: ['builtin:mcp']`；`additionalSkillPaths: [<userData>/skills]`；工具白名单加 `mcp__*`；`bindExtensions()` 触发 `session_start` |
| 界面 | `src/renderer/src/SettingsDialog.tsx` + `styles.css` | 设置新增「MCP 服务」「技能」两组：列表、启停、删除、内联添加表单 |

关键常量：

- MCP 配置：`<userData>/pi/agent/mcp.json`，形状 `{ "mcpServers": { "<name>": { command, args?, url?, exposure?, enabled? } } }`；
- 技能目录：`<userData>/skills/<name>/SKILL.md`，名字限 `[a-z0-9][a-z0-9-]{0,39}`，描述 ≤ 400 字，正文 ≤ 4 万字符；
- 工具前缀：`mcp__`；`OPENFUTURE_MCP=0` 可整体关闭。

## 验证

`node tools/mcp-smoke.mjs`（需要先 `pnpm build`）会：

1. 生成一个临时 profile：一个 stdio MCP 服务（`.scratch/mcp/demo-server.mjs`，工具 `echo`）+ 一个技能 `release-notes`；
2. 启动 Electron + mock 模型，通过真实输入框发一条消息（会话由此打开）；
3. mock 模式 `MOCK_REPORT_TOOLS=1` 把收到的工具名原样回显，断言模型确实收到 `mcp__demo__echo`；
4. 断言宿主日志 `[agent-host] skills=["release-notes"]`；
5. 再发一条 `/skill:release-notes 检查发布说明`，断言 mock 收到的 prompt 已经展开成 `<skill name="release-notes" …>` 与技能正文；
6. 打开设置，检查「MCP 服务」「技能」两组分别列出 `demo` 与 `release-notes`。

实测输出（2026-11-14）：

```
model saw tools -> MOCK_TOOLS: read,grep,find,ls,web_search,current_time,automation_create,automation_list,automation_set_active,automation_cancel,mcp__demo__echo
skills line -> [agent-host] skills=["release-notes"]
skill expansion -> <skill name="release-notes" location="D:\OpenFuture\.scratch\mcp-smoke-userdata\skills\release-notes\SKILL.md">
MCP SMOKE PASSED
```

界面截图：`docs/assets/mcp-settings.png`。

## 实现注意事项

- `/skill:<name>` 的展开发生在 `AgentSession.prompt` 内部，只有 `expandPromptTemplates` 为 `true` 时才会调用 `_expandSkillCommand`（`dist/core/agent-session.js:1678-1680`）。`src/agent-host/index.ts` 的 `sendMessage` 只在文本匹配斜杠命令时才打开该开关，因此命令正则必须包含冒号：`/^\s*\/[A-Za-z][\w:-]*(\s|$)/`。使用 `[\w-]` 会把 `/skill:name` 判成普通消息，模型收到的就是原始命令文本。

## 参考的开源项目（2026-11-14 数据）

| 项目 | Star | 许可 | 我们借鉴了什么 |
| --- | ---: | --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills) | 194,254 | 无 LICENSE 文件 | Agent Skills 约定：`SKILL.md` + `name`/`description` frontmatter，系统提示只放名称与描述、正文按需读取（渐进披露），`disable-model-invocation` 控制是否允许模型自动触发。 |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | 97,689 | MIT | 服务目录的组织方式（按用途分类、安装命令即配置），是我们做「添加服务」表单与示例文案的参照。 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | 91,979 | 自定义（NOASSERTION） | 官方参考服务器的 stdio 启动形态（`command` + `args` + `env`），用来验证我们的 `mcp.json` 能直接跑通这类服务。 |
| [oraios/serena](https://github.com/oraios/serena) | 31,367 | 自定义（NOASSERTION） | 重型 MCP 工具集（语义检索/编辑）的暴露策略：一次连接可能带来十几个工具，必须按服务器粒度启停，而不是全量塞给模型。 |
| [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | 24,855 | MIT | `stdio` 与 HTTP 两种传输的初始化握手（`initialize` → `notifications/initialized` → `tools/list`），本项目的冒烟服务按同一顺序实现。 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 13,765 | 自定义（NOASSERTION） | 同上的 TypeScript 版本；`mcp__<server>__<tool>` 命名空间化思路与之一致，避免不同服务器的同名工具互相覆盖。 |

设计取舍：MCP 采用「文件配置 + 会话启动时连接」，而不是把服务器嵌进进程；技能采用「目录扫描 + 显式目录白名单」，不读取 `~/.pi` 或项目内的 `.pi/skills`，避免不同项目互相污染。两者共用同一条 `host.reloadPlugins()` 重载路径。

## 侧边栏技能面板（2026-11-14）

参考 Codex 的「技能」页做了独立面板（左侧栏「✦ 技能」），不再只靠设置里的列表：

- **搜索**：按名称或描述即时过滤，已安装与技能库两个分区共用同一个搜索框。
- **已安装 / 技能库**：已安装区显示卡片（名称、描述、系统/个人来源、是否仅显式调用、更新时间、启用开关）；技能库列出内置模板，点「安装」写入 `skills/` 并切回已安装。
- **个人 / 系统筛选**：内置模板标记为 `builtin`（`.openfuture-builtin.json` 记录来源），手建技能为 `user`。
- **详情**：点卡片打开全文预览、文件路径、更新时间，可停用/启用、复制路径、删除。
- **启用/停用**：停用会把目录移到 `<userData>/skills-disabled`（Agent 不扫描该目录），启用时移回，`host.reloadPlugins()` 让下一次会话重新读取。
- **新建**：面板内直接填名称、描述、正文和「仅显式调用」，保存后立即出现在列表。

内置模板 6 个：`code-review`、`commit-message`、`release-notes`、`test-plan`、`api-contract`、`bug-report`。首次启动只落盘 `code-review` 与 `release-notes`，其余留在技能库供安装。

验证（`node tools/skills-panel-smoke.mjs`）：

```
installed -> {"count":2,"names":["code-review","release-notes"]}
search release -> {"count":1,"names":["release-notes"]}
install -> commit-message
toggle -> clicked
after toggle -> {"name":"commit-message","enabled":false,"origin":"builtin"}
detail body chars -> 254
SKILLS PANEL SMOKE PASSED
```

界面截图：`docs/assets/skills-panel.png`（列表）、`docs/assets/skills-detail.png`（详情）。

设置里的「技能」分区保留为快捷视图（只列已启用的技能），完整管理请到左侧栏面板。

## 已知限制

- MCP 服务在**会话启动时**连接：设置里改动后需要重新打开会话；`reloadPlugins()` 会让下一次会话重新加载。
- 只实现了 `stdio` 与 `url` 两种传输，HTTP 认证头、OAuth 等高级配置需要直接编辑 `mcp.json`。
- 技能只读取 `<userData>/skills`（不扫描 `~/.pi` 或项目 `.pi/skills`），避免不同项目互相污染。
- MCP 工具不下发给子 Agent 与群聊角色；插件工具（`dsh_*`）同样如此。
- 未做 MCP 连接状态可视化（当前只能从会话工具列表或日志判断）。

## 复现

```bash
pnpm build
node tools/mcp-smoke.mjs          # MCP + 技能注入
node tools/skills-panel-smoke.mjs # 技能面板搜索/安装/启停/详情
```

手动验证：设置 →「MCP 服务」添加一个服务（例如 `npx -y @modelcontextprotocol/server-filesystem D:\data`）→ 保存 → 新开会话 → 让模型调用 `mcp__<名字>__<工具>`；设置 →「技能」新建一个技能 → 新开会话 → 输入 `/skill:<名字>`。
