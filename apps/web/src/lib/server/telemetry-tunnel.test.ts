import { findForbiddenTelemetry } from "@calllog/shared";
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

  it("drops events from routes that are never sampled", () => {
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
