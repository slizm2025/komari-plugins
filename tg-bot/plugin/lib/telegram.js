"use strict";

var fmt = require("./formatter.js");

function createTelegramClient(options) {
  var opts = options || {};
  var fetchFn = opts.fetch || globalThis.fetch;

  function buildUrl(apiBase, token, method) {
    var base = String(apiBase || "https://api.telegram.org").replace(/\/+$/, "");
    return base + "/bot" + encodeURIComponent(token) + "/" + method;
  }

  async function callApi(apiBase, token, method, payload, reqOpts) {
    if (!token) throw new Error("bot_token is empty");
    var url = buildUrl(apiBase, token, method);
    var init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    };

    var timeoutMs = (reqOpts && reqOpts.timeoutMs) || 15000;
    var externalSignal = reqOpts && reqOpts.signal;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;

    if (controller) {
      init.signal = controller.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else if (typeof externalSignal.addEventListener === "function") {
          externalSignal.addEventListener("abort", function () {
            try { controller.abort(); } catch (_) {}
          }, { once: true });
        }
      }
      timer = setTimeout(function () {
        try { controller.abort(); } catch (_) {}
      }, timeoutMs);
    }

    try {
      var resp = await fetchFn(url, init);
      var text = await resp.text();
      var parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw new Error("Telegram API HTTP " + resp.status + ": non-JSON response");
      }
      if (!resp.ok || !parsed || parsed.ok === false) {
        var desc = (parsed && parsed.description) ? parsed.description : ("HTTP " + resp.status);
        var err = new Error("Telegram " + method + " failed: " + desc);
        err.statusCode = resp.status;
        err.description = desc;
        throw err;
      }
      return parsed.result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function sendMessage(apiBase, token, chatId, text, replyMarkup) {
    var chunks = fmt.splitLongMessage(text, 3900);
    var lastResult = null;
    for (var i = 0; i < chunks.length; i++) {
      var payload = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: "HTML",
        disable_web_page_preview: true
      };
      if (replyMarkup && i === chunks.length - 1) {
        payload.reply_markup = replyMarkup;
      }
      lastResult = await callApi(apiBase, token, "sendMessage", payload, { timeoutMs: 15000 });
    }
    return lastResult;
  }

  async function editMessageText(apiBase, token, chatId, messageId, text, replyMarkup) {
    var chunks = fmt.splitLongMessage(text, 3900);
    var payload = {
      chat_id: chatId,
      message_id: messageId,
      text: chunks[0],
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    try {
      return await callApi(apiBase, token, "editMessageText", payload, { timeoutMs: 15000 });
    } catch (err) {
      // Ignore "message is not modified" (happens when user clicks refresh rapidly)
      if (err && String(err.description || err.message || "").toLowerCase().indexOf("message is not modified") !== -1) {
        return null;
      }
      throw err;
    }
  }

  async function answerCallbackQuery(apiBase, token, callbackQueryId, text) {
    try {
      await callApi(apiBase, token, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text || ""
      }, { timeoutMs: 10000 });
    } catch (_) {
      // Non-fatal
    }
  }

  async function getUpdates(apiBase, token, offset, pollTimeoutSec, signal) {
    var sec = Math.max(5, Math.min(30, Number(pollTimeoutSec) || 20));
    return await callApi(apiBase, token, "getUpdates", {
      offset: offset,
      timeout: sec,
      allowed_updates: ["message", "callback_query"]
    }, {
      timeoutMs: (sec + 12) * 1000,
      signal: signal
    });
  }

  async function setMyCommands(apiBase, token) {
    try {
      await callApi(apiBase, token, "setMyCommands", {
        commands: [
          { command: "status", description: "全部 VPS 综合总览（CPU/延迟丢包/月度流量）" },
          { command: "ping", description: "查看三网延迟与丢包详情（可带小时数如 /ping 6）" },
          { command: "traffic", description: "查看各 VPS 月度流量已用与剩余配额" },
          { command: "node", description: "查看指定节点详情（如 /node LA）" },
          { command: "id", description: "查看当前会话的 Chat ID" },
          { command: "help", description: "显示机器人使用帮助" }
        ]
      }, { timeoutMs: 12000 });
    } catch (_) {
      // Non-fatal
    }
  }

  return {
    callApi: callApi,
    sendMessage: sendMessage,
    editMessageText: editMessageText,
    answerCallbackQuery: answerCallbackQuery,
    getUpdates: getUpdates,
    setMyCommands: setMyCommands
  };
}

module.exports = {
  createTelegramClient: createTelegramClient
};
