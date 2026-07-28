import * as Sentry from "@sentry/nextjs";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  webTraceSampleRate,
} from "@/lib/telemetry-sentry";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tunnel: "/api/monitoring",
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() || "staging",
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE?.trim() || undefined,
  sampleRate: 1,
  sendDefaultPii: false,
  enableLogs: false,
  maxBreadcrumbs: 20,
  tracesSampler: (context) =>
    webTraceSampleRate(context, {
      TELEMETRY_CRITICAL_SAMPLE_RATE:
        process.env.NEXT_PUBLIC_TELEMETRY_CRITICAL_SAMPLE_RATE,
      TELEMETRY_ROUTINE_SAMPLE_RATE:
        process.env.NEXT_PUBLIC_TELEMETRY_ROUTINE_SAMPLE_RATE,
    }),
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
