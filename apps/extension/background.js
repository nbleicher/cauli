import { listLegacyRecordings, uploadLegacyRecordings } from "./migration.js";
import "./companion-config.js";

chrome.action.onClicked.addListener(() => {
  const appUrl = globalThis.CALLLOG_COMPANION_CONFIG.webAppUrl;
  const appOrigin = globalThis.CALLLOG_COMPANION_CONFIG.webAppOrigin;
  chrome.tabs.query({}, (tabs) => {
    const existing = tabs.find((candidate) => {
      try {
        return new URL(candidate.url || "").origin === appOrigin;
      } catch {
        return false;
      }
    });
    if (existing?.id) {
      chrome.tabs.update(existing.id, { active: true, url: appUrl });
      if (existing.windowId) {
        chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
    chrome.tabs.create({ url: appUrl });
  });
});

function allowedMigrationSender(sender) {
  try {
    return (
      new URL(sender.url || sender.tab?.url || "").origin ===
      globalThis.CALLLOG_COMPANION_CONFIG.webAppOrigin
    );
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type !== "MIGRATION_LIST_RECORDINGS" &&
    message.type !== "MIGRATION_UPLOAD_RECORDINGS"
  ) {
    return;
  }
  if (!allowedMigrationSender(sender)) {
    sendResponse({
      success: false,
      error: "Migration sender origin is not allowed",
    });
    return;
  }

  if (message.type === "MIGRATION_LIST_RECORDINGS") {
    listLegacyRecordings()
      .then((recordings) => sendResponse({ success: true, recordings }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  uploadLegacyRecordings(message.items || [])
    .then((items) =>
      sendResponse({
        success: true,
        items,
        warning: items.find((item) => item.error)?.error,
      })
    )
    .catch((error) => sendResponse({ success: false, error: error.message }));
  return true;
});
