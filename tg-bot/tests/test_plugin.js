"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const pluginDir = path.resolve(__dirname, "../plugin");
const fmt = require(path.join(pluginDir, "lib/formatter.js"));
const alertsLib = require(path.join(pluginDir, "lib/alerts.js"));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("  PASS:", name);
}

function makeSampleSnapshot() {
  const GIB = 1024 ** 3;
  return {
    nowMs: Date.parse("2026-11-24T14:00:00.000Z"),
    nodes: [
      { uuid: "u-la", name: "LA", region: "🇺🇸", os: "Debian 13", arch: "amd64", cpu_cores: 1, mem_total: 1024 * 1024 * 968, disk_total: 30 * GIB },
      { uuid: "u-dedi", name: "dedi", region: "🇺🇸", os: "Debian 13", arch: "amd64", cpu_cores: 1, mem_total: 2 * GIB, disk_total: 30 * GIB }
    ],
    latestStatus: {
      "u-la": { online: true, cpu: 1.5, ram: 160 * 1024 * 1024, disk: 2.5 * GIB, net_in: 6400, net_out: 6500, uptime: 260000, load: 0.05, load5: 0.04, load15: 0.02, connections: 20, connections_udp: 5 },
      "u-dedi": { online: true, cpu: 14.2, ram: 700 * 1024 * 1024, disk: 8 * GIB, net_in: 1200, net_out: 2800, uptime: 260000, load: 0.3, load5: 0.25, load15: 0.2, connections: 60, connections_udp: 3 }
    },
    latencySummary: {
      windowHours: 1,
      nodes: [
        {
          uuid: "u-la",
          tasks: [
            { name: "陕西移动", type: "TCP", latestLatency: 165, avgLatency: 166, p95Latency: 175, lossPercent: 0, totalSamples: 120, latencyStatus: "good", lossStatus: "good" },
            { name: "陕西电信", type: "TCP", latestLatency: 150, avgLatency: 151, p95Latency: 158, lossPercent: 0, totalSamples: 120, latencyStatus: "good", lossStatus: "good" }
          ]
        },
        {
          uuid: "u-dedi",
          tasks: [
            { name: "陕西移动", type: "TCP", latestLatency: 205, avgLatency: 206, p95Latency: 220, lossPercent: 78, totalSamples: 120, latencyStatus: "good", lossStatus: "critical" },
            { name: "dedi → LA", type: "TCP", latestLatency: 2, avgLatency: 2, p95Latency: 4, lossPercent: 0, totalSamples: 120, latencyStatus: "good", lossStatus: "good" }
          ]
        }
      ]
    },
    trafficSummary: {
      config: { unitBase: 1024, timezoneOffset: 8 },
      nodes: [
        {
          uuid: "u-la",
          hasQuota: true,
          status: "ok",
          rule: { resetDay: 7, billingModeLabel: "双向 (入+出)" },
          cycle: { startDate: "2026-11-07", endDate: "2026-12-07", remainingDays: 13 },
          traffic: { usedBytes: Math.round(77.02 * GIB), quotaBytes: 500 * GIB, remainingBytes: Math.round(422.98 * GIB), overageBytes: 0, usagePercent: 15.4, dailyAvgBytes: 4.3 * GIB, projectedBytes: 129 * GIB }
        },
        {
          uuid: "u-dedi",
          hasQuota: true,
          status: "warn",
          rule: { resetDay: 6, billingModeLabel: "双向 (入+出)" },
          cycle: { startDate: "2026-11-06", endDate: "2026-12-06", remainingDays: 12 },
          traffic: { usedBytes: 1700 * GIB, quotaBytes: 2048 * GIB, remainingBytes: 348 * GIB, overageBytes: 0, usagePercent: 83.0, dailyAvgBytes: 90 * GIB, projectedBytes: 2700 * GIB }
        }
      ]
    }
  };
}

async function run() {
  console.log("Running Komari Telegram Bot plugin tests...\n");

  await test("manifest conforms to Komari 1.6.2 rules with least privilege", () => {
    const m = JSON.parse(fs.readFileSync(path.join(pluginDir, "komari-plugin.json"), "utf8"));
    assert.strictEqual(m.short, "tg-bot");
    assert.strictEqual(m.entry, "script.js");
    assert.strictEqual(m.permissions.node, false);
    assert.strictEqual(m.permissions.allowSystemRPC, true);
    assert.strictEqual(m.permissions.allowRoutes, true);
    assert.strictEqual(m.permissions.allowHTMLInject, false);
    assert.ok(m.permissions.timeout >= 60);
    assert.ok(fs.existsSync(path.join(pluginDir, m.entry)));
  });

  await test("formatter renders status, ping, traffic, single node, and degrades gracefully without optional plugins", () => {
    const snap = makeSampleSnapshot();

    const overview = fmt.formatStatusOverview(snap);
    assert.ok(overview.text.includes("2/2 在线"));
    assert.ok(overview.text.includes("<b>77.02 GB</b> / 500 GB"));
    assert.ok(overview.text.includes("剩 422.98 GB"));
    assert.ok(overview.text.includes("<blockquote>"));
    assert.ok(overview.text.includes("陕西移动"));
    assert.ok(overview.reply_markup.inline_keyboard.length >= 2);

    const ping = fmt.formatPingReport(snap);
    assert.ok(ping.text.includes("P95 175ms"));
    assert.ok(ping.text.includes("78%"));

    const traffic = fmt.formatTrafficReport(snap);
    assert.ok(traffic.text.includes("剩余 422.98 GB"));
    assert.ok(traffic.text.includes("预计超限"));

    const single = fmt.formatSingleNodeReport(snap, "la");
    assert.ok(single.text.includes("节点详情"));
    assert.ok(single.text.includes("LA"));

    // Graceful degradation when optional plugins are absent
    const minimal = fmt.formatStatusOverview({ nodes: snap.nodes, latestStatus: snap.latestStatus });
    assert.ok(minimal.text.includes("LA"));
    assert.ok(minimal.text.includes("CPU"));
  });

  await test("alert engine handles offline/recovery, quota escalation, watched-node loss, and cooldowns", () => {
    const engine = alertsLib.createAlertEngine();
    const cfg = {
      alertEnabled: true,
      alertLossNodes: "LA",
      alertLossPercent: 20,
      alertCooldownMinutes: 60
    };

    const snap1 = makeSampleSnapshot();
    // Tick 1: dedi is in warn (83%), LA has 0% loss -> 1 quota alert for dedi, NO loss spam for dedi (not in watched list!)
    const a1 = engine.evaluate(snap1, cfg);
    assert.strictEqual(a1.length, 1);
    assert.ok(a1[0].includes("月度流量预警") && a1[0].includes("dedi"));

    // Tick 2 (+5 min): same state -> 0 alerts (cooldown works!)
    const snap2 = makeSampleSnapshot();
    snap2.nowMs += 5 * 60 * 1000;
    const a2 = engine.evaluate(snap2, cfg);
    assert.strictEqual(a2.length, 0);

    // Tick 3 (+10 min): LA goes offline AND LA mobile loss spikes to 45% -> 2 alerts
    const snap3 = makeSampleSnapshot();
    snap3.nowMs += 10 * 60 * 1000;
    snap3.latestStatus["u-la"].online = false;
    snap3.latencySummary.nodes[0].tasks[0].lossPercent = 45;
    const a3 = engine.evaluate(snap3, cfg);
    assert.strictEqual(a3.length, 2);
    assert.ok(a3.some((m) => m.includes("VPS 离线告警") && m.includes("LA")));
    assert.ok(a3.some((m) => m.includes("高丢包告警") && m.includes("LA")));

    // Tick 4 (+15 min): LA recovers online
    const snap4 = makeSampleSnapshot();
    snap4.nowMs += 15 * 60 * 1000;
    const a4 = engine.evaluate(snap4, cfg);
    assert.strictEqual(a4.length, 1);
    assert.ok(a4[0].includes("VPS 恢复在线") && a4[0].includes("LA"));
  });

  await test("script.js end-to-end command routing, whitelist security, /id, callback edit, and admin routes", async () => {
    const routes = {};
    const crons = [];
    const sentApiCalls = [];
    const sampleSnap = makeSampleSnapshot();

    let pollCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async function (url, init) {
      const method = url.split("/").pop();
      const body = init && init.body ? JSON.parse(init.body) : {};
      sentApiCalls.push({ method, body });

      if (method === "getUpdates") {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                ok: true,
                result: [
                  // 1. Stranger asks /id -> allowed to get own chat ID only
                  { update_id: 100, message: { chat: { id: 999 }, from: { id: 999 }, text: "/id" } },
                  // 2. Stranger asks /status -> MUST BE IGNORED
                  { update_id: 101, message: { chat: { id: 999 }, from: { id: 999 }, text: "/status" } },
                  // 3. Allowed owner asks /status -> gets overview
                  { update_id: 102, message: { chat: { id: 12345 }, from: { id: 12345 }, text: "/status" } },
                  // 4. Allowed owner clicks inline button "cmd:traffic" -> edits message in place
                  { update_id: 103, callback_query: { id: "cb-1", from: { id: 12345 }, data: "cmd:traffic", message: { chat: { id: 12345 }, message_id: 55 } } }
                ]
              });
            }
          };
        }
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, result: [] }); } };
      }

      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, result: { message_id: 77 } }); } };
    };

    const fakeServer = {
      route(m, p, h) { routes[m + " " + p] = h; },
      cron(expr, fn) { crons.push({ expr, fn }); },
      async getConfig() {
        return {
          bot_token: "123:FAKE_TOKEN",
          allowed_chat_ids: "12345",
          poll_enabled: true,
          daily_report_enabled: true,
          daily_report_cron: "0 9 * * *",
          alert_enabled: true
        };
      },
      async call(method) {
        if (method === "common:getNodes") return sampleSnap.nodes;
        if (method === "common:getNodesLatestStatus") return sampleSnap.latestStatus;
        if (method === "latencyMonitor:getSummary") return sampleSnap.latencySummary;
        if (method === "trafficQuota:getSummary") return sampleSnap.trafficSummary;
        throw new Error("Unexpected RPC: " + method);
      }
    };

    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req === "server") return fakeServer;
      return origLoad.call(this, req, parent, isMain);
    };

    try {
      const code = fs.readFileSync(path.join(pluginDir, "script.js"), "utf8");
      const wrapper = new Function("require", "module", "exports", "__filename", "__dirname", code + "\nreturn { load, unload };");
      const localMod = { exports: {} };
      const localRequire = Module.createRequire(path.join(pluginDir, "script.js"));
      const hooks = wrapper(localRequire, localMod, localMod.exports, path.join(pluginDir, "script.js"), pluginDir);

      hooks.load();
      // Wait for startupTimer (1000ms) + first poll batch to finish
      await new Promise((r) => setTimeout(r, 1250));
      hooks.unload();

      const sends = sentApiCalls.filter((c) => c.method === "sendMessage");
      const edits = sentApiCalls.filter((c) => c.method === "editMessageText");
      const answers = sentApiCalls.filter((c) => c.method === "answerCallbackQuery");

      // Stranger got /id reply (chat 999), did NOT get /status reply!
      const strangerSends = sends.filter((c) => c.body.chat_id === 999);
      assert.strictEqual(strangerSends.length, 1);
      assert.ok(strangerSends[0].body.text.includes("999"));
      assert.ok(!strangerSends[0].body.text.includes("Komari VPS"));

      // Owner got /status reply (chat 12345)
      const ownerSends = sends.filter((c) => c.body.chat_id === 12345);
      assert.strictEqual(ownerSends.length, 1);
      assert.ok(ownerSends[0].body.text.includes("<b>77.02 GB</b> / 500 GB"));

      // Inline button edited message #55 in-place
      assert.strictEqual(answers.length, 1);
      assert.strictEqual(edits.length, 1);
      assert.strictEqual(edits[0].body.message_id, 55);
      assert.ok(edits[0].body.text.includes("月度流量配额与剩余统计"));

      // Admin route auth check
      function makeRes() {
        return { statusCode: 200, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v || ""; } };
      }
      const rForb = makeRes();
      await routes["GET /api/plugin/tg-bot/status"]({ context: { role: "guest" } }, rForb);
      assert.strictEqual(rForb.statusCode, 403);

      const rOk = makeRes();
      await routes["GET /api/plugin/tg-bot/status"]({ context: { role: "admin" } }, rOk);
      assert.strictEqual(rOk.statusCode, 200);
      assert.strictEqual(JSON.parse(rOk.body).data.handledCount, 2);
    } finally {
      Module._load = origLoad;
      globalThis.fetch = origFetch;
    }
  });

  console.log(`\nAll ${passed} tests passed!`);
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
