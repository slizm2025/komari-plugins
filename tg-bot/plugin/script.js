"use strict";

var server = require("server");
var fmt = require("./lib/formatter.js");
var alertsLib = require("./lib/alerts.js");
var tgLib = require("./lib/telegram.js");

var PLUGIN_SHORT = "tg-bot";
var ROUTE_BASE = "/api/plugin/" + PLUGIN_SHORT;
var LOCAL_KOMARI_BASE = "http://127.0.0.1:25774";
var POLL_TIMEOUT_SEC = 20;

var tg = tgLib.createTelegramClient();
var alertEngine = alertsLib.createAlertEngine();

var runtime = {
  generation: 0,
  running: false,
  offset: 0,
  pollController: null,
  pollTimer: null,
  startupTimer: null,
  commandsSynced: false,
  lastPollAt: null,
  lastError: "",
  handledCount: 0,
  alertsSentCount: 0,
  dailyCronSpec: ""
};

function parseBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

function normalizeConfig(raw) {
  var src = raw && typeof raw === "object" ? raw : {};
  var allowedList = alertsLib.parseCommaList(src.allowed_chat_ids);
  var allowedSet = {};
  for (var i = 0; i < allowedList.length; i++) {
    allowedSet[allowedList[i]] = true;
  }
  return {
    botToken: String(src.bot_token || "").trim(),
    allowedChatIds: allowedList,
    allowedSet: allowedSet,
    apiBase: String(src.api_base || "https://api.telegram.org").trim() || "https://api.telegram.org",
    pollEnabled: parseBool(src.poll_enabled, true),
    dailyReportEnabled: parseBool(src.daily_report_enabled, true),
    dailyReportCron: String(src.daily_report_cron || "0 9 * * *").trim() || "0 9 * * *",
    alertEnabled: parseBool(src.alert_enabled, true),
    alertLossNodes: String(src.alert_loss_nodes || "").trim(),
    alertLossPercent: Number(src.alert_loss_percent) || 20,
    alertCooldownMinutes: Number(src.alert_cooldown_minutes) || 60
  };
}

function isAuthorized(cfg, chatId, fromId) {
  if (!cfg.allowedChatIds || cfg.allowedChatIds.length === 0) return false;
  return Boolean(cfg.allowedSet[String(chatId)] || (fromId && cfg.allowedSet[String(fromId)]));
}

function normalizeNodesArray(rawNodes) {
  var list = [];
  if (Array.isArray(rawNodes)) {
    list = rawNodes.slice();
  } else if (rawNodes && typeof rawNodes === "object") {
    var keys = Object.keys(rawNodes);
    for (var i = 0; i < keys.length; i++) {
      var n = rawNodes[keys[i]];
      if (n && typeof n === "object") {
        list.push(n.uuid ? n : Object.assign({ uuid: keys[i] }, n));
      }
    }
  }
  list.sort(function (a, b) {
    var wa = Number(a.weight) || 0;
    var wb = Number(b.weight) || 0;
    if (wa !== wb) return wa - wb;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return list;
}

async function callRpcSafe(method, params) {
  try {
    if (params !== undefined) {
      return await server.call(method, params);
    }
    return await server.call(method);
  } catch (_) {
    return null;
  }
}

async function fetchLocalPluginJson(pathAndQuery) {
  try {
    var url = LOCAL_KOMARI_BASE + pathAndQuery;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, 8000) : null;
    try {
      var resp = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!resp || !resp.ok) return null;
      var parsed = JSON.parse(await resp.text());
      if (parsed && parsed.status === "success" && parsed.data) return parsed.data;
      return parsed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (_) {
    return null;
  }
}

async function fetchLatencySummary(hours, refresh) {
  var rpcRes = await callRpcSafe("latencyMonitor:getSummary", { hours: hours, refresh: refresh });
  if (rpcRes && Array.isArray(rpcRes.nodes)) return rpcRes;
  var q = "?hours=" + encodeURIComponent(hours) + (refresh ? "&refresh=1" : "");
  var httpRes = await fetchLocalPluginJson("/api/plugin/latency-monitor/summary" + q);
  return httpRes && Array.isArray(httpRes.nodes) ? httpRes : null;
}

async function fetchTrafficSummary(refresh) {
  var rpcRes = await callRpcSafe("trafficQuota:getSummary", { refresh: refresh });
  if (rpcRes && Array.isArray(rpcRes.nodes)) return rpcRes;
  var q = refresh ? "?refresh=1" : "";
  var httpRes = await fetchLocalPluginJson("/api/plugin/traffic-quota/summary" + q);
  return httpRes && Array.isArray(httpRes.nodes) ? httpRes : null;
}

async function collectFullSnapshot(options) {
  var opts = options || {};
  var hours = opts.hours ? Math.max(1, Math.min(24, Math.round(Number(opts.hours) || 1))) : 1;

  var results = await Promise.all([
    callRpcSafe("common:getNodes"),
    callRpcSafe("common:getNodesLatestStatus"),
    fetchLatencySummary(hours, Boolean(opts.refresh)),
    fetchTrafficSummary(Boolean(opts.refresh))
  ]);

  return {
    nowMs: Date.now(),
    nodes: normalizeNodesArray(results[0]),
    latestStatus: results[1] || {},
    latencySummary: results[2] || null,
    trafficSummary: results[3] || null
  };
}

function parseCommand(text) {
  var trimmed = String(text || "").trim();
  if (!trimmed) return null;
  // Support /status, /status@mybot, /ping 6, /node LA
  var m = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return {
    cmd: m[1].toLowerCase(),
    arg: (m[2] || "").trim()
  };
}

async function handleTextMessage(cfg, msg) {
  var chatId = msg && msg.chat && msg.chat.id;
  var fromId = msg && msg.from && msg.from.id;
  if (chatId === undefined || chatId === null) return;

  var parsed = parseCommand(msg.text);
  if (!parsed) return;

  // /id works even before whitelist is configured so setup is effortless (exposes zero VPS data)
  if (parsed.cmd === "id") {
    var idText =
      "🪪 <b>当前会话信息</b>\n" +
      "Chat ID: <code>" + fmt.escapeHtml(chatId) + "</code>" +
      (fromId !== undefined && String(fromId) !== String(chatId) ? "\nUser ID: <code>" + fmt.escapeHtml(fromId) + "</code>" : "") +
      "\n\n请将此 ID 填入 Komari 后台「Telegram 状态查询机器人 → 允许访问的 Chat ID」并保存。";
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, idText);
    return;
  }

  if (!isAuthorized(cfg, chatId, fromId)) {
    return;
  }

  runtime.handledCount += 1;

  if (parsed.cmd === "help") {
    var help = fmt.formatHelpMessage();
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, help.text);
    return;
  }

  if (parsed.cmd === "status" || parsed.cmd === "start" || parsed.cmd === "s") {
    var snap = await collectFullSnapshot({ refresh: true });
    var out = fmt.formatStatusOverview(snap);
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, out.text, out.reply_markup);
    return;
  }

  if (parsed.cmd === "ping" || parsed.cmd === "p") {
    var hours = parsed.arg ? Number(parsed.arg) : 1;
    var pSnap = await collectFullSnapshot({ hours: hours || 1, refresh: true });
    var pOut = fmt.formatPingReport(pSnap);
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, pOut.text, pOut.reply_markup);
    return;
  }

  if (parsed.cmd === "traffic" || parsed.cmd === "t") {
    var tSnap = await collectFullSnapshot({ refresh: true });
    var tOut = fmt.formatTrafficReport(tSnap);
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, tOut.text, tOut.reply_markup);
    return;
  }

  if (parsed.cmd === "node" || parsed.cmd === "n") {
    var nSnap = await collectFullSnapshot({ refresh: true });
    if (!parsed.arg) {
      var overview = fmt.formatStatusOverview(nSnap);
      await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, overview.text, overview.reply_markup);
      return;
    }
    var nOut = fmt.formatSingleNodeReport(nSnap, parsed.arg);
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, nOut.text, nOut.reply_markup);
  }
}

async function handleCallbackQuery(cfg, cq) {
  if (!cq || !cq.id) return;
  var msg = cq.message;
  var chatId = msg && msg.chat && msg.chat.id;
  var messageId = msg && msg.message_id;
  var fromId = cq.from && cq.from.id;
  var data = String(cq.data || "");

  if (chatId === undefined || !isAuthorized(cfg, chatId, fromId)) {
    await tg.answerCallbackQuery(cfg.apiBase, cfg.botToken, cq.id, "无权限");
    return;
  }

  runtime.handledCount += 1;
  await tg.answerCallbackQuery(cfg.apiBase, cfg.botToken, cq.id, "正在刷新...");

  var snap = await collectFullSnapshot({ refresh: true });
  var out = null;

  if (data === "cmd:status") {
    out = fmt.formatStatusOverview(snap);
  } else if (data === "cmd:ping") {
    out = fmt.formatPingReport(snap);
  } else if (data === "cmd:traffic") {
    out = fmt.formatTrafficReport(snap);
  } else if (data.indexOf("node:") === 0) {
    out = fmt.formatSingleNodeReport(snap, data.slice(5));
  }

  if (out && messageId) {
    await tg.editMessageText(cfg.apiBase, cfg.botToken, chatId, messageId, out.text, out.reply_markup);
  } else if (out) {
    await tg.sendMessage(cfg.apiBase, cfg.botToken, chatId, out.text, out.reply_markup);
  }
}

async function broadcastToAllowed(cfg, text, replyMarkup) {
  if (!cfg.botToken || cfg.allowedChatIds.length === 0) return 0;
  var sent = 0;
  for (var i = 0; i < cfg.allowedChatIds.length; i++) {
    try {
      await tg.sendMessage(cfg.apiBase, cfg.botToken, cfg.allowedChatIds[i], text, replyMarkup);
      sent += 1;
    } catch (err) {
      runtime.lastError = err && err.message ? err.message : String(err);
      console.warn("[tg-bot] send to " + cfg.allowedChatIds[i] + " failed:", runtime.lastError);
    }
  }
  return sent;
}

async function runDailyReport() {
  try {
    var cfg = normalizeConfig(await server.getConfig());
    if (!cfg.dailyReportEnabled || !cfg.botToken || cfg.allowedChatIds.length === 0) return;
    var snap = await collectFullSnapshot({ refresh: true });
    var out = fmt.formatStatusOverview(snap);
    var text = "🌅 <b>每日定时状态播报</b>\n\n" + out.text;
    await broadcastToAllowed(cfg, text, out.reply_markup);
  } catch (err) {
    runtime.lastError = err && err.message ? err.message : String(err);
    console.warn("[tg-bot] daily report error:", runtime.lastError);
  }
}

async function runAlertCheck() {
  try {
    var cfg = normalizeConfig(await server.getConfig());
    if (!cfg.alertEnabled || !cfg.botToken || cfg.allowedChatIds.length === 0) return;
    var snap = await collectFullSnapshot({ refresh: false });
    var msgs = alertEngine.evaluate(snap, cfg);
    for (var i = 0; i < msgs.length; i++) {
      var n = await broadcastToAllowed(cfg, msgs[i]);
      runtime.alertsSentCount += n;
    }
  } catch (err) {
    runtime.lastError = err && err.message ? err.message : String(err);
    console.warn("[tg-bot] alert check error:", runtime.lastError);
  }
}

function scheduleNextPoll(gen, delayMs) {
  if (!runtime.running || gen !== runtime.generation) return;
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
  runtime.pollTimer = setTimeout(function () {
    pollOnce(gen, delayMs);
  }, delayMs);
}

async function pollOnce(gen, prevBackoffMs) {
  if (!runtime.running || gen !== runtime.generation) return;
  var nextBackoff = 2000;

  try {
    var cfg = normalizeConfig(await server.getConfig());
    if (!cfg.botToken || !cfg.pollEnabled) {
      scheduleNextPoll(gen, 10000);
      return;
    }

    if (!runtime.commandsSynced) {
      runtime.commandsSynced = true;
      tg.setMyCommands(cfg.apiBase, cfg.botToken);
    }

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    runtime.pollController = controller;
    var updates = await tg.getUpdates(
      cfg.apiBase,
      cfg.botToken,
      runtime.offset,
      POLL_TIMEOUT_SEC,
      controller ? controller.signal : undefined
    );
    runtime.pollController = null;

    if (!runtime.running || gen !== runtime.generation) return;

    runtime.lastPollAt = new Date().toISOString();
    runtime.lastError = "";

    if (Array.isArray(updates) && updates.length > 0) {
      for (var i = 0; i < updates.length; i++) {
        var u = updates[i];
        if (u && typeof u.update_id === "number" && u.update_id >= runtime.offset) {
          runtime.offset = u.update_id + 1;
        }
        try {
          if (u && u.message) {
            await handleTextMessage(cfg, u.message);
          } else if (u && u.callback_query) {
            await handleCallbackQuery(cfg, u.callback_query);
          }
        } catch (handleErr) {
          runtime.lastError = handleErr && handleErr.message ? handleErr.message : String(handleErr);
          console.warn("[tg-bot] update handler error:", runtime.lastError);
        }
      }
    }

    scheduleNextPoll(gen, 300);
  } catch (err) {
    runtime.pollController = null;
    if (!runtime.running || gen !== runtime.generation) return;
    var msg = err && err.message ? err.message : String(err);
    // Ignore benign abort errors during shutdown/timeout
    if (msg.toLowerCase().indexOf("abort") === -1) {
      runtime.lastError = msg;
      console.warn("[tg-bot] poll error:", msg);
      nextBackoff = Math.min(30000, Math.max(2000, (prevBackoffMs || 2000) * 2));
    } else {
      nextBackoff = 1000;
    }
    scheduleNextPoll(gen, nextBackoff);
  }
}

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isAdministrator(req) {
  var ctx = req && req.context;
  if (!ctx) return false;
  if (ctx.role === "admin") return true;
  var principal = ctx.principal;
  return Boolean(principal && Array.isArray(principal.roles) && principal.roles.indexOf("admin") >= 0);
}

function load() {
  runtime.generation += 1;
  runtime.running = true;
  runtime.commandsSynced = false;
  runtime.lastError = "";
  var gen = runtime.generation;

  // Admin diagnostic endpoint
  server.route("GET", ROUTE_BASE + "/status", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    var cfg = normalizeConfig(await server.getConfig());
    sendJSON(res, 200, {
      status: "success",
      data: {
        running: runtime.running,
        tokenConfigured: Boolean(cfg.botToken),
        allowedChatCount: cfg.allowedChatIds.length,
        pollEnabled: cfg.pollEnabled,
        dailyReportEnabled: cfg.dailyReportEnabled,
        dailyReportCron: cfg.dailyReportCron,
        alertEnabled: cfg.alertEnabled,
        lastPollAt: runtime.lastPollAt,
        handledCount: runtime.handledCount,
        alertsSentCount: runtime.alertsSentCount,
        lastError: runtime.lastError
      }
    });
  });

  // Admin live preview endpoint (renders /status, /ping, /traffic using live Komari data)
  server.route("GET", ROUTE_BASE + "/preview", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    try {
      var q = (req && req.query) || {};
      var kind = String(q.cmd || "status").toLowerCase();
      var hours = q.hours ? Number(q.hours) : 1;
      var snap = await collectFullSnapshot({ hours: hours, refresh: false });
      var out;
      if (kind === "ping") out = fmt.formatPingReport(snap);
      else if (kind === "traffic") out = fmt.formatTrafficReport(snap);
      else if (kind === "node") out = fmt.formatSingleNodeReport(snap, q.name || "");
      else out = fmt.formatStatusOverview(snap);
      sendJSON(res, 200, {
        status: "success",
        data: {
          cmd: kind,
          hasLatencyPlugin: Boolean(snap.latencySummary),
          hasTrafficPlugin: Boolean(snap.trafficSummary),
          nodeCount: snap.nodes.length,
          text: out.text,
          reply_markup: out.reply_markup
        }
      });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // Admin manual test push endpoint
  server.route("POST", ROUTE_BASE + "/test", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    try {
      var cfg = normalizeConfig(await server.getConfig());
      if (!cfg.botToken) {
        sendJSON(res, 400, { status: "error", message: "尚未配置 Bot Token" });
        return;
      }
      if (cfg.allowedChatIds.length === 0) {
        sendJSON(res, 400, { status: "error", message: "尚未配置允许访问的 Chat ID" });
        return;
      }
      var snap = await collectFullSnapshot({ refresh: true });
      var out = fmt.formatStatusOverview(snap);
      var sent = await broadcastToAllowed(cfg, out.text, out.reply_markup);
      sendJSON(res, 200, { status: "success", data: { sent: sent } });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 5-minute alert check cron
  server.cron("*/5 * * * *", function () {
    runAlertCheck();
  });

  // Start polling & register configured daily report cron shortly after load
  runtime.startupTimer = setTimeout(async function () {
    if (!runtime.running || gen !== runtime.generation) return;
    try {
      var cfg = normalizeConfig(await server.getConfig());
      if (cfg.dailyReportEnabled && cfg.dailyReportCron) {
        try {
          server.cron(cfg.dailyReportCron, function () {
            runDailyReport();
          });
          runtime.dailyCronSpec = cfg.dailyReportCron;
        } catch (cronErr) {
          console.warn("[tg-bot] invalid daily_report_cron:", cfg.dailyReportCron, cronErr && cronErr.message);
        }
      }
    } catch (_) {}
    pollOnce(gen, 2000);
  }, 1000);

  console.info("[tg-bot] plugin loaded successfully");
}

function unload() {
  runtime.running = false;
  runtime.generation += 1;
  if (runtime.startupTimer) {
    clearTimeout(runtime.startupTimer);
    runtime.startupTimer = null;
  }
  if (runtime.pollTimer) {
    clearTimeout(runtime.pollTimer);
    runtime.pollTimer = null;
  }
  if (runtime.pollController) {
    try { runtime.pollController.abort(); } catch (_) {}
    runtime.pollController = null;
  }
  console.info("[tg-bot] plugin unloaded");
}
