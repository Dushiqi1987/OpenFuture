# OpenFuture Cloud

OpenFuture 的账号与计费服务：注册登录、设备配对、钱包充值、token 计量、OpenAI 兼容模型代理、管理后台。

- 技术栈：Java 17、Spring Boot 3.3.5、Spring Data JPA、H2（文件库，可切 MySQL）、JJWT
- 默认端口：`8090`
- 设计说明与商业化解释：`docs/商业化链路与手机管理落地-2026-11.md`

## 构建与运行

系统自带的 Maven 3.6.1 与全局 Nexus 镜像不可用，已提供批处理固定 JDK 17 + IDEA 自带 Maven 3.9.5：

```bat
cd cloud
build.cmd test                    :: 8 个端到端用例
build.cmd -DskipTests package     :: 打 jar
run.cmd                           :: 启动，监听 8090
```

等价的 mvn 命令：`mvn -s maven-settings.xml -DskipTests package`（`JAVA_HOME` 指向 ID​EA jbr 目录）。

启动后：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:8090` | 手机账户页（`/` 跳 `/app.html`） |
| `http://127.0.0.1:8090/admin.html` | 管理后台（令牌默认 `dev-admin`） |
| `http://127.0.0.1:8090/h2-console` | 数据库控制台（JDBC URL `jdbc:h2:file:./data/openfuture`，用户 `sa`，空密码） |

首次启动自动写入 4 个模型价格与演示兑换码 `OF-DEMO-100`（100 元）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `openfuture.jwt-secret` | dev 值 | JWT 签名密钥，≥32 字节，env `OF_JWT_SECRET` |
| `openfuture.jwt-ttl-hours` | `720` | 令牌有效期 |
| `openfuture.admin-token` | `dev-admin` | 管理后台令牌，env `OF_ADMIN_TOKEN` |
| `openfuture.pay-secret` | `dev-pay-secret` | 支付回调 HMAC 密钥，env `OF_PAY_SECRET` |
| `openfuture.auth.dev-sms` | `true` | 开发模式验证码固定 `123456`，env `OF_DEV_SMS` |
| `openfuture.pay.dev-mode` | `true` | 允许模拟支付，env `OF_PAY_DEV_MODE` |
| `openfuture.upstream.base-url` | 空 | 留空走演示回声；如 `https://api.deepseek.com/v1` |
| `openfuture.upstream.api-key` | 空 | 上游真实 key |
| `openfuture.billing.default-prompt-per-m` | `2000000` | 缺省输入价（微元/1M tokens = 2 元） |
| `openfuture.billing.default-completion-per-m` | `8000000` | 缺省输出价（8 元） |
| `openfuture.public-base-url` | `http://127.0.0.1:8090` | 二维码/深链里给手机用的地址，env `OF_PUBLIC_BASE_URL`；填局域网 IP |
| `openfuture.housekeeping.interval-ms` | `3600000` | 每小时维护：关超时订单、清过期票据/配对码 |

金额单位：**微元**，1 元 = 1,000,000 微元。

## 快速验证

```bash
B=http://127.0.0.1:8090

# 1) 注册（开发模式验证码 123456）
curl -s $B/api/auth/sms -H 'Content-Type: application/json' -d '{"phone":"13900000001"}'
TOKEN=$(curl -s $B/api/auth/register -H 'Content-Type: application/json' \
  -d '{"phone":"13900000001","code":"123456","password":"secret123"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

# 2) 兑换 100 元
curl -s $B/api/redeem -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"OF-DEMO-100"}'

# 3) 创建平台密钥（只显示一次）
KEY=$(curl -s $B/api/keys -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"desktop"}' | sed -E 's/.*"key":"([^"]+)".*/\1/')

# 4) 走平台调模型（未配置上游时是演示回声）
curl -s $B/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}'

# 5) 看用量与后台
curl -s "$B/api/usage?days=7" -H "Authorization: Bearer $TOKEN"
curl -s $B/api/admin/overview -H 'X-Admin-Token: dev-admin'
```

## 接口

用户侧（JWT）：`/api/auth/*`、`/api/me`、`/api/devices/*`、`/api/wallet`、`/api/redeem`、`/api/orders*`、`/api/usage*`、`/api/keys*`
模型侧（`sk-of-...`）：`/v1/models`、`/v1/chat/completions`、`/v1/me`
管理侧（`X-Admin-Token`）：`/api/admin/{overview,users,orders,usage,prices,redeem-codes}`

完整说明见 `docs/商业化链路与手机管理落地-2026-11.md` 第 10 节。

## 数据库
开发默认 H2 文件库 `cloud/data/openfuture.mv.db`。切 MySQL：

```yaml
spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/openfuture?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
    username: openfuture
    password: 你的密码
    driver-class-name: com.mysql.cj.jdbc.Driver
```

表结构由 JPA `ddl-auto: update` 自动维护；生产建议改成 `validate` 并用迁移脚本。

## 上线前检查

- [ ] 改掉 `jwt-secret`、`admin-token`、`pay-secret`
- [ ] `OF_DEV_SMS=false` 并接真实短信
- [ ] `OF_PAY_DEV_MODE=false` 并接真实支付回调（保留验签与幂等）
- [ ] 配置上游 base-url / api-key，移除演示回声依赖
- [ ] 管理后台加 IP 白名单或反向代理 Basic Auth
- [ ] 全站 HTTPS（Caddy/Nginx），H2 控制台关闭
- [ ] 备份 `data/` 与数据库；对账导出
- [ ] 合规：ICP 备案、生成式 AI 备案、支付资质（自用可暂缓，公开售卖不可省）
