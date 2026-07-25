import type { ProviderTranscriptSegment, TranscriptSegment } from "./types.js";

export function offsetTranscriptSegments(
  segments: ProviderTranscriptSegment[],
  offsetMs: number,
  sequenceStart = 0
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

function comparableWord(word: string) {
  return word
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function mergeTranscriptChunks(chunks: string[]) {
  const merged: string[] = [];
  for (const chunk of chunks) {
    const incoming = chunk.trim().split(/\s+/).filter(Boolean);
    let overlap = 0;
    const maxOverlap = Math.min(merged.length, incoming.length);
    for (let size = maxOverlap; size > 0; size -= 1) {
      const existingBoundary = merged.slice(-size).map(comparableWord);
      const incomingBoundary = incoming.slice(0, size).map(comparableWord);
      if (
        existingBoundary.every(
          (word, index) => word === incomingBoundary[index]
        )
      ) {
        overlap = size;
        break;
      }
    }
    merged.push(...incoming.slice(overlap));
  }
  return merged.join(" ").trim();
}
