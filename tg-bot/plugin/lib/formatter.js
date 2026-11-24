"use strict";

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatLocalTime(nowMs, tzOffsetHours) {
  var tz = Number.isFinite(Number(tzOffsetHours)) ? Number(tzOffsetHours) : 8;
  var d = new Date((nowMs || Date.now()) + tz * 3600 * 1000);
  return (
    d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " +
    pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes())
  );
}

function formatBytes(bytes, unitBase) {
  var n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "--";
  var base = unitBase === 1000 ? 1000 : 1024;
  var units = ["B", "KB", "MB", "GB", "TB", "PB"];
  var idx = 0;
  while (n >= base && idx < units.length - 1) {
    n /= base;
    idx += 1;
  }
  var digits = idx <= 1 ? 0 : 2;
  return n.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") + " " + units[idx];
}

function formatSpeed(bytesPerSec) {
  var n = Number(bytesPerSec);
  if (!Number.isFinite(n) || n < 0) return "0 B/s";
  return formatBytes(n, 1024) + "/s";
}

function formatUptime(sec) {
  var s = Math.floor(Number(sec) || 0);
  if (s <= 0) return "未知";
  var days = Math.floor(s / 86400);
  var hours = Math.floor((s % 86400) / 3600);
  var mins = Math.floor((s % 3600) / 60);
  if (days > 0) return days + "天" + hours + "时";
  if (hours > 0) return hours + "时" + mins + "分";
  return mins + "分";
}

function renderProgressBar(percent, width) {
  var w = width || 10;
  var p = Math.max(0, Math.min(100, Number(percent) || 0));
  var filled = Math.round((p / 100) * w);
  if (p > 0 && filled === 0) filled = 1;
  var out = "";
  for (var i = 0; i < w; i++) {
    out += i < filled ? "▓" : "░";
  }
  return out;
}

function statusDot(status) {
  if (status === "good" || status === "ok") return "🟢";
  if (status === "warn") return "🟡";
  if (status === "critical" || status === "timeout" || status === "exceeded") return "🔴";
  return "⚪";
}

function taskWorstStatus(tk) {
  if (!tk || !tk.totalSamples) return "empty";
  if (tk.lossStatus === "critical" || tk.latencyStatus === "critical" || tk.latencyStatus === "timeout") {
    return "critical";
  }
  if (tk.lossStatus === "warn" || tk.latencyStatus === "warn") {
    return "warn";
  }
  return "good";
}

function formatPercent(val) {
  var n = Number(val);
  if (!Number.isFinite(n)) return "--";
  return (n >= 10 || Number.isInteger(n) ? (n >= 10 ? Math.round(n) : n) : n.toFixed(1)) + "%";
}

function formatProbeRowCompact(tk) {
  var dot = statusDot(taskWorstStatus(tk));
  var name = escapeHtml(tk.name);
  if (!tk.totalSamples) {
    return dot + " " + name + "　<i>无采样</i>";
  }
  var lat = tk.latestWasLoss && tk.latestLatency === null
    ? "<b>超时</b>"
    : "<code>" + (tk.latestLatency !== null ? tk.latestLatency : tk.avgLatency) + "ms</code>";
  var lossNum = Number(tk.lossPercent) || 0;
  var lossPart = lossNum > 0
    ? " · <b>丢包 " + escapeHtml(formatPercent(lossNum)) + "</b>"
    : " · 0%";
  return dot + " " + name + "　" + lat + lossPart;
}

function normalizeSnapshot(raw) {
  var nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  var liveMap = raw.latestStatus && typeof raw.latestStatus === "object" ? raw.latestStatus : {};
  var latMap = {};
  if (raw.latencySummary && Array.isArray(raw.latencySummary.nodes)) {
    for (var i = 0; i < raw.latencySummary.nodes.length; i++) {
      latMap[raw.latencySummary.nodes[i].uuid] = raw.latencySummary.nodes[i];
    }
  }
  var tqMap = {};
  if (raw.trafficSummary && Array.isArray(raw.trafficSummary.nodes)) {
    for (var j = 0; j < raw.trafficSummary.nodes.length; j++) {
      tqMap[raw.trafficSummary.nodes[j].uuid] = raw.trafficSummary.nodes[j];
    }
  }
  var unitBase = (raw.trafficSummary && raw.trafficSummary.config && raw.trafficSummary.config.unitBase) || 1024;
  var tzOffset = (raw.trafficSummary && raw.trafficSummary.config && raw.trafficSummary.config.timezoneOffset);
  if (!Number.isFinite(Number(tzOffset))) tzOffset = 8;

  var merged = [];
  for (var k = 0; k < nodes.length; k++) {
    var nd = nodes[k];
    if (!nd || !nd.uuid) continue;
    var live = liveMap[nd.uuid] || null;
    var online = Boolean(live && (live.online === true || (live.online !== false && live.time)));
    merged.push({
      uuid: nd.uuid,
      name: String(nd.name || nd.uuid),
      region: String(nd.region || ""),
      os: String(nd.os || ""),
      arch: String(nd.arch || ""),
      cpuCores: Number(nd.cpu_cores) || 0,
      memTotal: Number(nd.mem_total) || (live ? Number(live.ram_total) || 0 : 0),
      diskTotal: Number(nd.disk_total) || (live ? Number(live.disk_total) || 0 : 0),
      online: online,
      live: live,
      latency: latMap[nd.uuid] || null,
      quota: tqMap[nd.uuid] || null
    });
  }

  return {
    nowMs: raw.nowMs || Date.now(),
    unitBase: unitBase,
    tzOffset: tzOffset,
    windowHours: (raw.latencySummary && raw.latencySummary.windowHours) || 1,
    nodes: merged
  };
}

function buildMainKeyboard(nodes, activeCmd) {
  var rows = [
    [
      { text: (activeCmd === "status" ? "🔄 刷新总览" : "🖥️ 综合总览"), callback_data: "cmd:status" },
      { text: (activeCmd === "ping" ? "🔄 刷新延迟" : "📶 延迟丢包"), callback_data: "cmd:ping" },
      { text: (activeCmd === "traffic" ? "🔄 刷新流量" : "📊 月度流量"), callback_data: "cmd:traffic" }
    ]
  ];
  if (Array.isArray(nodes) && nodes.length > 0) {
    var nodeRow = [];
    for (var i = 0; i < nodes.length && i < 6; i++) {
      var n = nodes[i];
      nodeRow.push({
        text: (n.online ? "🟢 " : "🔴 ") + n.name,
        callback_data: "node:" + n.uuid
      });
      if (nodeRow.length === 3) {
        rows.push(nodeRow);
        nodeRow = [];
      }
    }
    if (nodeRow.length > 0) rows.push(nodeRow);
  }
  return { inline_keyboard: rows };
}

function formatStatusOverview(raw) {
  var snap = normalizeSnapshot(raw);
  var onlineCount = 0;
  for (var i = 0; i < snap.nodes.length; i++) {
    if (snap.nodes[i].online) onlineCount += 1;
  }

  var blocks = [
    "<b>🖥️ Komari VPS 状态总览</b> · <code>" + onlineCount + "/" + snap.nodes.length + " 在线</code>\n" +
    "<i>更新于 " + formatLocalTime(snap.nowMs, snap.tzOffset) + " (UTC+" + snap.tzOffset + ")</i>"
  ];

  for (var k = 0; k < snap.nodes.length; k++) {
    var n = snap.nodes[k];
    var card = [];
    var stateText = n.online && n.live ? ("在线 " + formatUptime(n.live.uptime)) : "离线";
    card.push((n.online ? "🟢" : "🔴") + " <b>" + escapeHtml(n.name) + "</b>  ·  <i>" + escapeHtml(stateText) + "</i>");

    if (n.online && n.live) {
      var cpuPct = (Number(n.live.cpu) || 0).toFixed(1) + "%";
      var ramPct = n.memTotal > 0 ? ((Number(n.live.ram) || 0) / n.memTotal * 100).toFixed(1) + "%" : "--";
      var diskPct = n.diskTotal > 0 ? ((Number(n.live.disk) || 0) / n.diskTotal * 100).toFixed(1) + "%" : "--";
      card.push("CPU <code>" + cpuPct + "</code> · 内存 <code>" + ramPct + "</code> · 磁盘 <code>" + diskPct + "</code>");
      card.push("速率 <code>↑" + formatSpeed(n.live.net_out) + "  ↓" + formatSpeed(n.live.net_in) + "</code>");
    }

    if (n.quota && n.quota.hasQuota) {
      var tr = n.quota.traffic;
      var cy = n.quota.cycle;
      var pct = tr.usagePercent != null ? tr.usagePercent : 0;
      var remText = tr.overageBytes > 0
        ? "超限 +" + formatBytes(tr.overageBytes, snap.unitBase)
        : "剩 " + formatBytes(tr.remainingBytes, snap.unitBase);
      card.push("");
      card.push("📊 <b>月流量</b>  <code>" + renderProgressBar(pct, 10) + "</code> <b>" + pct.toFixed(1) + "%</b>");
      card.push(
        "已用 <b>" + formatBytes(tr.usedBytes, snap.unitBase) + "</b> / " + formatBytes(tr.quotaBytes, snap.unitBase) +
        " · <b>" + remText + "</b>（" + cy.remainingDays + "天重置）"
      );
    }

    if (n.latency && Array.isArray(n.latency.tasks) && n.latency.tasks.length > 0) {
      card.push("");
      card.push("📶 <b>近 " + snap.windowHours + " 小时线路</b>");
      for (var t = 0; t < n.latency.tasks.length && t < 4; t++) {
        card.push(formatProbeRowCompact(n.latency.tasks[t]));
      }
    }

    blocks.push("<blockquote>" + card.join("\n") + "</blockquote>");
  }

  return {
    text: blocks.join("\n\n"),
    reply_markup: buildMainKeyboard(snap.nodes, "status")
  };
}

function formatPingReport(raw) {
  var snap = normalizeSnapshot(raw);
  var blocks = [
    "<b>📶 节点延迟与丢包详情</b> · <code>近 " + snap.windowHours + " 小时</code>\n" +
    "<i>更新于 " + formatLocalTime(snap.nowMs, snap.tzOffset) + " (UTC+" + snap.tzOffset + ")</i>"
  ];

  for (var i = 0; i < snap.nodes.length; i++) {
    var n = snap.nodes[i];
    var card = [(n.online ? "🟢" : "🔴") + " <b>" + escapeHtml(n.name) + "</b>"];
    if (!n.latency || !Array.isArray(n.latency.tasks) || n.latency.tasks.length === 0) {
      card.push("<i>暂无 Ping 探测任务</i>");
    } else {
      for (var t = 0; t < n.latency.tasks.length; t++) {
        var tk = n.latency.tasks[t];
        var dot = statusDot(taskWorstStatus(tk));
        var name = escapeHtml(tk.name);
        if (!tk.totalSamples) {
          card.push(dot + " <b>" + name + "</b>　<i>无采样</i>");
          continue;
        }
        var latPart = tk.latestWasLoss && tk.latestLatency === null
          ? "<b>超时</b>"
          : "<code>" + tk.latestLatency + "ms</code>" +
            (tk.avgLatency != null ? " / 均" + tk.avgLatency + "ms" : "") +
            (tk.p95Latency != null ? " / P95 " + tk.p95Latency + "ms" : "");
        var lossNum = Number(tk.lossPercent) || 0;
        var lossPart = lossNum > 0
          ? "<b>丢包 " + escapeHtml(formatPercent(lossNum)) + "</b>"
          : "丢包 0%";
        card.push(dot + " <b>" + name + "</b>  (" + escapeHtml(tk.type) + ")");
        card.push("    延迟 " + latPart + " · " + lossPart);
      }
    }
    blocks.push("<blockquote>" + card.join("\n") + "</blockquote>");
  }

  return {
    text: blocks.join("\n\n"),
    reply_markup: buildMainKeyboard(snap.nodes, "ping")
  };
}

function formatTrafficReport(raw) {
  var snap = normalizeSnapshot(raw);
  var blocks = [
    "<b>📊 月度流量配额与剩余统计</b>\n" +
    "<i>更新于 " + formatLocalTime(snap.nowMs, snap.tzOffset) + " (UTC+" + snap.tzOffset + ")</i>"
  ];

  for (var i = 0; i < snap.nodes.length; i++) {
    var n = snap.nodes[i];
    var card = [(n.online ? "🟢" : "🔴") + " <b>" + escapeHtml(n.name) + "</b>"];
    if (!n.quota) {
      card.push("<i>未获取到 traffic-quota 插件数据</i>");
    } else if (!n.quota.hasQuota) {
      card.push("⚪ 未配置月度配额");
      card.push("当前追踪 ↑" + formatBytes(n.quota.traffic.trackedUpBytes, snap.unitBase) + " · ↓" + formatBytes(n.quota.traffic.trackedDownBytes, snap.unitBase));
    } else {
      var tr = n.quota.traffic;
      var cy = n.quota.cycle;
      var rl = n.quota.rule;
      var pct = tr.usagePercent != null ? tr.usagePercent : 0;
      var remStr = tr.overageBytes > 0
        ? "超限 +" + formatBytes(tr.overageBytes, snap.unitBase)
        : "剩余 " + formatBytes(tr.remainingBytes, snap.unitBase);
      var projWarn = tr.projectedBytes > tr.quotaBytes ? " ⚠️预计超限" : "";

      card[0] += "  ·  <i>" + escapeHtml(rl.billingModeLabel) + "</i>";
      card.push(statusDot(n.quota.status) + " <code>" + renderProgressBar(pct, 12) + "</code> <b>" + pct.toFixed(1) + "%</b>");
      card.push("已用 <b>" + formatBytes(tr.usedBytes, snap.unitBase) + "</b> / " + formatBytes(tr.quotaBytes, snap.unitBase) + " · <b>" + remStr + "</b>");
      card.push("周期 <code>" + escapeHtml(cy.startDate + " ~ " + cy.endDate) + "</code>（剩 <b>" + cy.remainingDays + "</b> 天）");
      card.push("日均 <code>" + formatBytes(tr.dailyAvgBytes, snap.unitBase) + "/天</code> · 预计 <code>" + formatBytes(tr.projectedBytes, snap.unitBase) + "</code>" + projWarn);
    }
    blocks.push("<blockquote>" + card.join("\n") + "</blockquote>");
  }

  return {
    text: blocks.join("\n\n"),
    reply_markup: buildMainKeyboard(snap.nodes, "traffic")
  };
}

function formatSingleNodeReport(raw, targetQuery) {
  var snap = normalizeSnapshot(raw);
  var q = String(targetQuery || "").trim().toLowerCase();
  var found = null;
  for (var i = 0; i < snap.nodes.length; i++) {
    var nd = snap.nodes[i];
    if (nd.uuid.toLowerCase() === q || nd.name.toLowerCase() === q) {
      found = nd;
      break;
    }
  }
  if (!found && q) {
    for (var j = 0; j < snap.nodes.length; j++) {
      if (snap.nodes[j].name.toLowerCase().indexOf(q) !== -1) {
        found = snap.nodes[j];
        break;
      }
    }
  }

  if (!found) {
    var names = snap.nodes.map(function (x) { return "<code>" + escapeHtml(x.name) + "</code>"; }).join("、");
    return {
      text: "❓ 未找到匹配节点 <code>" + escapeHtml(targetQuery) + "</code>\n当前可用节点：" + (names || "无"),
      reply_markup: buildMainKeyboard(snap.nodes, "")
    };
  }

  var blocks = [
    (found.online ? "🟢" : "🔴") + " <b>节点详情 · " + escapeHtml(found.name) + "</b>\n" +
    "<i>更新于 " + formatLocalTime(snap.nowMs, snap.tzOffset) + " (UTC+" + snap.tzOffset + ")</i>"
  ];

  // Section 1: System resources
  var sys = ["<b>⚙️ 系统资源</b>"];
  if (found.os || found.arch) {
    sys.push("系统  <code>" + escapeHtml([found.os, found.arch].filter(Boolean).join(" / ")) + "</code>");
  }
  if (found.online && found.live) {
    var l = found.live;
    var memPct = found.memTotal > 0 ? (l.ram / found.memTotal * 100).toFixed(1) + "%" : "--";
    var dPct = found.diskTotal > 0 ? (l.disk / found.diskTotal * 100).toFixed(1) + "%" : "--";
    sys.push("运行  <code>" + escapeHtml(formatUptime(l.uptime)) + "</code> · 负载 <code>" +
      [l.load, l.load5, l.load15].map(function (x) { return Number(x || 0).toFixed(2); }).join(" / ") + "</code>");
    sys.push("CPU   <code>" + Number(l.cpu || 0).toFixed(1) + "%</code> (" + (found.cpuCores || 1) + " 核)");
    sys.push("内存  <code>" + formatBytes(l.ram, 1024) + " / " + formatBytes(found.memTotal, 1024) + "</code> (" + memPct + ")");
    sys.push("磁盘  <code>" + formatBytes(l.disk, 1024) + " / " + formatBytes(found.diskTotal, 1024) + "</code> (" + dPct + ")");
    sys.push("速率  <code>↑" + formatSpeed(l.net_out) + "  ↓" + formatSpeed(l.net_in) + "</code> · 连接 <code>" + (l.connections || 0) + "/" + (l.connections_udp || 0) + "</code>");
  } else {
    sys.push("⚠️ 当前节点处于 <b>离线</b> 状态");
  }
  blocks.push("<blockquote>" + sys.join("\n") + "</blockquote>");

  // Section 2: Monthly traffic quota
  if (found.quota && found.quota.hasQuota) {
    var tr = found.quota.traffic;
    var cy = found.quota.cycle;
    var rl = found.quota.rule;
    var pct = tr.usagePercent != null ? tr.usagePercent : 0;
    var rem = tr.overageBytes > 0
      ? "超限 +" + formatBytes(tr.overageBytes, snap.unitBase)
      : "剩余 " + formatBytes(tr.remainingBytes, snap.unitBase);
    var tq = [
      "<b>📊 月度流量配额</b> · <i>" + escapeHtml(rl.billingModeLabel) + "</i>",
      statusDot(found.quota.status) + " <code>" + renderProgressBar(pct, 12) + "</code> <b>" + pct.toFixed(1) + "%</b>",
      "已用 <b>" + formatBytes(tr.usedBytes, snap.unitBase) + "</b> / " + formatBytes(tr.quotaBytes, snap.unitBase) + " · <b>" + rem + "</b>",
      "周期 <code>" + cy.startDate + " ~ " + cy.endDate + "</code>（剩 " + cy.remainingDays + " 天）",
      "日均 <code>" + formatBytes(tr.dailyAvgBytes, snap.unitBase) + "/天</code> · 预计 <code>" + formatBytes(tr.projectedBytes, snap.unitBase) + "</code>"
    ];
    blocks.push("<blockquote>" + tq.join("\n") + "</blockquote>");
  }

  // Section 3: Latency & packet loss
  if (found.latency && Array.isArray(found.latency.tasks) && found.latency.tasks.length > 0) {
    var pingCard = ["<b>📶 延迟与丢包</b> · <i>近 " + snap.windowHours + " 小时</i>"];
    for (var t = 0; t < found.latency.tasks.length; t++) {
      var tk = found.latency.tasks[t];
      var dot = statusDot(taskWorstStatus(tk));
      var lossNum = Number(tk.lossPercent) || 0;
      var lossStr = lossNum > 0 ? "<b>丢包 " + escapeHtml(formatPercent(lossNum)) + "</b>" : "0%";
      var detail = !tk.totalSamples
        ? "<i>无采样</i>"
        : (tk.latestWasLoss && tk.latestLatency === null
          ? "<b>超时</b>"
          : "<code>" + tk.latestLatency + "ms</code>" +
            (tk.avgLatency != null ? " / 均" + tk.avgLatency + "ms" : "") +
            (tk.p95Latency != null ? " / P95 " + tk.p95Latency + "ms" : "")) +
          " · " + lossStr;
      pingCard.push(dot + " <b>" + escapeHtml(tk.name) + "</b>　" + detail);
    }
    blocks.push("<blockquote>" + pingCard.join("\n") + "</blockquote>");
  }

  return {
    text: blocks.join("\n\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 刷新 " + found.name, callback_data: "node:" + found.uuid },
          { text: "⬅️ 返回总览", callback_data: "cmd:status" }
        ]
      ]
    }
  };
}

function formatHelpMessage() {
  return {
    text: [
      "<b>🤖 Komari 监控机器人</b>",
      "",
      "<blockquote><b>常用指令</b>",
      "• /status（或 /s）— 全部 VPS 卡片总览",
      "• /ping（或 /p）— 延迟与丢包详情（如 <code>/ping 6</code>）",
      "• /traffic（或 /t）— 月度流量配额与剩余",
      "• /node <code>节点名</code> — 单台节点详情（如 <code>/node LA</code>）",
      "• /id — 查看当前 Chat ID</blockquote>"
    ].join("\n")
  };
}

function splitLongMessage(text, maxLen) {
  var limit = maxLen || 3900;
  var str = String(text || "");
  if (str.length <= limit) return [str];
  var chunks = [];
  var blocks = str.split("\n\n");
  var cur = "";
  for (var i = 0; i < blocks.length; i++) {
    var next = cur ? cur + "\n\n" + blocks[i] : blocks[i];
    if (next.length > limit) {
      if (cur) chunks.push(cur);
      cur = blocks[i].slice(0, limit);
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

module.exports = {
  escapeHtml: escapeHtml,
  formatBytes: formatBytes,
  formatLocalTime: formatLocalTime,
  normalizeSnapshot: normalizeSnapshot,
  formatStatusOverview: formatStatusOverview,
  formatPingReport: formatPingReport,
  formatTrafficReport: formatTrafficReport,
  formatSingleNodeReport: formatSingleNodeReport,
  formatHelpMessage: formatHelpMessage,
  splitLongMessage: splitLongMessage
};
