"use strict";

var fs = require("fs");
var path = require("path");
var server = require("server");
var cycleLib = require("./lib/cycle.js");
var ledgerLib = require("./lib/ledger.js");

var PLUGIN_SHORT = "traffic-quota";
var ROUTE_BASE = "/api/plugin/" + PLUGIN_SHORT;
var ASSET_VERSION = "1.0.4";
var CACHE_TTL_MS = 10000;

var ledgerState = ledgerLib.createEmptyLedger();
var rulesState = {};
var summaryCache = {};
var startupTimer = null;
var samplingInFlight = false;

function getStorageDir() {
  if (typeof __storageDir__ === "string" && __storageDir__) {
    return __storageDir__;
  }
  return path.join(__dirname, ".storage");
}

function getLedgerPath() {
  return path.join(getStorageDir(), "ledger.json");
}

function getRulesPath() {
  return path.join(getStorageDir(), "rules.json");
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    var raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (err) {
    console.warn("[traffic-quota] failed to read " + filePath + ":", err && err.message ? err.message : err);
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  try {
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    var payload = JSON.stringify(data, null, 2);
    var tmpPath = filePath + ".tmp";
    var writeOpts = { encoding: "utf8", mode: 420 };
    try {
      fs.writeFileSync(tmpPath, payload, writeOpts);
      fs.renameSync(tmpPath, filePath);
    } catch (_) {
      fs.writeFileSync(filePath, payload, writeOpts);
    }
  } catch (err) {
    console.error("[traffic-quota] failed to write " + filePath + ":", err && err.message ? err.message : err);
  }
}

function loadStateFromDisk() {
  var loadedLedger = readJsonFile(getLedgerPath(), null);
  if (loadedLedger && loadedLedger.nodes && typeof loadedLedger.nodes === "object") {
    ledgerState = loadedLedger;
  } else {
    ledgerState = ledgerLib.createEmptyLedger();
  }
  var loadedRules = readJsonFile(getRulesPath(), {});
  rulesState = loadedRules && typeof loadedRules === "object" ? loadedRules : {};
}

function saveLedgerToDisk() {
  writeJsonFile(getLedgerPath(), ledgerState);
}

function saveRulesToDisk() {
  writeJsonFile(getRulesPath(), rulesState);
}

function invalidateCache() {
  summaryCache = {};
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
  if (principal && Array.isArray(principal.roles) && principal.roles.indexOf("admin") >= 0) {
    return true;
  }
  return false;
}

function parseJsonBody(req) {
  if (!req || !req.body) return {};
  try {
    var parsed = JSON.parse(req.body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function fetchLatestStatusSafe() {
  try {
    var st = await server.call("common:getNodesLatestStatus");
    return st && typeof st === "object" ? st : {};
  } catch (_) {
    return {};
  }
}

async function seedNewNodesIfNeeded(statusMap, tzOffset) {
  var uuids = Object.keys(statusMap || {});
  var seededAny = false;
  for (var i = 0; i < uuids.length; i++) {
    var uuid = uuids[i];
    var existing = ledgerState.nodes && ledgerState.nodes[uuid];
    if (existing && existing.seeded) continue;
    try {
      var recResp = await server.call("common:getRecords", {
        type: "load",
        load_type: "network",
        uuid: uuid,
        hours: 24,
        maxCount: -1
      });
      var recs = recResp && recResp.records && Array.isArray(recResp.records[uuid])
        ? recResp.records[uuid]
        : [];
      if (recs.length > 0) {
        if (ledgerLib.seedNodeFromNetworkRecords(ledgerState, uuid, recs, tzOffset)) {
          seededAny = true;
        }
      }
    } catch (_) {
      // Non-fatal: baseline will be created from latest status
    }
  }
  return seededAny;
}

async function collectSampleNow() {
  if (samplingInFlight) return;
  samplingInFlight = true;
  try {
    var rawCfg = await server.getConfig();
    var cfg = ledgerLib.normalizeGlobalConfig(rawCfg);
    var statusMap = await fetchLatestStatusSafe();
    var seeded = await seedNewNodesIfNeeded(statusMap, cfg.timezoneOffset);
    var changed = ledgerLib.applySampleToLedger(ledgerState, statusMap, Date.now(), cfg.timezoneOffset);
    if (seeded || changed) {
      saveLedgerToDisk();
      invalidateCache();
    }
  } catch (err) {
    console.warn("[traffic-quota] sample collection error:", err && err.message ? err.message : err);
  } finally {
    samplingInFlight = false;
  }
}

async function computeSummary(options) {
  var opts = options || {};
  var isAdmin = Boolean(opts.isAdmin);
  var forceRefresh = Boolean(opts.refresh);
  var cacheKey = isAdmin ? "admin" : "public";
  var nowMs = Date.now();

  if (!forceRefresh && summaryCache[cacheKey] && (nowMs - summaryCache[cacheKey].ts) < CACHE_TTL_MS) {
    return summaryCache[cacheKey].data;
  }

  var results = await Promise.all([
    server.getConfig(),
    server.call("common:getNodes"),
    fetchLatestStatusSafe()
  ]);

  var rawCfg = results[0];
  var nodes = results[1];
  var latestStatus = results[2];
  var cfg = ledgerLib.normalizeGlobalConfig(rawCfg);

  // Persist any fresh delta if ledger is empty or force refresh requested
  if (forceRefresh || Object.keys(ledgerState.nodes || {}).length === 0) {
    var seeded = await seedNewNodesIfNeeded(latestStatus, cfg.timezoneOffset);
    var changed = ledgerLib.applySampleToLedger(ledgerState, latestStatus, nowMs, cfg.timezoneOffset);
    if (seeded || changed) {
      saveLedgerToDisk();
    }
  }

  var summary = ledgerLib.buildQuotaOverview({
    nodes: nodes,
    latestStatus: latestStatus,
    ledger: ledgerState,
    rules: rulesState,
    globalConfig: rawCfg,
    isAdmin: isAdmin,
    nowMs: nowMs
  });

  summaryCache[cacheKey] = { ts: nowMs, data: summary };
  return summary;
}

function load() {
  loadStateFromDisk();

  // 1. Mount static assets and standalone page
  server.static(ROUTE_BASE + "/assets", "assets");
  server.static(ROUTE_BASE + "/pages", "pages");

  // 2. Public/Authenticated summary endpoint
  server.route("GET", ROUTE_BASE + "/summary", async function (req, res) {
    try {
      var q = (req && req.query) || {};
      var refresh = q.refresh === "1" || q.refresh === "true";
      var data = await computeSummary({
        isAdmin: isAdministrator(req),
        refresh: refresh
      });
      sendJSON(res, 200, { status: "success", data: data });
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      console.error("[traffic-quota] /summary error:", msg);
      sendJSON(res, 500, { status: "error", message: msg });
    }
  });

  // 3. Admin endpoint: get all nodes & current per-node quota rules
  server.route("GET", ROUTE_BASE + "/admin/rules", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    try {
      var data = await computeSummary({ isAdmin: true, refresh: true });
      sendJSON(res, 200, {
        status: "success",
        data: {
          config: data.config,
          nodes: data.nodes,
          modeLabels: ledgerLib.MODE_LABELS
        }
      });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 4. Admin endpoint: save per-node quota rules (batch or single)
  server.route("POST", ROUTE_BASE + "/admin/rules", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    var body = parseJsonBody(req);
    if (!body || !body.rules || typeof body.rules !== "object" || Array.isArray(body.rules)) {
      sendJSON(res, 400, { status: "error", message: "请提供 rules 对象（键为节点 UUID）" });
      return;
    }

    try {
      var rawCfg = await server.getConfig();
      var cfg = ledgerLib.normalizeGlobalConfig(rawCfg);
      var nowMs = Date.now();
      var latestStatus = await fetchLatestStatusSafe();
      var seeded = await seedNewNodesIfNeeded(latestStatus, cfg.timezoneOffset);
      var sampled = ledgerLib.applySampleToLedger(ledgerState, latestStatus, nowMs, cfg.timezoneOffset);
      if (seeded || sampled) {
        saveLedgerToDisk();
      }

      var uuids = Object.keys(body.rules);
      var updated = {};

      for (var i = 0; i < uuids.length; i++) {
        var uuid = String(uuids[i] || "").trim();
        if (!uuid) continue;
        var entry = body.rules[uuid];
        if (entry === null) {
          delete rulesState[uuid];
          continue;
        }
        var targetResetDay = entry && (entry.resetDay !== undefined ? entry.resetDay : entry.reset_day);
        var cycle = cycleLib.computeBillingCycle(targetResetDay || 1, nowMs, cfg.timezoneOffset);
        var nl = ledgerState.nodes && ledgerState.nodes[uuid] ? ledgerState.nodes[uuid] : null;
        var liveCounters = ledgerLib.extractCounters(latestStatus[uuid]);
        var trackedNow = ledgerLib.computeTrackedCycleTotals(nl, liveCounters, cycle);

        var checked = ledgerLib.sanitizeNodeRule(entry, nowMs, cfg.timezoneOffset, {
          existingRule: rulesState[uuid] || null,
          currentTrackedUp: trackedNow.trackedUp,
          currentTrackedDown: trackedNow.trackedDown
        });
        if (checked.error) {
          sendJSON(res, 400, { status: "error", message: "节点 " + uuid + " 配置有误：" + checked.error });
          return;
        }
        updated[uuid] = checked.rule;
      }

      var updatedKeys = Object.keys(updated);
      for (var j = 0; j < updatedKeys.length; j++) {
        rulesState[updatedKeys[j]] = updated[updatedKeys[j]];
      }

      saveRulesToDisk();
      invalidateCache();

      var fresh = await computeSummary({ isAdmin: true, refresh: true });
      sendJSON(res, 200, { status: "success", data: fresh });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 5. Register plugin RPC
  server.registerRPC("trafficQuota:getSummary", async function (params) {
    var p = params && typeof params === "object" ? params : {};
    return await computeSummary({ isAdmin: true, refresh: Boolean(p.refresh) });
  });

  // 6. Schedule 5-minute reboot-safe traffic sampling cron
  server.cron("*/5 * * * *", function () {
    collectSampleNow();
  });

  // 7. Inject homepage card quota bar CSS + JS
  var headHTML = '<link rel="stylesheet" href="' + ROUTE_BASE + '/assets/inject.css?v=' + ASSET_VERSION + '" />';
  var bodyHTML = '<script src="' + ROUTE_BASE + '/assets/inject.js?v=' + ASSET_VERSION + '" defer></script>';
  server.injectHTML(headHTML, bodyHTML);

  // Initial sample shortly after startup
  startupTimer = setTimeout(function () {
    collectSampleNow();
  }, 1200);

  console.info("[traffic-quota] plugin loaded successfully");
}

function unload() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  invalidateCache();
  console.info("[traffic-quota] plugin unloaded");
}
