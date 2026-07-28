import {
  scrubTelemetryValue,
  telemetrySampleRate,
  telemetrySamplingFromEnv,
} from "@calllog/shared";

interface SamplingContext {
  name: string;
  normalizedRequest?: { url?: string };
  location?: { href?: string; pathname?: string };
}

function routeFrom(value: string | undefined) {
  if (!value) return "/";
  try {
    return new URL(value, "https://telemetry.invalid").pathname;
  } catch {
    return value.split("?")[0] || "/";
  }
}

export function webTraceSampleRate(
  context: SamplingContext,
  env: Record<string, string | undefined>
) {
  const route = routeFrom(
    context.normalizedRequest?.url ??
      context.location?.pathname ??
      context.location?.href ??
      context.name
  );
  return telemetrySampleRate(route, telemetrySamplingFromEnv(env));
}

export function scrubSentryEvent<T>(event: T): T {
  return scrubTelemetryValue(event) as T;
}

export function scrubSentryBreadcrumb<T extends { category?: string }>(
  breadcrumb: T
): T | null {
  // Console capture is explicitly disabled. Other breadcrumbs retain their
  // operational category and timing while their prose and payload are scrubbed.
  if (breadcrumb.category?.startsWith("console")) return null;
  return scrubTelemetryValue(breadcrumb) as T;
}
