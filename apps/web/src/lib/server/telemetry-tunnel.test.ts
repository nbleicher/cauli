import { findForbiddenTelemetry } from "@calllog/shared";
import { createEventEnvelope, serializeEnvelope } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { parseDsn, prepareTelemetryEnvelope } from "./telemetry-tunnel";

const dsn = parseDsn("https://publickey@o4507.ingest.us.sentry.io/6001")!;

function envelope(header: object, items: Array<[object, object]>) {
  return [
    JSON.stringify(header),
    ...items.flatMap(([itemHeader, payload]) => [
      JSON.stringify(itemHeader),
      JSON.stringify(payload),
    ]),
    "",
  ].join("\n");
}

describe("telemetry tunnel", () => {
  it("resolves the envelope endpoint from the configured DSN", () => {
    expect(dsn).toMatchObject({
      publicKey: "publickey",
      host: "o4507.ingest.us.sentry.io",
      projectId: "6001",
      envelopeUrl: "https://o4507.ingest.us.sentry.io/api/6001/envelope/",
    });
    expect(parseDsn("not-a-dsn")).toBeNull();
    expect(parseDsn("https://o4507.ingest.us.sentry.io/6001")).toBeNull();
  });

  it("refuses an envelope addressed to another project", () => {
    const foreign = envelope(
      {
        event_id: "1",
        dsn: "https://other@o1.ingest.us.sentry.io/999",
      },
      [[{ type: "event" }, { message: "hello" }]]
    );
    expect(prepareTelemetryEnvelope(foreign, dsn)).toMatchObject({
      body: null,
      reason: "foreign_dsn",
    });
  });

  it("drops item types that could carry content", () => {
    const withAttachment = envelope({ event_id: "1" }, [
      [{ type: "attachment", filename: "screenshot.png" }, { data: "AAAA" }],
      [{ type: "profile" }, { samples: [] }],
    ]);
    expect(prepareTelemetryEnvelope(withAttachment, dsn)).toMatchObject({
      body: null,
      droppedItems: 2,
      reason: "nothing_forwardable",
    });
  });

  it("drops trace transactions from routes that are never sampled", () => {
    const polling = envelope({ event_id: "1" }, [
      [{ type: "transaction" }, { transaction: "/api/health" }],
      [
        { type: "transaction" },
        {
          transaction: "chunk upload",
          request: {
            url: "https://app.cauli.pro/storage/v1/object/w/c/chunks/1.webm",
          },
        },
      ],
    ]);
    expect(prepareTelemetryEnvelope(polling, dsn)).toMatchObject({
      body: null,
      droppedItems: 2,
    });
  });

  it("forwards scrubbed errors even when they happen on an excluded trace route", () => {
    const pollingError = envelope({ event_id: "1" }, [
      [
        { type: "event" },
        {
          transaction: "/api/health",
          level: "error",
          message: "health failed for dana@example.com",
          request: {
            url: "https://app.cauli.pro/api/health?token=abc",
          },
        },
      ],
    ]);

    const prepared = prepareTelemetryEnvelope(pollingError, dsn);
    expect(prepared).toMatchObject({
      droppedItems: 0,
      reason: "forwarded",
    });
    expect(prepared.body).not.toBeNull();
    expect(prepared.body).not.toContain("dana@example.com");
    expect(prepared.body).not.toContain("token=abc");
    expect(
      findForbiddenTelemetry(prepared.body!.split("\n").slice(1).join("\n"))
    ).toEqual([]);
  });

  it("preserves validated protocol fields from an actual Sentry SDK envelope", () => {
    const sdkEnvelope = createEventEnvelope(
      {
        event_id: "0123456789abcdef0123456789abcdef",
        level: "error",
        message: "failed for dana@example.com",
      },
      {
        protocol: "https",
        publicKey: dsn.publicKey,
        host: dsn.host,
        path: "",
        projectId: dsn.projectId,
      },
      {
        sdk: {
          name: "sentry.javascript.nextjs",
          version: "10.68.0",
        },
      },
      "/monitor"
    );
    const raw = serializeEnvelope(sdkEnvelope);
    expect(typeof raw).toBe("string");

    const prepared = prepareTelemetryEnvelope(raw as string, dsn);
    expect(prepared.reason).toBe("forwarded");
    const [headerLine] = prepared.body!.split("\n");
    const header = JSON.parse(headerLine!) as Record<string, unknown>;
    expect(header).toMatchObject({
      event_id: "0123456789abcdef0123456789abcdef",
      sdk: {
        name: "sentry.javascript.nextjs",
        version: "10.68.0",
      },
      dsn: "https://publickey@o4507.ingest.us.sentry.io/6001",
    });
    expect(new Date(header.sent_at as string).toISOString()).toBe(
      header.sent_at
    );
    expect(prepared.body).not.toContain("dana@example.com");
  });

  it("scrubs the canary out of a real-shaped event before forwarding", () => {
    const leaky = envelope(
      {
        event_id: "1",
        dsn: "https://publickey@o4507.ingest.us.sentry.io/6001",
      },
      [
        [
          { type: "event", length: 999 },
          {
            transaction: "/record",
            message: "upload failed for dana@example.com",
            user: { email: "dana@example.com", ip_address: "203.0.113.7" },
            request: {
              url: "https://app.cauli.pro/api/calls/9/media?token=abc",
              headers: { Authorization: "Bearer sb_secret_abc" },
            },
            extra: { title: "Q3 renewal with Acme", callId: "9f1c" },
          },
        ],
      ]
    );

    const prepared = prepareTelemetryEnvelope(leaky, dsn);
    expect(prepared.reason).toBe("forwarded");
    expect(prepared.body).not.toBeNull();
    // Everything after the envelope header, which is the only line allowed to
    // carry the DSN: a routing address holding a public key, not content.
    const [envelopeHeader, ...forwarded] = prepared.body!.split("\n");
    expect(envelopeHeader).toContain("o4507.ingest.us.sentry.io/6001");
    expect(findForbiddenTelemetry(forwarded.join("\n"))).toEqual([]);
    expect(prepared.body).not.toContain("Q3 renewal");
    // The operational identity that makes the event useful survives.
    expect(prepared.body).toContain("9f1c");
    expect(prepared.body).toContain("/record");

    // Item lengths are recomputed, because scrubbing changed them.
    const itemHeader = JSON.parse(prepared.body!.split("\n")[1]!) as {
      length: number;
    };
    const payload = prepared.body!.split("\n")[2]!;
    expect(itemHeader.length).toBe(Buffer.byteLength(payload));
  });

  it("rejects a malformed envelope rather than guessing", () => {
    expect(prepareTelemetryEnvelope("not json\n", dsn)).toMatchObject({
      body: null,
      reason: "malformed_header",
    });
    expect(prepareTelemetryEnvelope("", dsn)).toMatchObject({
      body: null,
      reason: "empty",
    });
  });
});
