"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const pluginDir = path.resolve(__dirname, "../plugin");
const cycleLib = require(path.join(pluginDir, "lib/cycle.js"));
const ledgerLib = require(path.join(pluginDir, "lib/ledger.js"));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("  PASS:", name);
}

async function run() {
  console.log("Running Komari Traffic Quota plugin tests...\n");

  await test("manifest conforms to Komari 1.6.1 rules", () => {
    const m = JSON.parse(fs.readFileSync(path.join(pluginDir, "komari-plugin.json"), "utf8"));
    assert.strictEqual(m.short, "traffic-quota");
    assert.strictEqual(m.entry, "script.js");
    assert.strictEqual(m.permissions.node, true);
    assert.strictEqual(m.permissions.allowSystemRPC, true);
    assert.strictEqual(m.permissions.allowRoutes, true);
    assert.strictEqual(m.permissions.allowHTMLInject, true);
    assert.ok(fs.existsSync(path.join(pluginDir, m.entry)));
    assert.ok(fs.existsSync(path.join(pluginDir, m.pages[0].file)));
  });

  await test("cycle math handles mid-month, upcoming, exact reset day, and short-month clamping", () => {
    // 2026-11-24 12:00:00 UTC+8 = 2026-11-24T04:00:00Z
    const now = Date.parse("2026-11-24T04:00:00.000Z");

    const c8 = cycleLib.computeBillingCycle(8, now, 8);
    assert.strictEqual(c8.startDateKey, "2026-11-08");
    assert.strictEqual(c8.endDateKey, "2026-12-08");
    assert.strictEqual(c8.totalDays, 30);

    const c28 = cycleLib.computeBillingCycle(28, now, 8);
    assert.strictEqual(c28.startDateKey, "2026-10-28");
    assert.strictEqual(c28.endDateKey, "2026-11-28");
    assert.strictEqual(c28.remainingDays, 4);

    const c24 = cycleLib.computeBillingCycle(24, now, 8);
    assert.strictEqual(c24.startDateKey, "2026-11-24");
    assert.strictEqual(c24.endDateKey, "2026-12-24");
    assert.strictEqual(c24.elapsedDays, 1);

    // 31st clamps to Feb 28 in non-leap year 2026
    const febNow = Date.parse("2026-02-15T04:00:00.000Z");
    const c31 = cycleLib.computeBillingCycle(31, febNow, 8);
    assert.strictEqual(c31.startDateKey, "2026-01-31");
    assert.strictEqual(c31.endDateKey, "2026-02-28");
    assert.strictEqual(c31.totalDays, 28);
  });

  await test("reboot-safe ledger accumulates deltas across normal ticks and VPS reboots", () => {
    const ledger = ledgerLib.createEmptyLedger();
    const t1 = Date.parse("2026-11-24T01:00:00.000Z");
    const t2 = Date.parse("2026-11-24T01:05:00.000Z");
    const t3 = Date.parse("2026-11-24T01:10:00.000Z");

    // Baseline: 10 GB up / 20 GB down (no spike added)
    ledgerLib.applySampleToLedger(ledger, { u1: { net_total_up: 10e9, net_total_down: 20e9, online: true } }, t1, 8);
    assert.deepStrictEqual(ledger.nodes.u1.daily, {});

    // Normal tick: +1 GB up, +2 GB down
    ledgerLib.applySampleToLedger(ledger, { u1: { net_total_up: 11e9, net_total_down: 22e9, online: true } }, t2, 8);
    assert.strictEqual(ledger.nodes.u1.daily["2026-11-24"].up, 1e9);
    assert.strictEqual(ledger.nodes.u1.daily["2026-11-24"].down, 2e9);

    // Reboot happened! NIC counters reset and now read 0.5 GB up / 0.8 GB down
    ledgerLib.applySampleToLedger(ledger, { u1: { net_total_up: 0.5e9, net_total_down: 0.8e9, online: true } }, t3, 8);
    assert.strictEqual(ledger.nodes.u1.daily["2026-11-24"].up, 1.5e9);
    assert.strictEqual(ledger.nodes.u1.daily["2026-11-24"].down, 2.8e9);
  });

  await test("quota overview computes all billing modes, remaining bytes, overage, and auto-expires offset on cycle rollover", () => {
    const GIB = 1024 ** 3;
    const ledger = {
      version: 1,
      nodes: {
        u1: {
          lastUp: 10 * GIB,
          lastDown: 20 * GIB,
          lastSeenMs: Date.parse("2026-11-24T04:00:00.000Z"),
          seeded: true,
          daily: {
            "2026-11-10": { up: 10 * GIB, down: 30 * GIB },
            "2026-11-24": { up: 5 * GIB, down: 15 * GIB }
          }
        }
      }
    };
    const rules = {
      u1: {
        enabled: true,
        resetDay: 8,
        monthlyQuotaGB: 100,
        billingMode: "sum",
        offsetGB: 20,
        offsetCycleKey: "2026-11-08"
      }
    };

    // Inside Nov 8 ~ Dec 8 cycle: tracked = (15 up + 45 down) = 60 GiB + 20 GiB offset = 80 GiB -> remaining 20 GiB -> warn (80%)
    const novNow = Date.parse("2026-11-24T04:00:00.000Z");
    const ov1 = ledgerLib.buildQuotaOverview({
      nodes: [{ uuid: "u1", name: "LA" }, { uuid: "u2", name: "Hidden", hidden: true }],
      latestStatus: { u1: { net_total_up: 10 * GIB, net_total_down: 20 * GIB, online: true } },
      ledger,
      rules,
      globalConfig: { timezone_offset: 8, unit_base: "1024", warn_percent: 80, critical_percent: 95 },
      isAdmin: false,
      nowMs: novNow
    });

    assert.strictEqual(ov1.nodes.length, 1, "Hidden node excluded for non-admin");
    const n1 = ov1.nodes[0];
    assert.strictEqual(n1.traffic.usedBytes, 80 * GIB);
    assert.strictEqual(n1.traffic.remainingBytes, 20 * GIB);
    assert.strictEqual(n1.traffic.usagePercent, 80);
    assert.strictEqual(n1.status, "warn");
    assert.strictEqual(n1.rule.offsetActive, true);

    // Billing mode = out (only 15 GiB + 20 GiB offset = 35 GiB)
    rules.u1.billingMode = "out";
    const ovOut = ledgerLib.buildQuotaOverview({
      nodes: [{ uuid: "u1", name: "LA" }],
      latestStatus: {},
      ledger,
      rules,
      globalConfig: { timezone_offset: 8, unit_base: "1024" },
      isAdmin: true,
      nowMs: novNow
    });
    assert.strictEqual(ovOut.nodes[0].traffic.usedBytes, 35 * GIB);
    assert.strictEqual(ovOut.nodes[0].traffic.remainingBytes, 65 * GIB);
    assert.strictEqual(ovOut.nodes[0].status, "ok");

    // Next billing cycle (Dec 10): Nov traffic AND Nov offset must auto-clear to 0!
    const decNow = Date.parse("2026-12-10T04:00:00.000Z");
    const ovDec = ledgerLib.buildQuotaOverview({
      nodes: [{ uuid: "u1", name: "LA" }],
      latestStatus: {},
      ledger,
      rules,
      globalConfig: { timezone_offset: 8, unit_base: "1024" },
      isAdmin: true,
      nowMs: decNow
    });
    assert.strictEqual(ovDec.nodes[0].cycle.startDate, "2026-12-08");
    assert.strictEqual(ovDec.nodes[0].rule.offsetActive, false);
    assert.strictEqual(ovDec.nodes[0].traffic.usedBytes, 0);
    assert.strictEqual(ovDec.nodes[0].traffic.remainingBytes, 100 * GIB);
  });

  await test("script.js end-to-end lifecycle, persistence, auth guard, cron, and HTML injection", async () => {
    const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), "ktq-test-"));
    const routes = {};
    const statics = {};
    const rpcs = {};
    const crons = [];
    let injected = null;

    const fakeServer = {
      static(mount, dir) { statics[mount] = dir; },
      route(method, p, handler) { routes[method + " " + p] = handler; },
      registerRPC(name, handler) { rpcs[name] = handler; },
      cron(expr, fn) { crons.push({ expr, fn }); },
      injectHTML(head, body) { injected = { head, body }; },
      async getConfig() {
        return { timezone_offset: 8, unit_base: "1024", inject_home_cards: true, warn_percent: 80, critical_percent: 95 };
      },
      async call(method) {
        if (method === "common:getNodes") {
          return [{ uuid: "u1", name: "racknerd", hidden: false }];
        }
        if (method === "common:getNodesLatestStatus") {
          return { u1: { net_total_up: 2 * (1024 ** 3), net_total_down: 3 * (1024 ** 3), online: true, uptime: 50000 } };
        }
        if (method === "common:getRecords") {
          return {
            records: {
              u1: [
                { time: new Date(Date.now() - 3600000).toISOString(), net_total_up: 1 * (1024 ** 3), net_total_down: 1 * (1024 ** 3) },
                { time: new Date(Date.now() - 60000).toISOString(), net_total_up: 2 * (1024 ** 3), net_total_down: 3 * (1024 ** 3) }
              ]
            }
          };
        }
        throw new Error("Unexpected RPC: " + method);
      }
    };

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "server") return fakeServer;
      return origLoad.call(this, request, parent, isMain);
    };

    try {
      const code = fs.readFileSync(path.join(pluginDir, "script.js"), "utf8");
      const wrapper = new Function("require", "module", "exports", "__filename", "__dirname", "__storageDir__", code + "\nreturn { load, unload };");
      const localMod = { exports: {} };
      const localRequire = Module.createRequire(path.join(pluginDir, "script.js"));
      const hooks = wrapper(localRequire, localMod, localMod.exports, path.join(pluginDir, "script.js"), pluginDir, tmpStorage);

      hooks.load();

      assert.strictEqual(statics["/api/plugin/traffic-quota/assets"], "assets");
      assert.strictEqual(crons.length, 1);
      assert.ok(injected && injected.head.includes("inject.css") && injected.body.includes("inject.js"));

      function makeRes() {
        return {
          statusCode: 200,
          headers: {},
          body: "",
          setHeader(k, v) { this.headers[k] = v; },
          end(v) { this.body = v || ""; }
        };
      }

      // Guest cannot read/write admin rules
      const rForb = makeRes();
      await routes["GET /api/plugin/traffic-quota/admin/rules"]({ context: { role: "guest" } }, rForb);
      assert.strictEqual(rForb.statusCode, 403);

      // Admin saves per-node rule using calibrateTotalGB (76.91 GB)
      // Even though 24h seed already has 3 GiB tracked, usedBytes right after save MUST equal 76.91 GiB (not 79.91 GiB!)
      const rSave = makeRes();
      await routes["POST /api/plugin/traffic-quota/admin/rules"]({
        context: { role: "admin" },
        body: JSON.stringify({
          rules: {
            u1: { enabled: true, resetDay: 7, monthlyQuotaGB: 500, billingMode: "sum", calibrateTotalGB: 76.91, note: "LA" }
          }
        })
      }, rSave);
      assert.strictEqual(rSave.statusCode, 200);
      const saved = JSON.parse(rSave.body).data;
      assert.strictEqual(saved.overview.configuredCount, 1);
      const expectedCalBytes = Math.round(76.91 * (1024 ** 3));
      assert.strictEqual(saved.nodes[0].traffic.usedBytes, expectedCalBytes);
      assert.strictEqual(saved.nodes[0].traffic.deltaAfterCalibrationBytes, 0);
      assert.strictEqual(saved.nodes[0].rule.calibrationActive, true);

      // Re-saving note without calibrateTotalGB preserves existing calibration untouched
      const rSave2 = makeRes();
      await routes["POST /api/plugin/traffic-quota/admin/rules"]({
        context: { role: "admin" },
        body: JSON.stringify({
          rules: {
            u1: { enabled: true, resetDay: 7, monthlyQuotaGB: 500, billingMode: "sum", note: "LA updated" }
          }
        })
      }, rSave2);
      assert.strictEqual(rSave2.statusCode, 200);
      const saved2 = JSON.parse(rSave2.body).data;
      assert.strictEqual(saved2.nodes[0].traffic.usedBytes, expectedCalBytes);
      assert.strictEqual(saved2.nodes[0].rule.note, "LA updated");

      // Subsequent +0.5 GiB up and +0.5 GiB down after save adds exactly +1 GiB on top of 76.91 GiB!
      const origCall = fakeServer.call;
      fakeServer.call = async function (method) {
        if (method === "common:getNodesLatestStatus") {
          return { u1: { net_total_up: 2.5 * (1024 ** 3), net_total_down: 3.5 * (1024 ** 3), online: true, uptime: 50600 } };
        }
        return origCall.call(this, method);
      };
      const rAfter = makeRes();
      await routes["GET /api/plugin/traffic-quota/summary"]({ query: { refresh: "1" }, context: { role: "admin" } }, rAfter);
      const afterData = JSON.parse(rAfter.body).data;
      assert.strictEqual(afterData.nodes[0].traffic.deltaAfterCalibrationBytes, 1 * (1024 ** 3));
      assert.strictEqual(afterData.nodes[0].traffic.usedBytes, expectedCalBytes + 1 * (1024 ** 3));

      // Verify rules.json and ledger.json persisted on disk
      assert.ok(fs.existsSync(path.join(tmpStorage, "rules.json")));
      assert.ok(fs.existsSync(path.join(tmpStorage, "ledger.json")));

      // Plugin RPC works
      const rpcRes = await rpcs["trafficQuota:getSummary"]({ refresh: false });
      assert.strictEqual(rpcRes.nodes[0].hasQuota, true);

      hooks.unload();
    } finally {
      Module._load = origLoad;
      fs.rmSync(tmpStorage, { recursive: true, force: true });
    }
  });

  console.log(`\nAll ${passed} tests passed!`);
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
