"use strict";

var ALLOWED_TYPES = {
  tcp: true,
  icmp: true,
  http: true
};

// 常见三网 TCP 探测参考模板（端口与目标均可在提交前自由修改）
var THREE_NET_PRESETS = [
  {
    key: "cm",
    name: "江苏移动",
    type: "tcp",
    target: "221.131.143.69:443",
    interval: 60
  },
  {
    key: "ct",
    name: "江苏电信",
    type: "tcp",
    target: "58.240.57.33:443",
    interval: 60
  },
  {
    key: "cu",
    name: "江苏联通",
    type: "tcp",
    target: "221.6.4.66:443",
    interval: 60
  }
];

function sanitizeTaskInput(raw) {
  if (!raw || typeof raw !== "object") {
    return { error: "Task entry must be an object" };
  }
  var name = String(raw.name || "").trim();
  var target = String(raw.target || "").trim();
  var type = String(raw.type || "tcp").trim().toLowerCase();
  var interval = Math.round(Number(raw.interval) || 60);
  var defaultOn = Boolean(raw.default_on);
  var clients = Array.isArray(raw.clients)
    ? raw.clients.map(function (c) { return String(c || "").trim(); }).filter(Boolean)
    : [];

  if (!name) return { error: "任务名称不能为空" };
  if (name.length > 80) return { error: "任务名称长度不能超过 80 个字符" };
  if (!target) return { error: "探测目标不能为空" };
  if (target.length > 255) return { error: "探测目标长度不能超过 255 个字符" };
  if (!ALLOWED_TYPES[type]) return { error: "探测协议仅支持 tcp / icmp / http" };
  if (!Number.isFinite(interval) || interval < 10 || interval > 3600) {
    return { error: "探测间隔需在 10~3600 秒之间" };
  }
  if (!defaultOn && clients.length === 0) {
    return { error: "请至少选择一个被监控节点（或开启对新节点默认启用）" };
  }

  return {
    task: {
      name: name,
      target: target,
      type: type,
      interval: interval,
      clients: clients,
      default_on: defaultOn
    }
  };
}

function buildTaskDedupKey(task) {
  var clients = Array.isArray(task.clients) ? task.clients.slice().sort().join(",") : "";
  return [
    String(task.name || "").trim().toLowerCase(),
    String(task.type || "").trim().toLowerCase(),
    String(task.target || "").trim().toLowerCase(),
    clients
  ].join("|");
}

function planTaskCreation(inputTasks, existingTasks, skipDuplicates) {
  var existingKeys = {};
  var list = Array.isArray(existingTasks) ? existingTasks : [];
  for (var i = 0; i < list.length; i++) {
    existingKeys[buildTaskDedupKey(list[i])] = true;
  }

  var toCreate = [];
  var skipped = [];
  var errors = [];

  for (var j = 0; j < inputTasks.length; j++) {
    var checked = sanitizeTaskInput(inputTasks[j]);
    if (checked.error) {
      errors.push({ index: j, error: checked.error });
      continue;
    }
    var key = buildTaskDedupKey(checked.task);
    if (skipDuplicates && existingKeys[key]) {
      skipped.push(checked.task);
      continue;
    }
    existingKeys[key] = true;
    toCreate.push(checked.task);
  }

  return {
    toCreate: toCreate,
    skipped: skipped,
    errors: errors
  };
}

function buildMeshTasks(nodes, port, interval, protocol) {
  var validNodes = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!n || !n.uuid || !n.host) continue;
    validNodes.push({
      uuid: String(n.uuid).trim(),
      name: String(n.name || n.uuid).trim(),
      host: String(n.host).trim(),
      port: n.port ? Number(n.port) : Number(port || 443)
    });
  }

  var proto = String(protocol || "tcp").toLowerCase();
  if (!ALLOWED_TYPES[proto]) proto = "tcp";
  var sec = Math.round(Number(interval) || 60);
  if (sec < 10) sec = 10;

  var tasks = [];
  for (var a = 0; a < validNodes.length; a++) {
    for (var b = 0; b < validNodes.length; b++) {
      if (a === b) continue;
      var src = validNodes[a];
      var dst = validNodes[b];
      var target = proto === "tcp"
        ? (dst.host.indexOf(":") !== -1 && dst.host.charAt(0) !== "[" ? "[" + dst.host + "]:" + dst.port : dst.host + ":" + dst.port)
        : dst.host;
      tasks.push({
        name: src.name + " → " + dst.name,
        type: proto,
        target: target,
        interval: sec,
        clients: [src.uuid],
        default_on: false
      });
    }
  }
  return tasks;
}

module.exports = {
  THREE_NET_PRESETS: THREE_NET_PRESETS,
  sanitizeTaskInput: sanitizeTaskInput,
  planTaskCreation: planTaskCreation,
  buildMeshTasks: buildMeshTasks
};
