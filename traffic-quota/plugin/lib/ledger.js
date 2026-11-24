"use strict";

var cycleLib = require("./cycle.js");

var ALLOWED_MODES = {
  sum: true,
  out: true,
  in: true,
  max: true
};

var MODE_LABELS = {
  sum: "双向 (入+出)",
  out: "仅出站 (上传)",
  in: "仅入站 (下载)",
  max: "取单向较大值"
};

var DEFAULT_GLOBAL_CONFIG = {
  timezoneOffset: 8,
  unitBase: 1024,
  injectHomeCards: true,
  refreshIntervalSeconds: 30,
  warnPercent: 80,
  criticalPercent: 95
};

var LEDGER_RETENTION_DAYS = 100;

function clampNumber(val, min, max, fallback) {
  var n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampInt(val, min, max, fallback) {
  return Math.round(clampNumber(val, min, max, fallback));
}

function parseBool(val, fallback) {
  if (typeof val === "boolean") return val;
  if (val === "true" || val === 1 || val === "1") return true;
  if (val === "false" || val === 0 || val === "0") return false;
  return fallback;
}

function normalizeGlobalConfig(raw) {
  var src = raw && typeof raw === "object" ? raw : {};
  var unitBase = Number(src.unit_base) === 1000 ? 1000 : 1024;
  var warnPercent = clampNumber(src.warn_percent, 10, 100, DEFAULT_GLOBAL_CONFIG.warnPercent);
  var criticalPercent = clampNumber(src.critical_percent, warnPercent, 100, Math.max(warnPercent, DEFAULT_GLOBAL_CONFIG.criticalPercent));

  return {
    timezoneOffset: clampNumber(src.timezone_offset, -12, 14, DEFAULT_GLOBAL_CONFIG.timezoneOffset),
    unitBase: unitBase,
    injectHomeCards: parseBool(src.inject_home_cards, DEFAULT_GLOBAL_CONFIG.injectHomeCards),
    refreshIntervalSeconds: clampInt(src.refresh_interval_seconds, 10, 300, DEFAULT_GLOBAL_CONFIG.refreshIntervalSeconds),
    warnPercent: warnPercent,
    criticalPercent: criticalPercent
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
      var n = rawNodes[k];
      if (n && typeof n === "object") {
        list.push(n.uuid ? n : Object.assign({ uuid: k }, n));
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

function gbToBytes(gb, unitBase) {
  var n = Number(gb);
  if (!Number.isFinite(n) || n <= 0) return 0;
  var base = unitBase === 1000 ? 1000 : 1024;
  return Math.round(n * base * base * base);
}

function computeBillableBytes(upBytes, downBytes, mode) {
  var u = Math.max(0, Number(upBytes) || 0);
  var d = Math.max(0, Number(downBytes) || 0);
  if (mode === "out") return u;
  if (mode === "in") return d;
  if (mode === "max") return Math.max(u, d);
  return u + d;
}

function sanitizeCalibration(rawCal, fallbackCycleKey) {
  if (!rawCal || typeof rawCal !== "object") return null;
  var totalGB = Number(rawCal.totalGB);
  if (!Number.isFinite(totalGB) || totalGB < 0) return null;
  var baseUp = Math.max(0, Math.round(Number(rawCal.baselineUpBytes) || 0));
  var baseDown = Math.max(0, Math.round(Number(rawCal.baselineDownBytes) || 0));
  var cycleKey = typeof rawCal.cycleKey === "string" && rawCal.cycleKey ? rawCal.cycleKey : String(fallbackCycleKey || "");
  if (!cycleKey) return null;
  return {
    totalGB: Math.round(totalGB * 1000) / 1000,
    baselineUpBytes: baseUp,
    baselineDownBytes: baseDown,
    cycleKey: cycleKey,
    savedAt: typeof rawCal.savedAt === "string" ? rawCal.savedAt : ""
  };
}

function computeTrackedCycleTotals(nl, liveCounters, cycle) {
  var dailyMap = nl && nl.daily ? nl.daily : {};
  var liveDeltaUp = 0;
  var liveDeltaDown = 0;
  if (liveCounters && nl && nl.lastUp !== null && nl.lastDown !== null) {
    liveDeltaUp = computeCounterDelta(liveCounters.up, nl.lastUp);
    liveDeltaDown = computeCounterDelta(liveCounters.down, nl.lastDown);
  }
  var dateKeys = cycleLib.enumerateDateKeys(cycle.startDateKey, cycle.todayDateKey);
  var trackedUp = 0;
  var trackedDown = 0;
  var dailySeries = [];
  for (var d = 0; d < dateKeys.length; d++) {
    var dk = dateKeys[d];
    var entry = dailyMap[dk];
    var dayUp = (entry ? Number(entry.up) || 0 : 0) + (dk === cycle.todayDateKey ? liveDeltaUp : 0);
    var dayDown = (entry ? Number(entry.down) || 0 : 0) + (dk === cycle.todayDateKey ? liveDeltaDown : 0);
    trackedUp += dayUp;
    trackedDown += dayDown;
    dailySeries.push({
      date: dk,
      upBytes: Math.round(dayUp),
      downBytes: Math.round(dayDown)
    });
  }
  return {
    trackedUp: Math.round(trackedUp),
    trackedDown: Math.round(trackedDown),
    dailySeries: dailySeries
  };
}

function sanitizeNodeRule(raw, nowMs, tzOffsetHours, options) {
  if (!raw || typeof raw !== "object") {
    return { error: "规则数据必须为对象" };
  }
  var opts = options || {};
  var existingRule = opts.existingRule && typeof opts.existingRule === "object" ? opts.existingRule : null;
  var currentTrackedUp = Math.max(0, Math.round(Number(opts.currentTrackedUp) || 0));
  var currentTrackedDown = Math.max(0, Math.round(Number(opts.currentTrackedDown) || 0));

  var enabled = parseBool(raw.enabled, false);
  var resetDay = clampInt(raw.resetDay !== undefined ? raw.resetDay : raw.reset_day, 1, 31, 1);
  var quotaGB = Number(raw.monthlyQuotaGB !== undefined ? raw.monthlyQuotaGB : raw.monthly_quota_gb);
  if (!Number.isFinite(quotaGB) || quotaGB < 0) quotaGB = 0;
  if (quotaGB > 1048576) {
    return { error: "月流量上限超出合理范围" };
  }
  var mode = String(raw.billingMode || raw.billing_mode || "sum").trim().toLowerCase();
  if (!ALLOWED_MODES[mode]) {
    return { error: "计费方式仅支持 sum / out / in / max" };
  }

  var cycle = cycleLib.computeBillingCycle(resetDay, nowMs, tzOffsetHours);
  var note = String(raw.note || "").trim().slice(0, 100);

  if (enabled && quotaGB <= 0) {
    return { error: "启用流量配额监控时，每月流量上限必须大于 0 GB" };
  }

  // Calibration semantics:
  // - calibrateTotalGB provided (non-empty number >= 0): used = calibrateTotalGB + traffic accumulated AFTER save
  // - legacy offsetGB > 0 sent by a stale cached v1.0.2 page without calibrateTotalGB: treat as calibrateTotalGB too so input is never silently dropped
  // - clearCalibration === true: drop calibration
  // - omitted / empty string / null: preserve existing calibration (if any)
  var calibration = null;
  var hasNewCal = raw.calibrateTotalGB !== undefined && raw.calibrateTotalGB !== null && String(raw.calibrateTotalGB).trim() !== "";
  var hasLegacyPositiveOffset = !hasNewCal && raw.offsetGB !== undefined && raw.offsetGB !== null && Number(raw.offsetGB) > 0;
  if (raw.clearCalibration === true) {
    calibration = null;
  } else if (hasNewCal || hasLegacyPositiveOffset) {
    var calVal = Number(hasNewCal ? raw.calibrateTotalGB : raw.offsetGB);
    if (!Number.isFinite(calVal) || calVal < 0) {
      return { error: "校准流量必须为大于等于 0 的数字" };
    }
    calibration = {
      totalGB: Math.round(calVal * 1000) / 1000,
      baselineUpBytes: currentTrackedUp,
      baselineDownBytes: currentTrackedDown,
      cycleKey: cycle.cycleKey,
      savedAt: new Date(nowMs).toISOString()
    };
  } else if (raw.calibration && typeof raw.calibration === "object") {
    calibration = sanitizeCalibration(raw.calibration, cycle.cycleKey);
  } else if (existingRule && existingRule.calibration) {
    calibration = sanitizeCalibration(existingRule.calibration, existingRule.calibration.cycleKey);
  }

  var offsetGB = 0;
  var offsetCycleKey = "";
  if (!calibration && existingRule && !raw.clearCalibration && Number(existingRule.offsetGB) > 0 && raw.offsetGB === undefined) {
    offsetGB = Number(existingRule.offsetGB);
    offsetCycleKey = String(existingRule.offsetCycleKey || cycle.cycleKey);
  }

  return {
    rule: {
      enabled: enabled,
      resetDay: resetDay,
      monthlyQuotaGB: Math.round(quotaGB * 1000) / 1000,
      billingMode: mode,
      calibration: calibration,
      offsetGB: offsetGB,
      offsetCycleKey: offsetCycleKey,
      note: note,
      updatedAt: new Date(nowMs).toISOString()
    }
  };
}

function extractCounters(statusEntry) {
  if (!statusEntry || typeof statusEntry !== "object") return null;
  var up = Number(statusEntry.net_total_up);
  var down = Number(statusEntry.net_total_down);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  if (up < 0 || down < 0) return null;
  // Some offline/uninitialized reports send 0,0 while offline; skip if offline and both 0
  if (statusEntry.online === false && up === 0 && down === 0) return null;
  return {
    up: Math.round(up),
    down: Math.round(down),
    uptime: Number.isFinite(Number(statusEntry.uptime)) ? Number(statusEntry.uptime) : null,
    online: statusEntry.online !== false
  };
}

function createEmptyLedger() {
  return { version: 1, nodes: {} };
}

function ensureNodeLedger(ledger, uuid) {
  if (!ledger.nodes || typeof ledger.nodes !== "object") {
    ledger.nodes = {};
  }
  if (!ledger.nodes[uuid] || typeof ledger.nodes[uuid] !== "object") {
    ledger.nodes[uuid] = {
      lastUp: null,
      lastDown: null,
      lastSeenMs: 0,
      lastUptime: null,
      seeded: false,
      daily: {}
    };
  }
  if (!ledger.nodes[uuid].daily || typeof ledger.nodes[uuid].daily !== "object") {
    ledger.nodes[uuid].daily = {};
  }
  return ledger.nodes[uuid];
}

function computeCounterDelta(cur, prev) {
  if (!Number.isFinite(cur) || cur < 0) return 0;
  if (!Number.isFinite(prev) || prev === null) return 0;
  if (cur >= prev) return cur - prev;
  // Counter decreased => VPS rebooted or NIC counter reset; cur is traffic since reboot
  return cur;
}

function addDailyBytes(nodeLedger, dateKey, deltaUp, deltaDown) {
  if (deltaUp <= 0 && deltaDown <= 0) return;
  var bucket = nodeLedger.daily[dateKey];
  if (!bucket || typeof bucket !== "object") {
    bucket = { up: 0, down: 0 };
    nodeLedger.daily[dateKey] = bucket;
  }
  bucket.up = Math.round((Number(bucket.up) || 0) + Math.max(0, deltaUp));
  bucket.down = Math.round((Number(bucket.down) || 0) + Math.max(0, deltaDown));
}

function pruneOldDaily(nodeLedger, nowMs, tzOffsetHours) {
  var cutoff = cycleLib.dateKeyDaysAgo(nowMs, LEDGER_RETENTION_DAYS, tzOffsetHours);
  var keys = Object.keys(nodeLedger.daily);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] < cutoff) {
      delete nodeLedger.daily[keys[i]];
    }
  }
}

function seedNodeFromNetworkRecords(ledger, uuid, records, tzOffsetHours) {
  var nl = ensureNodeLedger(ledger, uuid);
  if (nl.seeded || !Array.isArray(records) || records.length === 0) {
    return false;
  }
  var sorted = records.slice().sort(function (a, b) {
    return Date.parse(a.time || 0) - Date.parse(b.time || 0);
  });

  var prevUp = null;
  var prevDown = null;
  var lastTs = 0;

  for (var i = 0; i < sorted.length; i++) {
    var rec = sorted[i];
    var ts = Date.parse(rec.time || "");
    var up = Number(rec.net_total_up);
    var down = Number(rec.net_total_down);
    if (!Number.isFinite(ts) || !Number.isFinite(up) || !Number.isFinite(down)) continue;
    if (up < 0 || down < 0) continue;

    if (prevUp !== null && prevDown !== null) {
      var dUp = computeCounterDelta(up, prevUp);
      var dDown = computeCounterDelta(down, prevDown);
      var dateKey = cycleLib.getLocalParts(ts, tzOffsetHours).dateKey;
      addDailyBytes(nl, dateKey, dUp, dDown);
    }
    prevUp = Math.round(up);
    prevDown = Math.round(down);
    lastTs = ts;
  }

  if (prevUp !== null && prevDown !== null) {
    nl.lastUp = prevUp;
    nl.lastDown = prevDown;
    nl.lastSeenMs = lastTs;
    nl.seeded = true;
    return true;
  }
  return false;
}

function applySampleToLedger(ledger, statusMap, nowMs, tzOffsetHours) {
  if (!statusMap || typeof statusMap !== "object") return false;
  var changed = false;
  var todayKey = cycleLib.getLocalParts(nowMs, tzOffsetHours).dateKey;
  var uuids = Object.keys(statusMap);

  for (var i = 0; i < uuids.length; i++) {
    var uuid = uuids[i];
    var counters = extractCounters(statusMap[uuid]);
    if (!counters) continue;

    var nl = ensureNodeLedger(ledger, uuid);
    if (nl.lastUp === null || nl.lastDown === null) {
      // First observation: establish baseline without counting pre-install uptime as a spike
      nl.lastUp = counters.up;
      nl.lastDown = counters.down;
      nl.lastSeenMs = nowMs;
      nl.lastUptime = counters.uptime;
      nl.seeded = true;
      changed = true;
      continue;
    }

    var dUp = computeCounterDelta(counters.up, nl.lastUp);
    var dDown = computeCounterDelta(counters.down, nl.lastDown);
    if (dUp > 0 || dDown > 0 || counters.up !== nl.lastUp || counters.down !== nl.lastDown) {
      addDailyBytes(nl, todayKey, dUp, dDown);
      nl.lastUp = counters.up;
      nl.lastDown = counters.down;
      nl.lastSeenMs = nowMs;
      nl.lastUptime = counters.uptime;
      changed = true;
    }
    pruneOldDaily(nl, nowMs, tzOffsetHours);
  }

  return changed;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function buildQuotaOverview(options) {
  var opts = options || {};
  var cfg = normalizeGlobalConfig(opts.globalConfig);
  var isAdmin = Boolean(opts.isAdmin);
  var nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  var nodes = normalizeNodes(opts.nodes);
  var statusMap = opts.latestStatus && typeof opts.latestStatus === "object" ? opts.latestStatus : {};
  var ledger = opts.ledger && typeof opts.ledger === "object" ? opts.ledger : createEmptyLedger();
  var rules = opts.rules && typeof opts.rules === "object" ? opts.rules : {};

  var nodeResults = [];
  var configuredCount = 0;
  var alertCount = 0;
  var totalUsedBytes = 0;
  var totalQuotaBytes = 0;
  var totalRemainingBytes = 0;

  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];
    if (!nd || !nd.uuid) continue;
    if (!isAdmin && nd.hidden) continue;

    var uuid = nd.uuid;
    var rawRule = rules[uuid];
    var rule = rawRule && typeof rawRule === "object"
      ? {
          enabled: Boolean(rawRule.enabled),
          resetDay: clampInt(rawRule.resetDay, 1, 31, 1),
          monthlyQuotaGB: Number(rawRule.monthlyQuotaGB) || 0,
          billingMode: ALLOWED_MODES[rawRule.billingMode] ? rawRule.billingMode : "sum",
          calibration: sanitizeCalibration(rawRule.calibration, rawRule.calibration && rawRule.calibration.cycleKey),
          offsetGB: Number(rawRule.offsetGB) || 0,
          offsetCycleKey: String(rawRule.offsetCycleKey || ""),
          note: String(rawRule.note || "")
        }
      : {
          enabled: false,
          resetDay: 1,
          monthlyQuotaGB: 0,
          billingMode: "sum",
          calibration: null,
          offsetGB: 0,
          offsetCycleKey: "",
          note: ""
        };

    var cycle = cycleLib.computeBillingCycle(rule.resetDay, nowMs, cfg.timezoneOffset);
    var nl = ledger.nodes && ledger.nodes[uuid] ? ledger.nodes[uuid] : null;
    var liveCounters = extractCounters(statusMap[uuid]);
    var tracked = computeTrackedCycleTotals(nl, liveCounters, cycle);
    var trackedUp = tracked.trackedUp;
    var trackedDown = tracked.trackedDown;
    var dailySeries = tracked.dailySeries.map(function (pt) {
      return {
        date: pt.date,
        upBytes: pt.upBytes,
        downBytes: pt.downBytes,
        billableBytes: Math.round(computeBillableBytes(pt.upBytes, pt.downBytes, rule.billingMode))
      };
    });

    var trackedBillable = computeBillableBytes(trackedUp, trackedDown, rule.billingMode);

    // Compute cycle used bytes:
    // Priority 1: Active calibration (calibrated total + traffic accumulated AFTER saving calibration)
    // Priority 2: Legacy offsetGB (for backwards compatibility)
    // Priority 3: Pure tracked billable traffic
    var calibrationActive = Boolean(rule.calibration && rule.calibration.cycleKey === cycle.cycleKey);
    var offsetActive = !calibrationActive && rule.offsetGB > 0 && (!rule.offsetCycleKey || rule.offsetCycleKey === cycle.cycleKey);
    var calibrationBaseBytes = 0;
    var deltaAfterCalibrationBytes = 0;
    var offsetBytes = 0;
    var usedBytes = 0;

    if (calibrationActive) {
      calibrationBaseBytes = gbToBytes(rule.calibration.totalGB, cfg.unitBase);
      var postUp = Math.max(0, trackedUp - rule.calibration.baselineUpBytes);
      var postDown = Math.max(0, trackedDown - rule.calibration.baselineDownBytes);
      deltaAfterCalibrationBytes = Math.round(computeBillableBytes(postUp, postDown, rule.billingMode));
      usedBytes = Math.round(calibrationBaseBytes + deltaAfterCalibrationBytes);
    } else if (offsetActive) {
      offsetBytes = gbToBytes(rule.offsetGB, cfg.unitBase);
      usedBytes = Math.round(trackedBillable + offsetBytes);
    } else {
      usedBytes = Math.round(trackedBillable);
    }
    var quotaBytes = rule.enabled && rule.monthlyQuotaGB > 0 ? gbToBytes(rule.monthlyQuotaGB, cfg.unitBase) : 0;
    var hasQuota = quotaBytes > 0;
    var remainingBytes = hasQuota ? Math.max(0, quotaBytes - usedBytes) : null;
    var overageBytes = hasQuota ? Math.max(0, usedBytes - quotaBytes) : 0;
    var usagePercent = hasQuota ? round1((usedBytes / quotaBytes) * 100) : null;

    var dailyAvgBytes = Math.round(usedBytes / cycle.elapsedDaysFloat);
    var projectedBytes = Math.round(dailyAvgBytes * cycle.totalDays);

    var status = "unconfigured";
    if (hasQuota) {
      configuredCount += 1;
      totalUsedBytes += usedBytes;
      totalQuotaBytes += quotaBytes;
      totalRemainingBytes += remainingBytes;
      if (usedBytes >= quotaBytes) {
        status = "exceeded";
        alertCount += 1;
      } else if (usagePercent >= cfg.criticalPercent) {
        status = "critical";
        alertCount += 1;
      } else if (usagePercent >= cfg.warnPercent) {
        status = "warn";
      } else {
        status = "ok";
      }
    }

    var liveStatus = statusMap[uuid];
    var isOnline = Boolean(liveStatus && liveStatus.online !== false && (liveStatus.online === true || liveStatus.time));

    nodeResults.push({
      uuid: uuid,
      name: String(nd.name || uuid),
      region: String(nd.region || ""),
      os: String(nd.os || ""),
      arch: String(nd.arch || ""),
      online: isOnline,
      hasQuota: hasQuota,
      status: status,
      rule: {
        enabled: rule.enabled,
        resetDay: rule.resetDay,
        monthlyQuotaGB: rule.monthlyQuotaGB,
        billingMode: rule.billingMode,
        billingModeLabel: MODE_LABELS[rule.billingMode] || rule.billingMode,
        calibration: rule.calibration,
        calibrationActive: calibrationActive,
        offsetGB: rule.offsetGB,
        offsetCycleKey: rule.offsetCycleKey,
        offsetActive: offsetActive,
        note: rule.note
      },
      cycle: {
        cycleKey: cycle.cycleKey,
        startDate: cycle.startDateKey,
        endDate: cycle.endDateKey,
        totalDays: cycle.totalDays,
        elapsedDays: cycle.elapsedDays,
        remainingDays: cycle.remainingDays
      },
      traffic: {
        trackedUpBytes: Math.round(trackedUp),
        trackedDownBytes: Math.round(trackedDown),
        trackedBillableBytes: Math.round(trackedBillable),
        calibrationBaseBytes: calibrationBaseBytes,
        deltaAfterCalibrationBytes: deltaAfterCalibrationBytes,
        offsetBytes: offsetBytes,
        usedBytes: usedBytes,
        quotaBytes: quotaBytes,
        remainingBytes: remainingBytes,
        overageBytes: overageBytes,
        usagePercent: usagePercent,
        dailyAvgBytes: dailyAvgBytes,
        projectedBytes: projectedBytes
      },
      dailySeries: dailySeries
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    isAdmin: isAdmin,
    config: cfg,
    overview: {
      nodeCount: nodeResults.length,
      configuredCount: configuredCount,
      alertCount: alertCount,
      totalUsedBytes: totalUsedBytes,
      totalQuotaBytes: totalQuotaBytes,
      totalRemainingBytes: totalRemainingBytes
    },
    nodes: nodeResults
  };
}

module.exports = {
  MODE_LABELS: MODE_LABELS,
  DEFAULT_GLOBAL_CONFIG: DEFAULT_GLOBAL_CONFIG,
  normalizeGlobalConfig: normalizeGlobalConfig,
  normalizeNodes: normalizeNodes,
  gbToBytes: gbToBytes,
  computeBillableBytes: computeBillableBytes,
  computeTrackedCycleTotals: computeTrackedCycleTotals,
  extractCounters: extractCounters,
  sanitizeNodeRule: sanitizeNodeRule,
  createEmptyLedger: createEmptyLedger,
  seedNodeFromNetworkRecords: seedNodeFromNetworkRecords,
  applySampleToLedger: applySampleToLedger,
  buildQuotaOverview: buildQuotaOverview
};
