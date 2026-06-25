// background.js — Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Keep activeTab grant alive when the icon is clicked
chrome.action.onClicked.addListener((tab) => {
  // openPanelOnActionClick handles the panel; this listener keeps activeTab context in the SW
});

// ─── Offscreen document helpers ───────────────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture microphone audio for call recording",
    });
  }
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) await chrome.offscreen.closeDocument();
}

// ─── Relay mic chunks from offscreen → side panel ────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MIC_CHUNK") {
    // Forward to all extension pages (side panel picks it up)
    chrome.runtime.sendMessage({ type: "MIC_CHUNK", chunk: msg.chunk, mimeType: msg.mimeType })
      .catch(() => {}); // side panel may not be ready yet
    return;
  }

  if (msg.type === "START_MIC") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "START_MIC", deviceId: msg.deviceId || "default" },
        (res) => sendResponse(res)
      );
    }).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === "STOP_MIC") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_MIC" }, () => {
      closeOffscreen().catch(() => {});
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "CHECK_MIC") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "CHECK_MIC" },
        (res) => {
          if (!res?.granted) closeOffscreen().catch(() => {});
          sendResponse(res);
        }
      );
    }).catch((e) => sendResponse({ granted: false, error: e.message }));
    return true;
  }

  if (msg.type === "GET_TAB_CAPTURE_STREAM_ID") {
    chrome.tabCapture.getMediaStreamId(
      { targetTabId: msg.tabId },
      (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId });
        }
      }
    );
    return true;
  }
});
