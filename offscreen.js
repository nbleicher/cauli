// offscreen.js — runs in offscreen document, handles mic getUserMedia + MediaRecorder

let mediaRecorder = null;
let micStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "START_MIC") {
    startMic(sendResponse, msg.deviceId);
    return true; // async
  }

  if (msg.type === "STOP_MIC") {
    stopMic();
    sendResponse({ success: true });
  }

  if (msg.type === "CHECK_MIC") {
    checkMic(sendResponse);
    return true;
  }
});

async function checkMic(sendResponse) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    sendResponse({ granted: true });
  } catch (e) {
    sendResponse({ granted: false, error: e.name + ": " + e.message });
  }
}

async function startMic(sendResponse, deviceId) {
  try {
    const audioConstraints = (deviceId && deviceId !== "default")
      ? { deviceId: { exact: deviceId } }
      : true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(micStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        e.data.arrayBuffer().then((buf) => {
          chrome.runtime.sendMessage({
            type: "MIC_CHUNK",
            chunk: Array.from(new Uint8Array(buf)),
            mimeType,
          });
        });
      }
    };

    mediaRecorder.start(1000);
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e.name + ": " + e.message });
  }
}

function stopMic() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  mediaRecorder = null;
}
