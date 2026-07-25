(function () {
  "use strict";

  const btn = document.getElementById("request-mic");
  const statusEl = document.getElementById("status");
  const params = new URLSearchParams(location.search);
  let mediaRecorder = null;
  let micStream = null;
  let levelContext = null;
  let levelTimer = null;
  let pendingChunkSends = new Set();

  function setStatus(text, kind) {
    statusEl.className = `status ${kind || ""}`.trim();
    statusEl.innerHTML = text;
  }

  function settingsUrl() {
    return `chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${chrome.runtime.id}%2F`;
  }

  async function notify(granted, extra = {}) {
    await chrome.storage.local.set({
      mic_permission_prompted: true,
      mic_permission_granted: granted,
    });
    await chrome.runtime.sendMessage({ type: "MIC_PERMISSION_UPDATED", granted, ...extra }).catch(() => {});
  }

  async function requestMic() {
    btn.disabled = true;
    setStatus("Opening Chrome microphone prompt...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      await notify(true, {
        devices: devices
          .filter((d) => d.kind === "audioinput")
          .map((d) => ({ deviceId: d.deviceId, label: d.label || "" })),
      });

      setStatus("Microphone access granted. You can return to cauli.", "ok");
      if (new URLSearchParams(location.search).get("autoclose") === "1") {
        setTimeout(() => window.close(), 900);
      }
    } catch (err) {
      await notify(false, { error: `${err.name}: ${err.message}` });
      setStatus(
        `Microphone access was not granted: ${err.name}: ${err.message}<code>${settingsUrl()}</code>`,
        "error"
      );
      btn.disabled = false;
    }
  }

  function micConstraints(deviceId) {
    return (deviceId && deviceId !== "default")
      ? { deviceId: { exact: deviceId } }
      : true;
  }

  async function resolveDeviceId(deviceId, deviceLabel) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (deviceLabel) {
      const exactLabelMatch = devices.find((device) =>
        device.kind === "audioinput" && device.label === deviceLabel
      );
      if (exactLabelMatch) return exactLabelMatch.deviceId;

      const normalizedLabel = deviceLabel.toLowerCase();
      const partialLabelMatch = devices.find((device) =>
        device.kind === "audioinput" &&
        device.label &&
        (device.label.toLowerCase().includes(normalizedLabel) ||
          normalizedLabel.includes(device.label.toLowerCase()))
      );
      if (partialLabelMatch) return partialLabelMatch.deviceId;
    }
    if (deviceId && deviceId !== "default") return deviceId;
    const external = devices.find((device) =>
      device.kind === "audioinput" && isLikelyExternalMic(device.label)
    );
    if (external) return external.deviceId;
    return "default";
  }

  function isLikelyExternalMic(label) {
    const normalized = (label || "").toLowerCase();
    if (!normalized) return false;
    return !/(macbook|built-in|builtin|default|communications)/.test(normalized);
  }

  async function loadStoredMicSelection() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["mic_device_id", "mic_device_label"], (result) => {
        resolve({
          deviceId: result.mic_device_id || "default",
          deviceLabel: result.mic_device_label || "",
        });
      });
    });
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

  async function startIframeMic(deviceId, deviceLabel = "") {
    await stopIframeMic();
    try {
      if (!deviceLabel || deviceId === "default") {
        const stored = await loadStoredMicSelection();
        deviceId = deviceId && deviceId !== "default" ? deviceId : stored.deviceId;
        deviceLabel = deviceLabel || stored.deviceLabel;
      }
      setStatus(`Recording microphone for cauli${deviceLabel ? `: ${deviceLabel}` : " using the best available input"}...`);
      let resolvedDeviceId = await resolveDeviceId(deviceId, deviceLabel);
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micConstraints(resolvedDeviceId) === true ? {} : micConstraints(resolvedDeviceId)),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      startLevelMonitor(micStream);
      const track = micStream.getAudioTracks()[0];
      const settings = track?.getSettings?.() || {};
      const inputLabel = track?.label || "Unknown microphone";
      if (deviceLabel && inputLabel !== deviceLabel) {
        const labelDeviceId = await resolveDeviceId("default", deviceLabel);
        if (labelDeviceId !== "default" && labelDeviceId !== settings.deviceId) {
          micStream.getTracks().forEach((track) => track.stop());
          stopLevelMonitor();
          resolvedDeviceId = labelDeviceId;
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: resolvedDeviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            video: false,
          });
          startLevelMonitor(micStream);
        }
      }
      const finalTrack = micStream.getAudioTracks()[0];
      const finalSettings = finalTrack?.getSettings?.() || {};
      const finalInputLabel = finalTrack?.label || inputLabel;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mediaRecorder = new MediaRecorder(micStream, { mimeType });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) queueMicChunk(event.data, mimeType);
      };
      mediaRecorder.start(500);
      const startedAt = Date.now();
      setStatus(
        `Microphone recording is active: ${finalInputLabel}${deviceLabel ? ` (wanted ${deviceLabel})` : ""}. Keep this tab open until you stop recording.`,
        "ok"
      );

      await chrome.runtime.sendMessage({
        type: "MIC_IFRAME_STATUS",
        recording: true,
        success: true,
        mimeType,
        inputLabel: finalInputLabel,
        settings: finalSettings,
        requestedLabel: deviceLabel,
        startedAt,
      }).catch(() => {});
    } catch (err) {
      setStatus(`Microphone recorder failed: ${err.name}: ${err.message}<code>${settingsUrl()}</code>`, "error");
      await chrome.runtime.sendMessage({
        type: "MIC_IFRAME_STATUS",
        recording: false,
        success: false,
        error: `${err.name}: ${err.message}`,
      }).catch(() => {});
    }
  }

  function startLevelMonitor(stream) {
    stopLevelMonitor();
    levelContext = new AudioContext();
    const source = levelContext.createMediaStreamSource(stream);
    const analyser = levelContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (const sample of data) {
        const v = (sample - 128) / 128;
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      const rms = Math.sqrt(sum / data.length);
      chrome.runtime.sendMessage({
        type: "MIC_LEVEL",
        rms,
        peak,
      }).catch(() => {});
    }, 250);
  }

  function stopLevelMonitor() {
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    if (levelContext) {
      levelContext.close().catch(() => {});
      levelContext = null;
    }
  }

  async function stopIframeMic() {
    const recorder = mediaRecorder;
    const hadRecorder = !!recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }
    await Promise.allSettled([...pendingChunkSends]);
    stopLevelMonitor();
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    mediaRecorder = null;
    setStatus("Microphone recording stopped.", "ok");
    await chrome.runtime.sendMessage({
      type: "MIC_IFRAME_STATUS",
      recording: false,
      success: true,
    }).catch(() => {});
    if (hadRecorder && params.get("autoclose") === "1") {
      setTimeout(() => window.close(), 700);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.source !== "calllog-content") return;
    if (event.data.type === "START_MIC") startIframeMic(event.data.deviceId, event.data.deviceLabel);
    if (event.data.type === "STOP_MIC") stopIframeMic();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "STOP_EXTENSION_MIC") {
      stopIframeMic().then(() => sendResponse({ success: true }));
      return true;
    }
  });

  btn.addEventListener("click", requestMic);
  if (params.get("recorder") === "1") {
    btn.hidden = true;
    startIframeMic(params.get("deviceId") || "default", params.get("deviceLabel") || "");
  } else {
    if (params.get("embedded") !== "1") requestMic();
  }
})();
