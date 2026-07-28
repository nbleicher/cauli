import * as Sentry from "@sentry/nextjs";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  webTraceSampleRate,
} from "@/lib/telemetry-sentry";

const dsn = process.env.SENTRY_DSN?.trim();

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT?.trim() || "staging",
  release: process.env.SENTRY_RELEASE?.trim() || undefined,
  sampleRate: 1,
  sendDefaultPii: false,
  enableLogs: false,
  maxBreadcrumbs: 20,
  tracesSampler: (context) => webTraceSampleRate(context, process.env),
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
