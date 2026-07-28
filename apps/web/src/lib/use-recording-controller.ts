"use client";

import {
  decideCaptureSourceLoss,
  type CaptureSource,
  type SourceMode,
} from "@calllog/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireCapture,
  closeActiveCapture,
  supportedRecordingMimeType,
  type ActiveCapture,
} from "@/lib/recording-capture";
import {
  discardRecordingDraft,
  finalizeRecordingDraft,
  listRecoverableRecordingDrafts,
  persistAndUploadRecordingChunk,
  persistRecordingDraft,
} from "@/lib/recording-persistence";
import type { RecordingDraft } from "@/lib/recording-db";
import {
  degradedRecordingDraft,
  MAX_RECORDING_DURATION_MS,
  recoverableRecordingDraft,
  stoppedRecordingDraft,
  type RecordingControllerState,
} from "@/lib/recording-controller";

export function useRecordingController() {
  const [mode, setMode] = useState<SourceMode>("both");
  const [state, setState] = useState<RecordingControllerState>("idle");
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
    setDrafts(await listRecoverableRecordingDrafts());
  }, []);

  const cleanCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    await closeActiveCapture(capture);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listRecoverableRecordingDrafts()
      .then((restored) => {
        if (!cancelled) setDrafts(restored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") recorder.stop();

      void cleanCapture();
    };
  }, [cleanCapture]);

  useEffect(() => {
    if (state !== "recording") return;

    const warnBeforeWindowLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const confirmNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      const link = target instanceof Element ? target.closest("a[href]") : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      ) {
        return;
      }
      if (
        !window.confirm(
          "Leave this recording? The captured portion will be saved as an Incomplete Recording."
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", warnBeforeWindowLeave);
    document.addEventListener("click", confirmNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeWindowLeave);
      document.removeEventListener("click", confirmNavigation, true);
    };
  }, [state]);

  const stopRecording = useCallback(
    async (reason?: string) => {
      if (stoppingRef.current || !recorderRef.current || !draftRef.current) {
        return;
      }
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

      const stoppedDraft = stoppedRecordingDraft(
        draftRef.current,
        sequenceRef.current
      );
      draftRef.current = stoppedDraft;
      await persistRecordingDraft(stoppedDraft);
      await cleanCapture();
      recorderRef.current = null;
      setElapsedMs(stoppedDraft.durationMs);
      setState("uploading");

      try {
        await pipelineRef.current;
        if (stoppedDraft.finalChunkSequence < 0) {
          throw new Error("No audio data was recorded.");
        }
        await finalizeRecordingDraft(stoppedDraft);
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

  async function startRecording({
    recordingAttested,
    title,
  }: {
    recordingAttested: true;
    title: string;
  }) {
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
          title,
          recordingAttested,
        }),
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(created.error || "Unable to create Recording");
      }

      const mimeType = supportedRecordingMimeType();
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
      await persistRecordingDraft(draft);
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
            await persistAndUploadRecordingChunk(
              currentDraft,
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
          const degradedDraft = degradedRecordingDraft(draft, source);
          draftRef.current = degradedDraft;
          setDegraded(true);
          setNotice(
            `${source === "mic" ? "Microphone" : "Tab"} audio ended. Recording is continuing with ${
              remainingSources[0] === "mic" ? "microphone" : "tab"
            } audio.`
          );
          void persistRecordingDraft(degradedDraft);
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
          if (currentElapsed >= MAX_RECORDING_DURATION_MS) {
            void stopRecording(
              "The three-hour recording limit was reached. Saving now."
            );
          }
        }
      }, 250);
      return true;
    } catch (startError) {
      await closeActiveCapture(capture);
      captureRef.current = null;
      setState("failed");
      setError(
        startError instanceof Error
          ? startError.message
          : "Recording could not start"
      );
      return false;
    }
  }

  async function recoverDraft(draft: RecordingDraft) {
    setRecoveringId(draft.callId);
    setError("");
    try {
      await finalizeRecordingDraft(recoverableRecordingDraft(draft));
      setNotice("Interrupted Recording recovered and queued for processing.");
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
    setError("");
    try {
      await discardRecordingDraft(draft);
      await refreshDrafts();
    } catch (discardError) {
      setError(
        discardError instanceof Error
          ? discardError.message
          : "Unable to discard Incomplete Recording"
      );
    } finally {
      setRecoveringId("");
    }
  }

  return {
    active: state === "recording",
    busy: ["requesting", "stopping", "uploading"].includes(state),
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
  };
}
