# OpenFuture 桌面集成契约 v1.0

状态：M2 原型，合同版本 `1.0`。本契约只覆盖本地桌面壳与多 Agent 运行时之间的只读交接加一个外部测试报告入口，不包含 UI、项目中心、模型中心或合并主线。

## 1. 启动与范围

```bash
# 在 parallel/multiagent 目录下，使用 Node >= 22.19（推荐 Node 24）
node scripts/desktop-bridge.ts --root <项目根目录> --port 19744
```

默认绑定 `127.0.0.1:19744`。桥只读取 `<项目根>/.runtime/runs/<runId>/snapshot.json` 与已发布的 `artifacts/`；除 `POST /v1/runs/:runId/tests` 外不写任何运行状态。外部测试报告写入 `<runDir>/desktop-tests/`，**不会修改** RunStore 快照。

安全边界：

- 默认只允许回环地址；非回环地址必须同时提供 Bearer token。
- `--token` 或 `DESKTOP_BRIDGE_TOKEN` 设置后，除 `/v1/health` 和 `/v1/contract` 外的接口都要求 `Authorization: Bearer <token>`。
- 不提供 TLS，不应用于公网。
- 一个桥实例只服务一个 `projectId` 与一个项目根目录。

## 2. 响应包络

所有 JSON 响应使用统一包络：

```json
{
  "schemaVersion": "1.0",
  "kind": "board",
  "projectId": "project-openfuture-demo",
  "runId": "synthetic-run-1",
  "generatedAt": 1794212142352,
  "data": {}
}
```

错误响应：

```json
{
  "schemaVersion": "1.0",
  "kind": "error",
  "generatedAt": 1794212142352,
  "error": {
    "code": "run-not-found",
    "message": "cannot open run ...",
    "details": {}
  }
}
```

`kind` 取值：`health`、`contract`、`runs`、`board`、`events`、`artifacts`、`artifact`、`memory`、`test-integration`、`test-report`、`error`。

## 3. 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 存活探测，公开 |
| GET | `/v1/contract` | 合同清单、能力、端点，公开 |
| GET | `/v1/runs?limit=50` | 按 `updatedAt` 倒序列出运行摘要 |
| GET | `/v1/runs/:runId/board` | 任务板 `RunBoard`：四角色泳道、意图、从问题到任务的可追溯性、状态计数、集成报告 |
| GET | `/v1/runs/:runId/events?after=0&limit=500` | 运行事件分页；`nextAfter` 与 `hasMore` 用于继续拉取 |
| GET | `/v1/runs/:runId/events/stream?after=0&follow=1` | SSE 重放；`follow=0` 重放后立即结束，`follow=1` 在运行未终态时轮询快照直至终态 |
| GET | `/v1/runs/:runId/artifacts` | 版本化产物列表与 `latestByKind` |
| GET | `/v1/runs/:runId/artifacts/:artifactId` | 产物元数据与 `verified`（大小和 sha256） |
| GET | `/v1/runs/:runId/artifacts/:artifactId/content` | 产物原始字节；读取时校验 sha256，响应带 `x-artifact-*` 头 |
| GET | `/v1/runs/:runId/memory?view=off\|rag\|wiki` | 单次运行的项目记忆视图 |
| GET | `/v1/memory?view=off\|rag\|wiki&limit=10` | 跨最近若干次运行的项目级记忆视图 |
| GET | `/v1/runs/:runId/tests` | 已发布的 `test-report` 产物与外部测试报告 |
| POST | `/v1/runs/:runId/tests` | 追加一条外部测试报告，返回 201 |

`runId` 必须是 RunStore 接受的安全 ID；未知运行返回 `404 run-not-found`。

### 3.1 任务板

`GET /board` 返回：

```json
{
  "schemaVersion": "1.0",
  "runId": "synthetic-run-1",
  "projectId": "project-openfuture-demo",
  "status": "completed",
  "lanes": [{ "role": "researcher", "tasks": [] }],
  "intents": [],
  "traceability": [
    { "questionId": "q1", "index": 0, "text": "...", "intentIds": ["intent-q1"], "taskIds": ["task-q1-research"] }
  ],
  "summary": { "total": 4, "integrated": 2, "failed": 0 },
  "integration": { "status": "passed" }
}
```

桌面壳必须以 `traceability` 展示“原始问题 → 意图 → 任务”的链路，不能只显示最终回答。

### 3.2 事件流

普通分页返回 `RunEvent` 数组，`seq` 从 1 递增且连续。SSE 格式：

```text
id: 42
event: run-event
data: {"schemaVersion":"1.0","seq":42,"runId":"...","type":"task.state",...}

event: stream.end
data: {"runId":"...","lastSeq":69,"status":"completed"}
```

客户端可用 `Last-Event-ID` 或 `after` 从断点续传。`follow=1` 仅轮询持久化快照，不订阅运行时内存事件；运行终态后自动发送 `stream.end`。

### 3.3 产物

产物是不可变、内容寻址的版本化文件：

```json
{
  "id": "sha256:...",
  "taskId": "task-q2-backend",
  "name": "openapi.json",
  "version": "1.0.0",
  "kind": "contract",
  "mediaType": "application/json",
  "sha256": "...",
  "bytes": 1623,
  "uri": "artifacts/synthetic-run-1/task-q2-backend/...-openapi.json",
  "createdAt": 1794212142
}
```

`content` 端点通过 `ArtifactStore.read` 校验哈希；快照与文件不一致时返回 `409 artifact-corrupt`。桌面壳应记录 `id`、`version` 与 `sha256`，不能只按文件名缓存。

### 3.4 记忆视图

`off` 返回空 `entries`，不提供隐式兜底；`rag` 返回目标、问题、决策、研究/合同产物摘录与失败归因；`wiki` 额外包含意图和任务进度，并扩大产物摘录。

每条记忆：

```json
{
  "id": "memory:artifact:synthetic-run-1:sha256:...",
  "kind": "artifact",
  "title": "research-report@1.0.0 (research-report)",
  "text": "...",
  "runId": "synthetic-run-1",
  "sha256": "...",
  "refs": [{ "kind": "artifact", "id": "sha256:...", "label": "research-report" }]
}
```

记忆由持久化计划/任务/集成报告/产物派生，不包含原始 Pi 对话；常见 token、Bearer、api-key、password 片段会被替换为 `[redacted]`，并在响应中给出 `redactions` 计数。项目级视图按运行逐个附加 `runId`，便于回跳。

### 3.5 外部测试报告

`POST /v1/runs/:runId/tests`：

```json
{
  "taskId": "task-q4-test",
  "name": "desktop acceptance suite",
  "framework": "external-ci",
  "status": "passed",
  "checks": [
    { "id": "board-contract", "status": "passed" },
    { "id": "artifact-hash", "status": "passed", "detail": "sha256 verified" }
  ],
  "startedAt": 1794212142000,
  "finishedAt": 1794212142100,
  "evidence": ["desktop contract smoke"]
}
```

校验规则：

- `name` 1..200 字符；`status` 为 `passed`/`failed`/`blocked`。
- `checks` 1..200 条；`id` 唯一且非空；`status` 为 `passed`/`failed`。
- `taskId` 可选；存在时必须是该运行的任务，报告中回填 `ownerRole`。
- 请求体上限 256 KiB；时间戳必须是有限数且 `finishedAt >= startedAt`。

响应 201 的 `data` 是完整报告，含 `schemaVersion`、`reportId`、`projectId`、`runId`、`receivedAt`、`ownerRole` 和原始字段。

`GET /tests` 返回：

```json
{
  "artifacts": [],
  "reports": [],
  "summary": { "artifacts": 1, "reports": 1, "passed": 1, "failed": 0, "blocked": 0 }
}
```

## 4. 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `desktop-unauthorized` | token 缺失或不匹配 |
| 404 | `run-not-found` | 运行不存在 |
| 404 | `artifact-not-found` | 产物不属于该运行 |
| 409 | `artifact-corrupt` | 文件大小/哈希与引用不一致 |
| 400 | `desktop-invalid-body` | 测试报告字段非法 |
| 400 | `desktop-invalid-json` | 请求体不是 JSON |
| 400 | `desktop-invalid-query` | 分页/视图参数非法 |
| 405 | `desktop-method-not-allowed` | 路径存在但方法不支持 |
| 413 | `desktop-body-too-large` | 请求体超过 256 KiB |
| 500 | `run-snapshot-corrupt` 等 | 快照损坏或读失败 |

## 5. 兼容性与限制

- 合同版本只通过新增字段、端点或新版本号演进；`1.x` 内不删除既有字段。
- 当前只服务一个项目根；多项目需要启动多个桥或引入项目注册表（等待主线审查）。
- SSE 的 `follow=1` 是快照轮询，不保证亚 100ms 实时性；运行进程退出后仍可重放已持久化事件。
- 外部测试报告是证据附件，不会自动改变任务状态或触发重跑；测试结果与任务状态的合并由后续桌面集成层决定。
- 本桥不执行合并、不推送、不修改主线；M2 仅提供集成契约与验收代码。

## 6. 验收命令

```bash
# 合同桥 + 记忆 + 产物 + 测试报告，端口 19744
node --test --test-concurrency=1 test/m2-desktop.test.ts

# M0 独立验收（21 项检查）
node scripts/acceptance.ts

# M0+M1+M2 全部测试
node --test --test-concurrency=1 test/*.test.ts
```

参考证据（本地 Node 24.21.0）：M2 8/8 通过；全套 37/37 通过，约 7.0s；M0 验收 21/21 通过，集成 revision `403b4dda62ca09330486bb51b85de19e8e5ab19ac28e510c949abbca21293904`。
