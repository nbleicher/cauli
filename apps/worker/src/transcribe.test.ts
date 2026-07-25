import { describe, expect, it } from "vitest";
import { offsetTranscriptSegments, transcriptText } from "@calllog/shared";

describe("worker transcript merge", () => {
  it("applies ten-minute source offsets without changing segment order", () => {
    const first = offsetTranscriptSegments([
      { start: 1, end: 2, text: "First" },
    ], 0, 0);
    const second = offsetTranscriptSegments([
      { start: 0.5, end: 1.5, text: "Second" },
    ], 600_000, first.length);
    const merged = [...first, ...second];

    expect(merged[1]?.startMs).toBe(600_500);
    expect(transcriptText(merged)).toBe("First Second");
  });
});
