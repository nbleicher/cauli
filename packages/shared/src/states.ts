import type { CallStatus } from "./types.js";

const ALLOWED_TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  recording: ["uploading", "abandoned", "failed"],
  uploading: ["queued", "abandoned", "failed"],
  queued: ["processing", "failed"],
  processing: ["ready", "failed"],
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
