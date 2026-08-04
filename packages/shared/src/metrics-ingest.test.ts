import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCallEndedEvent,
  buildCallStartedEvent,
  callEndedDedupKey,
  callStartedDedupKey,
  deliverCallEnded,
  deliverCallStarted,
  emitCallEnded,
  emitCallStarted,
  metricsConfigured,
  type MetricsEventBody,
} from "./metrics-ingest.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("metrics event builders", () => {
  it("uses call id + phase as the dedup key and carries profile id as agent", () => {
    const callId = "11111111-1111-1111-1111-111111111111";
    const profileId = "22222222-2222-2222-2222-222222222222";

    const started = buildCallStartedEvent(
      {
        callId,
        profileId,
        occurredAt: "2026-08-03T18:00:00.000Z",
      },
      () => "event-started"
    );
    expect(started).toEqual({
      event_id: "event-started",
      dedup_key: callStartedDedupKey(callId),
      type: "call.started",
      actor: "agent",
      occurred_at: "2026-08-03T18:00:00.000Z",
      source: "cauli",
      source_agent_identity: profileId,
      payload: { agent: profileId },
    });
    expect(started.payload).not.toHaveProperty("contact");
    expect(started).not.toHaveProperty("contact_ref");

    const ended = buildCallEndedEvent(
      {
        callId,
        profileId,
        durationMs: 125_000,
        recordingRef: "workspace/call/artifacts/recording.mp3",
        occurredAt: "2026-08-03T18:05:00.000Z",
      },
      () => "event-ended"
    );
    expect(ended.dedup_key).toBe(callEndedDedupKey(callId));
    expect(ended.type).toBe("call.ended");
    expect(ended.payload).toEqual({
      agent: profileId,
      duration_ms: 125_000,
      recording_ref: "workspace/call/artifacts/recording.mp3",
    });
    expect(ended.payload).not.toHaveProperty("contact");
    expect(ended).not.toHaveProperty("contact_ref");
  });

  it("omits recording_ref when none is available at finalize time", () => {
    const ended = buildCallEndedEvent(
      {
        callId: "call-1",
        profileId: "profile-1",
        durationMs: 1_000,
      },
      () => "e1",
      () => new Date("2026-08-03T18:05:00.000Z")
    );
    expect(ended.payload).toEqual({
      agent: "profile-1",
      duration_ms: 1_000,
    });
    expect(ended.occurred_at).toBe("2026-08-03T18:05:00.000Z");
  });
});

describe("metricsConfigured", () => {
  it("requires both URL and shared secret", () => {
    expect(metricsConfigured({})).toBe(false);
    expect(metricsConfigured({ apiUrl: "https://metrics.example" })).toBe(
      false
    );
    expect(metricsConfigured({ secret: "secret" })).toBe(false);
    expect(
      metricsConfigured({
        apiUrl: "https://metrics.example",
        secret: "secret",
      })
    ).toBe(true);
  });
});

describe("metrics delivery", () => {
  it("skips when env is unset so local recording stays unblocked", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        { fetchImpl }
      )
    ).resolves.toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to /ingest/cauli with the shared secret", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await deliverCallStarted(
      {
        callId: "call-1",
        profileId: "profile-1",
        occurredAt: "2026-08-03T18:00:00.000Z",
      },
      {
        apiUrl: "https://metrics.example/",
        secret: "cauli-secret",
        fetchImpl,
        uuid: () => "evt-1",
      }
    );

    expect(result).toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const callArgs = fetchImpl.mock.calls[0] as unknown as
      [string, RequestInit | undefined] | undefined;
    expect(callArgs?.[0]).toBe("https://metrics.example/ingest/cauli");
    const init = callArgs?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Ingest-Secret": "cauli-secret",
    });
    const body = JSON.parse(String(init?.body)) as MetricsEventBody;
    expect(body.dedup_key).toBe("call-1:started");
    expect(body.payload.agent).toBe("profile-1");
  });

  it("retries after failure then delivers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const scheduleRetry = vi.fn((fn: () => void) => fn());

    await expect(
      deliverCallEnded(
        {
          callId: "call-1",
          profileId: "profile-1",
          durationMs: 5_000,
          recordingRef: "call-1",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry,
          backoffMs: [0],
          maxAttempts: 3,
          uuid: () => "evt-ended",
          now: () => new Date("2026-08-03T18:05:00.000Z"),
        }
      )
    ).resolves.toBe("delivered");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(scheduleRetry).toHaveBeenCalled();
  });

  it("treats a 422 held answer as delivered because the backend keeps the event for replay", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "held",
            reason: "unmapped_agent",
            held_event_id: "33333333-3333-3333-3333-333333333333",
            source: "cauli",
            source_identity: "profile-1",
            detail:
              "source-agent identity has no mapping; event held for replay",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        )
    );
    const scheduleRetry = vi.fn((fn: () => void) => fn());

    await expect(
      deliverCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry,
          backoffMs: [0],
          maxAttempts: 5,
          uuid: () => "evt-1",
        }
      )
    ).resolves.toBe("delivered");

    // Every retry would create another held-event row and operator alert.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("stops after one attempt on a 422 that is not held", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "invalid payload" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(
      deliverCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry: (fn) => fn(),
          backoffMs: [0],
          maxAttempts: 5,
          uuid: () => "evt-1",
        }
      )
    ).resolves.toBe("rejected");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("stops after one attempt on other permanent 4xx answers", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));

    await expect(
      deliverCallEnded(
        {
          callId: "call-1",
          profileId: "profile-1",
          durationMs: 5_000,
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry: (fn) => fn(),
          backoffMs: [0],
          maxAttempts: 5,
          uuid: () => "evt-1",
          now: () => new Date("2026-08-03T18:05:00.000Z"),
        }
      )
    ).resolves.toBe("rejected");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying 5xx answers until delivery", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    await expect(
      deliverCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry: (fn) => fn(),
          backoffMs: [0],
          maxAttempts: 3,
          uuid: () => "evt-1",
        }
      )
    ).resolves.toBe("delivered");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      deliverCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          scheduleRetry: (fn) => fn(),
          backoffMs: [0],
          maxAttempts: 2,
          uuid: () => "evt-1",
        }
      )
    ).resolves.toBe("exhausted");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fire-and-forget helpers do not return a promise the route must await", () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    expect(
      emitCallStarted(
        {
          callId: "call-1",
          profileId: "profile-1",
          occurredAt: "2026-08-03T18:00:00.000Z",
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          uuid: () => "evt-1",
        }
      )
    ).toBeUndefined();
    expect(
      emitCallEnded(
        {
          callId: "call-1",
          profileId: "profile-1",
          durationMs: 10,
        },
        {
          apiUrl: "https://metrics.example",
          secret: "secret",
          fetchImpl,
          uuid: () => "evt-2",
          now: () => new Date("2026-08-03T18:05:00.000Z"),
        }
      )
    ).toBeUndefined();
  });
});
