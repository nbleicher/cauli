import { classifyTelemetryRoute, scrubTelemetryValue } from "@calllog/shared";

/**
 * The browser cannot talk to the monitoring provider directly: `connect-src`
 * names only Cauli and Supabase, and widening it would hand every script on
 * the page a new place to send things. So the browser posts envelopes to this
 * same origin, and the server decides what actually leaves.
 *
 * That makes the tunnel the last enforcement point rather than a relay. It
 * refuses envelopes addressed anywhere but the configured project, drops item
 * types that would carry content, drops events from routes that are never
 * sampled, and scrubs everything that remains — after the browser SDK has
 * already scrubbed it once and before the organization's own rules scrub it
 * again.
 */

export interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
  envelopeUrl: string;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.username || !url.host || !projectId) return null;
    return {
      publicKey: url.username,
      host: url.host,
      projectId,
      envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

/** Item types that can only be operational. Everything else is dropped. */
const FORWARDABLE_ITEM_TYPES = new Set([
  "check_in",
  "client_report",
  "event",
  "session",
  "sessions",
  "transaction",
]);

/**
 * Every route an item claims to be about. A transaction name and a request URL
 * can disagree — a chunk upload may be named for the journey that triggered it
 * — so an item is dropped when any of them is a route Cauli never samples.
 */
function routesOf(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const routes: string[] = [];
  if (typeof record.transaction === "string") routes.push(record.transaction);
  const request = record.request;
  if (typeof request === "object" && request !== null) {
    const url = (request as Record<string, unknown>).url;
    if (typeof url === "string") {
      try {
        routes.push(new URL(url, "https://app.cauli.pro").pathname);
      } catch {
        routes.push(url);
      }
    }
  }
  return routes;
}

export interface PreparedEnvelope {
  body: string | null;
  droppedItems: number;
  reason: string;
}

/**
 * Rebuilds an envelope from only the parts that are allowed to leave. Returns
 * a null body when there is nothing left to send, which the caller reports as
 * an accepted no-op rather than an error.
 */
export function prepareTelemetryEnvelope(
  raw: string,
  configuredDsn: ParsedDsn
): PreparedEnvelope {
  const lines = raw.split("\n");
  const headerLine = lines.shift();
  if (!headerLine) return { body: null, droppedItems: 0, reason: "empty" };

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerLine) as Record<string, unknown>;
  } catch {
    return { body: null, droppedItems: 0, reason: "malformed_header" };
  }

  if (typeof header.dsn === "string") {
    const declared = parseDsn(header.dsn);
    if (
      !declared ||
      declared.host !== configuredDsn.host ||
      declared.projectId !== configuredDsn.projectId
    ) {
      // An envelope addressed elsewhere is not ours to forward, whoever posted
      // it. Refusing here keeps the tunnel from becoming an open relay.
      return { body: null, droppedItems: 0, reason: "foreign_dsn" };
    }
  }
  // The DSN is restored after scrubbing, because scrubbing correctly treats it
  // as a URL and the provider cannot route an envelope without it.
  const scrubbedHeader = scrubTelemetryValue(header) as Record<string, unknown>;
  scrubbedHeader.dsn = `https://${configuredDsn.publicKey}@${configuredDsn.host}/${configuredDsn.projectId}`;

  const output = [JSON.stringify(scrubbedHeader)];
  let droppedItems = 0;

  while (lines.length) {
    const itemHeaderLine = lines.shift();
    if (itemHeaderLine === undefined || itemHeaderLine === "") continue;
    const payloadLine = lines.shift();
    if (payloadLine === undefined) break;

    let itemHeader: Record<string, unknown>;
    let payload: unknown;
    try {
      itemHeader = JSON.parse(itemHeaderLine) as Record<string, unknown>;
      payload = JSON.parse(payloadLine);
    } catch {
      droppedItems += 1;
      continue;
    }

    const type = typeof itemHeader.type === "string" ? itemHeader.type : "";
    if (!FORWARDABLE_ITEM_TYPES.has(type)) {
      droppedItems += 1;
      continue;
    }

    if (
      routesOf(payload).some(
        (route) => classifyTelemetryRoute(route) === "excluded"
      )
    ) {
      droppedItems += 1;
      continue;
    }

    const scrubbedPayload = JSON.stringify(scrubTelemetryValue(payload));
    output.push(
      JSON.stringify({
        ...(scrubTelemetryValue(itemHeader) as Record<string, unknown>),
        type,
        length: Buffer.byteLength(scrubbedPayload),
      }),
      scrubbedPayload
    );
  }

  if (output.length === 1) {
    return { body: null, droppedItems, reason: "nothing_forwardable" };
  }
  return { body: `${output.join("\n")}\n`, droppedItems, reason: "forwarded" };
}
