# 隔离环境与 Mock 测试

## 原则

- 不读取、不修改正式用户目录 `%APPDATA%/OpenFuture`；
- 每个批次使用独立 `OPENFUTURE_USER_DATA`；
- 模型测试使用本地 mock 或临时假凭证；
- 不把真实 API Key 写进脚本、日志或提交。

## 启动 Mock

```bash
node tools/p01-mock-model.mjs
# http://127.0.0.1:8791/v1
```

## 启动隔离 App

```bash
unset ELECTRON_RUN_AS_NODE PWD
OPENFUTURE_USER_DATA=D:/OpenFuture/.scratch/v02b-userdata \
  ./node_modules/electron/dist/electron.exe . \
  --remote-debugging-port=9255 --enable-logging
```

## CDP 检查

```bash
curl http://127.0.0.1:9255/json/list
```

## 测试文件

- OF 回归：`tools/p34-of-test.mjs`、`tools/v02a-of04-test.mjs`
- B0 隔离：`.scratch/v02b-b0-test.mjs`
- 思考链：`.scratch/chain-tool-test.mjs`、`.scratch/chain-live-test.mjs`
- 用量：`.scratch/usage-test.mjs`

`.scratch/` 不入库；需要长期保留的脚本应复制到 `tools/`。
