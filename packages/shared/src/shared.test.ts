import { describe, expect, it } from "vitest";
import {
  calculateNormalizedScore,
  canDeleteCall,
  canReviewCall,
  canTransitionCall,
  canViewCall,
  offsetTranscriptSegments,
  transcriptText,
} from "./index.js";

const call = { id: "call", workspaceId: "workspace", ownerId: "owner" };

describe("calculateNormalizedScore", () => {
  it("normalizes weighted 1-5 answers to 0-100", () => {
    expect(calculateNormalizedScore([
      { criterionId: "a", value: 5, weight: 3 },
      { criterionId: "b", value: 1, weight: 1 },
    ])).toBe(75);
  });

  it("excludes N/A answers", () => {
    expect(calculateNormalizedScore([
      { criterionId: "a", value: 3, weight: 2 },
      { criterionId: "b", value: null, weight: 100 },
    ])).toBe(50);
    expect(calculateNormalizedScore([])).toBeNull();
  });
});

describe("authorization", () => {
  it("limits members to their calls", () => {
    expect(canViewCall({ userId: "owner", workspaceId: "workspace", role: "member" }, call)).toBe(true);
    expect(canViewCall({ userId: "other", workspaceId: "workspace", role: "member" }, call)).toBe(false);
  });

  it("allows managers to review but not delete another user's call", () => {
    const manager = { userId: "manager", workspaceId: "workspace", role: "manager" } as const;
    expect(canReviewCall(manager, call)).toBe(true);
    expect(canDeleteCall(manager, call)).toBe(false);
  });
});

describe("call transitions", () => {
  it("accepts the processing path and rejects skips", () => {
    expect(canTransitionCall("recording", "uploading")).toBe(true);
    expect(canTransitionCall("uploading", "ready")).toBe(false);
  });
});

describe("transcript helpers", () => {
  it("offsets and joins provider segments", () => {
    const segments = offsetTranscriptSegments([
      { start: 0.25, end: 1.5, text: " Hello " },
    ], 10_000, 3);

    expect(segments).toEqual([{
      sequence: 3,
      startMs: 10_250,
      endMs: 11_500,
      text: "Hello",
    }]);
    expect(transcriptText(segments)).toBe("Hello");
  });
});
