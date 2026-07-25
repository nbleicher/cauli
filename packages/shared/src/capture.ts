import type { SourceMode } from "./types.js";

export type CaptureSource = "mic" | "tab";
export type CaptureSourceLossAction = "continue_degraded" | "stop_and_save";

export function decideCaptureSourceLoss(
  mode: SourceMode,
  _lostSource: CaptureSource,
  remainingSources: CaptureSource[]
): CaptureSourceLossAction {
  return mode === "both" && remainingSources.length > 0
    ? "continue_degraded"
    : "stop_and_save";
}
