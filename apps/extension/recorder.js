(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const statusEl = document.getElementById("status");
  const chunks = [];
  let mediaRecorder = null;
  let audioContext = null;
  let tabStream = null;
  let micStream = null;
  let stopped = false;

  function setStatus(text, kind) {
    statusEl.className = `status ${kind || ""}`.trim();
    statusEl.textContent = text;
  }

  function micConstraints(deviceId) {
    return deviceId && deviceId !== "default"
      ? { deviceId: { exact: deviceId } }
      : true;
  }

  function isLikelyExternalMic(label) {
    const normalized = (label || "").toLowerCase();
    if (!normalized) return false;
    return !/(macbook|built-in|builtin|default|communications)/.test(normalized);
  }

  async function resolveDeviceId(deviceId, deviceLabel) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (deviceLabel) {
      const exact = devices.find((d) => d.kind === "audioinput" && d.label === deviceLabel);
      if (exact) return exact.deviceId;
      const wanted = deviceLabel.toLowerCase();
      const partial = devices.find((d) =>
        d.kind === "audioinput" &&
        d.label &&
        (d.label.toLowerCase().includes(wanted) || wanted.includes(d.label.toLowerCase()))
      );
      if (partial) return partial.deviceId;
    }
    if (deviceId && deviceId !== "default") return deviceId;
    const external = devices.find((d) => d.kind === "audioinput" && isLikelyExternalMic(d.label));
    return external?.deviceId || "default";
  }

  async function getTabStream(streamId) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  }

  async function getMicStream(deviceId, deviceLabel) {
    const resolvedDeviceId = await resolveDeviceId(deviceId, deviceLabel);
    return navigator.mediaDevices.getUserMedia({
      audio: {
        ...(micConstraints(resolvedDeviceId) === true ? {} : micConstraints(resolvedDeviceId)),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  async function start() {
    try {
      const streamId = params.get("streamId");
      if (!streamId) throw new Error("Missing tab capture stream ID.");

      setStatus("Capturing tab audio and microphone...");
      tabStream = await getTabStream(streamId);
      micStream = await getMicStream(params.get("micDeviceId") || "default", params.get("micDeviceLabel") || "");

      const micLabel = micStream.getAudioTracks()[0]?.label || "microphone";
      audioContext = new AudioContext();
      await audioContext.resume();
      const dest = audioContext.createMediaStreamDestination();

      const tabSource = audioContext.createMediaStreamSource(tabStream);
      const tabGain = audioContext.createGain();
      tabGain.gain.value = 0.75;
      tabSource.connect(tabGain);
      tabGain.connect(dest);

      const micSource = audioContext.createMediaStreamSource(micStream);
      const micGain = audioContext.createGain();
      micGain.gain.value = 0.9;
      micSource.connect(micGain);
      micGain.connect(dest);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorder.onstop = finish;
      mediaRecorder.start(1000);

      chrome.runtime.sendMessage({
        type: "SYNC_RECORDER_STATUS",
        recording: true,
        success: true,
        micLabel,
        mimeType,
      }).catch(() => {});
      setStatus(`Recording tab audio + ${micLabel}`);
    } catch (err) {
      setStatus(err.message, "error");
      chrome.runtime.sendMessage({
        type: "SYNC_RECORDER_STATUS",
        recording: false,
        success: false,
        error: err.message,
      }).catch(() => {});
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      return;
    }
    await finish();
  }

  async function finish() {
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    const buffer = await blob.arrayBuffer();
    chrome.runtime.sendMessage({
      type: "SYNC_RECORDING_COMPLETE",
      chunk: Array.from(new Uint8Array(buffer)),
      mimeType: blob.type || "audio/webm",
    }).catch(() => {});

    cleanup();
    setStatus("Recording stopped.");
    setTimeout(() => window.close(), 700);
  }

  function cleanup() {
    tabStream?.getTracks().forEach((track) => track.stop());
    micStream?.getTracks().forEach((track) => track.stop());
    audioContext?.close().catch(() => {});
    tabStream = null;
    micStream = null;
    audioContext = null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "STOP_SYNC_RECORDING") {
      stop().then(() => sendResponse({ success: true }));
      return true;
    }
  });

  start();
})();
