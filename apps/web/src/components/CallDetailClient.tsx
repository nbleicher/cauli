"use client";

import type {
  CallStatus,
  ReviewStatus,
  Role,
  SourceMode,
} from "@calllog/shared";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Download,
  FileAudio,
  FileText,
  LoaderCircle,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { StatusPill } from "@/components/StatusPill";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import {
  ReviewEditor,
  type ReviewEditorProps,
} from "@/components/ReviewEditor";

interface Segment {
  id: string;
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface CallDetail {
  id: string;
  title: string | null;
  ownerId: string;
  ownerName: string;
  startedAt: string;
  durationMs: number;
  sourceMode: SourceMode;
  degraded: boolean;
  degradedIntervalCount: number;
  status: CallStatus;
  reviewStatus: ReviewStatus;
  micLabel: string;
  tabLabel: string;
  sourceBytes: number;
  errorMessage: string | null;
  hasSource: boolean;
  hasMp3: boolean;
  hasWav: boolean;
  retentionDays: number | null;
  scheduledDeletionAt: string | null;
}

type CallOperation =
  | "retry"
  | "export"
  | "delete"
  | "rename"
  | "download-mp3"
  | "download-source"
  | "download-wav"
  | "download-txt"
  | "download-srt";

export function CallDetailClient({
  call,
  segments,
  transcriptText,
  currentUserId,
  role,
  review,
}: {
  call: CallDetail;
  segments: Segment[];
  transcriptText: string;
  currentUserId: string;
  role: Role;
  review: ReviewEditorProps | null;
}) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState(call.title ?? "");
  const [activeOperation, setActiveOperation] = useState<CallOperation | null>(
    null
  );

  useEffect(() => {
    if (!call.hasMp3 && !call.hasSource) return;
    const format = call.hasMp3 ? "mp3" : "source";
    fetch(`/api/calls/${call.id}/media?format=${format}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Playback unavailable");
        setAudioUrl(result.url);
      })
      .catch((error: Error) => setMediaError(error.message));
  }, [call.hasMp3, call.hasSource, call.id]);

  async function runAction(action: "retry" | "export" | "delete") {
    setActiveOperation(action);
    setMediaError("");
    try {
      const response = await fetch(
        action === "delete"
          ? `/api/calls/${call.id}`
          : action === "export"
            ? `/api/calls/${call.id}/exports`
            : `/api/calls/${call.id}/retry`,
        { method: action === "delete" ? "DELETE" : "POST" }
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `${action} failed`);
      }
      if (action === "delete") {
        router.push("/calls");
      } else {
        router.refresh();
      }
    } catch (error) {
      setMediaError(
        error instanceof Error ? error.message : `${action} failed`
      );
    } finally {
      setActiveOperation(null);
    }
  }

  async function download(format: "mp3" | "source" | "wav") {
    setActiveOperation(`download-${format}`);
    try {
      const response = await fetch(
        `/api/calls/${call.id}/media?format=${format}&download=1`
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Download unavailable");
      window.location.assign(result.url);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Download failed");
    } finally {
      setActiveOperation(null);
    }
  }

  /**
   * The export is generated on request rather than kept in step with the
   * Transcript, so a Transcript that was regenerated cannot hand back a stale
   * file, and a Call nobody exports never accumulates artifacts.
   */
  async function exportTranscript(format: "txt" | "srt") {
    setActiveOperation(`download-${format}`);
    setMediaError("");
    try {
      const response = await fetch(
        `/api/calls/${call.id}/transcript?format=${format}`,
        { method: "POST" }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Export unavailable");
      window.location.assign(result.url);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Export failed");
    } finally {
      setActiveOperation(null);
    }
  }

  function seek(startMs: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = startMs / 1000;
    void audioRef.current.play();
  }

  const canDelete = role === "admin" || currentUserId === call.ownerId;
  const canRename =
    currentUserId === call.ownerId &&
    call.status !== "recording" &&
    call.status !== "uploading";
  const canReview =
    role === "admin" ||
    (role === "manager" && review?.assignment?.assigneeId === currentUserId);

  async function renameCall(event: FormEvent) {
    event.preventDefault();
    setActiveOperation("rename");
    setMediaError("");
    setNotice("");
    try {
      const response = await fetch(`/api/calls/${call.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Call title could not be updated");
      }
      setTitle(result.title ?? "");
      setNotice("Call title updated.");
      router.refresh();
    } catch (error) {
      setMediaError(
        error instanceof Error
          ? error.message
          : "Call title could not be updated"
      );
    } finally {
      setActiveOperation(null);
    }
  }

  return (
    <>
      {mediaError && (
        <div className="error-banner">
          <AlertTriangle size={17} />
          {mediaError}
        </div>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          <CheckCircle2 size={17} />
          {notice}
        </div>
      )}

      <section className="call-overview">
        <div className="call-audio">
          {audioUrl ? (
            <audio ref={audioRef} controls src={audioUrl} preload="metadata" />
          ) : (
            <div className="audio-pending">
              {call.status === "ready" ? (
                <AlertTriangle size={18} />
              ) : (
                <LoaderCircle className="spin" size={18} />
              )}
              <span>
                {call.status === "ready"
                  ? "Audio unavailable"
                  : "Audio processing"}
              </span>
            </div>
          )}
          <div className="audio-downloads">
            <button
              className="button button-quiet"
              disabled={!call.hasMp3 || activeOperation !== null}
              onClick={() => void download("mp3")}
            >
              <Download size={14} /> MP3
            </button>
            <button
              className="button button-quiet"
              disabled={!call.hasSource || activeOperation !== null}
              onClick={() => void download("source")}
            >
              <FileAudio size={14} /> Source
            </button>
            {call.hasWav ? (
              <button
                className="button button-quiet"
                disabled={activeOperation !== null}
                onClick={() => void download("wav")}
              >
                <Download size={14} /> WAV
              </button>
            ) : (
              <button
                className="button button-quiet"
                disabled={call.status !== "ready" || activeOperation !== null}
                onClick={() => void runAction("export")}
              >
                {activeOperation === "export" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <FileAudio size={14} />
                )}
                Prepare WAV
              </button>
            )}
          </div>
        </div>
        <dl className="call-facts">
          <div>
            <dt>Recorded</dt>
            <dd>{formatDate(call.startedAt)}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{call.ownerName}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd className="mono">{formatDuration(call.durationMs)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd className="capitalize">{call.sourceMode}</dd>
          </div>
          <div>
            <dt>Quality</dt>
            <dd>
              {call.degraded
                ? `Degraded · ${call.degradedIntervalCount} source loss interval${call.degradedIntervalCount === 1 ? "" : "s"}`
                : "Complete"}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(call.sourceBytes)}</dd>
          </div>
          <div>
            <dt>Processing</dt>
            <dd>
              <StatusPill status={call.status} />
            </dd>
          </div>
          {call.scheduledDeletionAt && (
            <div>
              <dt>Scheduled deletion</dt>
              <dd
                title={`The Workspace Retention Policy deletes Calls after ${call.retentionDays} days.`}
              >
                {formatDate(call.scheduledDeletionAt)}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {canRename && (
        <form className="call-title-editor" onSubmit={renameCall}>
          <div className="field">
            <label htmlFor="call-title">Call title</label>
            <input
              id="call-title"
              value={title}
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={formatDate(call.startedAt)}
            />
            <p className="field-hint">
              Leave blank to identify the Call by its date and time.
            </p>
          </div>
          <button
            className="button button-secondary"
            disabled={activeOperation !== null}
          >
            {activeOperation === "rename" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Save size={15} />
            )}
            Save title
          </button>
        </form>
      )}

      {call.errorMessage && (
        <div className="processing-error">
          <div>
            <AlertTriangle size={17} />
            <span>{call.errorMessage}</span>
          </div>
          {call.status === "failed" && (
            <button
              className="button button-secondary"
              onClick={() => void runAction("retry")}
            >
              {activeOperation === "retry" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
              Retry processing
            </button>
          )}
        </div>
      )}

      <div className="call-detail-grid">
        <section className="transcript-panel">
          <div className="section-heading">
            <div>
              <h2>Transcript</h2>
              <p>
                {segments.length
                  ? `${segments.length} timestamped segments`
                  : "Waiting for transcription"}
              </p>
            </div>
            {segments.length > 0 && (
              <CheckCircle2 size={17} className="success-icon" />
            )}
          </div>
          {segments.length > 0 && (
            <div className="transcript-exports">
              <button
                className="button button-quiet"
                disabled={activeOperation !== null}
                onClick={() => void exportTranscript("txt")}
              >
                {activeOperation === "download-txt" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <FileText size={14} />
                )}
                Export TXT
              </button>
              <button
                className="button button-quiet"
                disabled={activeOperation !== null}
                onClick={() => void exportTranscript("srt")}
              >
                {activeOperation === "download-srt" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Captions size={14} />
                )}
                Export SRT
              </button>
            </div>
          )}
          {segments.length > 0 ? (
            <div className="transcript-list">
              {segments.map((segment) => (
                <button key={segment.id} onClick={() => seek(segment.start_ms)}>
                  <span className="mono">
                    {formatDuration(segment.start_ms)}
                  </span>
                  <p>{segment.text}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="transcript-empty">
              {transcriptText ||
                "Transcript segments will appear when processing completes."}
            </div>
          )}
        </section>

        <section className="review-panel">
          <div className="section-heading">
            <div>
              <h2>QA Review</h2>
              <p>Weighted scorecard and revision history</p>
            </div>
            <StatusPill status={call.reviewStatus} />
          </div>
          {review ? (
            <ReviewEditor {...review} readOnly={!canReview} />
          ) : (
            <div className="transcript-empty">
              No published scorecard is available for this workspace.
            </div>
          )}
        </section>
      </div>

      {canDelete && (
        <section className="danger-zone">
          <div>
            <h3>Delete recording</h3>
            <p>Permanently removes audio, transcript, exports, and reviews.</p>
          </div>
          <button
            className="button button-danger"
            disabled={activeOperation !== null}
            onClick={() => {
              if (window.confirm("Permanently delete this recording?")) {
                void runAction("delete");
              }
            }}
          >
            <Trash2 size={15} /> Delete
          </button>
        </section>
      )}
    </>
  );
}
