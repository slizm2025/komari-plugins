"use strict";

var server = require("server");
var aggregator = require("./lib/aggregator.js");
var presets = require("./lib/presets.js");

var PLUGIN_SHORT = "latency-monitor";
var ROUTE_BASE = "/api/plugin/" + PLUGIN_SHORT;
var ASSET_VERSION = "1.0.1";

var summaryCache = {};

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

function invalidateCache() {
  summaryCache = {};
}

function parseQueryInt(query, key) {
  if (!query || query[key] === undefined || query[key] === null || query[key] === "") {
    return null;
  }
  var n = Number(query[key]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function extractRecordsArray(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.records)) return resp.records;
  return [];
}

async function fetchLiveStatusSafe() {
  try {
    var st = await server.call("common:getNodesLatestStatus");
    return st && typeof st === "object" ? st : {};
  } catch (_) {
    return {};
  }
}

async function computeSummary(options) {
  var opts = options || {};
  var rawConfig = await server.getConfig();
  var cfg = aggregator.normalizeConfig(rawConfig);

  var windowHours = opts.hours || cfg.windowHours;
  var bucketCount = opts.buckets || cfg.bucketCount;
  var isAdmin = Boolean(opts.isAdmin);
  var filterUuid = opts.uuid || "";
  var forceRefresh = Boolean(opts.refresh);

  var cacheKey = [windowHours, bucketCount, isAdmin ? "1" : "0", filterUuid].join(":");
  var nowMs = Date.now();
  var ttlMs = cfg.cacheTtlSeconds * 1000;

  if (!forceRefresh && summaryCache[cacheKey] && (nowMs - summaryCache[cacheKey].ts) < ttlMs) {
    return summaryCache[cacheKey].data;
  }

  var rpcParams = {
    type: "ping",
    hours: windowHours,
    maxCount: -1
  };
  if (filterUuid) {
    rpcParams.uuid = filterUuid;
  }

  var results = await Promise.all([
    server.call("common:getNodes"),
    server.call("admin:getAllPingTasks"),
    server.call("common:getRecords", rpcParams),
    fetchLiveStatusSafe()
  ]);

  var nodes = results[0];
  var tasks = results[1];
  var pingResp = results[2];
  var latestStatus = results[3];

  var summary = aggregator.buildSummaryPayload({
    nodes: nodes,
    tasks: tasks,
    records: extractRecordsArray(pingResp),
    latestStatus: latestStatus,
    config: rawConfig,
    isAdmin: isAdmin,
    nowMs: nowMs,
    overrideHours: windowHours,
    overrideBuckets: bucketCount,
    filterUuid: filterUuid
  });

  // Prevent unbounded cache growth when callers vary parameters
  var keys = Object.keys(summaryCache);
  if (keys.length > 32) {
    summaryCache = {};
  }
  summaryCache[cacheKey] = { ts: nowMs, data: summary };
  return summary;
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

function load() {
  // 1. Static frontend assets & standalone page
  server.static(ROUTE_BASE + "/assets", "assets");
  server.static(ROUTE_BASE + "/pages", "pages");

  // 2. Public/Authenticated aggregated summary endpoint
  server.route("GET", ROUTE_BASE + "/summary", async function (req, res) {
    try {
      var q = (req && req.query) || {};
      var hours = parseQueryInt(q, "hours");
      var buckets = parseQueryInt(q, "buckets");
      var uuid = typeof q.uuid === "string" ? q.uuid.trim() : "";
      var refresh = q.refresh === "1" || q.refresh === "true";

      var data = await computeSummary({
        hours: hours,
        buckets: buckets,
        uuid: uuid,
        refresh: refresh,
        isAdmin: isAdministrator(req)
      });

      sendJSON(res, 200, { status: "success", data: data });
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      console.error("[latency-monitor] /summary error:", msg);
      sendJSON(res, 500, { status: "error", message: msg });
    }
  });

  // 3. Admin endpoint: list all native Komari ping tasks + nodes + presets
  server.route("GET", ROUTE_BASE + "/admin/tasks", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    try {
      var clientsPromise = server.call("admin:listClients").catch(function () {
        return server.call("common:getNodes");
      });
      var results = await Promise.all([
        server.call("admin:getAllPingTasks"),
        clientsPromise
      ]);
      var tasks = Array.isArray(results[0]) ? results[0] : [];
      var nodes = aggregator.normalizeNodes(results[1]).map(function (n) {
        return {
          uuid: n.uuid,
          name: n.name || n.uuid,
          region: n.region || "",
          ipv4: n.ipv4 || "",
          ipv6: n.ipv6 || "",
          hidden: Boolean(n.hidden)
        };
      });
      sendJSON(res, 200, {
        status: "success",
        data: {
          tasks: tasks,
          nodes: nodes,
          presets: presets.THREE_NET_PRESETS
        }
      });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 4. Admin endpoint: batch create native Komari ping tasks (e.g. three-net or mesh probes)
  server.route("POST", ROUTE_BASE + "/admin/tasks", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    var body = parseJsonBody(req);
    if (!body) {
      sendJSON(res, 400, { status: "error", message: "无效的 JSON 请求体" });
      return;
    }

    var inputTasks = [];
    if (body.mode === "mesh") {
      if (!Array.isArray(body.nodes) || body.nodes.length < 2) {
        sendJSON(res, 400, { status: "error", message: "节点互探至少需要选择 2 个带地址的节点" });
        return;
      }
      inputTasks = presets.buildMeshTasks(body.nodes, body.port || 443, body.interval || 60, body.type || "tcp");
    } else if (Array.isArray(body.tasks)) {
      inputTasks = body.tasks;
    } else {
      sendJSON(res, 400, { status: "error", message: "请提供 tasks 数组或 mode=mesh 参数" });
      return;
    }

    if (inputTasks.length === 0) {
      sendJSON(res, 400, { status: "error", message: "未生成任何有效的探测任务" });
      return;
    }

    try {
      var existing = await server.call("admin:getAllPingTasks");
      var plan = presets.planTaskCreation(inputTasks, existing, body.skipDuplicates !== false);

      if (plan.errors.length > 0 && plan.toCreate.length === 0) {
        sendJSON(res, 400, {
          status: "error",
          message: plan.errors[0].error,
          data: { errors: plan.errors, skipped: plan.skipped.length }
        });
        return;
      }

      var created = [];
      for (var i = 0; i < plan.toCreate.length; i++) {
        var tk = plan.toCreate[i];
        var resp = await server.call("admin:addPingTask", {
          name: tk.name,
          target: tk.target,
          type: tk.type,
          interval: tk.interval,
          clients: tk.clients,
          default_on: tk.default_on
        });
        created.push({
          id: resp && resp.task_id ? resp.task_id : null,
          name: tk.name,
          type: tk.type,
          target: tk.target,
          interval: tk.interval
        });
      }

      invalidateCache();
      sendJSON(res, 200, {
        status: "success",
        data: {
          created: created,
          skippedCount: plan.skipped.length,
          errors: plan.errors
        }
      });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 5. Admin endpoint: delete native Komari ping tasks
  server.route("POST", ROUTE_BASE + "/admin/tasks/delete", async function (req, res) {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    var body = parseJsonBody(req);
    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      sendJSON(res, 400, { status: "error", message: "请提供待删除任务 ids 数组" });
      return;
    }
    var ids = [];
    for (var i = 0; i < body.ids.length; i++) {
      var id = Number(body.ids[i]);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (ids.length === 0) {
      sendJSON(res, 400, { status: "error", message: "ids 中无有效任务 ID" });
      return;
    }
    try {
      await server.call("admin:deletePingTask", { id: ids });
      invalidateCache();
      sendJSON(res, 200, { status: "success", data: { deleted: ids } });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: err && err.message ? err.message : String(err) });
    }
  });

  // 6. Register plugin RPC for other plugins / automation
  server.registerRPC("latencyMonitor:getSummary", async function (params) {
    var p = params && typeof params === "object" ? params : {};
    return await computeSummary({
      hours: p.hours ? Number(p.hours) : null,
      buckets: p.buckets ? Number(p.buckets) : null,
      uuid: typeof p.uuid === "string" ? p.uuid : "",
      refresh: Boolean(p.refresh),
      isAdmin: true
    });
  });

  // 7. Inject frontend CSS + JS into Komari HTML pages
  var headHTML = '<link rel="stylesheet" href="' + ROUTE_BASE + '/assets/inject.css?v=' + ASSET_VERSION + '" />';
  var bodyHTML = '<script src="' + ROUTE_BASE + '/assets/inject.js?v=' + ASSET_VERSION + '" defer></script>';
  server.injectHTML(headHTML, bodyHTML);

  console.info("[latency-monitor] plugin loaded successfully");
}

function unload() {
  invalidateCache();
  console.info("[latency-monitor] plugin unloaded");
}
