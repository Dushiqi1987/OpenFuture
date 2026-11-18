# mobile/

手机端只有两块东西：

| 路径 | 作用 |
| --- | --- |
| `index.html` | 手机页面（单文件 SPA，无构建步骤）。电脑端 `remote-host.ts` 通过 `?raw` 内联它，APK 里打开的也是同一份 |
| `android/` | 极简 APK 工程：一个 WebView Activity + 图标 + 无 Gradle 构建脚本 |

## 页面

- 连接页：地址（默认取当前 origin）、配对码、设备名；令牌存 `localStorage.of_remote_token`
- 项目 / 会话 / 聊天三屏，`EventSource` 自动重连，`since` 续传
- 事件与桌面端 `IpcChannels.agentEvent` 同构：`text-delta`、`prompt`、`settled`、`status` 等

调试时不用装手机：电脑上启动 OpenFuture 后，手机浏览器打开 `http://<电脑IP>:8787` 即可。

## APK

```bash
# 依赖：JDK 17 + Android build-tools + 一个 platform（不需要 Android Studio / Gradle）
ANDROID_HOME=D:/OpenFuture/.android-sdk/sdk bash android/build-apk.sh
# 产物：android/OpenFuture-phone.apk（debug 签名，约 45KB）
```

脚本流程：`javac --release 11 → d8 → aapt2 link → 添加 classes.dex → zipalign → apksigner`。
`AndroidManifest.xml` 只需 `INTERNET` 权限、`usesCleartextTraffic=true`（局域网 http）和启动 Activity。

### 改 App 名称 / 图标 / 包名

- 名称：`AndroidManifest.xml` 的 `android:label`
- 图标：替换 `res/mipmap-*/ic_launcher.png`
- 包名：`manifest package` 与 `MainActivity.java` 的 `package` 两处一起改

### 换服务器地址

App 右上角 ⚙ 打开地址对话框；只填 `IP:端口` 会自动补 `http://` 和默认端口 `8787`。

## 协议速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/pair` | `{code,name}` → `{token,urls}` |
| GET | `/api/events?since=&token=` | SSE，帧 `{seq,sessionId,event}` |
| GET | `/api/projects` | 项目列表 |
| GET/POST | `/api/projects/:id/conversations` | 会话列表 / 新建 |
| POST | `/api/conversations/open` | `{projectId,conversationId}` |
| POST | `/api/sessions/:id/messages` | `{text,mode}` |
| POST | `/api/sessions/:id/stop` | 停止 |
| POST | `/api/prompts/answer` | `{id,optionIndex?,text?,cancelled?}` |

鉴权：`Authorization: Bearer <token>` 或 SSE 的 `?token=`。错误统一 `{"ok":false,"error":{"code","message"}}`。
