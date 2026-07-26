import type { CaptureSource, DegradedInterval } from "@calllog/shared";
import type { RecordingDraft } from "@/lib/recording-db";

export const MAX_RECORDING_DURATION_MS = 3 * 60 * 60 * 1_000;

export type RecordingControllerState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "uploading"
  | "queued"
  | "failed";

export function stoppedRecordingDraft(
  draft: RecordingDraft,
  finalChunkSequence: number,
  stoppedAt = Date.now()
) {
  const durationMs = stoppedAt - draft.startedAt;
  const degradedIntervals = (draft.degradedIntervals ?? []).map(
    (interval): DegradedInterval => ({
      ...interval,
      endMs: interval.endMs ?? durationMs,
    })
  );
  return {
    ...draft,
    durationMs,
    degradedIntervals,
    finalChunkSequence,
    stopped: true,
    updatedAt: stoppedAt,
  };
}

export function recoverableRecordingDraft(draft: RecordingDraft) {
  return {
    ...draft,
    stopped: true,
    durationMs: Math.max(draft.durationMs, draft.updatedAt - draft.startedAt),
  };
}

export function degradedRecordingDraft(
  draft: RecordingDraft,
  source: CaptureSource,
  now = Date.now()
) {
  return {
    ...draft,
    degradedIntervals: [
      ...(draft.degradedIntervals ?? []),
      {
        source,
        startMs: now - draft.startedAt,
        endMs: null,
      },
    ],
    updatedAt: now,
  };
}
