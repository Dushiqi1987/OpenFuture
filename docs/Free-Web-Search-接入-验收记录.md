# 免费网络搜索接入验收记录

日期：2026-11-10

## 目标

参考 [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 的 keyless 搜索思路，为 OpenFuture 的 Pi Agent 增加不依赖 API Key 的 `web_search` 工具。dsh-free-search 本身是 DSH 插件，不能直接嵌入 Pi Agent；因此在其公开引擎方案基础上实现了 OpenFuture 原生工具。

## 实现

- 新文件 `src/agent-host/web-search-tools.ts`：
  - `web_search({ query, limit? })`，limit 1–10，默认 6。
  - 主引擎：AnySearch 匿名接口 `POST https://api.anysearch.com/v1/search`，无需 key。
  - 回退：Exa 公共 MCP `https://mcp.exa.ai/mcp` 的 `web_search_exa`，无需 key。
  - 超时 20 秒；结果去重、截断；返回标题、URL、摘要；模型回答中可直接引用 URL。
  - 任一引擎失败不影响另一个；两个都失败时向 Agent 返回明确错误。
- `src/agent-host/index.ts`：将 `web_search` 加入 `customTools` 和工具 allowlist；设置 `OPENFUTURE_WEB_SEARCH=0` 可关闭。
- 不依赖 PowerShell、不写磁盘、不使用正式 API Key。

## 验证

- typecheck（node + web）通过，`electron-vite build` 通过。
- 正式 Qwen3.7 Flash 会话中发送：
  “请调用 web_search 工具搜索‘腾讯音乐 长三角 公司’，然后用一句话总结，并在最后列出来源链接。”
- Agent 实际调用 `web_search({query:"腾讯音乐 长三角 公司",limit:6})`，工具返回 provider=anysearch 的 6 条结果；随后生成总结并附来源链接。
- 会话 JSONL：
  `C:/Users/杜世旗/AppData/Roaming/OpenFuture/pi/agent/sessions/2026-11-10T12-11-55-537Z_01a1c55f-3d10-756b-bf92-994d2abae00b.jsonl`
- 摘要证据：`.scratch/web-search-result.json`、`.scratch/websearch-test.out.log`。

## 限制

- 使用公共匿名接口，受上游限流/可用性影响；AnySearch 无结果或失败时回退 Exa。
- 当前只提供搜索摘要，不提供网页正文抓取；需要正文时可后续增加 `web_fetch`。
- 结果质量取决于引擎；dsh-free-search 的 27 引擎、路由、冷却和多源合并未全部移植。
- 未增加 UI 开关；需要禁用时设置环境变量 `OPENFUTURE_WEB_SEARCH=0` 并重启。
- 未重打 EXE；开发构建已验证。

## 上游与许可

- 参考项目：https://github.com/DDDMUC/dsh-free-search （MIT）。
- OpenFuture 仅复用了 keyless 引擎思路与公开端点，没有复制其 DSH 插件运行时。
