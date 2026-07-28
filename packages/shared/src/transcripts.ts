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

function clockParts(totalMs: number) {
  const safeMs = Math.max(0, Math.round(totalMs));
  return {
    hours: Math.floor(safeMs / 3_600_000),
    minutes: Math.floor(safeMs / 60_000) % 60,
    seconds: Math.floor(safeMs / 1_000) % 60,
    milliseconds: safeMs % 1_000,
  };
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

/**
 * SubRip's timestamp, which is not negotiable: `hh:mm:ss,mmm`, a comma before
 * the milliseconds and every field zero-padded. Players drop a cue outright
 * when any of that is wrong, so this is exact rather than approximately right.
 */
export function srtTimestamp(totalMs: number) {
  const { hours, minutes, seconds, milliseconds } = clockParts(totalMs);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

function orderedSegments(segments: TranscriptSegment[]) {
  return segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .filter((segment) => segment.text.trim().length > 0);
}

/**
 * A Transcript as SubRip cues, numbered from one and ordered by sequence.
 *
 * A cue whose end is not after its start is invalid, and provider segments do
 * arrive that way, so an end is nudged a millisecond past its start rather
 * than emitted as a cue that will never display.
 */
export function transcriptSrt(segments: TranscriptSegment[]) {
  return orderedSegments(segments)
    .map((segment, index) => {
      const endMs = Math.max(segment.endMs, segment.startMs + 1);
      return [
        String(index + 1),
        `${srtTimestamp(segment.startMs)} --> ${srtTimestamp(endMs)}`,
        segment.text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
}

/**
 * A Transcript as readable text, one timestamped line per segment. The
 * timestamp is what makes it usable next to the audio; without it the file is
 * a wall of prose nobody can navigate.
 */
export function transcriptTxt(segments: TranscriptSegment[]) {
  const body = orderedSegments(segments)
    .map((segment) => {
      const { hours, minutes, seconds } = clockParts(segment.startMs);
      return `[${pad(hours)}:${pad(minutes)}:${pad(seconds)}] ${segment.text.trim()}`;
    })
    .join("\n");
  return body ? `${body}\n` : "";
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
