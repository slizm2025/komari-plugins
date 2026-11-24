(function () {
  "use strict";

  var API_SUMMARY = "/api/plugin/traffic-quota/summary";
  var PANEL_ATTR = "data-ktq-uuid";
  var MODE_SHORT = {
    sum: "双向",
    out: "出站",
    in: "入站",
    max: "取大"
  };

  var state = {
    summary: null,
    nodeMap: {},
    timer: null,
    observer: null,
    debounceId: null,
    fetching: false
  };

  function isHomepageRoute() {
    try {
      if (window.self !== window.top) return false;
      var p = (window.location.pathname || "/").toLowerCase();
      var h = (window.location.hash || "").toLowerCase();
      var full = p + " " + h;
      if (
        full.indexOf("/admin") !== -1 ||
        full.indexOf("/terminal") !== -1 ||
        full.indexOf("/api/plugin") !== -1 ||
        full.indexOf("/plugin") !== -1 ||
        full.indexOf("/login") !== -1 ||
        full.indexOf("/auth") !== -1 ||
        full.indexOf("/server/") !== -1 ||
        full.indexOf("/instance/") !== -1
      ) {
        return false;
      }
      var cleanP = p.replace(/\/+$/, "") || "/";
      var cleanH = h.replace(/\/+$/, "");
      return (
        (cleanP === "/" || cleanP === "/index.html") &&
        (cleanH === "" || cleanH === "#" || cleanH === "#/" || cleanH === "#/home" || cleanH === "#/overview")
      );
    } catch (_) {
      return false;
    }
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatBytes(bytes, unitBase) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return "--";
    var base = unitBase === 1000 ? 1000 : 1024;
    var units = ["B", "KB", "MB", "GB", "TB", "PB"];
    var idx = 0;
    while (n >= base && idx < units.length - 1) {
      n = n / base;
      idx += 1;
    }
    var digits = idx <= 1 ? 0 : (n >= 100 ? 1 : 2);
    return n.toFixed(digits).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1") + " " + units[idx];
  }

  function parseRgba(color) {
    if (!color) return null;
    var m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  }

  function detectDarkTheme(el) {
    try {
      var html = document.documentElement;
      var body = document.body;
      if (html.classList.contains("dark") || body.classList.contains("dark")) return true;
      var attrTheme = (html.getAttribute("data-theme") || body.getAttribute("data-theme") || "").toLowerCase();
      if (attrTheme.indexOf("dark") !== -1) return true;
      if (attrTheme.indexOf("light") !== -1) return false;
      var cur = el;
      while (cur && cur !== document) {
        var rgba = parseRgba(window.getComputedStyle(cur).backgroundColor);
        if (rgba && rgba.a > 0.2) {
          return (0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b) / 255 < 0.45;
        }
        cur = cur.parentElement;
      }
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return true;
    } catch (_) {}
    return false;
  }

  function extractUuidFromHref(href) {
    if (!href) return null;
    var m = href.match(/\/(?:server|instance|node)\/([0-9a-fA-F-]{8,64})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  function countUniqueNodeLinks(container) {
    var links = container.querySelectorAll('a[href*="/server/"], a[href*="/instance/"], a[href*="/node/"]');
    var seen = {};
    var count = 0;
    for (var i = 0; i < links.length; i++) {
      var u = extractUuidFromHref(links[i].getAttribute("href") || "");
      if (u && !seen[u]) {
        seen[u] = true;
        count += 1;
        if (count > 1) return count;
      }
    }
    return count;
  }

  function findCardHost(linkOrCard) {
    if (!linkOrCard) return null;
    if (linkOrCard.closest && linkOrCard.closest("table, tbody, tr")) return null;
    if (linkOrCard.tagName === "A") {
      var aRect = linkOrCard.getBoundingClientRect();
      if (aRect.width >= 180 && aRect.height >= 90) {
        var child = linkOrCard.firstElementChild;
        if (child && child.tagName === "DIV" && child.getBoundingClientRect().height >= 80) {
          return child;
        }
        return linkOrCard;
      }
      var cur = linkOrCard.parentElement;
      var best = null;
      for (var d = 0; d < 6 && cur && cur !== document.body && cur !== document.documentElement; d++) {
        if (cur.tagName === "MAIN" || cur.tagName === "SECTION") break;
        if (countUniqueNodeLinks(cur) > 1) break;
        var r = cur.getBoundingClientRect();
        if (r.width >= 180 && r.height >= 90 && r.width < window.innerWidth * 0.96) {
          best = cur;
        }
        cur = cur.parentElement;
      }
      return best;
    }
    return linkOrCard;
  }

  function findCardTargets(nodeMap) {
    var targets = [];
    var matched = {};

    // Strategy 0: Komari 1.6.x default theme cards
    var kmCards = document.querySelectorAll(".km-node-card[id], .node-card[id]");
    for (var k = 0; k < kmCards.length; k++) {
      var card = kmCards[k];
      if (card.closest && (card.closest(".ktq-panel") || card.closest("table, tbody, tr"))) continue;
      var cid = card.getAttribute("id") || "";
      if (!cid || !nodeMap[cid] || matched[cid]) continue;
      var cr = card.getBoundingClientRect();
      if (cr.width < 160 || cr.height < 60) continue;
      matched[cid] = true;
      targets.push({ uuid: cid, host: card });
    }

    // Strategy 1: Links
    var links = document.querySelectorAll('a[href*="/server/"], a[href*="/instance/"], a[href*="/node/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.closest && a.closest(".ktq-panel")) continue;
      var uuid = extractUuidFromHref(a.getAttribute("href") || "");
      if (!uuid || !nodeMap[uuid] || matched[uuid]) continue;
      var host = findCardHost(a);
      if (!host) continue;
      var r = host.getBoundingClientRect();
      if (r.width < 160 || r.height < 60) continue;
      matched[uuid] = true;
      targets.push({ uuid: uuid, host: host });
    }

    return targets;
  }

  function buildPanelMarkup(node, unitBase) {
    var tr = node.traffic;
    var cy = node.cycle;
    var rl = node.rule;
    var pct = tr.usagePercent != null ? tr.usagePercent : 0;
    var barWidth = Math.max(0, Math.min(100, pct));
    var st = node.status || "ok";

    var usedStr = formatBytes(tr.usedBytes, unitBase);
    var quotaStr = formatBytes(tr.quotaBytes, unitBase);
    var remainText = tr.overageBytes > 0
      ? "超限 +" + formatBytes(tr.overageBytes, unitBase)
      : "剩余 " + formatBytes(tr.remainingBytes, unitBase);

    var modeShort = MODE_SHORT[rl.billingMode] || rl.billingMode;
    var upStr = formatBytes(tr.trackedUpBytes, unitBase);
    var downStr = formatBytes(tr.trackedDownBytes, unitBase);
    var projStr = formatBytes(tr.projectedBytes, unitBase);
    var calTip = rl.calibrationActive && rl.calibration
      ? " | 校准基准 " + rl.calibration.totalGB + " GB (+保存后新增 " + formatBytes(tr.deltaAfterCalibrationBytes, unitBase) + ")"
      : (rl.offsetActive ? " | 含初始校准 +" + rl.offsetGB + " GB" : "");
    var titleTip =
      "账单周期: " + cy.startDate + " ~ " + cy.endDate +
      " | 本期追踪 ↑" + upStr + " / ↓" + downStr +
      calTip +
      " | 预计本期总量: " + projStr;

    return (
      '<div class="ktq-box" title="' + esc(titleTip) + '">' +
        '<div class="ktq-head">' +
          '<span class="ktq-title-wrap">' +
            '<span class="ktq-title">月度流量</span>' +
            '<span class="ktq-mode-tag">' + esc(modeShort) + "</span>" +
          "</span>" +
          '<span class="ktq-pct ktq-st-' + esc(st) + '">' + esc(pct.toFixed(1)) + "%</span>" +
        "</div>" +
        '<div class="ktq-track">' +
          '<div class="ktq-fill ktq-bar-' + esc(st) + '" style="width:' + barWidth + '%"></div>' +
        "</div>" +
        '<div class="ktq-metrics">' +
          '<span class="ktq-used"><strong>' + esc(usedStr) + "</strong> / " + esc(quotaStr) + "</span>" +
          '<span class="ktq-remain ktq-rem-' + esc(st) + '">' + esc(remainText) + "</span>" +
        "</div>" +
        '<div class="ktq-sub">' +
          "<span>每月 " + esc(rl.resetDay) + " 日重置 · 剩 " + esc(cy.remainingDays) + " 天</span>" +
          "<span>↑" + esc(upStr) + " ↓" + esc(downStr) + "</span>" +
        "</div>" +
      "</div>"
    );
  }

  function removeAllPanels() {
    var panels = document.querySelectorAll(".ktq-panel[" + PANEL_ATTR + "]");
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].parentNode) panels[i].parentNode.removeChild(panels[i]);
    }
  }

  function renderPanels() {
    if (!isHomepageRoute()) {
      removeAllPanels();
      return;
    }
    var summary = state.summary;
    if (!summary || !summary.config || summary.config.injectHomeCards === false) {
      removeAllPanels();
      return;
    }

    var unitBase = summary.config.unitBase || 1024;
    var targets = findCardTargets(state.nodeMap);

    for (var i = 0; i < targets.length; i++) {
      var item = targets[i];
      var node = state.nodeMap[item.uuid];
      var existing = item.host.querySelector(".ktq-panel[" + PANEL_ATTR + '="' + item.uuid + '"]');

      if (!node || !node.hasQuota) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        continue;
      }

      var markup = buildPanelMarkup(node, unitBase);
      var isDark = detectDarkTheme(item.host);

      if (existing) {
        existing.classList.toggle("ktq-dark", isDark);
        if (existing.getAttribute("data-ktq-hash") !== markup) {
          existing.innerHTML = markup;
          existing.setAttribute("data-ktq-hash", markup);
        }
      } else {
        var panel = document.createElement("div");
        panel.className = isDark ? "ktq-panel ktq-dark" : "ktq-panel";
        panel.setAttribute(PANEL_ATTR, item.uuid);
        panel.setAttribute("data-ktq-hash", markup);
        panel.innerHTML = markup;

        // Place neatly above latency-monitor panel if both plugins are installed
        var latencyPanel = item.host.querySelector(".klm-panel");
        if (latencyPanel && latencyPanel.parentNode === item.host) {
          item.host.insertBefore(panel, latencyPanel);
        } else {
          item.host.appendChild(panel);
        }
      }
    }
  }

  function scheduleRender() {
    if (state.debounceId) clearTimeout(state.debounceId);
    state.debounceId = setTimeout(function () {
      state.debounceId = null;
      renderPanels();
    }, 120);
  }

  function fetchSummary() {
    if (!isHomepageRoute() || state.fetching) return;
    state.fetching = true;
    fetch(API_SUMMARY, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.status !== "success" || !j.data) return;
        state.summary = j.data;
        var map = {};
        var nodes = Array.isArray(j.data.nodes) ? j.data.nodes : [];
        for (var i = 0; i < nodes.length; i++) map[nodes[i].uuid] = nodes[i];
        state.nodeMap = map;
        renderPanels();
        resetTimer((j.data.config && j.data.config.refreshIntervalSeconds) || 30);
      })
      .catch(function () {})
      .finally(function () {
        state.fetching = false;
      });
  }

  function resetTimer(seconds) {
    if (state.timer) clearInterval(state.timer);
    var ms = Math.max(10, Number(seconds) || 30) * 1000;
    state.timer = setInterval(function () {
      if (!document.hidden && isHomepageRoute()) fetchSummary();
    }, ms);
  }

  function patchHistory() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    function onChange() {
      if (isHomepageRoute()) {
        fetchSummary();
        scheduleRender();
      } else {
        removeAllPanels();
      }
    }
    if (typeof origPush === "function") {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        onChange();
        return r;
      };
    }
    if (typeof origReplace === "function") {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        onChange();
        return r;
      };
    }
    window.addEventListener("popstate", onChange);
    window.addEventListener("hashchange", onChange);
  }

  function init() {
    if (window.self !== window.top) return;
    patchHistory();

    state.observer = new MutationObserver(function (mutations) {
      if (!isHomepageRoute()) return;
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        if (t && t.closest && t.closest(".ktq-panel")) continue;
        scheduleRender();
        break;
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && isHomepageRoute()) fetchSummary();
    });

    if (isHomepageRoute()) fetchSummary();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
