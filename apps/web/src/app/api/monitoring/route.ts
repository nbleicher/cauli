import { NextResponse } from "next/server";
import {
  parseDsn,
  prepareTelemetryEnvelope,
} from "@/lib/server/telemetry-tunnel";

const MAX_ENVELOPE_BYTES = 200_000;

/**
 * The browser's only route to the monitoring provider. Everything here fails
 * open: monitoring that is misconfigured, unreachable, or out of quota must
 * never become an outage, so the browser is always told the envelope was
 * accepted and the failure is left in Cauli's own logs.
 */
export async function POST(request: Request) {
  const configuredDsn = parseDsn(process.env.SENTRY_DSN?.trim() ?? "");
  if (!configuredDsn) return new NextResponse(null, { status: 202 });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new NextResponse(null, { status: 202 });
  }
  if (raw.length > MAX_ENVELOPE_BYTES) {
    console.warn("telemetry.envelope_rejected", { reason: "too_large" });
    return new NextResponse(null, { status: 202 });
  }

  const prepared = prepareTelemetryEnvelope(raw, configuredDsn);
  if (!prepared.body) {
    if (prepared.reason !== "nothing_forwardable") {
      console.warn("telemetry.envelope_rejected", { reason: prepared.reason });
    }
    return new NextResponse(null, { status: 202 });
  }

  try {
    const response = await fetch(configuredDsn.envelopeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: prepared.body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      // 429 here is the provider's quota limit. Cauli keeps working; its own
      // durable metrics, not this stream, are the service-level source.
      console.warn("telemetry.forward_failed", { status: response.status });
    }
  } catch {
    console.warn("telemetry.forward_failed", { status: "unreachable" });
  }

  return new NextResponse(null, { status: 202 });
}
