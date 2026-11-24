# Komari Telegram 状态查询机器人插件 (`tg-bot`)

直接运行在 Komari 1.6.x 嵌入式插件运行时内的轻量 Telegram 双向机器人，**无需额外 Docker 容器，无需公网域名或 Webhook 回调**。

通过 Komari 内部 RPC 一次性聚合：
- **基础资源**：节点在线状态、运行时长、CPU / 内存 / 磁盘 / 实时上下行速率（`common:getNodes`、`common:getNodesLatestStatus`）；
- **三网延迟与丢包**：自动联动 `latency-monitor` 插件（`latencyMonitor:getSummary`）；
- **月度流量配额与剩余**：自动联动 `traffic-quota` 插件（`trafficQuota:getSummary`）。

*(若某插件未启用，自动优雅降级，不影响其余数据正常展示。)*

---

## 支持的交互指令与按钮

| 指令 | 功能 |
| :--- | :--- |
| `/status`（或 `/s`、`/start`） | 全部 VPS 综合总览（在线/CPU/内存 + 月度已用/剩余流量 + 三网延迟丢包），底部附快捷切换与单节点按钮 |
| `/ping`（或 `/p`，支持 `/ping 6`） | 查看各节点延迟（最新/均值/P95）与丢包详情，可指定小时数 |
| `/traffic`（或 `/t`） | 查看各节点月度流量进度条、已用/剩余量、日均消耗与预计本期总量 |
| `/node <节点名>` | 查看单台 VPS 完整信息（如 `/node LA`） |
| `/id` | 返回当前会话的 Chat ID（配白名单前也可用，不泄露任何服务器数据） |
| `/help` | 查看指令列表 |

点击消息底部的 **Inline 按钮**（`🔄 刷新总览` / `📶 延迟丢包` / `📊 月度流量` / 单节点按钮）会在原消息上**原地刷新**，不会刷屏。

---

## 快速配置教程（3 分钟完成）

### 第一步：在 Telegram 创建机器人拿 Token
1. 在 Telegram 搜索并打开官方 **`@BotFather`**。
2. 发送 `/newbot`，依次按提示输入机器人显示名称（如 `My VPS Monitor`）和用户名（必须以 `bot` 结尾，如 `slizm_vps_mon_bot`）。
3. 复制 `@BotFather` 返回的 **HTTP API Token**（形如 `123456789:AAH...`）。

### 第二步：上传并启用插件
1. 打开 Komari 管理后台 → **插件（Plugins）** → 上传 `dist/komari-plugin-tg-bot-v1.0.0.zip` 并启用。
2. 进入插件配置页（**插件配置 → Telegram 状态查询机器人**）：
   - 填入 **`Bot Token`**，先保持 `允许访问的 Chat ID` 为空并点 **保存**。

### 第三步：获取并填入你的 Chat ID（开启白名单）
1. 在 Telegram 打开刚创建的机器人，点击 **Start** 后发送 `/id`。
2. 机器人会立刻回复你的 **`Chat ID`**（一串纯数字）。
3. 回到 Komari 插件配置页，把该数字填入 **`允许访问的 Chat ID`**（支持英文逗号分隔多个 ID），按需调整：
   - **每日定时汇总 Cron**：默认 `0 9 * * *`（每天早 9:00 北京时间）；
   - **高丢包告警节点名**：推荐只填主力优化节点名（如 `LA`），避免普通线路日常高丢包刷屏；
   - 点击 **保存**。
4. 回到 Telegram 发送 `/status`，即可实时收到全机状态卡片！

---

## 安全与资源说明
- **严格白名单**：非白名单 Chat ID 发送除 `/id` 外的任何消息与按钮点击全部丢弃，不会泄露任何节点信息；
- **最小权限**：仅申请 `allowSystemRPC` 与 `allowRoutes`，无需文件系统或命令行权限；
- **纯出站长轮询**：20 秒长轮询，收到指令毫秒级响应，空载 CPU 占用接近 0%，插件重载/停用时通过 `AbortController` 立即中断退出。
