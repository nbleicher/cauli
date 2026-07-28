"use client";

import {
  AlertTriangle,
  Check,
  CloudUpload,
  Headphones,
  LoaderCircle,
  Mic2,
  Radio,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { useState, useSyncExternalStore } from "react";
import {
  detectRecordingSupport,
  type RecordingSupport,
} from "@/lib/recording-capture";
import { useRecordingController } from "@/lib/use-recording-controller";

let cachedRecordingSupport: RecordingSupport | null = null;

function subscribeRecordingSupport() {
  return () => undefined;
}

function getRecordingSupportSnapshot(): RecordingSupport | null {
  cachedRecordingSupport ??= detectRecordingSupport();
  return cachedRecordingSupport;
}

function getServerRecordingSupportSnapshot(): RecordingSupport | null {
  return null;
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [...(hours > 0 ? [hours] : []), minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function RecorderPanel() {
  const recordingSupport = useSyncExternalStore(
    subscribeRecordingSupport,
    getRecordingSupportSnapshot,
    getServerRecordingSupportSnapshot
  );
  const [title, setTitle] = useState("");
  const [recordingAttested, setRecordingAttested] = useState(false);
  const {
    active,
    busy,
    degraded,
    discardDraft,
    drafts,
    elapsedMs,
    error,
    mode,
    notice,
    recoverDraft,
    recoveringId,
    setMode,
    startRecording,
    state,
    stopRecording,
    uploadedChunks,
  } = useRecordingController();

  async function beginRecording() {
    if (!recordingAttested) return;
    const started = await startRecording({
      recordingAttested: true,
      title,
    });
    if (started) {
      setTitle("");
      setRecordingAttested(false);
    }
  }

  return (
    <div className="recorder-layout">
      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          <Check size={17} />
          <span>{notice}</span>
        </div>
      )}

      {recordingSupport === null && (
        <p className="notice-banner" role="status">
          Checking recording support…
        </p>
      )}

      {recordingSupport?.supported === false && (
        <section className="recording-unsupported" role="status">
          <AlertTriangle size={22} />
          <div>
            <h2>Recording is unavailable in this browser</h2>
            <p>
              Recording is available in Google Chrome on a macOS or Windows
              desktop.
            </p>
            <p>
              You can still use Calls, Reviews, and account settings in this
              browser.
            </p>
          </div>
        </section>
      )}

      {recordingSupport?.supported === true && (
        <section className="recorder-console">
          {!active && !busy && (
            <div className="recording-preflight">
              <div className="field">
                <label htmlFor="call-title">Call title (optional)</label>
                <input
                  id="call-title"
                  value={title}
                  maxLength={240}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Customer discovery"
                />
                <p className="field-hint">
                  Leave blank to identify the Call by its date and time.
                </p>
              </div>
              <label className="recording-attestation">
                <input
                  type="checkbox"
                  checked={recordingAttested}
                  onChange={(event) =>
                    setRecordingAttested(event.target.checked)
                  }
                />
                <span>
                  I confirm that I obtained all required notices, permissions,
                  and consents for this Call.
                  <small>
                    This Recording Attestation records my statement; checking it
                    does not independently make the recording lawful.
                  </small>
                </span>
              </label>
              <p className="transcript-language">
                Transcript generation is English-only.
              </p>
            </div>
          )}

          <div className="recorder-toolbar">
            <div>
              <span className="toolbar-label">Audio source</span>
              <div className="segmented" role="group" aria-label="Audio source">
                {(
                  [
                    ["mic", Mic2, "Mic"],
                    ["tab", Headphones, "Tab"],
                    ["both", Radio, "Both"],
                  ] as const
                ).map(([value, Icon, label]) => (
                  <button
                    key={value}
                    className={mode === value ? "active" : ""}
                    onClick={() => setMode(value)}
                    disabled={active || busy}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="upload-counter"
              title="Successfully uploaded Recording chunks"
            >
              <CloudUpload size={16} />
              <span>{uploadedChunks} uploaded</span>
            </div>
          </div>

          <div className={`recording-stage${active ? " active" : ""}`}>
            {state === "idle" ? (
              <Image
                src="/cal-head.png"
                alt=""
                width={72}
                height={72}
                className="stage-cal"
              />
            ) : (
              <div className="recording-indicator">
                <span className="recording-core" />
                {active && <span className="recording-ring" />}
              </div>
            )}
            <div className="recording-time mono">
              {formatElapsed(elapsedMs)}
            </div>
            <div className="recording-state">
              {state === "idle" && "Ready to record"}
              {state === "requesting" && "Waiting for browser permissions"}
              {state === "recording" &&
                (degraded
                  ? "Recording remaining audio · Degraded"
                  : `Recording ${mode === "both" ? "mic + tab" : mode} audio`)}
              {state === "stopping" && "Closing audio streams"}
              {state === "uploading" && "Finishing upload"}
              {state === "queued" && "Queued for processing"}
              {state === "failed" && "Recorder paused"}
            </div>
            <div className="wave-bars" aria-hidden="true">
              {Array.from({ length: 24 }, (_, index) => (
                <i key={index} className={`wave-delay-${index % 8}`} />
              ))}
            </div>
          </div>

          <div className="recorder-actions">
            {active ? (
              <button
                className="button button-danger record-action"
                onClick={() => void stopRecording()}
              >
                <Square size={17} fill="currentColor" />
                Stop and save
              </button>
            ) : (
              <button
                className="button button-primary record-action"
                onClick={() => void beginRecording()}
                disabled={busy || !recordingAttested}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Radio size={17} />
                )}
                {busy ? "Working" : "Start recording"}
              </button>
            )}
          </div>
        </section>
      )}

      {drafts.length > 0 && (
        <section className="recovery-section">
          <div className="section-heading">
            <div>
              <h2>Incomplete Recordings</h2>
              <p>
                Source Audio buffered on this device or uploaded to the
                Workspace can be recovered without recording again.
              </p>
            </div>
          </div>
          <div className="recovery-list">
            {drafts.map((draft) => (
              <div className="recovery-row" key={draft.callId}>
                <div>
                  <strong>{new Date(draft.startedAt).toLocaleString()}</strong>
                  <span>
                    {formatElapsed(draft.durationMs)} · {draft.sourceMode} ·
                    chunk {draft.finalChunkSequence + 1}
                  </span>
                </div>
                <div className="recovery-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => void recoverDraft(draft)}
                    disabled={Boolean(recoveringId)}
                  >
                    {recoveringId === draft.callId ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <RotateCcw size={15} />
                    )}
                    Recover
                  </button>
                  <button
                    className="icon-button"
                    title="Discard Incomplete Recording"
                    aria-label="Discard Incomplete Recording"
                    onClick={() => void discardDraft(draft)}
                    disabled={Boolean(recoveringId)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
