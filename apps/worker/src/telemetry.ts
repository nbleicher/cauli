import { scrubTelemetryValue, telemetrySamplingFromEnv } from "@calllog/shared";
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN?.trim();
const sampling = telemetrySamplingFromEnv(process.env);

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT?.trim() || "staging",
  release: process.env.SENTRY_RELEASE?.trim() || undefined,
  sampleRate: 1,
  sendDefaultPii: false,
  enableLogs: false,
  maxBreadcrumbs: 20,
  // Every worker job is a critical journey; routine HTTP noise is not traced
  // by this process.
  tracesSampler: () => sampling.criticalRate,
  beforeSend: (event) => scrubTelemetryValue(event) as typeof event,
  beforeSendTransaction: (event) => scrubTelemetryValue(event) as typeof event,
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.category?.startsWith("console")
      ? null
      : (scrubTelemetryValue(breadcrumb) as typeof breadcrumb),
});

interface WorkerErrorContext {
  workerIndex?: number;
  jobId?: string;
  callId?: string | null;
  jobKind?: string;
  errorClass?: string;
}

export function captureWorkerError(
  error: unknown,
  context: WorkerErrorContext = {}
) {
  Sentry.withScope((scope) => {
    scope.setContext(
      "worker",
      scrubTelemetryValue(context) as Record<string, unknown>
    );
    Sentry.captureException(error);
  });
}

export function traceWorkerJob<T>(
  job: { id: string; call_id: string | null; kind: string },
  run: () => Promise<T>
) {
  return Sentry.startSpan(
    {
      name: "worker.job",
      op: "queue.process",
      attributes: {
        job_id: job.id,
        call_id: job.call_id ?? undefined,
        job_kind: job.kind,
      },
    },
    run
  );
}

export function flushTelemetry(timeoutMs = 2_000) {
  return Sentry.flush(timeoutMs);
}
