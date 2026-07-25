import type {
  ProviderTranscriptSegment,
  TranscriptSegment,
} from "./types.js";

export function offsetTranscriptSegments(
  segments: ProviderTranscriptSegment[],
  offsetMs: number,
  sequenceStart = 0,
): TranscriptSegment[] {
  return segments.map((segment, index) => ({
    sequence: sequenceStart + index,
    startMs: Math.max(0, Math.round(segment.start * 1000) + offsetMs),
    endMs: Math.max(0, Math.round(segment.end * 1000) + offsetMs),
    text: segment.text.trim(),
  }));
}

export function transcriptText(segments: TranscriptSegment[]) {
  return segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(" ")
    .trim();
}
