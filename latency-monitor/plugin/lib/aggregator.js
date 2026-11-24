"use strict";

var DOT_PALETTE = [
  "#22c55e", // emerald (移动/主线)
  "#f43f5e", // rose    (电信)
  "#3b82f6", // blue    (联通)
  "#a855f7", // violet  (节点互探)
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#14b8a6", // teal
  "#f97316"  // orange
];

var DEFAULT_CONFIG = {
  windowHours: 1,
  bucketCount: 20,
  cacheTtlSeconds: 15,
  injectHomeCards: true,
  selectedTasks: [],
  cardMaxTasks: 4,
  refreshIntervalSeconds: 30,
  latencyWarnMs: 300,
  latencyCriticalMs: 500,
  lossWarnPercent: 1,
  lossCriticalPercent: 10
};

function clampNumber(value, min, max, fallback) {
  var num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function parseTaskIdList(raw) {
  if (!raw) return [];
  var arr = raw;
  if (typeof raw === "string") {
    var trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.charAt(0) === "[") {
      try {
        arr = JSON.parse(trimmed);
      } catch (_) {
        arr = trimmed.split(",");
      }
    } else {
      arr = trimmed.split(",");
    }
  }
  if (!Array.isArray(arr)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    var id = typeof item === "object" && item !== null ? Number(item.id) : Number(item);
    if (Number.isInteger(id) && id > 0 && !seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  return out;
}

function normalizeConfig(raw) {
  var src = raw && typeof raw === "object" ? raw : {};
  var latencyWarnMs = clampInt(src.latency_warn_ms, 10, 10000, DEFAULT_CONFIG.latencyWarnMs);
  var latencyCriticalMs = clampInt(src.latency_critical_ms, latencyWarnMs, 30000, Math.max(latencyWarnMs, DEFAULT_CONFIG.latencyCriticalMs));
  var lossWarnPercent = clampNumber(src.loss_warn_percent, 0.1, 100, DEFAULT_CONFIG.lossWarnPercent);
  var lossCriticalPercent = clampNumber(src.loss_critical_percent, lossWarnPercent, 100, Math.max(lossWarnPercent, DEFAULT_CONFIG.lossCriticalPercent));

  return {
    windowHours: clampInt(src.window_hours, 1, 168, DEFAULT_CONFIG.windowHours),
    bucketCount: clampInt(src.bucket_count, 6, 60, DEFAULT_CONFIG.bucketCount),
    cacheTtlSeconds: clampInt(src.cache_ttl_seconds, 5, 120, DEFAULT_CONFIG.cacheTtlSeconds),
    injectHomeCards: parseBool(src.inject_home_cards, DEFAULT_CONFIG.injectHomeCards),
    selectedTasks: parseTaskIdList(src.selected_tasks),
    cardMaxTasks: clampInt(src.card_max_tasks, 1, 12, DEFAULT_CONFIG.cardMaxTasks),
    refreshIntervalSeconds: clampInt(src.refresh_interval_seconds, 10, 300, DEFAULT_CONFIG.refreshIntervalSeconds),
    latencyWarnMs: latencyWarnMs,
    latencyCriticalMs: latencyCriticalMs,
    lossWarnPercent: lossWarnPercent,
    lossCriticalPercent: lossCriticalPercent
  };
}

function normalizeNodes(rawNodes) {
  var list = [];
  if (Array.isArray(rawNodes)) {
    list = rawNodes.slice();
  } else if (rawNodes && typeof rawNodes === "object") {
    var keys = Object.keys(rawNodes);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var node = rawNodes[k];
      if (node && typeof node === "object") {
        if (!node.uuid) {
          node = Object.assign({ uuid: k }, node);
        }
        list.push(node);
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

function round1(val) {
  return Math.round(val * 10) / 10;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

function computePercentile(sortedValues, p) {
  if (!sortedValues || sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  var pos = (sortedValues.length - 1) * p;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  var frac = pos - lo;
  return Math.round(sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac);
}

function parseTimestampMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw) {
    var ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function classifyLatencyStatus(hasSample, validCount, avgLatency, cfg) {
  if (!hasSample) return "empty";
  if (validCount === 0 || avgLatency === null) return "timeout";
  if (avgLatency >= cfg.latencyCriticalMs) return "critical";
  if (avgLatency >= cfg.latencyWarnMs) return "warn";
  return "good";
}

function classifyLossStatus(hasSample, lossPercent, cfg) {
  if (!hasSample || lossPercent === null) return "empty";
  if (lossPercent >= cfg.lossCriticalPercent) return "critical";
  if (lossPercent >= cfg.lossWarnPercent) return "warn";
  return "good";
}

function formatProbeTypeLabel(type) {
  var t = String(type || "icmp").trim().toUpperCase();
  if (t === "TCP" || t === "ICMP" || t === "HTTP" || t === "HTTPS") return t;
  return t || "PING";
}

function buildProbeFooterLabel(tasks, windowHours) {
  var types = [];
  var seen = {};
  for (var i = 0; i < tasks.length; i++) {
    var label = formatProbeTypeLabel(tasks[i].type);
    if (!seen[label]) {
      seen[label] = true;
      types.push(label);
    }
  }
  var protoText = types.length > 0 ? types.join("/") + " 探测" : "探测";
  var rangeText = windowHours >= 24 && windowHours % 24 === 0
    ? "近 " + (windowHours / 24) + " 天"
    : "近 " + windowHours + " 小时";
  return protoText + " · " + rangeText + " · 灰色为无采样";
}

function taskAppliesToNode(task, uuid) {
  if (!task || !uuid) return false;
  if (Array.isArray(task.clients)) {
    for (var i = 0; i < task.clients.length; i++) {
      if (task.clients[i] === uuid) return true;
    }
  }
  return false;
}

function buildSummaryPayload(options) {
  var opts = options || {};
  var cfg = normalizeConfig(opts.config);
  var isAdmin = Boolean(opts.isAdmin);
  var nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  var windowHours = opts.overrideHours ? clampInt(opts.overrideHours, 1, 168, cfg.windowHours) : cfg.windowHours;
  var bucketCount = opts.overrideBuckets ? clampInt(opts.overrideBuckets, 6, 60, cfg.bucketCount) : cfg.bucketCount;
  var filterUuid = typeof opts.filterUuid === "string" && opts.filterUuid.trim() ? opts.filterUuid.trim() : "";

  var windowMs = windowHours * 3600 * 1000;
  var windowEnd = nowMs;
  var windowStart = windowEnd - windowMs;
  var bucketMs = windowMs / bucketCount;

  // 1. Filter visible nodes
  var allNodes = normalizeNodes(opts.nodes);
  var visibleNodes = [];
  var visibleNodeMap = {};
  for (var i = 0; i < allNodes.length; i++) {
    var node = allNodes[i];
    if (!node || !node.uuid) continue;
    if (!isAdmin && node.hidden) continue;
    if (filterUuid && node.uuid !== filterUuid) continue;
    visibleNodes.push(node);
    visibleNodeMap[node.uuid] = node;
  }

  // 2. Sort & filter ping tasks
  var rawTasks = Array.isArray(opts.tasks) ? opts.tasks.slice() : [];
  rawTasks.sort(function (a, b) {
    var wa = Number(a.weight) || 0;
    var wb = Number(b.weight) || 0;
    if (wa !== wb) return wa - wb;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  var selectedSet = null;
  if (cfg.selectedTasks.length > 0) {
    selectedSet = {};
    for (var s = 0; s < cfg.selectedTasks.length; s++) {
      selectedSet[cfg.selectedTasks[s]] = true;
    }
  }

  var activeTasks = [];
  var taskMap = {};
  for (var t = 0; t < rawTasks.length; t++) {
    var task = rawTasks[t];
    if (!task || !task.id) continue;
    if (selectedSet && !selectedSet[Number(task.id)]) continue;
    activeTasks.push(task);
    taskMap[Number(task.id)] = task;
  }

  // 3. Index records by client + task_id in a single pass
  var records = Array.isArray(opts.records) ? opts.records : [];
  var pairBuckets = {};
  var pairStats = {};
  var pairSeenByNode = {};

  for (var r = 0; r < records.length; r++) {
    var rec = records[r];
    if (!rec) continue;
    var clientUuid = rec.client;
    var taskId = Number(rec.task_id);
    if (!clientUuid || !visibleNodeMap[clientUuid]) continue;
    if (!taskId || !taskMap[taskId]) continue;

    var ts = parseTimestampMs(rec.time);
    if (!Number.isFinite(ts)) continue;
    if (ts < windowStart || ts > windowEnd + 5000) continue;

    var key = clientUuid + ":" + taskId;
    var buckets = pairBuckets[key];
    var st = pairStats[key];
    if (!buckets) {
      buckets = new Array(bucketCount);
      for (var b = 0; b < bucketCount; b++) {
        buckets[b] = { total: 0, valid: 0, loss: 0, sum: 0, min: null, max: null };
      }
      pairBuckets[key] = buckets;
      st = {
        total: 0,
        valid: 0,
        loss: 0,
        sum: 0,
        min: null,
        max: null,
        latestVal: null,
        latestTs: -1,
        latestAnyTs: -1,
        latestWasLoss: false,
        latencies: []
      };
      pairStats[key] = st;
      if (!pairSeenByNode[clientUuid]) pairSeenByNode[clientUuid] = {};
      pairSeenByNode[clientUuid][taskId] = true;
    }

    var idx = Math.floor((ts - windowStart) / bucketMs);
    if (idx < 0) idx = 0;
    if (idx >= bucketCount) idx = bucketCount - 1;

    var bucket = buckets[idx];
    var val = Number(rec.value);
    var isLoss = !Number.isFinite(val) || val < 0;

    bucket.total += 1;
    st.total += 1;
    if (ts >= st.latestAnyTs) {
      st.latestAnyTs = ts;
      st.latestWasLoss = isLoss;
    }

    if (isLoss) {
      bucket.loss += 1;
      st.loss += 1;
    } else {
      bucket.valid += 1;
      bucket.sum += val;
      if (bucket.min === null || val < bucket.min) bucket.min = val;
      if (bucket.max === null || val > bucket.max) bucket.max = val;

      st.valid += 1;
      st.sum += val;
      if (st.min === null || val < st.min) st.min = val;
      if (st.max === null || val > st.max) st.max = val;
      if (ts >= st.latestTs) {
        st.latestTs = ts;
        st.latestVal = val;
      }
      st.latencies.push(val);
    }
  }

  // 4. Assemble per-node result
  var latestStatusMap = opts.latestStatus && typeof opts.latestStatus === "object" ? opts.latestStatus : {};
  var nodeResults = [];
  var globalLatencySum = 0;
  var globalLatencyCount = 0;
  var globalSamples = 0;
  var globalValidSamples = 0;
  var alertTaskCount = 0;
  var totalAssignedSeries = 0;

  for (var n = 0; n < visibleNodes.length; n++) {
    var nd = visibleNodes[n];
    var uuid = nd.uuid;
    var nodeTasks = [];

    for (var ti = 0; ti < activeTasks.length; ti++) {
      var tk = activeTasks[ti];
      var tid = Number(tk.id);
      var assigned = taskAppliesToNode(tk, uuid) || Boolean(pairSeenByNode[uuid] && pairSeenByNode[uuid][tid]);
      if (!assigned) continue;

      totalAssignedSeries += 1;
      var pk = uuid + ":" + tid;
      var rawBuckets = pairBuckets[pk];
      var stat = pairStats[pk];
      var finalizedBuckets = new Array(bucketCount);

      for (var bi = 0; bi < bucketCount; bi++) {
        var bStart = Math.round(windowStart + bi * bucketMs);
        var bEnd = Math.round(windowStart + (bi + 1) * bucketMs);
        var rb = rawBuckets ? rawBuckets[bi] : null;
        if (!rb || rb.total === 0) {
          finalizedBuckets[bi] = {
            start: bStart,
            end: bEnd,
            total: 0,
            valid: 0,
            loss: 0,
            avgLatency: null,
            minLatency: null,
            maxLatency: null,
            lossPercent: null,
            latencyStatus: "empty",
            lossStatus: "empty"
          };
        } else {
          var bAvg = rb.valid > 0 ? Math.round(rb.sum / rb.valid) : null;
          var bLossPct = round1((rb.loss / rb.total) * 100);
          finalizedBuckets[bi] = {
            start: bStart,
            end: bEnd,
            total: rb.total,
            valid: rb.valid,
            loss: rb.loss,
            avgLatency: bAvg,
            minLatency: rb.min,
            maxLatency: rb.max,
            lossPercent: bLossPct,
            latencyStatus: classifyLatencyStatus(true, rb.valid, bAvg, cfg),
            lossStatus: classifyLossStatus(true, bLossPct, cfg)
          };
        }
      }

      var total = stat ? stat.total : 0;
      var valid = stat ? stat.valid : 0;
      var lossCount = stat ? stat.loss : 0;
      var avgLatency = valid > 0 ? Math.round(stat.sum / valid) : null;
      var latestLatency = stat && stat.latestVal !== null ? Math.round(stat.latestVal) : null;
      var lossPercent = total > 0 ? round1((lossCount / total) * 100) : null;
      var availabilityPercent = total > 0 ? round2(((total - lossCount) / total) * 100) : null;

      var p50Latency = null;
      var p95Latency = null;
      if (stat && stat.latencies.length > 0) {
        stat.latencies.sort(function (a, b) { return a - b; });
        p50Latency = computePercentile(stat.latencies, 0.50);
        p95Latency = computePercentile(stat.latencies, 0.95);
      }

      var displayLatency = stat && stat.latestWasLoss ? null : latestLatency;
      var latencyStatus = classifyLatencyStatus(total > 0, valid, displayLatency !== null ? displayLatency : avgLatency, cfg);
      var lossStatus = classifyLossStatus(total > 0, lossPercent, cfg);

      if (latencyStatus === "critical" || latencyStatus === "timeout" || lossStatus === "critical") {
        alertTaskCount += 1;
      }
      if (avgLatency !== null) {
        globalLatencySum += avgLatency;
        globalLatencyCount += 1;
      }
      globalSamples += total;
      globalValidSamples += valid;

      var dotColor = DOT_PALETTE[nodeTasks.length % DOT_PALETTE.length];

      nodeTasks.push({
        id: tid,
        name: String(tk.name || ("Task #" + tid)),
        type: formatProbeTypeLabel(tk.type),
        interval: Number(tk.interval) || 60,
        dotColor: dotColor,
        latestLatency: latestLatency,
        latestWasLoss: Boolean(stat && stat.latestWasLoss),
        avgLatency: avgLatency,
        minLatency: stat ? stat.min : null,
        maxLatency: stat ? stat.max : null,
        p50Latency: p50Latency,
        p95Latency: p95Latency,
        lossPercent: lossPercent,
        availabilityPercent: availabilityPercent,
        totalSamples: total,
        lossSamples: lossCount,
        latencyStatus: latencyStatus,
        lossStatus: lossStatus,
        buckets: finalizedBuckets
      });
    }

    var liveStatus = latestStatusMap[uuid];
    var isOnline = Boolean(liveStatus && (liveStatus.online === true || liveStatus.time));

    nodeResults.push({
      uuid: uuid,
      name: String(nd.name || uuid),
      region: String(nd.region || ""),
      group: String(nd.group || ""),
      os: String(nd.os || ""),
      arch: String(nd.arch || ""),
      online: isOnline,
      footerLabel: buildProbeFooterLabel(nodeTasks, windowHours),
      tasks: nodeTasks
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: windowHours,
    bucketCount: bucketCount,
    windowStart: windowStart,
    windowEnd: windowEnd,
    isAdmin: isAdmin,
    config: {
      injectHomeCards: cfg.injectHomeCards,
      cardMaxTasks: cfg.cardMaxTasks,
      refreshIntervalSeconds: cfg.refreshIntervalSeconds,
      latencyWarnMs: cfg.latencyWarnMs,
      latencyCriticalMs: cfg.latencyCriticalMs,
      lossWarnPercent: cfg.lossWarnPercent,
      lossCriticalPercent: cfg.lossCriticalPercent
    },
    overview: {
      nodeCount: nodeResults.length,
      taskCount: activeTasks.length,
      seriesCount: totalAssignedSeries,
      avgLatency: globalLatencyCount > 0 ? Math.round(globalLatencySum / globalLatencyCount) : null,
      availabilityPercent: globalSamples > 0 ? round2((globalValidSamples / globalSamples) * 100) : null,
      alertTaskCount: alertTaskCount
    },
    nodes: nodeResults
  };
}

module.exports = {
  DOT_PALETTE: DOT_PALETTE,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  normalizeConfig: normalizeConfig,
  normalizeNodes: normalizeNodes,
  buildSummaryPayload: buildSummaryPayload,
  classifyLatencyStatus: classifyLatencyStatus,
  classifyLossStatus: classifyLossStatus
};
