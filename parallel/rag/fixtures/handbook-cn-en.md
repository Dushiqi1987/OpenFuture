# OpenFuture 运维手册 / Operations handbook

## 1. 升级流程 / Upgrade flow

升级前必须备份配置。固件升级采用 30 秒重试间隔 (retry interval 30 seconds)，
失败三次后停止并保留旧版本。回滚窗口为 15 分钟。

## 2. 保修 / Warranty

整机保修 36 个月 (36 months from delivery)。人为损坏不在保修范围内。
备件供应周期为 7 年。

## 3. 型号差异 / Model differences

OF-2200 Lite 待机功耗 5 W，适合边缘部署。OF-2200 Pro 最大吞吐量 1200 页/分钟。
OF-2200 X 典型功耗 410 W，适合高负载批处理。

## 4. 升级路径 / Escalation

一线支持无法解决时升级到二线支持；二线支持仍无法定位时升级到研发。
