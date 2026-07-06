// background.js — Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
let syncRecorderTabId = null;
let lastInvokedTabId = null;
let lastInvokedWindowId = null;

function isCapturableTab(tab) {
  return !!tab?.id && /^https?:\/\//.test(tab.url || "");
}

function tabCaptureHelpMessage() {
  return "Open the dialer/call tab, click the CallLog extension icon on that tab, then press Record. Chrome only allows tab audio capture after the extension is invoked on a normal http/https page; chrome:// pages and the Extensions page cannot be recorded.";
}

// Keep activeTab grant alive when the icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (isCapturableTab(tab)) {
    lastInvokedTabId = tab.id;
    lastInvokedWindowId = tab.windowId;
  }
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

function openPermissionTab(sendResponse) {
  chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html?autoclose=1") }, (tab) => {
    if (chrome.runtime.lastError) {
      sendResponse({ success: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ success: true, mode: "tab", tabId: tab?.id });
  });
}

function openMicRecorderTab(deviceId, sendResponse, deviceLabel = "") {
  const params = new URLSearchParams({
    recorder: "1",
    autoclose: "1",
    deviceId: deviceId || "default",
    deviceLabel,
  });
  chrome.tabs.create({ url: chrome.runtime.getURL(`permissions.html?${params}`) }, (tab) => {
    if (chrome.runtime.lastError) {
      sendResponse({ success: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ success: true, mode: "extension-recorder-tab", tabId: tab?.id });
  });
}

function startSyncRecorder(msg, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    const useActiveTab = isCapturableTab(activeTab);
    const useInvokedTab =
      lastInvokedTabId &&
      (!lastInvokedWindowId || activeTab?.windowId === lastInvokedWindowId);

    const startForTab = (tab) => {
      if (!isCapturableTab(tab)) {
        sendResponse({ success: false, error: tabCaptureHelpMessage() });
        return;
      }

      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const message = chrome.runtime.lastError?.message || "Could not capture tab audio.";
          sendResponse({
            success: false,
            error: /not been invoked|Chrome pages cannot be captured/i.test(message)
              ? tabCaptureHelpMessage()
              : message,
          });
          return;
        }

        const params = new URLSearchParams({
          streamId,
          micDeviceId: msg.deviceId || "default",
          micDeviceLabel: msg.deviceLabel || "",
        });
        chrome.tabs.create({ url: chrome.runtime.getURL(`recorder.html?${params}`), active: true }, (recorderTab) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          syncRecorderTabId = recorderTab?.id || null;
          sendResponse({ success: true, tabId: recorderTab?.id });
        });
      });
    };

    if (useInvokedTab) {
      chrome.tabs.get(lastInvokedTabId, (invokedTab) => {
        if (chrome.runtime.lastError || !isCapturableTab(invokedTab)) {
          if (useActiveTab) {
            startForTab(activeTab);
            return;
          }
          sendResponse({ success: false, error: tabCaptureHelpMessage() });
          return;
        }
        startForTab(invokedTab);
      });
      return;
    }

    startForTab(activeTab);
  });
}

function sendToActiveContent(message, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      sendResponse({ success: false, error: "Open a normal https:// dialer tab before starting mic recording." });
      return;
    }

    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(res || { success: true });
      });
    });
  });
}

// ─── Relay mic chunks from offscreen → side panel ────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_SYNC_RECORDING") {
    startSyncRecorder(msg, sendResponse);
    return true;
  }

  if (msg.type === "STOP_SYNC_RECORDING") {
    if (!syncRecorderTabId) {
      sendResponse({ success: false, error: "No synchronized recorder tab is active." });
      return true;
    }
    chrome.tabs.sendMessage(syncRecorderTabId, { type: "STOP_SYNC_RECORDING" }, () => {
      void chrome.runtime.lastError;
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "SYNC_RECORDER_STATUS") {
    chrome.runtime.sendMessage({ ...msg, type: "SYNC_RECORDER_STATUS_CHANGED" }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (msg.type === "SYNC_RECORDING_COMPLETE") {
    syncRecorderTabId = null;
    chrome.runtime.sendMessage({
      type: "SYNC_RECORDING_COMPLETE",
      chunk: msg.chunk,
      mimeType: msg.mimeType,
    }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (msg.type === "START_PAGE_MIC") {
    openMicRecorderTab(msg.deviceId || "default", sendResponse, msg.deviceLabel || "");
    return true;
  }

  if (msg.type === "STOP_PAGE_MIC") {
    chrome.runtime.sendMessage({ type: "STOP_EXTENSION_MIC" }, () => {
      void chrome.runtime.lastError;
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "OPEN_MIC_PERMISSION_PAGE") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id || !/^https?:/.test(tab.url || "")) {
        openPermissionTab(sendResponse);
        return;
      }

      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }, () => {
        if (chrome.runtime.lastError) {
          openPermissionTab(sendResponse);
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: "INJECT_MIC_PERMISSION_IFRAME" }, (res) => {
          if (chrome.runtime.lastError || !res?.success) {
            openPermissionTab(sendResponse);
            return;
          }
          sendResponse({ success: true, mode: "iframe", tabId: tab.id });
        });
      });
    });
    return true;
  }

  if (msg.type === "MIC_PERMISSION_UPDATED") {
    chrome.runtime.sendMessage({
      type: "MIC_PERMISSION_CHANGED",
      granted: msg.granted,
      devices: msg.devices || [],
      error: msg.error,
    }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (msg.type === "MIC_IFRAME_STATUS") {
    chrome.runtime.sendMessage({
      type: "MIC_IFRAME_STATUS_CHANGED",
      recording: msg.recording,
      success: msg.success,
      error: msg.error,
      mimeType: msg.mimeType,
      inputLabel: msg.inputLabel,
      settings: msg.settings,
      requestedLabel: msg.requestedLabel,
      startedAt: msg.startedAt,
    }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (msg.type === "MIC_LEVEL") {
    chrome.runtime.sendMessage({
      type: "MIC_LEVEL",
      rms: msg.rms,
      peak: msg.peak,
    }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (msg.type === "MIC_CHUNK") {
    // Forward to all extension pages (side panel picks it up)
    chrome.runtime.sendMessage(
      { type: "MIC_CHUNK", chunk: msg.chunk, mimeType: msg.mimeType },
      () => {
        // The side panel may not be open or may not send a response.
        void chrome.runtime.lastError;
        sendResponse({ success: true });
      }
    );
    return true;
  }

  if (msg.type === "START_MIC") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "START_MIC", deviceId: msg.deviceId || "default" },
        (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(res);
        }
      );
    }).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === "STOP_MIC") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_MIC" }, (res) => {
      if (chrome.runtime.lastError) {
        closeOffscreen().catch(() => {});
        sendResponse({ success: true, warning: chrome.runtime.lastError.message });
        return;
      }
      closeOffscreen().catch(() => {});
      sendResponse(res || { success: true });
    });
    return true;
  }

  if (msg.type === "CHECK_MIC") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "CHECK_MIC" },
        (res) => {
          if (chrome.runtime.lastError) {
            closeOffscreen().catch(() => {});
            sendResponse({ granted: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!res?.granted) closeOffscreen().catch(() => {});
          sendResponse(res);
        }
      );
    }).catch((e) => sendResponse({ granted: false, error: e.message }));
    return true;
  }

  if (msg.type === "GET_MIC_DEVICES") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "GET_MIC_DEVICES" },
        (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, devices: [], error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(res);
        }
      );
    }).catch((e) => sendResponse({ success: false, devices: [], error: e.message }));
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
