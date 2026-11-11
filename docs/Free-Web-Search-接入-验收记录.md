# 免费网络搜索接入验收记录

日期：2026-11-10

## 目标

参考 [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 的 keyless 搜索思路，为 OpenFuture 的 Pi Agent 增加不依赖 API Key 的 `web_search` 工具。dsh-free-search 本身是 DSH 插件，不能直接嵌入 Pi Agent；因此在其公开引擎方案基础上实现了 OpenFuture 原生工具。

## 实现

- 新文件 `src/agent-host/web-search-tools.ts`：
  - `web_search({ query, limit? })`，limit 1–10，默认 6。
  - 主引擎：Exa 公共 MCP `https://mcp.exa.ai/mcp` 的 `web_search_exa`，无需 key。
  - 回退：AnySearch 匿名接口 `POST https://api.anysearch.com/v1/search`，无需 key。
  - 超时 20 秒；结果去重、截断；返回标题、URL、摘要；模型回答中可直接引用 URL。
  - 任一引擎失败不影响另一个；两个都失败时向 Agent 返回明确错误。
- `src/agent-host/index.ts`：将 `web_search` 加入 `customTools` 和工具 allowlist；设置 `OPENFUTURE_WEB_SEARCH=0` 可关闭。
- 不依赖 PowerShell、不写磁盘、不使用正式 API Key。

## 验证

- typecheck（node + web）通过，`electron-vite build` 通过。
- 正式 Qwen3.7 Flash 会话中发送：
  “请调用 web_search 工具搜索‘腾讯音乐 长三角 公司’，然后用一句话总结，并在最后列出来源链接。”
- 首轮 Agent 实际调用 `web_search({query:"腾讯音乐 长三角 公司",limit:6})`，工具返回 provider=anysearch 的 6 条结果；但结果几乎全是裁判文书网，与查询意图不符。
- 质量复核：同查询下 Exa 返回新浪财经“在秀洲，腾讯音乐正式起航”、杭州 MUSIC Q 等结果；已将 Exa 改为主引擎，AnySearch 仅作 fallback。
- 复测（Exa 优先构建）：工具返回 `provider: exa`，首条为新浪财经“在秀洲，腾讯音乐正式起航”，第二条为杭州 MUSIC Q；证据会话 `2026-11-10T13-25-13-255Z_01a1c5a2-57a7-7153-a841-a2d446d74e6d.jsonl`。
- 会话 JSONL：
  `C:/Users/杜世旗/AppData/Roaming/OpenFuture/pi/agent/sessions/2026-11-10T12-11-55-537Z_01a1c55f-3d10-756b-bf92-994d2abae00b.jsonl`
- 摘要证据：`.scratch/web-search-result.json`、`.scratch/websearch-test.out.log`。

## 限制

- 使用公共匿名接口，受上游限流/可用性影响；Exa 无结果或失败时回退 AnySearch；AnySearch 匿名语料法律文书偏多，已降为备选。
- 当前只提供搜索摘要，不提供网页正文抓取；需要正文时可后续增加 `web_fetch`。
- 结果质量取决于引擎；dsh-free-search 的 27 引擎、路由、冷却和多源合并未全部移植。
- 未增加 UI 开关；需要禁用时设置环境变量 `OPENFUTURE_WEB_SEARCH=0` 并重启。
- 未重打 EXE；开发构建已验证。

## 上游与许可

- 参考项目：https://github.com/DDDMUC/dsh-free-search （MIT）。
- OpenFuture 仅复用了 keyless 引擎思路与公开端点，没有复制其 DSH 插件运行时。

## 2026-11-11 时效性修复

问题：用户问“最近黄金为什么又跌了”时，模型回答引用的是 2025 年 6 月 27 日的旧闻。

定位：不是搜索引擎故障，而是工具没有把“今天”和“发布时间”交给模型。模型按训练数据猜了一个年份，先搜 `2024年1月`、再搜 `2025年6月`，Exa 忠实返回了对应旧闻；工具解析时也丢弃了 `Published:` 字段。

修复（`src/agent-host/web-search-tools.ts`）：

- 工具描述写入当天日期，并提示“不要凭训练数据猜年份”。
- 新增 `freshness: day|week|month|year|any`，默认 `month`；Exa 调用增加 `objective`，要求优先最近结果。
- 解析并返回 `Published:` 发布时间；结果按发布时间降序，超出 freshness 窗口的日期结果被过滤（若没有可用的近期结果则回退展示最接近的结果并注明）。
- 工具结果头部输出 `Current date: YYYY-MM-DD`，每条结果带 `Published:`。

复测（正式 Qwen3.7 Flash，原始问法“帮我分析一下最近黄金为什么又跌了”）：

- 工具调用：`web_search({ query: "黄金价格下跌 本周 2026年11月", freshness: "week", limit: 10 })`。
- 工具结果包含 `Current date: 2026-11-11` 与 `Published: 2026-11-11T...`。
- 回答以“根据今天（2026年11月11日）最新资料”开头，引用 2026-11-11 的财联社/CNBC/每经等来源，不再出现 2025 年旧闻。
- 会话：`2026-11-11T10-04-32-996Z_01a1ca10-fb64-72a7-a42c-cb829491546a.jsonl`。
- 证据：`.scratch/websearch-date-result.json`。

限制：Exa 公共 MCP 不提供服务端时间过滤，freshness 是客户端按 `Published` 过滤与排序；没有发布时间的页面只能原样返回，模型仍需结合日期判断。

补充修复：`src/agent-host/index.ts` 的 `before_agent_start` 现在每轮注入权威 `<current_time>`（Asia/Shanghai），与角色设定、记忆上下文并列。这样即使用户不调用 `web_search`，模型也不能再用训练数据猜日期。

- 复测：“今天是几号？星期几？不要调用工具。” → “今天是2026年11月11日，星期三。”
- 会话：`2026-11-11T10-35-46-935Z_01a1ca2d-9375-76e8-90c0-ae627a1da8b9.jsonl`；证据 `.scratch/time-test-result.json`。
