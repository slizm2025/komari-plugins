# Komari Plugins Collection

一组面向 **[Komari Monitor](https://github.com/komari-monitor/komari) >= 1.5.0（实测适配 Komari 1.6.x MoeJS 插件运行时）** 的轻量、零额外探针监控与交互插件合集。三款插件既可独立运行，也可无缝联动。

---

## 插件一览

| 插件目录 | 插件标识 (`short`) | 当前版本 | 核心功能 | 权限需求 |
| :--- | :---: | :---: | :--- | :--- |
| [`latency-monitor`](./latency-monitor) | `latency-monitor` | `1.0.2` | **延迟与丢包可用性监控**：复用 Komari 原生 TCP/ICMP/HTTP Ping 任务，按时间分桶计算延迟与丢包率，在首页节点卡片底部注入双栏胶囊色块条（参考 CF-Server-Monitor 视觉设计），附带独立总览页与三网/节点互探任务快捷预设 | `allowSystemRPC`, `allowRoutes`, `allowHTMLInject` |
| [`traffic-quota`](./traffic-quota) | `traffic-quota` | `1.0.4` | **月度流量配额监控**：每台 VPS 独立设置每月开始/重置日（1–31，小月自动对齐）、月度上限（GB/TB）、计费方式（双向/出站/入站/取大）与“保存后增量累加”校准基线；内置防重启清零的 100 天持久化账本，首页卡片展示月流量进度条与剩余流量 | `node`, `allowSystemRPC`, `allowRoutes`, `allowHTMLInject` |
| [`tg-bot`](./tg-bot) | `tg-bot` | `1.0.2` | **Telegram 状态查询机器人**：内嵌于 Komari 进程（无需额外容器或 Webhook），纯出站长轮询 + 严格 Chat ID 白名单；发 `/status`、`/ping`、`/traffic`、`/node` 或点击 Inline 快捷按钮原地刷新，一键聚合 CPU/内存 + 延迟丢包 + 月度剩余流量，支持定时日报与离线/流量/丢包告警 | `allowSystemRPC`, `allowRoutes` |

---

## 快速安装

1. 前往本仓库 [**Releases**](https://github.com/slizm2025/komari-plugins/releases) 下载对应插件的 `.zip` 安装包：
   - `komari-plugin-latency-monitor-v1.0.2.zip`
   - `komari-plugin-traffic-quota-v1.0.4.zip`
   - `komari-plugin-tg-bot-v1.0.2.zip`
2. 在 Komari 管理后台进入 **插件（Plugins）** → 点击 **上传插件（Upload）** → 选择 `.zip` → 确认权限并启用。
3. 详细配置说明请查看各自目录下的 `README.md`：
   - [延迟与丢包可用性监控使用说明](./latency-monitor/README.md)
   - [月度流量配额监控使用说明](./traffic-quota/README.md)
   - [Telegram 状态查询机器人配置指南](./tg-bot/README.md)

---

## 本地测试与自行打包

每个插件均自带 Node.js 单元/集成测试与一键打包脚本（无任何第三方 npm 依赖）：

```bash
./latency-monitor/build.sh
./traffic-quota/build.sh
./tg-bot/build.sh
```

打包产物位于各子目录的 `dist/` 下，`komari-plugin.json` 严格位于 ZIP 根目录，符合 Komari 1.6.x 安装规范。

## License

[MIT](./LICENSE)
