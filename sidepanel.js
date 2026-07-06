// sidepanel.js — CallLog v2
// MP3/WAV export, Groq Whisper transcription, API key settings

(function () {
  "use strict";
  const APP_VERSION = "1.1.8";
  const AUDIO_DECODE_TIMEOUT_MS = 30000;
  const TRANSCRIPTION_TIMEOUT_MS = 120000;
  const AUDIO_DB_NAME = "calllog-audio";
  const AUDIO_DB_VERSION = 1;
  const AUDIO_STORE = "recording_blobs";

  // ─── State ──────────────────────────────────────────────────────────────────
  let state = {
    view: "recorder",        // 'recorder' | 'log' | 'settings'
    recordingState: "idle",  // 'idle' | 'recording'
    sourceMode: "both",      // 'mic' | 'tab' | 'both'
    exportFormat: "mp3",     // 'mp3' | 'wav'
    recordings: [],
    timer: 0,
    timerInterval: null,
    error: null,
    groqApiKey: "",
    editingGroqKey: false,
    transcribingId: null,    // id of recording currently being transcribed
    micPermission: "unknown", // 'unknown' | 'prompt' | 'granted' | 'denied' | 'os-blocked'
    micDeviceId: "default",
    micDeviceLabel: "",
    micDevices: [],          // [{deviceId, label}]
    micInputLabel: "",
    micRequestedLabel: "",
    micLevel: 0,
    tabArmed: false,
    armedTabLabel: "",
  };

  // ─── Recording internals ────────────────────────────────────────────────────
  let mediaRecorder = null;
  let audioChunks = [];
  let micStream = null;
  let tabStream = null;
  let audioContext = null;
  let audioSources = [];
  let analyser = null;
  let animationFrameId = null;
  let micChunks = [];       // raw chunks from offscreen mic
  let usingPageMic = false;
  let stopInProgress = false;
  let lastMicChunkTime = 0; // track mic activity for mic-only visualizer
  let micStatusWaiters = [];
  let syncStatusWaiters = [];
  let usingSyncRecorder = false;
  let syncRecordingBlob = null;
  let micStartedAt = null;
  let tabStartedAt = null;
  let armedTabStream = null;

  // ─── Audio conversion (lamejs MP3 + manual WAV, no WASM needed) ──────────────
  async function decodeWebm(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const tempCtx = new AudioContext();
    try {
      return await tempCtx.decodeAudioData(arrayBuffer);
    } finally {
      tempCtx.close();
    }
  }

  function withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
  }

  function audioBufferHasSignal(audioBuffer) {
    const threshold = 0.0005;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i += 32) {
        if (Math.abs(data[i]) >= threshold) return true;
      }
    }
    return false;
  }

  // ─── Durable audio storage ───────────────────────────────────────────────────
  function audioKey(id, kind) {
    return `${id}:${kind}`;
  }

  function openAudioDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Unable to open recording storage"));
    });
  }

  async function requestDurableStorage() {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (_) {
      // Best effort. IndexedDB still works if persistence is not granted.
    }
  }

  async function writeAudioBlob(id, kind, blob, meta = {}) {
    if (!blob || blob.size === 0) throw new Error("No audio blob to save");
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readwrite");
      tx.objectStore(AUDIO_STORE).put({
        key: audioKey(id, kind),
        id,
        kind,
        type: blob.type || "",
        size: blob.size,
        savedAt: Date.now(),
        ...meta,
        blob,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("Unable to save recording audio")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Recording audio save was aborted")); };
    });
  }

  async function readAudioBlob(id, kind) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readonly");
      const req = tx.objectStore(AUDIO_STORE).get(audioKey(id, kind));
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error || new Error("Unable to read saved recording audio"));
      tx.oncomplete = () => db.close();
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Recording audio read was aborted")); };
    });
  }

  async function listAudioRecords() {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readonly");
      const req = tx.objectStore(AUDIO_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).map(({ blob, ...record }) => record));
      req.onerror = () => reject(req.error || new Error("Unable to list saved recording audio"));
      tx.oncomplete = () => db.close();
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Recording audio list was aborted")); };
    });
  }

  async function deleteAudioBlobs(id) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readwrite");
      const store = tx.objectStore(AUDIO_STORE);
      store.delete(audioKey(id, "source"));
      store.delete(audioKey(id, "converted"));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("Unable to delete saved recording audio")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Recording audio delete was aborted")); };
    });
  }

  async function convertAudio(webmBlob, format) {
    const audioBuffer = await decodeWebm(webmBlob);
    if (!audioBufferHasSignal(audioBuffer)) {
      throw new Error("recording is silent; no microphone or tab samples were captured");
    }
    if (format === "wav") return encodeWav(audioBuffer);
    return encodeMp3(audioBuffer);
  }

  async function mergeAndConvert(tabBlob, micBlob, format, offsets = {}) {
    const [bufA, bufB] = await Promise.all([decodeWebm(tabBlob), decodeWebm(micBlob)]);
    const sampleRate = Math.max(bufA.sampleRate, bufB.sampleRate);
    const tabOffsetFrames = Math.max(0, Math.round((offsets.tabOffsetMs || 0) * sampleRate / 1000));
    const micOffsetFrames = Math.max(0, Math.round((offsets.micOffsetMs || 0) * sampleRate / 1000));
    const length = Math.max(bufA.length + tabOffsetFrames, bufB.length + micOffsetFrames);
    const numChannels = 2;
    const ctx = new OfflineAudioContext(numChannels, length, sampleRate);

    const tabGain = ctx.createGain();
    tabGain.gain.value = 0.72;
    tabGain.connect(ctx.destination);

    const micGain = ctx.createGain();
    micGain.gain.value = 0.85;
    micGain.connect(ctx.destination);

    const srcA = ctx.createBufferSource();
    srcA.buffer = bufA;
    srcA.connect(tabGain);
    srcA.start(tabOffsetFrames / sampleRate);

    const srcB = ctx.createBufferSource();
    srcB.buffer = bufB;
    srcB.connect(micGain);
    srcB.start(micOffsetFrames / sampleRate);

    const mixed = normalizeAudioBuffer(await ctx.startRendering(), 0.92);
    if (!audioBufferHasSignal(mixed)) {
      throw new Error("recording is silent; no microphone or tab samples were captured");
    }
    if (format === "wav") return encodeWav(mixed);
    return encodeMp3(mixed);
  }

  function normalizeAudioBuffer(audioBuffer, targetPeak) {
    let peak = 0;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    if (!peak || peak <= targetPeak) return audioBuffer;

    const ctx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const out = ctx.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const gain = targetPeak / peak;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const input = audioBuffer.getChannelData(ch);
      const output = out.getChannelData(ch);
      for (let i = 0; i < input.length; i++) output[i] = input[i] * gain;
    }
    return out;
  }

  function mergeOffsets(tabStart, micStart) {
    if (!tabStart || !micStart) return { tabOffsetMs: 0, micOffsetMs: 0 };
    return {
      tabOffsetMs: Math.max(0, micStart - tabStart),
      micOffsetMs: Math.max(0, tabStart - micStart),
    };
  }

  function encodeWav(audioBuffer) {
    const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numChannels * 2;
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);
    const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    write(0, "RIFF"); view.setUint32(4, 36 + length, true);
    write(8, "WAVE"); write(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, length, true);
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function encodeMp3(audioBuffer) {
    const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
    const sampleRate = audioBuffer.sampleRate;
    const mp3enc = new lamejs.Mp3Encoder(numChannels, sampleRate, 192);
    const blockSize = 1152;
    const left = audioBuffer.getChannelData(0);
    const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;
    const toInt16 = (f32) => { const buf = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) buf[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768)); return buf; };
    const leftInt = toInt16(left);
    const rightInt = toInt16(right);
    const mp3Data = [];
    for (let i = 0; i < leftInt.length; i += blockSize) {
      const chunk = mp3enc.encodeBuffer(leftInt.subarray(i, i + blockSize), rightInt.subarray(i, i + blockSize));
      if (chunk.length > 0) mp3Data.push(new Uint8Array(chunk));
    }
    const end = mp3enc.flush();
    if (end.length > 0) mp3Data.push(new Uint8Array(end));
    return new Blob(mp3Data, { type: "audio/mpeg" });
  }

  // ─── Storage ─────────────────────────────────────────────────────────────────
  function saveRecordings(recs) {
    const meta = recs.map((r) => ({
      id: r.id,
      date: r.date,
      duration: r.duration,
      source: r.source,
      transcript: r.transcript || "",
      transcriptStatus: r.transcriptStatus || "none", // 'pending'|'transcribing'|'done'|'error'|'none'
      size: r.size || 0,
      sourceSize: r.sourceSize || r.size || 0,
      sourceMimeType: r.sourceMimeType || "",
      sourceSaved: !!r.sourceSaved,
      sourceSaveError: r.sourceSaveError || "",
      convertedSaved: !!r.convertedSaved,
      convertedMimeType: r.convertedMimeType || "",
      convertedSaveError: r.convertedSaveError || "",
      convertError: r.convertError || "",
      exportFormat: r.exportFormat || "webm",
    }));
    chrome.storage.local.set({ recordings_meta: meta });
  }

  function loadRecordings() {
    return new Promise((res) => {
      chrome.storage.local.get(["recordings_meta", "groq_api_key", "export_format", "source_mode", "mic_device_id", "mic_device_label", "mic_permission_prompted"], (result) => {
        res(result);
      });
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      groq_api_key: state.groqApiKey,
      export_format: state.exportFormat,
      source_mode: state.sourceMode,
      mic_device_id: state.micDeviceId,
      mic_device_label: state.micDeviceLabel,
    });
  }

  async function loadMicDevices() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_MIC_DEVICES" });
      if (!res?.success) throw new Error(res?.error || "Unable to enumerate microphones");
      setMicDevices(res.devices || []);
    } catch (err) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(devices.filter((d) => d.kind === "audioinput"));
      } catch (_) {
        state.micDevices = [];
      }
    }
  }

  function setMicDevices(devices) {
    state.micDevices = devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${d.deviceId ? `(${d.deviceId.slice(0, 8)})` : ""}`.trim(),
    }));

    if (state.micDeviceId === "default") {
      const external = state.micDevices.find((d) => isLikelyExternalMic(d.label));
      if (external) {
        state.micDeviceId = external.deviceId;
        state.micDeviceLabel = external.label;
        saveSettings();
      }
    }

    if (!state.micDeviceLabel && state.micDeviceId !== "default") {
      const selected = state.micDevices.find((d) => d.deviceId === state.micDeviceId);
      if (selected?.label) {
        state.micDeviceLabel = selected.label;
        saveSettings();
      }
    }

    if (state.micDeviceId !== "default") {
      const selected = state.micDevices.find((d) => d.deviceId === state.micDeviceId);
      if (selected?.label && selected.label !== state.micDeviceLabel) {
        state.micDeviceLabel = selected.label;
        saveSettings();
      }
    }

    if (
      state.micDeviceId !== "default" &&
      state.micDevices.length > 0 &&
      !state.micDevices.some((d) => d.deviceId === state.micDeviceId)
    ) {
      const labelMatch = state.micDeviceLabel
        ? state.micDevices.find((d) => d.label === state.micDeviceLabel)
        : null;
      if (labelMatch) {
        state.micDeviceId = labelMatch.deviceId;
        saveSettings();
      } else {
        state.micDeviceId = "default";
        saveSettings();
      }
    }
  }

  function isLikelyExternalMic(label) {
    const normalized = (label || "").toLowerCase();
    if (!normalized) return false;
    return !/(macbook|built-in|builtin|default|communications)/.test(normalized);
  }

  function selectedMicLabel() {
    if (state.micDeviceLabel) return state.micDeviceLabel;
    if (state.micDeviceId === "default") return "";
    return state.micDevices.find((d) => d.deviceId === state.micDeviceId)?.label || "";
  }

  async function prepareMicSelectionForRecording() {
    await loadMicDevices();
    if (state.micDeviceId !== "default" && selectedMicLabel()) return;

    const external = state.micDevices.find((d) => isLikelyExternalMic(d.label));
    if (external) {
      state.micDeviceId = external.deviceId;
      state.micDeviceLabel = external.label;
      saveSettings();
    }
  }

  // ─── Groq Whisper transcription ──────────────────────────────────────────────
  async function transcribeWithGroq(blob, recId) {
    if (!state.groqApiKey) {
      updateTranscript(recId, "(no API key — add one in Settings)", "error");
      render();
      return;
    }
    if (!blob || blob.size < 1000) {
      updateTranscript(recId, `Audio too small to transcribe (${blob?.size ?? 0} bytes) — recording may be empty`, "error");
      render();
      return;
    }

    state.transcribingId = recId;
    updateTranscript(recId, "", "transcribing");
    render();

    try {
      const decoded = await withTimeout(
        decodeWebm(blob),
        AUDIO_DECODE_TIMEOUT_MS,
        "Audio decode timed out before transcription could start"
      );
      if (!audioBufferHasSignal(decoded)) {
        updateTranscript(recId, "Recording is silent; no audio was sent to Groq.", "error");
        return;
      }

      const ext = audioExtension(blob);
      const file = new File([blob], `recording.${ext}`, { type: blob.type || `audio/${ext}` });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("model", "whisper-large-v3-turbo");
      formData.append("response_format", "verbose_json");
      formData.append("language", "en");
      formData.append("prompt", "Transcribe exactly what is said.");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
      let res;
      try {
        res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${state.groqApiKey}` },
          body: formData,
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error("Transcription timed out after 120 seconds");
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      const transcript = data.text?.trim() || "(empty transcript)";
      updateTranscript(recId, transcript, "done");
    } catch (err) {
      updateTranscript(recId, `Transcription error: ${err.message}`, "error");
    } finally {
      state.transcribingId = null;
      render();
    }
  }

  function audioExtension(blob) {
    if (blob?.type?.includes("mpeg")) return "mp3";
    if (blob?.type?.includes("wav")) return "wav";
    if (blob?.type?.includes("ogg")) return "ogg";
    return "webm";
  }

  function updateTranscript(id, text, status) {
    state.recordings = state.recordings.map((r) =>
      r.id === id ? { ...r, transcript: text, transcriptStatus: status } : r
    );
    saveRecordings(state.recordings);
  }

  function restoreRecordingMeta(records) {
    let changed = false;
    const restored = (records || []).map((r) => {
      if (r.transcriptStatus === "transcribing" || r.transcriptStatus === "pending") {
        changed = true;
        if (r.sourceSaved || r.convertedSaved) {
          return {
            ...r,
            transcript: "",
            transcriptStatus: "pending",
          };
        }
        return {
          ...r,
          transcript: "Transcription was interrupted before completion. Recordings cannot resume transcription after the side panel reloads.",
          transcriptStatus: "error",
        };
      }
      return r;
    });
    return { recordings: restored, changed };
  }

  function mergeAudioStorageMeta(records, audioRecords) {
    let changed = false;
    const byKey = new Map((audioRecords || []).map((r) => [r.key, r]));
    const seenIds = new Set((records || []).map((r) => r.id));
    const merged = (records || []).map((r) => {
      const sourceRecord = byKey.get(audioKey(r.id, "source"));
      const convertedRecord = byKey.get(audioKey(r.id, "converted"));
      if (!sourceRecord && !convertedRecord) {
        if (r.sourceSaved || r.convertedSaved) {
          changed = true;
          return {
            ...r,
            sourceSaved: false,
            convertedSaved: false,
            convertedMimeType: "",
          };
        }
        return r;
      }
      changed = changed ||
        r.sourceSaved !== !!sourceRecord ||
        r.convertedSaved !== !!convertedRecord ||
        (!!sourceRecord && !r.sourceMimeType) ||
        (!!convertedRecord && !r.convertedMimeType);
      return {
        ...r,
        sourceSaved: !!sourceRecord,
        sourceSize: r.sourceSize || sourceRecord?.size || r.size || 0,
        sourceMimeType: r.sourceMimeType || sourceRecord?.type || "",
        convertedSaved: !!convertedRecord,
        convertedMimeType: r.convertedMimeType || convertedRecord?.type || "",
      };
    });

    for (const sourceRecord of (audioRecords || []).filter((r) => r.kind === "source" && !seenIds.has(r.id))) {
      changed = true;
      merged.push({
        id: sourceRecord.id,
        date: sourceRecord.date || new Date(sourceRecord.savedAt || Number(sourceRecord.id) || Date.now()).toISOString(),
        duration: sourceRecord.duration || 0,
        source: sourceRecord.source || "unknown",
        transcript: "",
        transcriptStatus: "none",
        size: sourceRecord.size || 0,
        sourceSize: sourceRecord.size || 0,
        sourceMimeType: sourceRecord.type || "audio/webm",
        sourceSaved: true,
        sourceSaveError: "",
        convertedSaved: !!byKey.get(audioKey(sourceRecord.id, "converted")),
        convertedMimeType: byKey.get(audioKey(sourceRecord.id, "converted"))?.type || "",
        convertedSaveError: "",
        convertError: "",
        exportFormat: sourceRecord.exportFormat || "webm",
      });
    }

    merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { recordings: merged, changed };
  }

  async function resumePendingTranscriptions() {
    for (const rec of state.recordings.filter((r) => r.transcriptStatus === "pending")) {
      try {
        const blob = rec.convertedSaved
          ? await readAudioBlob(rec.id, "converted")
          : await readAudioBlob(rec.id, "source");
        if (!blob) {
          updateTranscript(rec.id, "Transcription could not resume because saved audio was not found.", "error");
          render();
          continue;
        }
        await transcribeWithGroq(blob, rec.id);
      } catch (err) {
        updateTranscript(rec.id, `Transcription resume error: ${err.message}`, "error");
        render();
      }
    }
  }

  async function savedBlobForTranscription(rec, blobs = {}) {
    if (rec.convertedSaved) {
      return blobs.convertedBlob || await readAudioBlob(rec.id, "converted");
    }
    if (rec.sourceSaved) {
      return blobs.sourceBlob || await readAudioBlob(rec.id, "source");
    }
    return null;
  }

  // Listen for audio chunks from offscreen mic via background relay
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "MIC_CHUNK" && (state.recordingState === "recording" || stopInProgress)) {
      micChunks.push({ data: msg.chunk, mimeType: msg.mimeType });
      lastMicChunkTime = Date.now();
    }
    if (msg.type === "MIC_PERMISSION_CHANGED") {
      if (msg.granted) {
        state.micPermission = "granted";
        state.error = null;
        if (msg.devices) setMicDevices(msg.devices);
        loadMicDevices().then(() => render());
      } else {
        state.micPermission = "os-blocked";
        state.error = msg.error || "Microphone access was not granted";
        render();
      }
    }
    if (msg.type === "MIC_IFRAME_STATUS_CHANGED") {
      micStatusWaiters = micStatusWaiters.filter((waiter) => {
        if (!waiter.match(msg)) return true;
        clearTimeout(waiter.timeoutId);
        waiter.resolve(msg);
        return false;
      });
      if (msg.success === false) {
        state.error = msg.error || "Microphone iframe recorder failed";
        render();
      } else if (msg.recording && msg.inputLabel) {
        state.micInputLabel = msg.inputLabel;
        state.micRequestedLabel = msg.requestedLabel || state.micDeviceLabel || "";
        micStartedAt = msg.startedAt || Date.now();
        render();
      }
    }
    if (msg.type === "MIC_LEVEL") {
      state.micLevel = msg.rms || 0;
      const levelEl = document.getElementById("mic-level-value");
      if (levelEl) levelEl.textContent = formatMicLevel(state.micLevel);
      const meterEl = document.getElementById("mic-level-meter");
      if (meterEl) meterEl.style.width = `${Math.min(100, Math.round(state.micLevel * 400))}%`;
    }
    if (msg.type === "SYNC_RECORDER_STATUS_CHANGED") {
      syncStatusWaiters = syncStatusWaiters.filter((waiter) => {
        if (!waiter.match(msg)) return true;
        clearTimeout(waiter.timeoutId);
        waiter.resolve(msg);
        return false;
      });
      if (msg.success === false) {
        state.error = msg.error || "Synchronized recorder failed";
        render();
      } else if (msg.recording) {
        state.micInputLabel = msg.micLabel || "";
        state.micLevel = 0.01;
        render();
      }
    }
    if (msg.type === "SYNC_RECORDING_COMPLETE") {
      const mimeType = msg.mimeType || "audio/webm";
      syncRecordingBlob = new Blob([new Uint8Array(msg.chunk)], { type: mimeType });
      syncStatusWaiters = syncStatusWaiters.filter((waiter) => {
        if (!waiter.match({ type: "SYNC_RECORDING_COMPLETE" })) return true;
        clearTimeout(waiter.timeoutId);
        waiter.resolve({ success: true, blob: syncRecordingBlob });
        return false;
      });
    }
  });

  // ─── Recording logic ─────────────────────────────────────────────────────────
  function waitForMicStatus(match, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        micStatusWaiters = micStatusWaiters.filter((waiter) => waiter.timeoutId !== timeoutId);
        resolve(null);
      }, timeoutMs);
      micStatusWaiters.push({ match, resolve, timeoutId });
    });
  }

  function waitForSyncStatus(match, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        syncStatusWaiters = syncStatusWaiters.filter((waiter) => waiter.timeoutId !== timeoutId);
        resolve(null);
      }, timeoutMs);
      syncStatusWaiters.push({ match, resolve, timeoutId });
    });
  }

  function selectedMicConstraints() {
    return (state.micDeviceId && state.micDeviceId !== "default")
      ? { deviceId: { exact: state.micDeviceId } }
      : true;
  }

  function selectedMicAudioConstraints() {
    const selected = selectedMicConstraints();
    const processing = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    return selected === true ? processing : { ...selected, ...processing };
  }

  async function getSelectedMicStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: selectedMicAudioConstraints(),
        video: false,
      });
    } catch (err) {
      if (
        state.micDeviceId !== "default" &&
        /OverconstrainedError|NotFoundError/.test(`${err.name}: ${err.message}`)
      ) {
        state.micDeviceId = "default";
        saveSettings();
        state.error = "Selected microphone was unavailable, so the default microphone is being used.";
        return navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }, video: false });
      }
      throw err;
    }
  }

  function clearArmedTab({ stop = true } = {}) {
    if (stop && armedTabStream) {
      armedTabStream.getTracks().forEach((track) => track.stop());
    }
    armedTabStream = null;
    state.tabArmed = false;
    state.armedTabLabel = "";
  }

  function markArmedTabEnded() {
    if (!armedTabStream) return;
    armedTabStream = null;
    state.tabArmed = false;
    state.armedTabLabel = "";
    if (state.recordingState !== "recording") {
      state.error = "Tab share ended. Set the dialer tab again before recording.";
      render();
    }
  }

  function liveArmedTabStream() {
    const audioTrack = armedTabStream?.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState === "ended") {
      clearArmedTab({ stop: false });
      return null;
    }
    return new MediaStream([audioTrack]);
  }

  function siteNameFromUrl(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./i, "");
      const parts = host.split(".").filter(Boolean);
      if (parts.length === 0) return "";
      let name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
      if (name.length <= 2 && parts.length > 2) name = parts[parts.length - 3];
      return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
    } catch (_) {
      return "";
    }
  }

  function siteNameFromText(text) {
    const match = `${text || ""}`.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.(?:com|net|org|io|ai|app|co|us|ca|dev|sales|cloud)\b/i);
    if (!match?.[1]) return "";
    return match[1].charAt(0).toUpperCase() + match[1].slice(1);
  }

  function cleanTabLabel(rawLabel, fallbackLabel = "") {
    const raw = `${rawLabel || ""}`.trim();
    if (!raw || raw.startsWith("web-contents-media-stream://")) return fallbackLabel || "selected tab";
    return siteNameFromUrl(raw) || siteNameFromText(raw) || fallbackLabel || "selected tab";
  }

  function getActiveTabSiteLabel() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (chrome.runtime.lastError) {
          resolve("");
          return;
        }
        resolve(siteNameFromUrl(tab?.url || "") || siteNameFromText(tab?.title || ""));
      });
    });
  }

  async function requestTabAudioStream() {
    const activeTabLabel = await getActiveTabSiteLabel();
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (e) {
      throw new Error("Tab audio: " + e.message + " — select the dialer tab and click Share.");
    }

    const tabAudioTracks = displayStream.getAudioTracks();
    if (tabAudioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error("No tab audio captured. Select the dialer tab and make sure 'Share tab audio' is checked.");
    }

    const rawTabLabel = displayStream.getVideoTracks()[0]?.label || tabAudioTracks[0]?.label || "";
    const tabLabel = cleanTabLabel(rawTabLabel, activeTabLabel);
    displayStream.getVideoTracks().forEach((track) => track.stop());
    tabAudioTracks.forEach((track) => track.addEventListener("ended", markArmedTabEnded, { once: true }));
    return { stream: new MediaStream(tabAudioTracks), label: tabLabel };
  }

  async function armTabForRecording() {
    state.error = null;
    try {
      clearArmedTab();
      const { stream, label } = await requestTabAudioStream();
      armedTabStream = stream;
      state.tabArmed = true;
      state.armedTabLabel = label;
      render();
    } catch (err) {
      state.error = err.message;
      clearArmedTab({ stop: false });
      render();
    }
  }

  function cancelArmedTab() {
    clearArmedTab();
    render();
  }

  async function getTabAudioStreamForRecording() {
    const armed = liveArmedTabStream();
    if (armed) {
      tabStream = armed;
      armedTabStream = null;
      state.tabArmed = false;
      return tabStream;
    }

    const { stream, label } = await requestTabAudioStream();
    tabStream = stream;
    state.armedTabLabel = label;
    return tabStream;
  }

  function addRecorderStopHandler(recorder) {
    recorder.addEventListener("stop", () => {
      if (stopInProgress) return;
      clearInterval(state.timerInterval);
      state.recordingState = "idle";
      onRecordingStop().catch((err) => {
        state.error = err.message;
        cleanup({ stopMic: false });
        render();
      });
    }, { once: true });
  }

  async function startLocalBothRecording() {
    const requestedMicLabel = selectedMicLabel();
    state.micRequestedLabel = requestedMicLabel;

    await getTabAudioStreamForRecording();
    micStream = await getSelectedMicStream();

    const micTrack = micStream.getAudioTracks()[0];
    state.micInputLabel = micTrack?.label || requestedMicLabel || "Selected microphone";
    state.micPermission = "granted";
    tabStartedAt = Date.now();
    micStartedAt = tabStartedAt;

    audioContext = new AudioContext();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;

    const dest = audioContext.createMediaStreamDestination();
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    const tabGain = audioContext.createGain();
    const micGain = audioContext.createGain();
    tabGain.gain.value = 0.75;
    micGain.gain.value = 0.9;

    audioSources.push(tabSource, micSource, tabGain, micGain);
    tabSource.connect(tabGain);
    micSource.connect(micGain);
    tabGain.connect(dest);
    micGain.connect(dest);
    tabGain.connect(analyser);
    micGain.connect(analyser);

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    addRecorderStopHandler(mediaRecorder);
    mediaRecorder.start(1000);
  }

  async function startRecording() {
    state.error = null;
    audioChunks = [];
    micChunks = [];
    usingPageMic = false;
    usingSyncRecorder = false;
    syncRecordingBlob = null;
    stopInProgress = false;
    lastMicChunkTime = 0;
    micStartedAt = null;
    tabStartedAt = null;
    state.micLevel = 0;

    try {
      if (state.sourceMode === "both") {
        await startLocalBothRecording();
        state.recordingState = "recording";
        state.timer = 0;
        state.timerInterval = setInterval(() => { state.timer++; renderTimer(); }, 1000);
        render();
        return;
      }

      // Get tab stream ID first if needed (before any async gaps that might lose gesture context)
      let tabStreamId = null;
      if (state.sourceMode === "tab" || state.sourceMode === "both") {
        await getTabAudioStreamForRecording();
        tabStreamId = "display"; // flag that we used getDisplayMedia
      }

      if (state.sourceMode === "mic" || state.sourceMode === "both") {
        await prepareMicSelectionForRecording();
        const requestedMicLabel = selectedMicLabel();
        state.micRequestedLabel = requestedMicLabel;
        const micRes = await chrome.runtime.sendMessage({
          type: "START_PAGE_MIC",
          deviceId: state.micDeviceId,
          deviceLabel: requestedMicLabel,
        });
        if (!micRes?.success) {
          state.micPermission = "os-blocked";
          state.error = micRes?.error || "Microphone iframe recorder failed to start";
          cleanup();
          render();
          return;
        }
        const micStatus = await waitForMicStatus((msg) => msg.recording === true || msg.success === false);
        if (!micStatus?.success) {
          state.micPermission = "os-blocked";
          state.error = micStatus?.error || "Microphone iframe recorder did not start";
          cleanup();
          render();
          return;
        }
        usingPageMic = true;
        state.micPermission = "granted";
      }

      audioContext = new AudioContext();
      await audioContext.resume();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;

      let recordingStream = null;
      if (state.sourceMode === "both") {
        const dest = audioContext.createMediaStreamDestination();
        if (tabStream) {
          const tabSource = audioContext.createMediaStreamSource(tabStream);
          audioSources.push(tabSource);
          tabSource.connect(dest);
          tabSource.connect(analyser);
        }
        recordingStream = dest.stream;
      } else if (state.sourceMode === "mic") {
        recordingStream = null;
      } else {
        recordingStream = tabStream;
        const tabSource = audioContext.createMediaStreamSource(tabStream);
        audioSources.push(tabSource);
        tabSource.connect(analyser);
      }

      if (audioContext.state === "suspended") await audioContext.resume();
      if (state.sourceMode !== "mic" && (!recordingStream || recordingStream.getAudioTracks().length === 0)) {
        throw new Error("No active audio track available to record.");
      }

      if (recordingStream) {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus" : "audio/webm";
        mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        addRecorderStopHandler(mediaRecorder);
        mediaRecorder.start(1000);
        tabStartedAt = Date.now();
      }

      state.recordingState = "recording";
      state.timer = 0;
      state.timerInterval = setInterval(() => { state.timer++; renderTimer(); }, 1000);
      render();
    } catch (err) {
      state.error = err.message;
      state.recordingState = "idle";
      cleanup();
      render();
    }
  }

  async function stopRecording() {
    if (stopInProgress) return;
    stopInProgress = true;
    clearInterval(state.timerInterval);
    state.recordingState = "idle";
    render();

    try {
      if (usingSyncRecorder) {
        await chrome.runtime.sendMessage({ type: "STOP_SYNC_RECORDING" }).catch((e) => ({ success: false, error: e.message }));
        const done = await waitForSyncStatus((msg) => msg.type === "SYNC_RECORDING_COMPLETE", 10000);
        if (!done?.blob && !syncRecordingBlob) throw new Error("Synchronized recorder did not return audio.");
        await onRecordingStop(done?.blob || syncRecordingBlob);
        return;
      }

      const recorder = mediaRecorder;
      const stopMicPromise = usingPageMic
        ? chrome.runtime.sendMessage({ type: "STOP_PAGE_MIC" })
          .then(() => waitForMicStatus((msg) => msg.recording === false, 3000))
          .catch((e) => ({ success: false, error: e.message }))
        : Promise.resolve({ success: true });
      const stopRecorderPromise = recorder && recorder.state !== "inactive"
        ? new Promise((resolve) => {
          recorder.addEventListener("stop", resolve, { once: true });
          recorder.stop();
        })
        : Promise.resolve();

      await Promise.all([stopRecorderPromise, stopMicPromise]);
      await onRecordingStop();
    } catch (err) {
      state.error = err.message;
      cleanup({ stopMic: false });
      render();
    } finally {
      stopInProgress = false;
    }
  }

  async function onRecordingStop(prebuiltBlob = null) {
    // Build the primary audio blob
    let webmBlob;

    let micBlobForMerge = null;
    if (prebuiltBlob) {
      webmBlob = prebuiltBlob;
    } else if (micChunks.length > 0) {
      const mimeType = micChunks[0]?.mimeType || "audio/webm";
      micBlobForMerge = new Blob(micChunks.map((c) => new Uint8Array(c.data)), { type: mimeType });
    }

    if (prebuiltBlob) {
      // already set
    } else if (audioChunks.length > 0) {
      webmBlob = new Blob(audioChunks, { type: "audio/webm" });
    } else if (micBlobForMerge) {
      webmBlob = micBlobForMerge;
    } else {
      state.error = "No audio recorded — nothing to save.";
      cleanup({ stopMic: false });
      render();
      return;
    }
    const duration = state.timer;
    const format = state.exportFormat;
    const recId = Date.now();
    const recDate = new Date().toISOString();
    let sourceSaved = false;
    let sourceSaveError = null;

    try {
      await writeAudioBlob(recId, "source", webmBlob, {
        date: recDate,
        duration,
        source: state.sourceMode,
        exportFormat: format,
      });
      sourceSaved = true;
    } catch (err) {
      sourceSaveError = `Recording is only in memory; save failed: ${err.message}`;
      state.error = sourceSaveError;
    }

    const rec = {
      id: recId,
      date: recDate,
      duration,
      source: state.sourceMode,
      transcript: sourceSaved ? "" : "Recording was not transcribed because audio could not be saved first.",
      transcriptStatus: sourceSaved ? "pending" : "error",
      size: webmBlob.size,
      sourceSize: webmBlob.size,
      sourceMimeType: webmBlob.type || "audio/webm",
      sourceSaved,
      sourceSaveError,
      convertedSaved: false,
      convertedMimeType: "",
      exportFormat: format,
      webmBlob,
      _micBlobForMerge: null,
      _mergeOffsets: mergeOffsets(tabStartedAt, micStartedAt),
      convertedBlob: null,
      convertedUrl: null,
    };

    state.recordings = [rec, ...state.recordings];
    saveRecordings(state.recordings);
    cleanup({ stopMic: false });
    render();

    convertAndCache(rec.id, webmBlob, format).then((convertedBlob) => {
      const savedRec = state.recordings.find((r) => r.id === rec.id);
      if (!savedRec) return;
      savedBlobForTranscription(savedRec, { convertedBlob, sourceBlob: webmBlob })
        .then((savedBlob) => {
          if (!savedBlob) {
            updateTranscript(rec.id, "Recording was not transcribed because audio could not be saved first.", "error");
            render();
            return;
          }
          transcribeWithGroq(savedBlob, rec.id);
        })
        .catch((err) => {
          updateTranscript(rec.id, `Saved audio could not be opened for transcription: ${err.message}`, "error");
          render();
        });
    });
  }

  async function convertAndCache(id, webmBlob, format) {
    try {
      const rec = state.recordings.find((r) => r.id === id);
      const outputBlob = rec?._micBlobForMerge
        ? await mergeAndConvert(webmBlob, rec._micBlobForMerge, format, rec._mergeOffsets)
        : await convertAudio(webmBlob, format);
      let convertedSaved = false;
      let convertedSaveError = null;
      try {
        await writeAudioBlob(id, "converted", outputBlob);
        convertedSaved = true;
      } catch (err) {
        convertedSaveError = `${format.toUpperCase()} export is only in memory; save failed: ${err.message}`;
      }
      const url = URL.createObjectURL(outputBlob);
      state.recordings = state.recordings.map((r) =>
        r.id === id ? {
          ...r,
          convertedBlob: outputBlob,
          convertedUrl: url,
          size: outputBlob.size,
          convertedSaved,
          convertedMimeType: outputBlob.type || "",
          convertedSaveError,
        } : r
      );
      saveRecordings(state.recordings);
      render();
      return outputBlob;
    } catch (err) {
      state.recordings = state.recordings.map((r) =>
        r.id === id ? { ...r, convertedUrl: null, convertedBlob: null, convertError: `${format.toUpperCase()} export failed: ${err.message}` } : r
      );
      saveRecordings(state.recordings);
      render();
      return null;
    }
  }

  function cleanup({ stopMic = true } = {}) {
    stopWaveformAnimation();
    if (usingPageMic) {
      if (stopMic) chrome.runtime.sendMessage({ type: "STOP_PAGE_MIC" }).catch(() => {});
      usingPageMic = false;
    }
    usingSyncRecorder = false;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (tabStream) { tabStream.getTracks().forEach((t) => t.stop()); tabStream = null; }
    audioSources.forEach((source) => source.disconnect());
    audioSources = [];
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;
  }

  function stopWaveformAnimation() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
  }

  function startWaveformAnimation() {
    stopWaveformAnimation();
    const canvas = document.getElementById("waveform-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;

    if (analyser) {
      // Real waveform from tab audio
      const bufLen = analyser.fftSize;
      const data = new Uint8Array(bufLen);

      function drawReal() {
        animationFrameId = requestAnimationFrame(drawReal);
        analyser.getByteTimeDomainData(data);
        ctx.clearRect(0, 0, W, H);

        // Compute RMS to detect silence and scale the waveform
        let sum = 0;
        for (let i = 0; i < bufLen; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / bufLen);
        const scale = Math.max(1, rms * 12); // amplify quiet signals a bit

        ctx.beginPath();
        const step = W / bufLen;
        let x = 0;
        for (let i = 0; i < bufLen; i++) {
          const v = ((data[i] - 128) / 128) * scale;
          const y = H / 2 + v * (H / 2) * 0.9;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          x += step;
        }
        ctx.strokeStyle = rms < 0.005 ? "#1e3d28" : "#4ade80";
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      drawReal();
    } else {
      // Mic-only: animated bar visualizer driven by MIC_CHUNK arrival timestamps
      const bars = 28;
      const barW = Math.floor(W / bars) - 1;
      let phase = 0;

      function drawMic() {
        animationFrameId = requestAnimationFrame(drawMic);
        ctx.clearRect(0, 0, W, H);
        const active = (Date.now() - lastMicChunkTime) < 2500; // dim if no chunk recently
        phase += active ? 0.09 : 0.015;

        for (let i = 0; i < bars; i++) {
          const t = phase + i * 0.45;
          const heightFrac = active
            ? 0.15 + 0.72 * Math.abs(Math.sin(t) * Math.cos(t * 0.6 + 1.2))
            : 0.04 + 0.06 * Math.abs(Math.sin(t));
          const barH = heightFrac * H;
          const x = i * (barW + 1);
          const y = (H - barH) / 2;
          ctx.fillStyle = active ? `rgba(74,222,128,${0.4 + heightFrac * 0.6})` : "#1e3d28";
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, 2);
          ctx.fill();
        }
      }
      drawMic();
    }
  }

  async function downloadRecording(rec) {
    const convertedBlob = rec.convertedBlob || (rec.convertedSaved ? await readAudioBlob(rec.id, "converted") : null);
    const sourceBlob = rec.webmBlob || (!convertedBlob && rec.sourceSaved ? await readAudioBlob(rec.id, "source") : null);
    const blob = convertedBlob || sourceBlob;
    if (!blob) {
      state.error = "Saved audio was not found for this recording.";
      render();
      return;
    }
    const url = rec.convertedUrl && convertedBlob === rec.convertedBlob
      ? rec.convertedUrl
      : URL.createObjectURL(blob);
    const ext = convertedBlob
      ? (rec.exportFormat || audioExtension(blob))
      : audioExtension(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-${formatDate(rec.date).replace(/[^a-zA-Z0-9]/g, "-")}.${ext}`;
    a.click();
    if (url !== rec.convertedUrl) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function deleteRecording(id) {
    try {
      await deleteAudioBlobs(id);
    } catch (err) {
      state.error = `Recording was not deleted because saved audio cleanup failed: ${err.message}`;
      render();
      return;
    }
    state.recordings = state.recordings.filter((r) => r.id !== id);
    saveRecordings(state.recordings);
    render();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  function formatBytes(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatMicLevel(level) {
    if (!level) return "0.000";
    return level.toFixed(3);
  }

  function sourceLabel(mode) {
    return { mic: "Mic", tab: "Tab", both: "Mic+Tab" }[mode] || mode;
  }

  // ─── Render helpers ───────────────────────────────────────────────────────────
  const root = document.getElementById("root");

  function renderTimer() {
    const el = document.getElementById("timer-display");
    if (el) el.textContent = formatTime(state.timer);
  }

  function render() {
    root.innerHTML = `<div class="app"><style>${CSS}</style>${buildHeader()}${buildView()}</div>`;
    attachEvents();
    if (state.recordingState === "recording") startWaveformAnimation();
  }

  function buildView() {
    const needsMic = state.sourceMode === "mic" || state.sourceMode === "both";
    if (needsMic && state.micPermission !== "granted" && state.view === "recorder") {
      if (state.micPermission === "unknown") return `<div class="perm-screen"><div class="perm-icon">🎙</div><div class="perm-body">Checking microphone…</div></div>`;
      return buildPermissionScreen();
    }
    if (state.view === "recorder") return buildRecorder();
    if (state.view === "log") return buildLog();
    if (state.view === "settings") return buildSettings();
    return "";
  }

  // ─── Header ───────────────────────────────────────────────────────────────────
  function buildHeader() {
    const hasKey = !!state.groqApiKey;
    return `
    <header class="header">
      <div class="logo">
        <div class="logo-dot"></div>
        <span>CallLog</span>
      </div>
      <nav class="nav">
        <button class="nav-btn ${state.view === "recorder" ? "active" : ""}" data-view="recorder">Record</button>
        <button class="nav-btn ${state.view === "log" ? "active" : ""}" data-view="log">
          Log${state.recordings.length > 0 ? ` <span class="badge">${state.recordings.length}</span>` : ""}
        </button>
        <button class="nav-btn ${state.view === "settings" ? "active" : ""} ${!hasKey ? "nav-warn" : ""}" data-view="settings">
          ${!hasKey ? "⚠ " : ""}Settings
        </button>
      </nav>
    </header>`;
  }

  // ─── Recorder view ────────────────────────────────────────────────────────────
  function buildRecorder() {
    const isRecording = state.recordingState === "recording";
    const hasKey = !!state.groqApiKey;

    return `
    <div class="recorder">
      ${!hasKey ? `<div class="info-bar">Add your Groq API key in <button class="inline-link" data-view="settings">Settings</button> to enable transcription.</div>` : ""}
      ${state.error ? `<div class="error-bar">⚠ ${state.error}</div>` : ""}
      ${isRecording && (state.sourceMode === "mic" || state.sourceMode === "both") ? `
        <div class="info-bar">
          Mic: ${state.micInputLabel || "starting..."}${(state.micRequestedLabel || selectedMicLabel()) ? ` · wanted ${state.micRequestedLabel || selectedMicLabel()}` : ""} · level <span id="mic-level-value">${formatMicLevel(state.micLevel)}</span>
          <div class="mic-meter"><div id="mic-level-meter" class="mic-meter-fill" style="width:${Math.min(100, Math.round(state.micLevel * 400))}%"></div></div>
        </div>
      ` : ""}
      ${!isRecording && (state.sourceMode === "tab" || state.sourceMode === "both") ? `
        <div class="${state.tabArmed ? "armed-bar" : "info-bar"}">
          ${state.tabArmed
            ? `Call tab set: ${state.armedTabLabel || "dialer tab"} is ready. Start recording when the call begins.`
            : "Optional: set the dialer tab before the call so Start Recording can begin immediately."}
        </div>
      ` : ""}

      <div class="record-stage">
        ${isRecording ? `
          <div class="pulse-ring"></div>
          <div class="timer-wrap">
            <div class="rec-dot"></div>
            <span id="timer-display" class="timer">${formatTime(state.timer)}</span>
            <span class="rec-label">REC</span>
          </div>
          <canvas id="waveform-canvas" width="220" height="44" style="width:220px;height:44px"></canvas>
          <div class="rec-hint">Recording ${sourceLabel(state.sourceMode)} audio…</div>
        ` : `
          <div class="idle-icon">◉</div>
          <div class="idle-hint">Ready to record</div>
        `}
      </div>

      <div class="controls">
        ${isRecording
          ? `<button class="btn-stop" id="btn-stop">■ Stop & Save</button>`
          : `
            ${(state.sourceMode === "tab" || state.sourceMode === "both") ? `
              ${state.tabArmed
                ? `<button class="btn-secondary" id="btn-cancel-arm">Cancel Tab</button>`
                : `<button class="btn-secondary" id="btn-arm-tab">Set Call Tab</button>`}
            ` : ""}
            <button class="btn-record" id="btn-start">● Start Recording</button>
          `}
      </div>

      ${state.recordings.length > 0 ? `
        <div class="section-label" style="margin-top:4px">Recent</div>
        <div class="recent-list">
          ${state.recordings.slice(0, 3).map(buildRecRow).join("")}
          ${state.recordings.length > 3 ? `<button class="view-all-btn" data-view="log">View all ${state.recordings.length} →</button>` : ""}
        </div>
      ` : ""}
    </div>`;
  }

  // ─── Recording row (shared) ───────────────────────────────────────────────────
  function buildRecRow(r) {
    const isTranscribing = state.transcribingId === r.id;
    const convertedReady = (!!r.convertedUrl || !!r.convertedBlob || !!r.convertedSaved) && !r.convertError;
    const sourceReady = !!r.webmBlob || !!r.sourceSaved;
    const downloadReady = convertedReady || sourceReady;
    const downloadLabel = convertedReady
      ? (r.exportFormat || "webm").toUpperCase()
      : audioExtension({ type: r.sourceMimeType || "audio/webm" }).toUpperCase();
    const exportFailed = !!r.convertError;

    let transcriptNotice = "";
    let transcriptSnippet = "";
    if (r.sourceSaveError) {
      transcriptNotice += `<div class="transcript-snippet error" style="margin-bottom:4px">${r.sourceSaveError}</div>`;
    }
    if (r.convertedSaveError) {
      transcriptNotice += `<div class="transcript-snippet error" style="margin-bottom:4px">${r.convertedSaveError}</div>`;
    }
    if (r.convertError) {
      transcriptNotice += `<div class="transcript-snippet error" style="margin-bottom:4px">${r.convertError}</div>`;
    }
    if (r.transcriptStatus === "transcribing" || isTranscribing) {
      transcriptSnippet = `<div class="transcript-snippet transcribing"><span class="spin">⟳</span> Transcribing with Whisper…</div>`;
    } else if (r.transcriptStatus === "done" && r.transcript) {
      transcriptSnippet = `<div class="transcript-snippet">${r.transcript.slice(0, 130)}${r.transcript.length > 130 ? "…" : ""}</div>`;
    } else if (r.transcriptStatus === "error") {
      transcriptSnippet = `<div class="transcript-snippet error">${r.transcript}</div>`;
    } else if (r.transcriptStatus === "pending") {
      transcriptSnippet = `<div class="transcript-snippet muted">Waiting for transcription…</div>`;
    }

    return `
    <div class="rec-row">
      <div class="rec-meta">
        <span class="rec-date">${formatDate(r.date)}</span>
        <div class="rec-chips">
          <span class="chip mono">${formatTime(r.duration)}</span>
          <span class="chip chip-src">${sourceLabel(r.source)}</span>
          <span class="chip mono">${(r.exportFormat || "webm").toUpperCase()}</span>
          ${r.size ? `<span class="chip mono">${formatBytes(r.size)}</span>` : ""}
        </div>
      </div>
      ${transcriptNotice}${transcriptSnippet}
      <div class="rec-actions">
        ${downloadReady
          ? `<button class="rec-btn" data-action="download" data-id="${r.id}">↓ ${downloadLabel}</button>`
          : exportFailed
            ? `<button class="rec-btn" disabled style="opacity:0.4">Export failed</button>`
            : `<button class="rec-btn" disabled style="opacity:0.4">⟳ Converting…</button>`}
        <button class="rec-btn rec-btn-del" data-action="delete" data-id="${r.id}">Delete</button>
      </div>
    </div>`;
  }

  // ─── Log view ─────────────────────────────────────────────────────────────────
  function buildLog() {
    if (state.recordings.length === 0) {
      return `
      <div class="log-empty">
        <div class="empty-icon">◎</div>
        <p>No recordings yet</p>
        <p class="empty-hint">Go to Record and capture your first call.</p>
      </div>`;
    }
    return `
    <div class="log">
      ${state.recordings.map((r) => `
        <div class="log-item">
          ${buildRecRow(r)}
          ${r.transcriptStatus === "done" && r.transcript ? `
            <details class="transcript-full">
              <summary>Full transcript</summary>
              <div class="transcript-body">${r.transcript}</div>
            </details>
          ` : ""}
        </div>
      `).join("")}
    </div>`;
  }

  // ─── Settings view ────────────────────────────────────────────────────────────
  function buildSettings() {
    return `
    <div class="settings">
      <div class="settings-section">
        <div class="settings-title">Groq API Key</div>
        <div class="settings-hint">
          Used for Whisper speech-to-text transcription.
          Get a free key at <span class="link-hint">console.groq.com</span>
        </div>
        ${state.groqApiKey && !state.editingGroqKey ? `
          <div class="key-actions">
            <button class="btn-key-secondary" id="btn-update-key">Update Key</button>
            <button class="btn-key-danger" id="btn-delete-key">Delete Key</button>
          </div>
        ` : `
          <input
            class="api-input"
            id="groq-key-input"
            type="password"
            placeholder="gsk_••••••••••••••••••••••••"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="key-actions">
            <button class="btn-save-key" id="btn-save-key">Save Key</button>
            ${state.groqApiKey ? `<button class="btn-key-secondary" id="btn-cancel-key-update">Cancel</button>` : ""}
          </div>
        `}
      </div>

      <div class="settings-section">
        <div class="settings-title">Audio Source</div>
        <div class="settings-hint">Which audio to capture when recording.</div>
        <div class="source-btns">
          ${["mic", "tab", "both"].map((s) => `
            <button class="source-btn ${state.sourceMode === s ? "active" : ""}" data-source="${s}">
              ${s === "mic" ? "🎙 Mic" : s === "tab" ? "🔊 Tab" : "🎙+🔊 Both"}
            </button>`).join("")}
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-title">Export Format</div>
        <div class="settings-hint">Format for downloaded recordings.</div>
        <div class="format-btns">
          <button class="format-btn ${state.exportFormat === "mp3" ? "active" : ""}" data-format="mp3">MP3 <span class="format-sub">192 kbps</span></button>
          <button class="format-btn ${state.exportFormat === "wav" ? "active" : ""}" data-format="wav">WAV <span class="format-sub">Lossless</span></button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-title">Microphone</div>
        <div class="settings-hint">Select which mic to use for recording.</div>
        ${state.micDevices.length === 0 ? `
          <div class="settings-hint" style="color:#555">Grant mic access first to see available devices.</div>
        ` : `
          <select class="mic-select" id="mic-device-select">
            <option value="default" data-label="" ${state.micDeviceId === "default" ? "selected" : ""}>Auto-select best microphone</option>
            ${state.micDevices.map((d) => `
              <option value="${d.deviceId}" data-label="${d.label.replace(/"/g, "&quot;")}" ${state.micDeviceId === d.deviceId ? "selected" : ""}>${d.label}</option>
            `).join("")}
          </select>
          <div class="settings-hint">Selected: ${selectedMicLabel() || "Auto-select best microphone"}</div>
        `}
      </div>

      <div class="settings-section">
        <div class="settings-title">About</div>
        <div class="settings-hint">
          CallLog v${APP_VERSION} — Open source call recorder.<br/>
          Transcription via <strong>Groq Whisper large-v3-turbo</strong>.<br/>
          MP3/WAV encoding in-browser via <strong>lamejs</strong> — no upload.<br/>
          Your audio never leaves your device except for transcription.
        </div>
      </div>
    </div>`;
  }

  // ─── Events ───────────────────────────────────────────────────────────────────
  function attachEvents() {
    root.querySelectorAll("[data-view]").forEach((el) => {
      el.addEventListener("click", () => { state.view = el.dataset.view; render(); });
    });

    root.querySelectorAll("[data-source]").forEach((el) => {
      el.addEventListener("click", () => {
        if (state.sourceMode !== el.dataset.source) clearArmedTab();
        state.sourceMode = el.dataset.source; saveSettings(); render();
      });
    });

    root.querySelectorAll("[data-format]").forEach((el) => {
      el.addEventListener("click", () => { state.exportFormat = el.dataset.format; saveSettings(); render(); });
    });

    const btnGrantMic = document.getElementById("btn-grant-mic");
    if (btnGrantMic) btnGrantMic.addEventListener("click", requestMicPermission);

    const btnRetryPerm = document.getElementById("btn-retry-perm");
    if (btnRetryPerm) btnRetryPerm.addEventListener("click", requestMicPermission);

    const btnCopyUrl = document.getElementById("btn-copy-url");
    if (btnCopyUrl) btnCopyUrl.addEventListener("click", () => {
      const url = document.getElementById("perm-settings-url")?.textContent;
      if (url) navigator.clipboard.writeText(url).then(() => { btnCopyUrl.textContent = "Copied!"; });
    });

    const btnStart = document.getElementById("btn-start");
    if (btnStart) btnStart.addEventListener("click", startRecording);

    const btnArmTab = document.getElementById("btn-arm-tab");
    if (btnArmTab) btnArmTab.addEventListener("click", armTabForRecording);

    const btnCancelArm = document.getElementById("btn-cancel-arm");
    if (btnCancelArm) btnCancelArm.addEventListener("click", cancelArmedTab);

    const btnStop = document.getElementById("btn-stop");
    if (btnStop) btnStop.addEventListener("click", stopRecording);

    const micDeviceSelect = document.getElementById("mic-device-select");
    if (micDeviceSelect) micDeviceSelect.addEventListener("change", () => {
      state.micDeviceId = micDeviceSelect.value;
      state.micDeviceLabel = micDeviceSelect.selectedOptions[0]?.dataset.label || "";
      saveSettings();
    });

    const btnSaveKey = document.getElementById("btn-save-key");
    if (btnSaveKey) btnSaveKey.addEventListener("click", () => {
      const val = document.getElementById("groq-key-input")?.value?.trim();
      if (val) { state.groqApiKey = val; state.editingGroqKey = false; saveSettings(); render(); }
    });

    const btnUpdateKey = document.getElementById("btn-update-key");
    if (btnUpdateKey) btnUpdateKey.addEventListener("click", () => {
      state.editingGroqKey = true;
      render();
      setTimeout(() => document.getElementById("groq-key-input")?.focus(), 0);
    });

    const btnDeleteKey = document.getElementById("btn-delete-key");
    if (btnDeleteKey) btnDeleteKey.addEventListener("click", () => {
      state.groqApiKey = "";
      state.editingGroqKey = false;
      saveSettings();
      render();
    });

    const btnCancelKeyUpdate = document.getElementById("btn-cancel-key-update");
    if (btnCancelKeyUpdate) btnCancelKeyUpdate.addEventListener("click", () => {
      state.editingGroqKey = false;
      render();
    });

    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = parseInt(el.dataset.id);
        const rec = state.recordings.find((r) => r.id === id);
        if (el.dataset.action === "download" && rec) {
          downloadRecording(rec).catch((err) => {
            state.error = `Download failed: ${err.message}`;
            render();
          });
        }
        if (el.dataset.action === "delete") {
          deleteRecording(id).catch((err) => {
            state.error = `Delete failed: ${err.message}`;
            render();
          });
        }
      });
    });
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────────
  const CSS = `
    .app {
      display: flex; flex-direction: column; height: 100vh;
      background: #0e0e11; color: #e8e8ec;
      font-family: 'Inter', system-ui, sans-serif; font-size: 13px; overflow: hidden;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px; border-bottom: 1px solid #1e1e26; flex-shrink: 0;
    }
    .logo { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
    .logo-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade8088; }
    .nav { display: flex; gap: 2px; }
    .nav-btn {
      background: none; border: none; color: #555; padding: 5px 9px;
      border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; transition: all 0.15s;
      display: flex; align-items: center; gap: 4px;
    }
    .nav-btn:hover { color: #e8e8ec; background: #1a1a22; }
    .nav-btn.active { color: #e8e8ec; background: #1a1a22; }
    .nav-warn { color: #f59e0b !important; }
    .badge { background: #4ade8022; color: #4ade80; border-radius: 10px; padding: 1px 5px; font-size: 10px; }

    /* Recorder */
    .recorder { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
    .info-bar {
      background: #1a1808; border: 1px solid #3d3010; color: #f59e0b;
      padding: 9px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5;
    }
    .mic-meter {
      height: 4px; margin-top: 6px; background: #2b2412; border-radius: 999px; overflow: hidden;
    }
    .mic-meter-fill {
      height: 100%; background: #4ade80; border-radius: 999px; transition: width 0.12s linear;
    }
    .error-bar {
      background: #2d1a1a; border: 1px solid #6b2b2b; color: #f87171;
      padding: 9px 12px; border-radius: 8px; font-size: 12px;
    }
    .armed-bar {
      background: #0d2419; border: 1px solid #2d6b45; color: #86efac;
      padding: 9px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5;
    }
    .inline-link { background: none; border: none; color: #f59e0b; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 0; font-family: inherit; }
    .section-label { font-size: 11px; color: #444; text-transform: uppercase; letter-spacing: 0.07em; }

    .source-btns { display: flex; gap: 6px; }
    .source-btn {
      flex: 1; padding: 8px 4px; background: #14141a; border: 1px solid #22222c;
      border-radius: 8px; color: #666; cursor: pointer; font-size: 11px; font-family: inherit; transition: all 0.15s;
    }
    .source-btn:hover:not(:disabled) { border-color: #4ade8044; color: #bbb; }
    .source-btn.active { background: #0d2419; border-color: #4ade8066; color: #4ade80; }
    .source-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    .record-stage {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 130px; background: #09090e; border: 1px solid #18181f;
      border-radius: 12px; padding: 20px 16px; position: relative; overflow: hidden;
    }
    .idle-icon { font-size: 32px; color: #222230; margin-bottom: 6px; }
    .idle-hint { color: #38384a; font-size: 12px; }
    .pulse-ring {
      position: absolute; width: 150px; height: 150px; border-radius: 50%;
      border: 1px solid #4ade8018; animation: pulse 2.2s ease-in-out infinite; pointer-events: none;
    }
    @keyframes pulse { 0% { transform: scale(0.7); opacity: 0.9; } 100% { transform: scale(1.5); opacity: 0; } }
    .timer-wrap { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .rec-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
    .timer { font-family: 'JetBrains Mono', monospace; font-size: 26px; font-weight: 500; color: #f0f0f0; }
    .rec-label { font-size: 9px; color: #ef4444; letter-spacing: 0.12em; align-self: flex-end; margin-bottom: 3px; }
    .rec-hint { font-size: 11px; color: #3a3a4a; }
    #waveform-canvas { border-radius: 6px; background: #07100d; display: block; }

    .controls { display: flex; gap: 8px; }
    .btn-record, .btn-stop, .btn-secondary {
      flex: 1; padding: 11px; border-radius: 10px; border: none;
      cursor: pointer; font-size: 13px; font-weight: 500; font-family: inherit; transition: all 0.15s;
    }
    .btn-record { background: #4ade80; color: #071510; }
    .btn-record:hover { background: #86efac; }
    .btn-secondary { background: #15151d; color: #c6c6d1; border: 1px solid #282836; }
    .btn-secondary:hover { background: #1e1e29; border-color: #3a3a4a; }
    .btn-stop { background: #1c1c24; color: #f87171; border: 1px solid #38202020; }
    .btn-stop:hover { background: #2d1a1a; border-color: #6b2b2b; }

    /* Recording rows */
    .recent-list { display: flex; flex-direction: column; gap: 8px; }
    .view-all-btn { background: none; border: none; color: #4ade80; font-size: 12px; cursor: pointer; padding: 2px 0; font-family: inherit; }
    .view-all-btn:hover { text-decoration: underline; }

    .rec-row {
      background: #111118; border: 1px solid #1c1c26;
      border-radius: 10px; padding: 11px; display: flex; flex-direction: column; gap: 7px;
    }
    .rec-meta { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
    .rec-date { font-size: 11px; color: #888; white-space: nowrap; }
    .rec-chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip {
      background: #1a1a24; border: 1px solid #26263a; border-radius: 4px;
      padding: 2px 6px; font-size: 10px; color: #666;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .chip-src { color: #a78bfa; border-color: #362860; background: #160f2a; }

    .transcript-snippet { font-size: 11px; color: #4a4a60; font-style: italic; line-height: 1.5; }
    .transcript-snippet.transcribing { color: #6366f1; display: flex; align-items: center; gap: 5px; font-style: normal; }
    .transcript-snippet.error { color: #f87171; font-style: normal; }
    .transcript-snippet.muted { color: #333345; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spin { display: inline-block; animation: spin 1s linear infinite; }

    .rec-actions { display: flex; gap: 6px; }
    .rec-btn {
      background: none; border: 1px solid #22222e; border-radius: 6px; color: #666;
      padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .rec-btn:hover:not(:disabled) { border-color: #4ade8044; color: #4ade80; }
    .rec-btn-del:hover { border-color: #ef444444 !important; color: #ef4444 !important; }

    /* Log */
    .log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .log-item { display: flex; flex-direction: column; }
    .log-item .rec-row { border-radius: 10px 10px 0 0; border-bottom: none; }
    .transcript-full { background: #0c0c12; border: 1px solid #1c1c26; border-top: none; border-radius: 0 0 10px 10px; }
    .transcript-full summary { padding: 7px 11px; font-size: 11px; color: #444; cursor: pointer; user-select: none; }
    .transcript-full summary:hover { color: #666; }
    .transcript-body { padding: 10px 12px 12px; font-size: 12px; color: #556; font-style: italic; line-height: 1.7; white-space: pre-wrap; border-top: 1px solid #18181f; }
    .log-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 24px; gap: 8px; color: #333; }
    .empty-icon { font-size: 28px; color: #22222e; margin-bottom: 6px; }
    .empty-hint { font-size: 12px; color: #2a2a3a; }

    /* Settings */
    .settings { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 20px; }
    .settings-section { display: flex; flex-direction: column; gap: 8px; }
    .settings-title { font-size: 12px; font-weight: 600; color: #aaa; }
    .settings-hint { font-size: 11px; color: #444; line-height: 1.6; }
    .settings-hint strong { color: #666; }
    .link-hint { color: #6366f1; }
    .api-input {
      background: #0d0d14; border: 1px solid #25253a; border-radius: 8px; color: #ccc;
      padding: 9px 11px; font-size: 12px; font-family: 'JetBrains Mono', monospace;
      outline: none; width: 100%; transition: border-color 0.15s;
    }
    .api-input:focus { border-color: #4ade8066; }
    .btn-save-key {
      flex: 1; background: #4ade80; color: #071510; border: none; border-radius: 8px;
      padding: 9px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .btn-save-key:hover { background: #86efac; }
    .key-actions { display: flex; gap: 8px; }
    .btn-key-secondary, .btn-key-danger {
      flex: 1; border-radius: 8px; padding: 9px; font-size: 12px; font-weight: 600;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .btn-key-secondary { background: #15151d; color: #c6c6d1; border: 1px solid #282836; }
    .btn-key-secondary:hover { background: #1e1e29; border-color: #3a3a4a; }
    .btn-key-danger { background: #241414; color: #f87171; border: 1px solid #4a2020; }
    .btn-key-danger:hover { background: #2d1a1a; border-color: #6b2b2b; }
    .format-btns { display: flex; gap: 8px; }
    .format-btn {
      flex: 1; padding: 10px; background: #14141a; border: 1px solid #22222c;
      border-radius: 8px; color: #666; cursor: pointer; font-size: 12px; font-weight: 500;
      font-family: inherit; transition: all 0.15s; display: flex; flex-direction: column; align-items: center; gap: 3px;
    }
    .format-btn:hover { border-color: #4ade8044; color: #bbb; }
    .format-btn.active { background: #0d2419; border-color: #4ade8066; color: #4ade80; }
    .format-sub { font-size: 10px; color: #444; font-weight: 400; }
    .format-btn.active .format-sub { color: #2d7a50; }
    .mic-select {
      background: #0d0d14; border: 1px solid #25253a; border-radius: 8px; color: #ccc;
      padding: 9px 11px; font-size: 12px; font-family: 'Inter', system-ui, sans-serif;
      outline: none; width: 100%; cursor: pointer; transition: border-color 0.15s;
    }
    .mic-select:focus { border-color: #4ade8066; }
    .mic-select option { background: #111118; color: #ccc; }

    /* Permission screen */
    .perm-screen {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 24px 20px; gap: 14px; text-align: center;
    }
    .perm-icon { font-size: 36px; }
    .perm-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
    .perm-body { font-size: 12px; color: #555; line-height: 1.6; }
    .perm-hint { font-size: 11px; color: #444; line-height: 1.6; max-width: 220px; }
    .perm-btn {
      padding: 10px 24px; border-radius: 10px; border: none;
      background: #4ade80; color: #071510; cursor: pointer;
      font-size: 13px; font-weight: 600; font-family: inherit;
    }
    .perm-btn:hover { background: #86efac; }
    .perm-blocked {
      background: #1a1808; border: 1px solid #3d3010; border-radius: 10px;
      padding: 12px 14px; text-align: left; width: 100%;
    }
    .perm-blocked-title { font-size: 12px; color: #f59e0b; font-weight: 600; margin-bottom: 6px; }
    .perm-blocked-body { font-size: 11px; color: #a07020; line-height: 1.7; }
    .perm-blocked-body em { font-style: normal; color: #d4a040; }
    .perm-url {
      display: block; margin: 6px 0 4px; font-family: 'JetBrains Mono', monospace;
      font-size: 9px; color: #888; word-break: break-all; user-select: all;
      background: #0d0d14; border: 1px solid #25253a; border-radius: 4px; padding: 5px 7px;
    }
    .perm-copy-btn {
      background: none; border: 1px solid #3d3010; border-radius: 4px; color: #f59e0b;
      font-size: 10px; padding: 3px 8px; cursor: pointer; font-family: inherit; margin-top: 4px;
    }

    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #22222e; border-radius: 2px; }
  `;

  // ─── Mic permission check via offscreen document ─────────────────────────────
  async function checkMicPermission() {
    // Passive check via enumerateDevices — no prompt, labels populated only if granted
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      if (mics.length > 0 && mics.some((d) => d.label !== "")) {
        state.micPermission = "granted";
        render();
        return;
      }
    } catch (_) {}
    state.micPermission = "prompt";
    render();
  }

  // Called on button click. Chrome shows the mic prompt reliably from a normal extension tab.
  async function requestMicPermission() {
    chrome.storage.local.set({ mic_permission_prompted: true });
    state.micPermission = "unknown";
    state.error = null;
    render();
    try {
      const res = await chrome.runtime.sendMessage({ type: "OPEN_MIC_PERMISSION_PAGE" });
      state.micPermission = "prompt";
      state.error = res?.success
        ? "Chrome is requesting microphone access. Return here after allowing it."
        : res?.error || "Could not open the microphone permission page.";
    } catch (e) {
      state.micPermission = "os-blocked";
      state.error = e.message;
    }
    render();
  }

  async function maybeRequestMicOnFirstLaunch(alreadyPrompted) {
    const needsMic = state.sourceMode === "mic" || state.sourceMode === "both";
    if (!needsMic || alreadyPrompted || state.micPermission === "granted") return;

    // Chrome does not expose a manifest-only microphone grant for extensions.
    // Open a normal extension tab once so Chrome can show its native mic prompt.
    await requestMicPermission();
  }

  // ─── Permission screen ────────────────────────────────────────────────────────
  function buildPermissionScreen() {
    const isOsBlocked = state.micPermission === "os-blocked" || state.micPermission === "denied";
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const isWin = navigator.platform.toLowerCase().includes("win");

    return `
    <div class="perm-screen">
      <div class="perm-icon">🎙</div>
      <div class="perm-title">Microphone access needed</div>
      <div class="perm-body">
        CallLog needs your microphone to record calls.
      </div>

      ${state.error ? `<div class="error-bar" style="font-size:10px;word-break:break-all;text-align:left">${state.error}</div>` : ""}
      ${isOsBlocked ? `
        <div class="perm-blocked">
          <div class="perm-blocked-title">⚠ Mic permission is blocked</div>
          <div class="perm-blocked-body">
            Your browser previously dismissed the mic prompt and won't show it again automatically.<br/><br/>
            <strong>Fix in 2 steps:</strong><br/><br/>
            1. Copy this URL and paste it in your address bar:<br/>
            <span class="perm-url" id="perm-settings-url">chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${chrome.runtime.id}%2F</span>
            <button class="perm-copy-btn" id="btn-copy-url">Copy</button><br/><br/>
            2. Find <em>Microphone</em> → set to <em>Allow</em> → come back and click Retry.
          </div>
        </div>
        <button class="perm-btn" id="btn-retry-perm">↺ Retry</button>
      ` : `
        <div class="perm-hint">Click below — your browser will ask to confirm microphone access.</div>
        <button class="perm-btn" id="btn-grant-mic">Allow Microphone</button>
      `}
    </div>`;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    await requestDurableStorage();
    const stored = await loadRecordings();
    const audioRecords = await listAudioRecords().catch((err) => {
      state.error = `Saved audio index could not be read: ${err.message}`;
      return [];
    });
    const merged = mergeAudioStorageMeta(stored.recordings_meta, audioRecords);
    const restored = restoreRecordingMeta(merged.recordings);
    state.recordings = restored.recordings.map((r) => ({
      ...r, webmBlob: null, convertedBlob: null, convertedUrl: null,
    }));
    if (merged.changed || restored.changed) saveRecordings(state.recordings);
    state.groqApiKey = stored.groq_api_key || "";
    state.exportFormat = stored.export_format || "mp3";
    state.sourceMode = stored.source_mode || "both";
    state.micDeviceId = stored.mic_device_id || "default";
    state.micDeviceLabel = stored.mic_device_label || "";
    await checkMicPermission();
    await loadMicDevices();
    render();
    resumePendingTranscriptions();
    await maybeRequestMicOnFirstLaunch(!!stored.mic_permission_prompted);
  }

  init();
})();
