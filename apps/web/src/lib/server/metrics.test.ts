import { afterEach, describe, expect, it, vi } from "vitest";

const emitCallStarted = vi.fn();
const emitCallEnded = vi.fn();

vi.mock("@calllog/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calllog/shared")>();
  return {
    ...actual,
    emitCallStarted: (...args: unknown[]) => emitCallStarted(...args),
    emitCallEnded: (...args: unknown[]) => emitCallEnded(...args),
    metricsConfigFromEnv: () => ({
      apiUrl: "https://metrics.example",
      secret: "secret",
    }),
  };
});

afterEach(() => {
  emitCallStarted.mockReset();
  emitCallEnded.mockReset();
});

describe("Call metrics side effects", () => {
  it("forwards call.started and call.ended without inventing contact fields", async () => {
    const { emitCallEndedMetric, emitCallStartedMetric } = await import(
      "./metrics.js"
    );

    emitCallStartedMetric({
      callId: "call-1",
      profileId: "profile-1",
      occurredAt: "2026-08-03T18:00:00.000Z",
    });
    emitCallEndedMetric({
      callId: "call-1",
      profileId: "profile-1",
      durationMs: 12_000,
      recordingRef: "call-1",
    });

    expect(emitCallStarted).toHaveBeenCalledWith(
      {
        callId: "call-1",
        profileId: "profile-1",
        occurredAt: "2026-08-03T18:00:00.000Z",
      },
      expect.objectContaining({
        apiUrl: "https://metrics.example",
        secret: "secret",
      })
    );
    expect(emitCallEnded).toHaveBeenCalledWith(
      {
        callId: "call-1",
        profileId: "profile-1",
        durationMs: 12_000,
        recordingRef: "call-1",
      },
      expect.objectContaining({
        apiUrl: "https://metrics.example",
        secret: "secret",
      })
    );
    const startedPayload = emitCallStarted.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const endedPayload = emitCallEnded.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(startedPayload).not.toHaveProperty("contact");
    expect(endedPayload).not.toHaveProperty("contact");
  });
});
