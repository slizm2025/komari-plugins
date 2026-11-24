# Komari 延迟与丢包可用性监控插件 (`latency-monitor`)

适用于 **Komari >= 1.5.0（已按 Komari 1.6.1 MoeJS 插件运行时验证接口与打包规范）** 的延迟与丢包可视化监控插件，参考了 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的双栏时间窗口分桶与胶囊色块设计。

## 核心特性

1. **零额外探针，直接复用 Komari 原生 Ping 任务**
   - 直接通过 Komari System RPC（`common:getNodes`、`admin:getAllPingTasks`、`common:getRecords`）拉取原生 TCP / ICMP / HTTP 探测记录。
   - 对原始未降采样记录按配置窗口（默认近 1 小时、20 个分桶，每桶 3 分钟）精准计算：
     - **延迟**：最新值、桶内均值 / 最小 / 最大值、窗口 P50 / P95；
     - **丢包与可用率**：精确识别 `value < 0` 失败记录，计算各分桶丢包率与整窗可用率；
     - **无采样标识**：未采集到样本的时间桶显示灰色胶囊，直观区分「丢包超时（红）」与「无采样（灰）」。
   - 内置内存缓存（默认 15s）减轻 `metrics.db` 读压力；公开接口严格过滤隐藏节点且绝不暴露探测 `target` 地址。

2. **首页节点卡片底部内嵌注入（复刻双栏胶囊样式）**
   - 自动识别 Komari 官方默认主题（`<a href="/server/:uuid">`）及主流第三方主题的节点卡片，在卡片底部无侵入注入「**延迟 | 丢包**」双栏胶囊色块面板与底部协议/时间说明。
   - 自动适配深/浅色主题、响应 React SPA 路由切换，悬停任意色块通过全局浮层展示精确时间段、延迟区间与丢包比例（不会被卡片 `overflow: hidden` 裁切）。
   - 表格视图自动跳过，不影响表格排版。

3. **独立监控总览页 + 管理员快捷任务预设**
   - 内置公共总览页（`pages/index.html`），支持切换 `1h / 3h / 6h / 12h / 24h` 窗口、按节点/线路筛选与整体 KPI 概览。
   - 管理员登录状态下自动显示「**任务预设管理**」入口：
     - **三网 TCP 预设**：可编辑目标与间隔，一键批量创建至选中节点；
     - **节点互探生成**：自动读取各节点 IP，一键生成双向 `A → B` / `B → A` TCP 互探任务（支持去重）。

## 目录结构

```text
komari-latency-monitor/
├── build.sh                                        # 运行测试并打包 Komari 规范 ZIP
├── tests/test_plugin.js                            # 聚合/预设/生命周期/权限单测与集成测试
├── dist/komari-plugin-latency-monitor-v1.0.0.zip   # 可直接上传到 Komari 后台的插件包
└── plugin/
    ├── komari-plugin.json                          # 插件清单与后台可视化配置项
    ├── script.js                                   # Komari 插件入口 (MoeJS)
    ├── lib/
    │   ├── aggregator.js                           # 时间分桶与延迟/丢包统计核心
    │   └── presets.js                              # 三网/互探任务校验与生成器
    ├── assets/
    │   ├── inject.css                              # 首页卡片双栏胶囊样式与 Tooltip
    │   └── inject.js                               # 首页 DOM 识别、自动注入与定时刷新
    └── pages/
        └── index.html                              # 独立监控总览页与管理员任务预设弹窗
```

## 安装与使用步骤

1. **上传插件包**
   - 打开 Komari 管理后台 → **插件（Plugins）** → 点击 **上传插件（Upload）**。
   - 选择 `dist/komari-plugin-latency-monitor-v1.0.0.zip`。
2. **授权并启用**
   - 确认插件申请的最小权限（`allowSystemRPC`、`allowRoutes`、`allowHTMLInject`，**无需 `node` / `exec` 权限**），启用插件。
3. **配置探测任务**
   - 若 Komari 已有原生 Ping 任务，启用后刷新首页即可在卡片底部看到双栏延迟与丢包条。
   - 若尚未配置，可打开侧栏/导航中的「**延迟与丢包监控**」页面，点击右上角「**任务预设管理**」，一键创建三网 TCP 与节点互探任务（等待 1~2 个采样周期即可出图）。
4. **参数微调**
   - 在 Komari 后台插件配置页中可直接调整：默认时间窗口、分桶数量、卡片最大线路数、指定显示的 Ping 任务、延迟/丢包红黄绿阈值、以及是否开启首页卡片注入。

## 本地重新打包与测试

```bash
cd komari-latency-monitor
./build.sh
```
