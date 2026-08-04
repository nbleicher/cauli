/**
 * Summit metrics ingest emitter for cauli (PRD §4.8).
 * POSTs call.started / call.ended to /ingest/cauli with shared-secret auth.
 * Never invents contact identity — v1 carries no contact linkage.
 */

export type MetricsIngestConfig = {
  apiUrl?: string | null;
  secret?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  uuid?: () => string;
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
  maxAttempts?: number;
  backoffMs?: readonly number[];
};

export type CallStartedInput = {
  callId: string;
  profileId: string;
  occurredAt: string;
};

export type CallEndedInput = {
  callId: string;
  profileId: string;
  durationMs: number;
  recordingRef?: string;
  occurredAt?: string;
};

export type MetricsEventBody = {
  event_id: string;
  dedup_key: string;
  type: "call.started" | "call.ended";
  actor: "agent";
  occurred_at: string;
  source: "cauli";
  source_agent_identity: string;
  payload: {
    agent: string;
    duration_ms?: number;
    recording_ref?: string;
  };
};

export type MetricsDeliveryResult =
  "skipped" | "delivered" | "rejected" | "exhausted";

const DEFAULT_BACKOFF_MS = [250, 1_000, 3_000, 10_000] as const;

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return proc?.env ?? {};
}

export function metricsConfigFromEnv(
  env: Record<string, string | undefined> = readProcessEnv()
): MetricsIngestConfig {
  return {
    apiUrl: env.METRICS_API_URL,
    secret: env.METRICS_INGEST_SECRET,
  };
}

export function metricsConfigured(config: MetricsIngestConfig): boolean {
  return Boolean(config.apiUrl?.trim() && config.secret?.trim());
}

export function callStartedDedupKey(callId: string) {
  return `${callId}:started`;
}

export function callEndedDedupKey(callId: string) {
  return `${callId}:ended`;
}

export function buildCallStartedEvent(
  input: CallStartedInput,
  uuid: () => string = () => crypto.randomUUID()
): MetricsEventBody {
  return {
    event_id: uuid(),
    dedup_key: callStartedDedupKey(input.callId),
    type: "call.started",
    actor: "agent",
    occurred_at: input.occurredAt,
    source: "cauli",
    source_agent_identity: input.profileId,
    payload: {
      agent: input.profileId,
    },
  };
}

export function buildCallEndedEvent(
  input: CallEndedInput,
  uuid: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date()
): MetricsEventBody {
  const payload: MetricsEventBody["payload"] = {
    agent: input.profileId,
    duration_ms: input.durationMs,
  };
  if (input.recordingRef) {
    payload.recording_ref = input.recordingRef;
  }
  return {
    event_id: uuid(),
    dedup_key: callEndedDedupKey(input.callId),
    type: "call.ended",
    actor: "agent",
    occurred_at: input.occurredAt ?? now().toISOString(),
    source: "cauli",
    source_agent_identity: input.profileId,
    payload,
  };
}

function ingestUrl(apiUrl: string) {
  return `${apiUrl.replace(/\/$/, "")}/ingest/cauli`;
}

type PostOutcome =
  | { kind: "delivered" }
  | { kind: "rejected"; status: number }
  | { kind: "retry" };

/**
 * The metrics backend answers 422 with `{"status": "held", ...}` when the
 * source-agent identity has no mapping yet: the event is stored server-side
 * as a held-event row for replay. Retrying a held event would create a NEW
 * held row (plus an operator alert) per attempt, so a held answer is success
 * from the emitter's point of view — the backend has the event.
 */
async function heldForReplay(response: Response): Promise<boolean> {
  if (response.status !== 422) return false;
  try {
    const body = (await response.json()) as { status?: unknown };
    return body?.status === "held";
  } catch {
    return false;
  }
}

async function postOnce(
  body: MetricsEventBody,
  config: { apiUrl: string; secret: string; fetchImpl: typeof fetch }
): Promise<PostOutcome> {
  const response = await config.fetchImpl(ingestUrl(config.apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Secret": config.secret,
    },
    body: JSON.stringify(body),
  });
  // 2xx and duplicate acknowledgements (typically 200) are success.
  if (response.ok) return { kind: "delivered" };
  // Held for replay is delivered as far as this emitter is concerned.
  if (await heldForReplay(response)) return { kind: "delivered" };
  // Any other 4xx is permanent: the same request will fail the same way.
  if (response.status >= 400 && response.status < 500) {
    return { kind: "rejected", status: response.status };
  }
  // 5xx (and anything else transient-looking) is worth retrying.
  return { kind: "retry" };
}

function wait(ms: number, scheduleRetry: MetricsIngestConfig["scheduleRetry"]) {
  return new Promise<void>((resolve) => {
    if (scheduleRetry) {
      scheduleRetry(resolve, ms);
      return;
    }
    setTimeout(resolve, ms);
  });
}

/**
 * Awaitable delivery with in-process retry. Never throws — metrics must not
 * fail Call recording or processing.
 */
export async function deliverMetricsEvent(
  body: MetricsEventBody,
  config: MetricsIngestConfig = metricsConfigFromEnv()
): Promise<MetricsDeliveryResult> {
  const apiUrl = config.apiUrl?.trim();
  const secret = config.secret?.trim();
  if (!apiUrl || !secret) return "skipped";

  const fetchImpl = config.fetchImpl ?? fetch;
  const maxAttempts = config.maxAttempts ?? DEFAULT_BACKOFF_MS.length + 1;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const outcome = await postOnce(body, { apiUrl, secret, fetchImpl });
      if (outcome.kind === "delivered") return "delivered";
      if (outcome.kind === "rejected") {
        // Permanent: retrying an unprocessable request only repeats the
        // failure (and multiplies backend side effects). Log once and stop.
        console.error(
          `metrics ingest rejected ${body.type} (${body.dedup_key}) with status ${outcome.status}; not retrying`
        );
        return "rejected";
      }
    } catch {
      // Network / abort — retry below.
    }
    if (attempt < maxAttempts - 1) {
      const delay =
        backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 10_000;
      await wait(delay, config.scheduleRetry);
    }
  }
  return "exhausted";
}

export async function deliverCallStarted(
  input: CallStartedInput,
  config: MetricsIngestConfig = metricsConfigFromEnv()
): Promise<MetricsDeliveryResult> {
  const uuid = config.uuid ?? (() => crypto.randomUUID());
  return deliverMetricsEvent(buildCallStartedEvent(input, uuid), config);
}

export async function deliverCallEnded(
  input: CallEndedInput,
  config: MetricsIngestConfig = metricsConfigFromEnv()
): Promise<MetricsDeliveryResult> {
  const uuid = config.uuid ?? (() => crypto.randomUUID());
  const now = config.now ?? (() => new Date());
  return deliverMetricsEvent(buildCallEndedEvent(input, uuid, now), config);
}

/** Fire-and-forget; never blocks the caller. */
export function emitCallStarted(
  input: CallStartedInput,
  config: MetricsIngestConfig = metricsConfigFromEnv()
): void {
  void deliverCallStarted(input, config);
}

/** Fire-and-forget; never blocks the caller. */
export function emitCallEnded(
  input: CallEndedInput,
  config: MetricsIngestConfig = metricsConfigFromEnv()
): void {
  void deliverCallEnded(input, config);
}
