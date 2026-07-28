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
import { useRecordingController } from "@/lib/use-recording-controller";

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

      <section className="recorder-console">
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
          <div className="recording-time mono">{formatElapsed(elapsedMs)}</div>
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
              onClick={() => void startRecording()}
              disabled={busy}
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
