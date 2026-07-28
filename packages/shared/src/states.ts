import type { CallStatus } from "./types.js";

const ALLOWED_TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  recording: ["uploading", "abandoned", "failed"],
  uploading: ["queued", "abandoned", "failed"],
  queued: ["processing", "budget_paused", "failed"],
  processing: ["ready", "budget_paused", "failed"],
  // Budget Paused is a wait, not an outcome: the only way forward is back into
  // the queue, and the only way sideways is the same abandonment or failure any
  // queued Call can meet.
  budget_paused: ["queued", "failed", "abandoned"],
  ready: ["queued"],
  failed: ["queued", "abandoned"],
  abandoned: ["uploading"],
};

export function canTransitionCall(from: CallStatus, to: CallStatus) {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertCallTransition(from: CallStatus, to: CallStatus) {
  if (!canTransitionCall(from, to)) {
    throw new Error(`Invalid call status transition: ${from} -> ${to}`);
  }
}
