"use strict";

var fmt = require("./formatter.js");

function parseCommaList(str) {
  if (!str) return [];
  return String(str)
    .split(/[,，\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function createAlertEngine() {
  var state = {
    initialized: false,
    onlineByUuid: {},
    quotaLevelByUuid: {},
    cooldowns: {}
  };

  function canFire(key, nowMs, cooldownMs) {
    var last = state.cooldowns[key] || 0;
    if (nowMs - last < cooldownMs) return false;
    state.cooldowns[key] = nowMs;
    return true;
  }

  function evaluate(rawSnapshot, cfg) {
    var alerts = [];
    if (!cfg || !cfg.alertEnabled) return alerts;

    var snap = fmt.normalizeSnapshot(rawSnapshot);
    var nowMs = snap.nowMs;
    var cooldownMs = Math.max(5, Number(cfg.alertCooldownMinutes) || 60) * 60 * 1000;
    var watchedLossNodes = {};
    var lossList = parseCommaList(cfg.alertLossNodes);
    for (var w = 0; w < lossList.length; w++) {
      watchedLossNodes[lossList[w].toLowerCase()] = true;
    }
    var lossThreshold = Math.max(1, Math.min(100, Number(cfg.alertLossPercent) || 20));
    var timeStr = fmt.formatLocalTime(nowMs, snap.tzOffset);

    for (var i = 0; i < snap.nodes.length; i++) {
      var n = snap.nodes[i];
      var uuid = n.uuid;
      var nameEsc = fmt.escapeHtml(n.name);

      // 1. Offline / Recovery transitions (skip initial baseline tick)
      if (state.initialized && Object.prototype.hasOwnProperty.call(state.onlineByUuid, uuid)) {
        var wasOnline = state.onlineByUuid[uuid];
        if (wasOnline && !n.online) {
          if (canFire("offline:" + uuid, nowMs, 5 * 60 * 1000)) {
            alerts.push(
              "🔴 <b>VPS 离线告警</b>\n" +
              "节点：<b>" + nameEsc + "</b>\n" +
              "时间：<code>" + timeStr + "</code>"
            );
          }
        } else if (!wasOnline && n.online) {
          alerts.push(
            "🟢 <b>VPS 恢复在线</b>\n" +
            "节点：<b>" + nameEsc + "</b>\n" +
            "时间：<code>" + timeStr + "</code>"
          );
        }
      }
      state.onlineByUuid[uuid] = n.online;

      // 2. Monthly traffic quota alerts (warn / critical / exceeded)
      if (n.quota && n.quota.hasQuota) {
        var level = n.quota.status; // ok | warn | critical | exceeded
        var prevLevel = state.quotaLevelByUuid[uuid] || "ok";
        if (level === "warn" || level === "critical" || level === "exceeded") {
          var escalated = (prevLevel === "ok") ||
            (prevLevel === "warn" && (level === "critical" || level === "exceeded")) ||
            (prevLevel === "critical" && level === "exceeded");
          var qKey = "quota:" + uuid + ":" + level;
          if (escalated || canFire(qKey, nowMs, cooldownMs)) {
            state.cooldowns[qKey] = nowMs;
            var tr = n.quota.traffic;
            var icon = level === "warn" ? "🟡" : "🔴";
            var title = level === "exceeded" ? "月度流量已超限" : (level === "critical" ? "月度流量高危告警" : "月度流量预警");
            var remLine = tr.overageBytes > 0
              ? "已超限：<b>+" + fmt.formatBytes(tr.overageBytes, snap.unitBase) + "</b>"
              : "剩余：<b>" + fmt.formatBytes(tr.remainingBytes, snap.unitBase) + "</b>";
            alerts.push(
              icon + " <b>" + title + "</b>\n" +
              "节点：<b>" + nameEsc + "</b>\n" +
              "已用：<code>" + fmt.formatBytes(tr.usedBytes, snap.unitBase) + " / " + fmt.formatBytes(tr.quotaBytes, snap.unitBase) +
              "</code> (" + (tr.usagePercent != null ? tr.usagePercent.toFixed(1) : "0") + "%)\n" +
              remLine + " · 距重置剩 " + n.quota.cycle.remainingDays + " 天\n" +
              "时间：<code>" + timeStr + "</code>"
            );
          }
        }
        state.quotaLevelByUuid[uuid] = level;
      }

      // 3. Packet loss alert (only for explicitly watched nodes like LA)
      if (watchedLossNodes[n.name.toLowerCase()] || watchedLossNodes[uuid.toLowerCase()]) {
        if (n.latency && Array.isArray(n.latency.tasks)) {
          var badLines = [];
          for (var t = 0; t < n.latency.tasks.length; t++) {
            var tk = n.latency.tasks[t];
            if (tk.totalSamples >= 5 && tk.lossPercent !== null && tk.lossPercent >= lossThreshold) {
              badLines.push("• " + fmt.escapeHtml(tk.name) + "：丢包 <b>" + tk.lossPercent + "%</b>" +
                (tk.avgLatency != null ? "（均 " + tk.avgLatency + "ms）" : "（超时）"));
            }
          }
          if (badLines.length > 0 && canFire("loss:" + uuid, nowMs, cooldownMs)) {
            alerts.push(
              "⚠️ <b>高丢包告警（近 " + snap.windowHours + " 小时）</b>\n" +
              "节点：<b>" + nameEsc + "</b>（阈值 ≥ " + lossThreshold + "%）\n" +
              badLines.join("\n") + "\n" +
              "时间：<code>" + timeStr + "</code>"
            );
          }
        }
      }
    }

    state.initialized = true;
    return alerts;
  }

  return {
    evaluate: evaluate,
    _state: state
  };
}

module.exports = {
  parseCommaList: parseCommaList,
  createAlertEngine: createAlertEngine
};
