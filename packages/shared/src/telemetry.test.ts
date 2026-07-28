import { describe, expect, it } from "vitest";
import {
  classifyTelemetryRoute,
  findForbiddenTelemetry,
  scrubTelemetryValue,
  TELEMETRY_DISABLED_FEATURES,
  TELEMETRY_FREE_PLAN_QUOTA,
  telemetryQuotaAlerts,
  telemetrySampleRate,
  telemetrySamplingFromEnv,
} from "./index.js";

/**
 * The canary. Every value the specification forbids appears here at least
 * once, in the shapes a real event would carry them: as a field, nested in a
 * breadcrumb, and buried in free-form message text.
 */
const canaryEvent = {
  message:
    "Call 'Q3 renewal with Acme' failed for dana@example.com at https://cauli.pro/calls/9?token=secret-value. Customer agreed to confidential acquisition.",
  user: { email: "dana@example.com", ip_address: "203.0.113.7", id: "u_1" },
  request: {
    url: "https://app.cauli.pro/api/calls/9/media?format=source&download=1",
    query_string: "format=source&signature=abc123",
    cookies: "sb-access-token=eyJhbGciOiJIUzI1NiJ9.payload.signature",
    headers: {
      Authorization: `Bearer ${["sb", "secret", "canary", "credential"].join("_")}`,
      "user-agent": "Mozilla/5.0",
    },
    data: { title: "Q3 renewal with Acme", transcript: "we agreed to renew" },
  },
  extra: {
    signedUrl: `https://project.supabase.co/storage/v1/object/sign/recordings/a.webm?${["to", "ken"].join("")}=${["eyJ", "canary", "signature"].join(".")}`,
    filename: "/Users/dana/Recordings/q3-renewal.webm",
    apiKey: ["sk", "or", "v1", "canary123456"].join("-"),
    reviewSummary: "The rep talked over the customer twice.",
    callId: "9f1c2d3e",
    durationMs: 3_600_000,
  },
  breadcrumbs: [
    {
      category: "fetch",
      message: "POST https://openrouter.ai/api/v1/audio/transcriptions",
      data: { body: '{"input_audio":"AAAA"}' },
    },
  ],
};

const canaryContent = [
  "Q3 renewal with Acme",
  "Customer agreed to confidential acquisition",
  "we agreed to renew",
  "The rep talked over the customer twice.",
] as const;

describe("telemetry scrubbing", () => {
  it("lets no forbidden value out of the canary event", () => {
    const scrubbed = scrubTelemetryValue(canaryEvent);
    expect(findForbiddenTelemetry(scrubbed, canaryContent)).toEqual([]);
  });

  it("would have caught the leak if scrubbing were skipped", () => {
    // Without this the canary above could pass because the fixture is clean.
    expect(findForbiddenTelemetry(canaryEvent, canaryContent)).toEqual(
      expect.arrayContaining([
        "email",
        "url",
        "credential",
        "ip address",
        ...canaryContent.map((value) => `content:${value}`),
      ])
    );
  });

  it("keeps the operational fields that make an event worth sending", () => {
    const scrubbed = scrubTelemetryValue(canaryEvent) as {
      user: { id: string };
      extra: { callId: string; durationMs: number };
    };
    expect(scrubbed.user.id).toBe("u_1");
    expect(scrubbed.extra.callId).toBe("9f1c2d3e");
    expect(scrubbed.extra.durationMs).toBe(3_600_000);
  });

  it("drops shapes it cannot reason about rather than serializing them", () => {
    class Opaque {
      secretHolder = "dana@example.com";
    }
    const scrubbed = scrubTelemetryValue({
      opaque: new Opaque(),
      fn: () => "dana@example.com",
      cyclicDepth: {
        a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } },
      },
    }) as Record<string, unknown>;
    expect(scrubbed.opaque).toBe("[redacted]");
    expect(scrubbed.fn).toBeUndefined();
    expect(findForbiddenTelemetry(scrubbed)).toEqual([]);
  });

  it("names every content-bearing provider feature that must stay off", () => {
    expect(TELEMETRY_DISABLED_FEATURES).toEqual([
      "session_replay",
      "screenshots",
      "attachments",
      "user_feedback",
      "profiling",
      "console_logs",
      "log_ingestion",
      "seer_ai",
      "automatic_request_body_capture",
      "default_pii",
    ]);
  });
});

describe("telemetry sampling", () => {
  it("never samples static assets, health polling, or chunk uploads", () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/api/health",
      "/api/status",
      "/favicon.ico",
      "/logo.png",
      "/storage/v1/object/workspace/call/chunks/0001.webm",
    ]) {
      expect(classifyTelemetryRoute(path)).toBe("excluded");
      expect(telemetrySampleRate(path)).toBe(0);
    }
  });

  it("keeps every critical journey and samples routine traffic at 10%", () => {
    expect(telemetrySampleRate("/record")).toBe(1);
    expect(telemetrySampleRate("/api/calls/9/finalize")).toBe(1);
    expect(telemetrySampleRate("/login")).toBe(1);
    expect(telemetrySampleRate("/workspace")).toBeCloseTo(0.1);
    expect(telemetrySampleRate("/admin/scorecards")).toBeCloseTo(0.1);
  });

  it("is environment-configurable and ignores values outside 0 to 1", () => {
    expect(
      telemetrySamplingFromEnv({ TELEMETRY_ROUTINE_SAMPLE_RATE: "0.25" })
    ).toEqual({ criticalRate: 1, routineRate: 0.25 });
    expect(
      telemetrySamplingFromEnv({ TELEMETRY_ROUTINE_SAMPLE_RATE: "4" })
    ).toEqual({ criticalRate: 1, routineRate: 0.1 });
    expect(telemetrySamplingFromEnv({})).toEqual({
      criticalRate: 1,
      routineRate: 0.1,
    });
  });

  it("alerts at 80% of the free plan's error and span quotas", () => {
    expect(
      telemetryQuotaAlerts({
        errorsUsed: 4_000,
        spansUsed: 1_000,
        ...TELEMETRY_FREE_PLAN_QUOTA,
      })
    ).toEqual(["telemetry.error_quota"]);
    expect(
      telemetryQuotaAlerts({
        errorsUsed: 10,
        spansUsed: 4_500_000,
        ...TELEMETRY_FREE_PLAN_QUOTA,
      })
    ).toEqual(["telemetry.span_quota"]);
    expect(
      telemetryQuotaAlerts({
        errorsUsed: 10,
        spansUsed: 10,
        ...TELEMETRY_FREE_PLAN_QUOTA,
      })
    ).toEqual([]);
  });
});
