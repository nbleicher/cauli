/**
 * Summit metrics side effects for Call lifecycle routes.
 * Mirrors audit emission placement (after the primary success path) but is
 * fire-and-forget: metrics must never block or fail recording.
 */
import {
  emitCallEnded,
  emitCallStarted,
  metricsConfigFromEnv,
} from "@calllog/shared";

export function emitCallStartedMetric(input: {
  callId: string;
  profileId: string;
  occurredAt: string;
}) {
  emitCallStarted(input, metricsConfigFromEnv());
}

export function emitCallEndedMetric(input: {
  callId: string;
  profileId: string;
  durationMs: number;
  recordingRef?: string;
  occurredAt?: string;
}) {
  emitCallEnded(input, metricsConfigFromEnv());
}
