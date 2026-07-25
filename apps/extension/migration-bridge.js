(function () {
  "use strict";

  const config = globalThis.CALLLOG_COMPANION_CONFIG;
  if (!config || location.origin !== config.webAppOrigin) return;

  function reply(type, nonce, payload) {
    window.postMessage({
      source: "calllog-extension",
      type,
      nonce,
      ...payload,
    }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window
      || event.origin !== config.webAppOrigin
      || event.data?.source !== "calllog-web"
      || typeof event.data?.nonce !== "string"
      || event.data.nonce.length < 16
    ) return;

    if (event.data.type === "CALLLOG_EXTENSION_PING") {
      reply("CALLLOG_EXTENSION_PONG", event.data.nonce, {
        success: true,
        version: chrome.runtime.getManifest().version,
      });
      return;
    }

    if (event.data.type === "CALLLOG_EXTENSION_LIST_RECORDINGS") {
      chrome.runtime.sendMessage({
        type: "MIGRATION_LIST_RECORDINGS",
        nonce: event.data.nonce,
      }, (response) => {
        if (chrome.runtime.lastError) {
          reply("CALLLOG_EXTENSION_RECORDINGS", event.data.nonce, {
            success: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        reply("CALLLOG_EXTENSION_RECORDINGS", event.data.nonce, response || {
          success: false,
          error: "Extension service worker did not respond",
        });
      });
      return;
    }

    if (event.data.type === "CALLLOG_EXTENSION_UPLOAD" && Array.isArray(event.data.items)) {
      chrome.runtime.sendMessage({
        type: "MIGRATION_UPLOAD_RECORDINGS",
        nonce: event.data.nonce,
        items: event.data.items,
      }, (response) => {
        if (chrome.runtime.lastError) {
          reply("CALLLOG_EXTENSION_UPLOAD_COMPLETE", event.data.nonce, {
            success: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        reply("CALLLOG_EXTENSION_UPLOAD_COMPLETE", event.data.nonce, response || {
          success: false,
          error: "Extension upload did not respond",
        });
      });
    }
  });
})();
