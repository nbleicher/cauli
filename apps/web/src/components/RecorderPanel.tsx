"use client";

import {
  decideCaptureSourceLoss,
  type CaptureSource,
  type DegradedInterval,
  type SourceMode,
} from "@calllog/shared";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  deleteCallDraft,
  deleteChunk,
  deleteDraft,
  listChunks,
  listDrafts,
  saveChunk,
  saveDraft,
  type RecordingDraft,
} from "@/lib/recording-db";

type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "uploading"
  | "queued"
  | "failed";

interface ActiveCapture {
  outputStream: MediaStream;
  sourceStreams: Array<{
    source: CaptureSource;
    stream: MediaStream;
  }>;
  audioContext: AudioContext | null;
  micLabel: string;
  tabLabel: string;
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

function supportedMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm"];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function acquireCapture(mode: SourceMode): Promise<ActiveCapture> {
  let micStream: MediaStream | null = null;
  let displayStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;

  try {
    if (mode === "tab" || mode === "both") {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (displayStream.getAudioTracks().length === 0) {
        throw new Error(
          "No tab audio was shared. Choose the call tab and enable Share tab audio."
        );
      }
    }

    if (mode === "mic" || mode === "both") {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    }

    const micLabel = micStream?.getAudioTracks()[0]?.label ?? "";
    const tabLabel =
      displayStream?.getVideoTracks()[0]?.label ||
      displayStream?.getAudioTracks()[0]?.label ||
      "";

    displayStream?.getVideoTracks().forEach((track) => track.stop());
    const sourceStreams: ActiveCapture["sourceStreams"] = [
      ...(micStream ? [{ source: "mic" as const, stream: micStream }] : []),
      ...(displayStream
        ? [{ source: "tab" as const, stream: displayStream }]
        : []),
    ];

    if (mode !== "both") {
      const stream = mode === "mic" ? micStream : displayStream;
      if (!stream)
        throw new Error("The selected audio source was unavailable.");
      return {
        outputStream: new MediaStream(stream.getAudioTracks()),
        sourceStreams,
        audioContext: null,
        micLabel,
        tabLabel,
      };
    }

    if (!micStream || !displayStream)
      throw new Error("Both audio sources are required.");
    audioContext = new AudioContext();
    await audioContext.resume();
    const destination = audioContext.createMediaStreamDestination();
    const tabSource = audioContext.createMediaStreamSource(
      new MediaStream(displayStream.getAudioTracks())
    );
    const micSource = audioContext.createMediaStreamSource(micStream);
    const tabGain = audioContext.createGain();
    const micGain = audioContext.createGain();
    tabGain.gain.value = 0.75;
    micGain.gain.value = 0.9;
    tabSource.connect(tabGain).connect(destination);
    micSource.connect(micGain).connect(destination);

    return {
      outputStream: destination.stream,
      sourceStreams,
      audioContext,
      micLabel,
      tabLabel,
    };
  } catch (error) {
    micStream?.getTracks().forEach((track) => track.stop());
    displayStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => undefined);
    throw error;
  }
}

async function uploadChunk(
  storagePrefix: string,
  callId: string,
  sequence: number,
  blob: Blob
) {
  const supabase = createBrowserSupabaseClient();
  const path = `${storagePrefix}/${sequence.toString().padStart(8, "0")}.webm`;
  const { error } = await supabase.storage
    .from("recordings")
    .upload(path, blob, {
      contentType: blob.type || "audio/webm",
      upsert: true,
    });
  if (error) throw error;
  await deleteChunk(callId, sequence);
}

async function finalizeDraft(draft: RecordingDraft) {
  const chunks = await listChunks(draft.callId);
  for (const chunk of chunks) {
    await uploadChunk(
      draft.storagePrefix,
      draft.callId,
      chunk.sequence,
      chunk.blob
    );
  }

  const response = await fetch(`/api/calls/${draft.callId}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      finalChunkSequence: draft.finalChunkSequence,
      durationMs: Math.max(1, draft.durationMs),
      mimeType: draft.mimeType,
      sourceMode: draft.sourceMode,
      micLabel: draft.micLabel,
      tabLabel: draft.tabLabel,
      degradedIntervals: draft.degradedIntervals ?? [],
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || "Unable to finalize recording");
  await deleteDraft(draft.callId);
}

export function RecorderPanel() {
  const [mode, setMode] = useState<SourceMode>("both");
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [degraded, setDegraded] = useState(false);
  const [drafts, setDrafts] = useState<RecordingDraft[]>([]);
  const [recoveringId, setRecoveringId] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureRef = useRef<ActiveCapture | null>(null);
  const draftRef = useRef<RecordingDraft | null>(null);
  const sequenceRef = useRef(-1);
  const pipelineRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppingRef = useRef(false);
  const activeSourcesRef = useRef<Set<CaptureSource>>(new Set());

  const refreshDrafts = useCallback(async () => {
    const restored = await listDrafts();
    setDrafts(restored.sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  useEffect(() => {
    let cancelled = false;
    listDrafts()
      .then((restored) => {
        if (!cancelled) {
          setDrafts(restored.sort((a, b) => b.updatedAt - a.updatedAt));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const cleanCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.sourceStreams.forEach(({ stream }) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    capture?.outputStream.getTracks().forEach((track) => track.stop());
    await capture?.audioContext?.close().catch(() => undefined);
  }, []);

  const stopRecording = useCallback(
    async (reason?: string) => {
      if (stoppingRef.current || !recorderRef.current || !draftRef.current)
        return;
      stoppingRef.current = true;
      setState("stopping");
      if (reason) setNotice(reason);
      if (timerRef.current) clearInterval(timerRef.current);

      const recorder = recorderRef.current;
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        if (recorder.state !== "inactive") recorder.stop();
        else resolve();
      });

      const durationMs = Date.now() - draftRef.current.startedAt;
      const degradedIntervals = (draftRef.current.degradedIntervals ?? []).map(
        (interval): DegradedInterval => ({
          ...interval,
          endMs: interval.endMs ?? durationMs,
        })
      );
      const stoppedDraft: RecordingDraft = {
        ...draftRef.current,
        durationMs,
        degradedIntervals,
        finalChunkSequence: sequenceRef.current,
        stopped: true,
        updatedAt: Date.now(),
      };
      draftRef.current = stoppedDraft;
      await saveDraft(stoppedDraft);
      await cleanCapture();
      recorderRef.current = null;
      setElapsedMs(durationMs);
      setState("uploading");

      try {
        await pipelineRef.current;
        if (stoppedDraft.finalChunkSequence < 0) {
          throw new Error("No audio data was recorded.");
        }
        await finalizeDraft(stoppedDraft);
        setState("queued");
        setNotice(
          "Recording saved. Audio processing and transcription are queued."
        );
        await refreshDrafts();
      } catch (stopError) {
        setState("failed");
        setError(
          stopError instanceof Error
            ? stopError.message
            : "Unable to finish upload"
        );
        await refreshDrafts();
      } finally {
        stoppingRef.current = false;
        draftRef.current = null;
      }
    },
    [cleanCapture, refreshDrafts]
  );

  async function startRecording() {
    setError("");
    setNotice("");
    setElapsedMs(0);
    setUploadedChunks(0);
    setDegraded(false);
    setState("requesting");
    sequenceRef.current = -1;
    pipelineRef.current = Promise.resolve();

    let capture: ActiveCapture | null = null;
    try {
      capture = await acquireCapture(mode);
      captureRef.current = capture;
      activeSourcesRef.current = new Set(
        capture.sourceStreams.map(({ source }) => source)
      );
      const response = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceMode: mode,
          micLabel: capture.micLabel,
          tabLabel: capture.tabLabel,
        }),
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(created.error || "Unable to create recording");

      const mimeType = supportedMimeType();
      const recorder = new MediaRecorder(
        capture.outputStream,
        mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined
      );
      const draft: RecordingDraft = {
        callId: created.callId,
        workspaceId: created.workspaceId,
        storagePrefix: created.storagePrefix,
        sourceMode: mode,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        startedAt: Date.now(),
        durationMs: 0,
        finalChunkSequence: -1,
        micLabel: capture.micLabel,
        tabLabel: capture.tabLabel,
        stopped: false,
        degradedIntervals: [],
        updatedAt: Date.now(),
      };
      await saveDraft(draft);
      draftRef.current = draft;
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || !draftRef.current) return;
        const sequence = ++sequenceRef.current;
        const currentDraft = {
          ...draftRef.current,
          durationMs: Date.now() - draftRef.current.startedAt,
          finalChunkSequence: sequence,
          updatedAt: Date.now(),
        };
        draftRef.current = currentDraft;

        pipelineRef.current = pipelineRef.current
          .catch(() => undefined)
          .then(async () => {
            await saveChunk(currentDraft.callId, sequence, event.data);
            await saveDraft(currentDraft);
            await uploadChunk(
              currentDraft.storagePrefix,
              currentDraft.callId,
              sequence,
              event.data
            );
            setUploadedChunks((count) => count + 1);
          })
          .catch((chunkError) => {
            setError(
              chunkError instanceof Error
                ? chunkError.message
                : "Chunk upload failed"
            );
            if (
              chunkError instanceof DOMException &&
              ["QuotaExceededError", "UnknownError"].includes(chunkError.name)
            ) {
              void stopRecording(
                "Local recording storage became unavailable. Saving the completed portion."
              );
            }
            throw chunkError;
          });
      });

      const handleTrackEnded = (source: CaptureSource) => {
        if (stoppingRef.current || recorder.state !== "recording") return;
        activeSourcesRef.current.delete(source);
        const remainingSources = [...activeSourcesRef.current];
        if (
          decideCaptureSourceLoss(mode, source, remainingSources) ===
          "continue_degraded"
        ) {
          const draft = draftRef.current;
          if (!draft) return;
          const degradedDraft: RecordingDraft = {
            ...draft,
            degradedIntervals: [
              ...(draft.degradedIntervals ?? []),
              {
                source,
                startMs: Date.now() - draft.startedAt,
                endMs: null,
              },
            ],
            updatedAt: Date.now(),
          };
          draftRef.current = degradedDraft;
          setDegraded(true);
          setNotice(
            `${source === "mic" ? "Microphone" : "Tab"} audio ended. Recording is continuing with ${
              remainingSources[0] === "mic" ? "microphone" : "tab"
            } audio.`
          );
          void saveDraft(degradedDraft);
          return;
        }
        void stopRecording(
          "All required audio sources ended. The completed portion is being saved."
        );
      };
      capture.sourceStreams.forEach(({ source, stream }) => {
        stream.getAudioTracks().forEach((track) => {
          track.addEventListener("ended", () => handleTrackEnded(source), {
            once: true,
          });
        });
      });

      recorder.start(10_000);
      setState("recording");
      timerRef.current = setInterval(() => {
        if (draftRef.current) {
          const currentElapsed = Date.now() - draftRef.current.startedAt;
          setElapsedMs(currentElapsed);
          if (currentElapsed >= 3 * 60 * 60 * 1_000) {
            void stopRecording(
              "The three-hour recording limit was reached. Saving now."
            );
          }
        }
      }, 250);
    } catch (startError) {
      capture?.sourceStreams.forEach(({ stream }) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      await capture?.audioContext?.close().catch(() => undefined);
      captureRef.current = null;
      setState("failed");
      setError(
        startError instanceof Error
          ? startError.message
          : "Recording could not start"
      );
    }
  }

  async function recoverDraft(draft: RecordingDraft) {
    setRecoveringId(draft.callId);
    setError("");
    try {
      await finalizeDraft({
        ...draft,
        stopped: true,
        durationMs: Math.max(
          draft.durationMs,
          draft.updatedAt - draft.startedAt
        ),
      });
      setNotice("Interrupted recording recovered and queued for processing.");
      await refreshDrafts();
    } catch (recoverError) {
      setError(
        recoverError instanceof Error ? recoverError.message : "Recovery failed"
      );
    } finally {
      setRecoveringId("");
    }
  }

  async function discardDraft(draft: RecordingDraft) {
    setRecoveringId(draft.callId);
    try {
      await fetch(`/api/calls/${draft.callId}`, { method: "DELETE" });
      await deleteCallDraft(draft.callId);
      await refreshDrafts();
    } finally {
      setRecoveringId("");
    }
  }

  const active = state === "recording";
  const busy = ["requesting", "stopping", "uploading"].includes(state);

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
            title="Successfully uploaded recording chunks"
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
              <i
                key={index}
                style={{ animationDelay: `${(index % 8) * 55}ms` }}
              />
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
              <h2>Interrupted recordings</h2>
              <p>
                Audio buffered on this device can be recovered without recording
                again.
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
                    title="Discard interrupted recording"
                    aria-label="Discard interrupted recording"
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
