# GitHub 发布与候选目录

## 仓库

- `git@github.com:Dushiqi1987/OpenFuture.git`
- 默认分支 `main`
- 不提交 `third_party/`、`out/`、`release/`、`.scratch/`、`node_modules/`

## 发布前

1. `git status --short` 确认没有真实凭证、用户数据、构建产物；
2. `pnpm typecheck`（node + web）；
3. `pnpm build`；
4. 在隔离 profile 启动应用，做冒烟；
5. 记录候选 EXE/资源哈希和证据 JSON。

## 提交拆分

建议按层拆分，便于审查：

- `protocol`：DTO/事件；
- `agent-host`：Pi 消息/usage/工具；
- `main`：项目存储/IPC/凭证；
- `renderer`：组件/状态；
- `styles`：主题/布局；
- `docs`：验收记录/日志；
- `tools`：可复用测试脚本。

## 当前候选

- `release/desktop-adapters/win-unpacked`
- `release/v0.2-a-projects-runnable`
- `release/v0.2-b0-memory-isolation-runnable`
- 旧 P0.1–P3.4 目录全部保留
- 安装包/签名留到后续
