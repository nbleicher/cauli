export const ROLES = ["member", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const SOURCE_MODES = ["mic", "tab", "both"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export interface DegradedInterval {
  source: "mic" | "tab";
  startMs: number;
  endMs: number | null;
}

export const CALL_STATUSES = [
  "recording",
  "uploading",
  "queued",
  "processing",
  "ready",
  "failed",
  "abandoned",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const REVIEW_STATUSES = [
  "unreviewed",
  "in_progress",
  "reviewed",
  "needs_follow_up",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type JobStatus =
  "queued" | "processing" | "retrying" | "complete" | "failed";
export type ProcessingJobKind =
  "process_recording" | "generate_wav" | "delete_call" | "cleanup_abandoned";

export interface WorkspaceMember {
  userId: string;
  workspaceId: string;
  role: Role;
}

export interface CallAccessSubject {
  id: string;
  workspaceId: string;
  ownerId: string;
}

export interface ScoreAnswer {
  criterionId: string;
  weight: number;
  value: 1 | 2 | 3 | 4 | 5 | null;
  comment?: string;
}

export interface TranscriptSegment {
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ProviderTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface CallSummary {
  id: string;
  workspaceId: string;
  ownerId: string;
  ownerName: string;
  sourceMode: SourceMode;
  status: CallStatus;
  reviewStatus: ReviewStatus;
  startedAt: string;
  durationMs: number;
  title: string | null;
  errorMessage: string | null;
}
