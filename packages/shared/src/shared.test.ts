import { describe, expect, it } from "vitest";
import {
  calculateNormalizedScore,
  canDeleteCall,
  canReviewCall,
  canTransitionCall,
  canViewCall,
  decideCaptureSourceLoss,
  offsetTranscriptSegments,
  transcriptText,
  mergeTranscriptChunks,
  validateReviewCompletion,
} from "./index.js";

const call = { id: "call", workspaceId: "workspace", ownerId: "owner" };

describe("calculateNormalizedScore", () => {
  it("normalizes weighted 1-5 answers to 0-100", () => {
    expect(
      calculateNormalizedScore([
        { criterionId: "a", value: 5, weight: 3 },
        { criterionId: "b", value: 1, weight: 1 },
      ])
    ).toBe(75);
  });

  it("excludes N/A answers", () => {
    expect(
      calculateNormalizedScore([
        { criterionId: "a", value: 3, weight: 2 },
        { criterionId: "b", value: null, weight: 100 },
      ])
    ).toBe(50);
    expect(calculateNormalizedScore([])).toBeNull();
  });
});

describe("authorization", () => {
  it("limits members to their calls", () => {
    expect(
      canViewCall(
        { userId: "owner", workspaceId: "workspace", role: "member" },
        call
      )
    ).toBe(true);
    expect(
      canViewCall(
        { userId: "other", workspaceId: "workspace", role: "member" },
        call
      )
    ).toBe(false);
  });

  it("allows managers to review but not delete another user's call", () => {
    const manager = {
      userId: "manager",
      workspaceId: "workspace",
      role: "manager",
    } as const;
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

describe("capture source loss", () => {
  it("continues a Both recording in a degraded state while one audio source survives", () => {
    expect(decideCaptureSourceLoss("both", "mic", ["tab"])).toBe(
      "continue_degraded"
    );
    expect(decideCaptureSourceLoss("both", "tab", ["mic"])).toBe(
      "continue_degraded"
    );
  });

  it("stops and saves when no required audio source survives", () => {
    expect(decideCaptureSourceLoss("both", "mic", [])).toBe("stop_and_save");
    expect(decideCaptureSourceLoss("mic", "mic", [])).toBe("stop_and_save");
  });
});

describe("transcript helpers", () => {
  it("offsets and joins provider segments", () => {
    const segments = offsetTranscriptSegments(
      [{ start: 0.25, end: 1.5, text: " Hello " }],
      10_000,
      3
    );

    expect(segments).toEqual([
      {
        sequence: 3,
        startMs: 10_250,
        endMs: 11_500,
        text: "Hello",
      },
    ]);
    expect(transcriptText(segments)).toBe("Hello");
  });

  it("merges overlapping chunk text without duplicating the boundary", () => {
    expect(
      mergeTranscriptChunks([
        "We need to call Sarah tomorrow morning",
        "tomorrow morning before the meeting",
      ])
    ).toBe("We need to call Sarah tomorrow morning before the meeting");
  });
});

describe("validateReviewCompletion", () => {
  it("rejects scores outside the 1-5 scale", () => {
    expect(
      validateReviewCompletion(
        {
          status: "reviewed",
          summary: "Completed review.",
          answers: [{ criterionId: "required", value: 6 }],
        },
        [{ id: "required", required: true }]
      )
    ).toContainEqual({
      field: "answers.required",
      message: "Scores must be an integer from 1 to 5.",
    });
  });

  it("rejects a completed Review with an unanswered required criterion", () => {
    expect(
      validateReviewCompletion(
        {
          status: "reviewed",
          summary: "Solid call overall.",
          answers: [{ criterionId: "required", value: null, comment: "" }],
        },
        [{ id: "required", required: true }]
      )
    ).toEqual([
      {
        field: "answers.required",
        message: "Required criteria must have a score from 1 to 5.",
      },
    ]);
  });

  it("rejects a completed Review when a required criterion is missing", () => {
    expect(
      validateReviewCompletion(
        {
          status: "reviewed",
          summary: "Solid call overall.",
          answers: [],
        },
        [{ id: "required", required: true }]
      )
    ).toEqual([
      {
        field: "answers.required",
        message: "Required criteria must have a score from 1 to 5.",
      },
    ]);
  });

  it("requires a summary when a Review is submitted", () => {
    expect(
      validateReviewCompletion(
        {
          status: "reviewed",
          summary: "   ",
          answers: [],
        },
        []
      )
    ).toEqual([
      { field: "summary", message: "Submitted Reviews require a summary." },
    ]);
  });

  it("requires a follow-up explanation for Needs Follow-up", () => {
    expect(
      validateReviewCompletion(
        {
          status: "needs_follow_up",
          summary: "The call needs another pass.",
          followUp: "",
          answers: [],
        },
        []
      )
    ).toEqual([
      {
        field: "followUp",
        message: "Needs Follow-up requires an explanation.",
      },
    ]);
  });
});
