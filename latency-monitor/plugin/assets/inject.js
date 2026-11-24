(function () {
  "use strict";

  var API_SUMMARY = "/api/plugin/latency-monitor/summary";
  var PANEL_ATTR = "data-klm-uuid";
  var state = {
    summary: null,
    nodeMap: {},
    timer: null,
    observer: null,
    debounceId: null,
    fetching: false,
    tooltipEl: null,
    activePill: null
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

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatHM(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function formatLatencyText(task) {
    if (!task || task.totalSamples === 0) return "--";
    if (task.latestWasLoss && task.latestLatency === null) return "超时";
    var val = task.latestLatency !== null ? task.latestLatency : task.avgLatency;
    if (val === null || val === undefined) return "超时";
    return val + " ms";
  }

  function formatLossText(lossPercent, totalSamples) {
    if (!totalSamples || lossPercent === null || lossPercent === undefined) return "--";
    var num = Number(lossPercent);
    if (!isFinite(num)) return "--";
    if (num === 0) return "0 %";
    if (num >= 10 || Number.isInteger(num)) {
      return (num >= 10 ? Math.round(num) : num) + " %";
    }
    return num.toFixed(1) + " %";
  }

  function parseRgba(color) {
    if (!color) return null;
    var m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4])
    };
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
        var bg = window.getComputedStyle(cur).backgroundColor;
        var rgba = parseRgba(bg);
        if (rgba && rgba.a > 0.2) {
          var lum = (0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b) / 255;
          return lum < 0.45;
        }
        cur = cur.parentElement;
      }
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return true;
      }
    } catch (_) {
      // ignore
    }
    return false;
  }

  function buildPanelMarkup(node, maxTasks, bucketCount) {
    var tasks = Array.isArray(node.tasks) ? node.tasks.slice(0, maxTasks) : [];
    if (tasks.length === 0) return "";

    var latencyRows = [];
    var lossRows = [];

    for (var i = 0; i < tasks.length; i++) {
      var tk = tasks[i];
      var dot = '<span class="klm-dot" style="background:' + escapeHtml(tk.dotColor) + '"></span>';
      var nameHtml =
        '<span class="klm-row-name" title="' + escapeHtml(tk.name) + '">' +
        dot +
        '<span class="klm-row-label-text">' + escapeHtml(tk.name) + "</span>" +
        "</span>";

      var latValClass = "klm-row-val klm-st-" + escapeHtml(tk.latencyStatus || "empty");
      var lossValClass = "klm-row-val klm-st-" + escapeHtml(tk.lossStatus || "empty");
      if (tk.lossStatus === "warn" && tk.lossPercent > 0 && tk.lossPercent < 5) {
        lossValClass = "klm-row-val klm-loss-accent-good";
      }

      var latPills = [];
      var lossPills = [];
      var buckets = Array.isArray(tk.buckets) ? tk.buckets : [];

      for (var b = 0; b < buckets.length; b++) {
        var bk = buckets[b];
        var tipData = encodeURIComponent(JSON.stringify({
          taskName: tk.name,
          type: tk.type,
          start: bk.start,
          end: bk.end,
          total: bk.total,
          valid: bk.valid,
          loss: bk.loss,
          avgLatency: bk.avgLatency,
          minLatency: bk.minLatency,
          maxLatency: bk.maxLatency,
          lossPercent: bk.lossPercent
        }));

        latPills.push(
          '<span class="klm-pill klm-st-' + escapeHtml(bk.latencyStatus) +
          '" data-klm-kind="latency" data-klm-tip="' + tipData + '"></span>'
        );
        lossPills.push(
          '<span class="klm-pill klm-st-' + escapeHtml(bk.lossStatus) +
          '" data-klm-kind="loss" data-klm-tip="' + tipData + '"></span>'
        );
      }

      latencyRows.push(
        '<div class="klm-row">' +
          '<div class="klm-row-head">' +
            nameHtml +
            '<span class="' + latValClass + '">' + escapeHtml(formatLatencyText(tk)) + "</span>" +
          "</div>" +
          '<div class="klm-bars" style="--klm-buckets:' + bucketCount + '">' + latPills.join("") + "</div>" +
        "</div>"
      );

      lossRows.push(
        '<div class="klm-row">' +
          '<div class="klm-row-head">' +
            nameHtml +
            '<span class="' + lossValClass + '">' + escapeHtml(formatLossText(tk.lossPercent, tk.totalSamples)) + "</span>" +
          "</div>" +
          '<div class="klm-bars" style="--klm-buckets:' + bucketCount + '">' + lossPills.join("") + "</div>" +
        "</div>"
      );
    }

    return (
      '<div class="klm-grid">' +
        '<div class="klm-col">' +
          '<div class="klm-col-title">延迟</div>' +
          '<div class="klm-rows">' + latencyRows.join("") + "</div>" +
        "</div>" +
        '<div class="klm-col">' +
          '<div class="klm-col-title">丢包</div>' +
          '<div class="klm-rows">' + lossRows.join("") + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="klm-footer">' +
        "<span>" + escapeHtml(node.footerLabel || "探测 · 灰色为无采样") + "</span>" +
      "</div>"
    );
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
    // Do not inject into table rows
    if (linkOrCard.closest && linkOrCard.closest("table, tbody, tr")) return null;
    if (linkOrCard.tagName === "A") {
      var aRect = linkOrCard.getBoundingClientRect();
      // Official Komari default theme: <a href="/server/:uuid"><div class="card">...</div></a>
      if (aRect.width >= 180 && aRect.height >= 90) {
        var child = linkOrCard.firstElementChild;
        if (child && child.tagName === "DIV" && child.getBoundingClientRect().height >= 80) {
          return child;
        }
        return linkOrCard;
      }
      // Third-party themes where <a> only wraps the title inside a card container: walk up
      var cur = linkOrCard.parentElement;
      var best = null;
      for (var depth = 0; depth < 6 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
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
    var matchedUuids = {};

    // Strategy 0: Direct Komari 1.6.x default theme cards (<Card id="<uuid>" class="km-node-card node-card">)
    var kmCards = document.querySelectorAll(".km-node-card[id], .node-card[id]");
    for (var k = 0; k < kmCards.length; k++) {
      var card = kmCards[k];
      if (card.closest && (card.closest(".klm-panel") || card.closest("table, tbody, tr"))) continue;
      var cardUuid = card.getAttribute("id") || "";
      if (!cardUuid || !nodeMap[cardUuid] || matchedUuids[cardUuid]) continue;
      var cRect = card.getBoundingClientRect();
      if (cRect.width < 160 || cRect.height < 60) continue;

      matchedUuids[cardUuid] = true;
      targets.push({ uuid: cardUuid, host: card });
    }

    // Strategy 1: Links to /server/:uuid or /instance/:uuid or /node/:uuid
    var links = document.querySelectorAll('a[href*="/server/"], a[href*="/instance/"], a[href*="/node/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.closest && a.closest(".klm-panel")) continue;
      var href = a.getAttribute("href") || "";
      var uuid = extractUuidFromHref(href);
      if (!uuid || !nodeMap[uuid] || matchedUuids[uuid]) continue;

      var host = findCardHost(a);
      if (!host) continue;
      var rect = host.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 60) continue;

      matchedUuids[uuid] = true;
      targets.push({ uuid: uuid, host: host });
    }

    // Strategy 2: data-node-uuid / data-uuid attributes (custom themes)
    var attrEls = document.querySelectorAll("[data-node-uuid], [data-server-uuid], [data-uuid]");
    for (var j = 0; j < attrEls.length; j++) {
      var el = attrEls[j];
      if (el.closest && (el.closest(".klm-panel") || el.closest("table, tr"))) continue;
      var uid = el.getAttribute("data-node-uuid") || el.getAttribute("data-server-uuid") || el.getAttribute("data-uuid");
      if (!uid || !nodeMap[uid] || matchedUuids[uid]) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 60) continue;

      matchedUuids[uid] = true;
      targets.push({ uuid: uid, host: el });
    }

    return targets;
  }

  function removeAllPanels() {
    var panels = document.querySelectorAll(".klm-panel[" + PANEL_ATTR + "]");
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].parentNode) {
        panels[i].parentNode.removeChild(panels[i]);
      }
    }
  }

  function renderInjectedPanels() {
    if (!isHomepageRoute()) {
      removeAllPanels();
      hideTooltip();
      return;
    }
    var summary = state.summary;
    if (!summary || !summary.config || summary.config.injectHomeCards === false) {
      removeAllPanels();
      return;
    }

    var maxTasks = summary.config.cardMaxTasks || 4;
    var bucketCount = summary.bucketCount || 20;
    var targets = findCardTargets(state.nodeMap);

    for (var i = 0; i < targets.length; i++) {
      var item = targets[i];
      var node = state.nodeMap[item.uuid];
      if (!node || !Array.isArray(node.tasks) || node.tasks.length === 0) {
        var stale = item.host.querySelector(".klm-panel[" + PANEL_ATTR + '="' + item.uuid + '"]');
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        continue;
      }

      var markup = buildPanelMarkup(node, maxTasks, bucketCount);
      var existing = item.host.querySelector(".klm-panel[" + PANEL_ATTR + '="' + item.uuid + '"]');
      var isDark = detectDarkTheme(item.host);

      if (existing) {
        existing.classList.toggle("klm-dark", isDark);
        if (existing.getAttribute("data-klm-hash") !== markup) {
          existing.innerHTML = markup;
          existing.setAttribute("data-klm-hash", markup);
        }
      } else {
        var panel = document.createElement("div");
        panel.className = isDark ? "klm-panel klm-dark" : "klm-panel";
        panel.setAttribute(PANEL_ATTR, item.uuid);
        panel.setAttribute("data-klm-hash", markup);
        panel.innerHTML = markup;
        item.host.appendChild(panel);
      }
    }
  }

  function ensureTooltip() {
    if (state.tooltipEl && document.body.contains(state.tooltipEl)) {
      return state.tooltipEl;
    }
    var el = document.createElement("div");
    el.id = "klm-tooltip";
    document.body.appendChild(el);
    state.tooltipEl = el;
    return el;
  }

  function showTooltip(pill) {
    var raw = pill.getAttribute("data-klm-tip");
    if (!raw) return;
    var info;
    try {
      info = JSON.parse(decodeURIComponent(raw));
    } catch (_) {
      return;
    }

    var tip = ensureTooltip();
    var timeStr = formatHM(info.start) + " – " + formatHM(info.end);
    var bodyHtml;
    if (!info.total) {
      bodyHtml = '<div class="klm-tip-line"><span class="klm-tip-k">状态</span><span class="klm-tip-v">该时段无采样</span></div>';
    } else {
      var latText = info.avgLatency !== null
        ? info.avgLatency + " ms" + (info.minLatency !== info.maxLatency ? " (" + info.minLatency + "~" + info.maxLatency + ")" : "")
        : "全部超时";
      var lossText = info.lossPercent + "% (" + info.loss + "/" + info.total + ")";
      bodyHtml =
        '<div class="klm-tip-line"><span class="klm-tip-k">延迟</span><span class="klm-tip-v">' + escapeHtml(latText) + "</span></div>" +
        '<div class="klm-tip-line"><span class="klm-tip-k">丢包</span><span class="klm-tip-v">' + escapeHtml(lossText) + "</span></div>";
    }

    tip.innerHTML =
      '<div class="klm-tip-head"><span>' + escapeHtml(info.taskName) + "</span><span>" + escapeHtml(info.type) + "</span></div>" +
      '<div class="klm-tip-time">' + escapeHtml(timeStr) + "</div>" +
      bodyHtml;

    tip.classList.add("klm-tip-visible");
    var rect = pill.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var left = rect.left + rect.width / 2 - tipRect.width / 2;
    var margin = 8;
    if (left < margin) left = margin;
    if (left + tipRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tipRect.width - margin;
    }
    var top = rect.top - tipRect.height - 8;
    if (top < margin) {
      top = rect.bottom + 8;
    }
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
    state.activePill = pill;
  }

  function hideTooltip() {
    if (state.tooltipEl) {
      state.tooltipEl.classList.remove("klm-tip-visible");
    }
    state.activePill = null;
  }

  function bindTooltipEvents() {
    document.addEventListener("mouseover", function (e) {
      var target = e.target;
      if (target && target.classList && target.classList.contains("klm-pill")) {
        showTooltip(target);
      }
    }, true);

    document.addEventListener("mouseout", function (e) {
      var target = e.target;
      if (target && target === state.activePill) {
        hideTooltip();
      }
    }, true);

    window.addEventListener("scroll", hideTooltip, true);
  }

  function scheduleRender() {
    if (state.debounceId) clearTimeout(state.debounceId);
    state.debounceId = setTimeout(function () {
      state.debounceId = null;
      renderInjectedPanels();
    }, 120);
  }

  function fetchSummary() {
    if (!isHomepageRoute() || state.fetching) return;
    state.fetching = true;
    fetch(API_SUMMARY, { credentials: "same-origin", cache: "no-store" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (json) {
        if (!json || json.status !== "success" || !json.data) return;
        state.summary = json.data;
        var map = {};
        var nodes = Array.isArray(json.data.nodes) ? json.data.nodes : [];
        for (var i = 0; i < nodes.length; i++) {
          map[nodes[i].uuid] = nodes[i];
        }
        state.nodeMap = map;
        renderInjectedPanels();
        resetPollingTimer((json.data.config && json.data.config.refreshIntervalSeconds) || 30);
      })
      .catch(function () {
        // Silent fail so Komari UI is never disrupted
      })
      .finally(function () {
        state.fetching = false;
      });
  }

  function resetPollingTimer(seconds) {
    if (state.timer) clearInterval(state.timer);
    var ms = Math.max(10, Number(seconds) || 30) * 1000;
    state.timer = setInterval(function () {
      if (!document.hidden && isHomepageRoute()) {
        fetchSummary();
      }
    }, ms);
  }

  function patchHistoryNavigation() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    function onRouteChange() {
      hideTooltip();
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
        onRouteChange();
        return r;
      };
    }
    if (typeof origReplace === "function") {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        onRouteChange();
        return r;
      };
    }
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
  }

  function init() {
    if (window.self !== window.top) return;
    bindTooltipEvents();
    patchHistoryNavigation();

    state.observer = new MutationObserver(function (mutations) {
      if (!isHomepageRoute()) return;
      for (var i = 0; i < mutations.length; i++) {
        var target = mutations[i].target;
        if (target && target.closest && (target.closest(".klm-panel") || target.id === "klm-tooltip")) {
          continue;
        }
        scheduleRender();
        break;
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && isHomepageRoute()) {
        fetchSummary();
      }
    });

    if (isHomepageRoute()) {
      fetchSummary();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
