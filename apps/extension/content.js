(function () {
  "use strict";
  if (window.__calllogMicPermissionContentLoaded) {
    return;
  }
  window.__calllogMicPermissionContentLoaded = true;

  const IFRAME_ID = "calllog-microphone-permission-frame";

  function injectMicrophonePermissionIframe() {
    const existing = document.getElementById(IFRAME_ID);
    if (existing) return existing;
    if (!document.documentElement) return;

    const iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.hidden = true;
    iframe.setAttribute("allow", "microphone *");
    iframe.src = chrome.runtime.getURL("permissions.html?embedded=1");

    (document.body || document.documentElement).appendChild(iframe);
    return iframe;
  }

  function postToPermissionFrame(message) {
    const iframe = injectMicrophonePermissionIframe();
    if (!iframe?.contentWindow) return false;
    iframe.contentWindow.postMessage({ source: "calllog-content", ...message }, "*");
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "INJECT_MIC_PERMISSION_IFRAME") {
      injectMicrophonePermissionIframe();
      sendResponse({ success: true });
    }
    if (msg.type === "START_MIC_IN_IFRAME") {
      const sent = postToPermissionFrame({
        type: "START_MIC",
        deviceId: msg.deviceId || "default",
        deviceLabel: msg.deviceLabel || "",
      });
      sendResponse({ success: sent });
    }
    if (msg.type === "STOP_MIC_IN_IFRAME") {
      const sent = postToPermissionFrame({ type: "STOP_MIC" });
      sendResponse({ success: sent });
    }
  });

  chrome.storage.local.get(["mic_permission_granted", "mic_permission_prompted", "source_mode"], (result) => {
    if (result.source_mode !== "tab" && !result.mic_permission_granted && !result.mic_permission_prompted) {
      injectMicrophonePermissionIframe();
    }
  });
})();
