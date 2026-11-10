# DSH 风格状态栏与回答尾部操作验收记录

日期：2026-11-10
分支：`feat/dsh-thinking-chain`
状态：本地验证通过；未提交、未打新候选包。

## 需求

用户反馈：

1. 原有用量条最后文字显示不全，视觉单调；
2. 改成 DSH 同款状态栏：轮数/步数、tok/s、累计 token、前缀缓存命中率、环形上下文占比；
3. 在每个回答输出末尾增加时间、复制按钮和本轮 token 用量。

参考：DSH 状态栏与回答尾部操作栏截图（用户提供）。

## 实现

### 会话状态栏

- `src/renderer/src/App.tsx`
  - `summarizeSessionUsage` 聚合当前会话所有 assistant 轮次：轮数、工具/思考步数、输出 token、耗时、累计 token、缓存读取与命中率；上下文使用最近一次非零 prompt。
  - `UsageRing` 用 `conic-gradient` 画环形占比，`ClockIcon`/`DatabaseIcon` 与 DSH 状态栏对应。
  - 状态栏位于 composer 顶部，展示：
    - `N 轮 M 步 · X tok/s`
    - `TOTAL tok · 缓存命中 C%`
    - 环形图 + `P% P_TOKENS / WINDOW`
- `src/renderer/src/styles.css`
  - 新增 `.usage-cluster`、`.usage-unit`、`.usage-sep`、`.usage-context`、`.usage-ring`、`.usage-context-detail`。
  - 宽屏单行；≤1200px 隐藏上下文明细；≤1040px 允许换行，避免截断。

### 回答尾部

- 每个 assistant turn 末尾增加：
  - 复制按钮：优先 `navigator.clipboard.writeText`，失败回退 `textarea + execCommand`；显示“已复制/复制失败”，1.5s 复位。
  - 本轮 token：`↑提示 · ↓输出`。
  - 右侧时间：HH:mm。
- 新增 `.message-footer`、`.message-action`、`.message-usage`、`.message-time`，含 hover/focus 与浅色覆盖。

### 数据来源

- `src/shared/protocol.ts`：`MessageUsage` 与 `ChatMessage.usage`。
- `src/agent-host/index.ts`：`toMessageUsage` 从 Pi assistant 的 `usage`/`durationMs` 提取；实时与历史恢复共用。
- 统计为请求结束后准确值；流式过程中显示上一轮。

## 验证

- `tsc --noEmit -p tsconfig.web.json`、`-p tsconfig.node.json` 通过。
- `electron-vite build` 通过；最终资源：
  - `out/renderer/assets/index-DOndx0ep.js` 691.55 kB
  - `out/renderer/assets/index-vCf6okkV.css` 50.62 kB
- 正式实例（Qwen3.7 Flash，CDP 9257）实测：
  - 状态栏：`4 轮 5 步 · 73 tok/s`、`10.2K tok · 缓存命中 56.9%`、`2.0% 2.6K / 131.1K`。
  - 1351px 宽：stats `scrollWidth=clientWidth=846`，无截断。
  - 960px 仿真：stats 宽 614px，上下文明细自动隐藏，无横向溢出。
  - 页面共有 3 个回答 footer；时间与 `↑3.6K · ↓170` 等用量显示正确。
  - 使用 CDP 可信鼠标点击复制按钮，按钮变为“已复制”；测试环境读取剪贴板权限被拒绝，但写入成功。
  - 程序化 `element.click()` 不是可信手势，会显示“复制失败”，属浏览器安全限制。
- 截图：`docs/assets/dsh-status-bar.png`（1351px，正式实例）。

## 限制

- 统计为轮次结束后更新，不做流式 token 估算。
- 汇总仅覆盖当前已加载会话；更早未加载的历史不计入。
- 复制依赖系统剪贴板权限；失败时有可见提示。
- 未提交、未打包新候选，未同步 GitHub。
