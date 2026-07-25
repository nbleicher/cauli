// offscreen.js — runs in offscreen document, handles mic getUserMedia + MediaRecorder

let mediaRecorder = null;
let micStream = null;
let pendingChunkSends = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "START_MIC") {
    startMic(sendResponse, msg.deviceId);
    return true; // async
  }

  if (msg.type === "STOP_MIC") {
    stopMic().then(sendResponse);
    return true;
  }

  if (msg.type === "CHECK_MIC") {
    checkMic(sendResponse);
    return true;
  }

  if (msg.type === "GET_MIC_DEVICES") {
    listMicDevices(sendResponse);
    return true;
  }
});

async function listMicDevices(sendResponse) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    sendResponse({
      success: true,
      devices: devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "" })),
    });
  } catch (e) {
    sendResponse({ success: false, devices: [], error: e.name + ": " + e.message });
  }
}

async function checkMic(sendResponse) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    sendResponse({
      granted: true,
      devices: devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "" })),
    });
  } catch (e) {
    sendResponse({ granted: false, error: e.name + ": " + e.message });
  }
}

async function startMic(sendResponse, deviceId) {
  try {
    await stopMic();
    const audioConstraints = (deviceId && deviceId !== "default")
      ? { deviceId: { exact: deviceId } }
      : true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    const track = micStream.getAudioTracks()[0];
    const settings = track?.getSettings?.() || {};
    const label = track?.label || "";

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(micStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        queueMicChunk(e.data, mimeType);
      }
    };

    mediaRecorder.start(1000);
    sendResponse({
      success: true,
      deviceId: settings.deviceId || deviceId || "default",
      label,
      mimeType,
    });
  } catch (e) {
    sendResponse({ success: false, error: e.name + ": " + e.message });
  }
}

function queueMicChunk(blob, mimeType) {
  const sendPromise = blob.arrayBuffer()
    .then((buf) => chrome.runtime.sendMessage({
      type: "MIC_CHUNK",
      chunk: Array.from(new Uint8Array(buf)),
      mimeType,
    }))
    .catch(() => {});
  pendingChunkSends.add(sendPromise);
  sendPromise.finally(() => pendingChunkSends.delete(sendPromise));
  return sendPromise;
}

async function stopMic() {
  const recorder = mediaRecorder;
  if (recorder && recorder.state !== "inactive") {
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.stop();
    });
  }
  await Promise.allSettled([...pendingChunkSends]);
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  mediaRecorder = null;
  return { success: true };
}
