"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const pluginDir = path.resolve(__dirname, "../plugin");
const aggregator = require(path.join(pluginDir, "lib/aggregator.js"));
const presets = require(path.join(pluginDir, "lib/presets.js"));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("  PASS:", name);
}

async function run() {
  console.log("Running Komari Latency Monitor plugin tests...\n");

  await test("manifest conforms to Komari 1.6.1 rules", () => {
    const manifestPath = path.join(pluginDir, "komari-plugin.json");
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.strictEqual(m.short, "latency-monitor");
    assert.match(m.short, /^[A-Za-z0-9_-]+$/);
    assert.ok(m.name && m.name.zh_CN && m.name.en);
    assert.strictEqual(m.entry, "script.js");
    assert.ok(fs.existsSync(path.join(pluginDir, m.entry)));
    assert.strictEqual(m.permissions.allowSystemRPC, true);
    assert.strictEqual(m.permissions.allowRoutes, true);
    assert.strictEqual(m.permissions.allowHTMLInject, true);
    assert.ok(Array.isArray(m.pages) && m.pages.length >= 1);
    assert.ok(fs.existsSync(path.join(pluginDir, m.pages[0].file)));
  });

  await test("aggregator computes exact buckets, packet loss, gray empty buckets, and hides private fields", () => {
    const nowMs = Date.parse("2026-11-24T10:00:00.000Z");
    const nodes = {
      "uuid-1": { uuid: "uuid-1", name: "德国 Bero", region: "DE", hidden: false, weight: 1 },
      "uuid-hidden": { uuid: "uuid-hidden", name: "Hidden Node", region: "US", hidden: true, weight: 2 }
    };
    const tasks = [
      { id: 1, name: "江苏移动", type: "tcp", target: "221.131.143.69:443", interval: 60, weight: 1, clients: ["uuid-1", "uuid-hidden"] },
      { id: 2, name: "江苏电信", type: "tcp", target: "58.240.57.33:443", interval: 60, weight: 2, clients: ["uuid-1"] }
    ];
    // 1 hour = 60 min, 20 buckets = 3 min each.
    // Bucket 19 is [09:57, 10:00], Bucket 0 is [09:00, 09:03].
    const records = [
      // Task 1 in bucket 19: two valid pings (220, 230 -> avg 225, 0% loss)
      { client: "uuid-1", task_id: 1, time: "2026-11-24T09:58:00.000Z", value: 220 },
      { client: "uuid-1", task_id: 1, time: "2026-11-24T09:59:00.000Z", value: 230 },
      // Task 2 in bucket 19: 1 valid (265) + 1 loss (-1) -> 50% loss in bucket 19
      { client: "uuid-1", task_id: 2, time: "2026-11-24T09:58:00.000Z", value: 265 },
      { client: "uuid-1", task_id: 2, time: "2026-11-24T09:59:00.000Z", value: -1 },
      // Task 2 in bucket 0: 1 loss (-1) -> 100% loss / timeout in bucket 0
      { client: "uuid-1", task_id: 2, time: "2026-11-24T09:01:00.000Z", value: -1 },
      // Hidden node record
      { client: "uuid-hidden", task_id: 1, time: "2026-11-24T09:59:00.000Z", value: 120 }
    ];

    const pub = aggregator.buildSummaryPayload({
      nodes,
      tasks,
      records,
      config: { window_hours: "1", bucket_count: 20, latency_warn_ms: 300, latency_critical_ms: 500, loss_warn_percent: 1, loss_critical_percent: 10 },
      isAdmin: false,
      nowMs
    });

    assert.strictEqual(pub.nodes.length, 1, "Hidden node must be omitted for non-admin");
    const node = pub.nodes[0];
    assert.strictEqual(node.uuid, "uuid-1");
    assert.strictEqual(node.tasks.length, 2);
    assert.strictEqual(node.footerLabel, "TCP 探测 · 近 1 小时 · 灰色为无采样");

    // Verify target is NEVER leaked
    assert.strictEqual("target" in node.tasks[0], false);

    // Task 1 checks
    const t1 = node.tasks[0];
    assert.strictEqual(t1.latestLatency, 230);
    assert.strictEqual(t1.avgLatency, 225);
    assert.strictEqual(t1.lossPercent, 0);
    assert.strictEqual(t1.availabilityPercent, 100);
    assert.strictEqual(t1.buckets.length, 20);
    assert.strictEqual(t1.buckets[0].latencyStatus, "empty");
    assert.strictEqual(t1.buckets[0].lossStatus, "empty");
    assert.strictEqual(t1.buckets[19].avgLatency, 225);
    assert.strictEqual(t1.buckets[19].latencyStatus, "good");
    assert.strictEqual(t1.buckets[19].lossStatus, "good");

    // Task 2 checks: 3 samples total, 2 lost -> 66.7% loss
    const t2 = node.tasks[1];
    assert.strictEqual(t2.lossPercent, 66.7);
    assert.strictEqual(t2.lossStatus, "critical");
    assert.strictEqual(t2.buckets[0].latencyStatus, "timeout");
    assert.strictEqual(t2.buckets[0].lossStatus, "critical");
    assert.strictEqual(t2.buckets[19].avgLatency, 265);
    assert.strictEqual(t2.buckets[19].lossPercent, 50);

    // Admin sees hidden node
    const adm = aggregator.buildSummaryPayload({ nodes, tasks, records, config: {}, isAdmin: true, nowMs });
    assert.strictEqual(adm.nodes.length, 2);
  });

  await test("aggregator respects selected_tasks filter (array or JSON string)", () => {
    const res = aggregator.buildSummaryPayload({
      nodes: [{ uuid: "u1", name: "N1" }],
      tasks: [
        { id: 10, name: "A", type: "tcp", clients: ["u1"] },
        { id: 20, name: "B", type: "icmp", clients: ["u1"] }
      ],
      records: [],
      config: { selected_tasks: "[20]" },
      isAdmin: false,
      nowMs: Date.now()
    });
    assert.strictEqual(res.nodes[0].tasks.length, 1);
    assert.strictEqual(res.nodes[0].tasks[0].id, 20);
  });

  await test("presets builds bidirectional mesh tasks including IPv6 and deduplicates", () => {
    const mesh = presets.buildMeshTasks([
      { uuid: "u1", name: "Bero", host: "1.2.3.4", port: 443 },
      { uuid: "u2", name: "VMISS", host: "2001:db8::1", port: 22222 }
    ], 443, 60, "tcp");

    assert.strictEqual(mesh.length, 2);
    assert.strictEqual(mesh[0].name, "Bero → VMISS");
    assert.strictEqual(mesh[0].target, "[2001:db8::1]:22222");
    assert.deepStrictEqual(mesh[0].clients, ["u1"]);
    assert.strictEqual(mesh[1].name, "VMISS → Bero");
    assert.strictEqual(mesh[1].target, "1.2.3.4:443");
    assert.deepStrictEqual(mesh[1].clients, ["u2"]);

    const plan = presets.planTaskCreation(mesh, [mesh[0]], true);
    assert.strictEqual(plan.toCreate.length, 1);
    assert.strictEqual(plan.skipped.length, 1);
    assert.strictEqual(plan.toCreate[0].name, "VMISS → Bero");
  });

  await test("script.js end-to-end lifecycle, routes, auth guard, caching, and HTML injection", async () => {
    const routes = {};
    const statics = {};
    const rpcs = {};
    let injected = null;
    let rpcCallCount = 0;

    const fakeTasks = [
      { id: 1, name: "江苏移动", type: "tcp", target: "221.131.143.69:443", interval: 60, weight: 1, clients: ["u1"] }
    ];

    const fakeServer = {
      static(mount, dir) { statics[mount] = dir; },
      route(method, p, handler) { routes[method + " " + p] = handler; },
      registerRPC(name, handler) { rpcs[name] = handler; },
      injectHTML(head, body) { injected = { head, body }; },
      async getConfig() {
        return { window_hours: "1", bucket_count: 20, cache_ttl_seconds: 30, inject_home_cards: true };
      },
      async call(method, params) {
        rpcCallCount += 1;
        if (method === "common:getNodes" || method === "admin:listClients") {
          return [{ uuid: "u1", name: "LA-1", ipv4: "203.0.113.10", hidden: false }];
        }
        if (method === "common:getNodesLatestStatus") {
          return { u1: { online: true } };
        }
        if (method === "admin:getAllPingTasks") {
          return fakeTasks.slice();
        }
        if (method === "common:getRecords") {
          return {
            records: [{ client: "u1", task_id: 1, time: new Date().toISOString(), value: 145 }]
          };
        }
        if (method === "admin:addPingTask") {
          const id = fakeTasks.length + 1;
          fakeTasks.push(Object.assign({ id, weight: id }, params));
          return { task_id: id };
        }
        if (method === "admin:deletePingTask") {
          for (const id of params.id) {
            const idx = fakeTasks.findIndex((t) => t.id === id);
            if (idx >= 0) fakeTasks.splice(idx, 1);
          }
          return null;
        }
        throw new Error("Unexpected RPC: " + method);
      }
    };

    // Intercept require("server") and evaluate script.js in a sandboxed function that exposes load/unload
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "server") return fakeServer;
      return origLoad.call(this, request, parent, isMain);
    };

    try {
      const code = fs.readFileSync(path.join(pluginDir, "script.js"), "utf8");
      const wrapper = new Function("require", "module", "exports", "__filename", "__dirname", code + "\nreturn { load, unload };");
      const localMod = { exports: {} };
      const localRequire = Module.createRequire(path.join(pluginDir, "script.js"));
      const hooks = wrapper(localRequire, localMod, localMod.exports, path.join(pluginDir, "script.js"), pluginDir);

      hooks.load();

      assert.ok(statics["/api/plugin/latency-monitor/assets"] === "assets");
      assert.ok(injected && injected.head.includes("inject.css") && injected.body.includes("inject.js"));

      function makeRes() {
        const res = {
          statusCode: 200,
          headers: {},
          body: "",
          setHeader(k, v) { this.headers[k] = v; },
          end(v) { this.body = v || ""; }
        };
        return res;
      }

      // 1. Public summary request + cache hit
      const r1 = makeRes();
      await routes["GET /api/plugin/latency-monitor/summary"]({ query: {}, context: {} }, r1);
      assert.strictEqual(r1.statusCode, 200);
      const j1 = JSON.parse(r1.body);
      assert.strictEqual(j1.status, "success");
      assert.strictEqual(j1.data.nodes[0].tasks[0].latestLatency, 145);
      const callsAfterFirst = rpcCallCount;

      const r2 = makeRes();
      await routes["GET /api/plugin/latency-monitor/summary"]({ query: {}, context: {} }, r2);
      assert.strictEqual(rpcCallCount, callsAfterFirst, "Second identical call should hit in-memory cache");

      // 2. Non-admin blocked from admin endpoints
      const rForbidden = makeRes();
      await routes["GET /api/plugin/latency-monitor/admin/tasks"]({ context: { role: "guest" } }, rForbidden);
      assert.strictEqual(rForbidden.statusCode, 403);

      // 3. Admin creates task and invalidates cache
      const rCreate = makeRes();
      await routes["POST /api/plugin/latency-monitor/admin/tasks"]({
        context: { role: "admin" },
        body: JSON.stringify({
          tasks: [{ name: "江苏电信", type: "tcp", target: "58.240.57.33:443", interval: 60, clients: ["u1"] }]
        })
      }, rCreate);
      assert.strictEqual(rCreate.statusCode, 200);
      assert.strictEqual(JSON.parse(rCreate.body).data.created.length, 1);

      // 4. Delete task
      const rDel = makeRes();
      await routes["POST /api/plugin/latency-monitor/admin/tasks/delete"]({
        context: { role: "admin" },
        body: JSON.stringify({ ids: [2] })
      }, rDel);
      assert.strictEqual(rDel.statusCode, 200);

      // 5. Plugin RPC works
      const rpcData = await rpcs["latencyMonitor:getSummary"]({ hours: 1 });
      assert.strictEqual(rpcData.nodes.length, 1);

      hooks.unload();
    } finally {
      Module._load = origLoad;
    }
  });

  console.log(`\nAll ${passed} tests passed!`);
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
