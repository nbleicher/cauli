/**
 * What Cauli is allowed to tell a monitoring provider.
 *
 * Observability is useful precisely because it describes real traffic, which
 * is exactly why it is dangerous: an unscrubbed error carries the title of a
 * Call, the address of the person who recorded it, or a signed URL that grants
 * the audio itself. The rules live here, as pure functions, so the same
 * decisions apply to the browser, the server, and the worker, and so a canary
 * can prove them without a network.
 *
 * The posture is deny-by-default. Values are scrubbed on the way out and the
 * organization's own server-side rules scrub them again; a shape nobody
 * anticipated is dropped rather than forwarded.
 */

/**
 * Fields that never leave, whatever they contain. Matching is case-insensitive
 * and ignores separators, so `Authorization`, `authorization`, `auth_header`
 * and `authHeader` are one rule.
 */
const FORBIDDEN_KEYS = [
  "apikey",
  "attachment",
  "audio",
  "authorization",
  "body",
  "comment",
  "content",
  "cookie",
  "credential",
  "displayname",
  "email",
  "filename",
  "followup",
  "ip",
  "ipaddress",
  "media",
  "password",
  "passphrase",
  "path",
  "privatekey",
  "query",
  "querystring",
  "requestbody",
  "review",
  "search",
  "secret",
  "session",
  "setcookie",
  "signedurl",
  "summary",
  "title",
  "token",
  "transcript",
  "uri",
  "url",
] as const;

/**
 * Provider features that would turn telemetry into a content store. Listed
 * rather than assumed so the operator checklist and the code cannot drift.
 */
export const TELEMETRY_DISABLED_FEATURES = [
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
] as const;

export const TELEMETRY_REDACTED = "[redacted]";

const EMAIL = /[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi;
const URL_LIKE = /\b(?:https?|wss?|blob|data):\/{0,2}\S+/gi;
const BEARER = /\bBearer\s+\S+/gi;
const CREDENTIAL = /\b(?:sk-or-v1-|sb_secret_|sb_publishable_)[\w-]+/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/[\w.-]+){2,}/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

const MAX_STRING_LENGTH = 200;

function normalizeKey(key: string) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isForbiddenKey(key: string) {
  const normalized = normalizeKey(key);
  return FORBIDDEN_KEYS.some(
    (forbidden) => normalized === forbidden || normalized.endsWith(forbidden)
  );
}

/**
 * Replaces every value that could carry content or identity. Applied to
 * strings anywhere in an event, including the ones under keys that looked
 * harmless.
 */
export function scrubTelemetryString(value: string) {
  const scrubbed = value
    .replace(BEARER, `Bearer ${TELEMETRY_REDACTED}`)
    .replace(CREDENTIAL, TELEMETRY_REDACTED)
    .replace(JWT, TELEMETRY_REDACTED)
    .replace(EMAIL, TELEMETRY_REDACTED)
    .replace(URL_LIKE, TELEMETRY_REDACTED)
    .replace(IPV4, TELEMETRY_REDACTED)
    .replace(ABSOLUTE_PATH, ` ${TELEMETRY_REDACTED}`);
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}

/**
 * Deep-scrubs an event. Anything that is not a string, finite number, boolean,
 * null, array, or plain object is dropped rather than serialized, because an
 * unexpected shape is exactly where content hides.
 */
export function scrubTelemetryValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return TELEMETRY_REDACTED;
  if (value === null) return null;
  if (typeof value === "string") return scrubTelemetryString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => scrubTelemetryValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (
      Object.getPrototypeOf(source) !== Object.prototype &&
      Object.getPrototypeOf(source) !== null
    ) {
      return TELEMETRY_REDACTED;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = isForbiddenKey(key)
        ? TELEMETRY_REDACTED
        : scrubTelemetryValue(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

/**
 * The canary's assertion. Returns the forbidden values it can still find, so a
 * test can fail with the actual leak rather than a bare boolean.
 */
export function findForbiddenTelemetry(value: unknown): string[] {
  const found: string[] = [];
  const serialized = JSON.stringify(value) ?? "";
  const patterns: Array<[string, RegExp]> = [
    ["email", new RegExp(EMAIL.source, "i")],
    ["url", new RegExp(URL_LIKE.source, "i")],
    ["bearer token", new RegExp(BEARER.source, "i")],
    ["credential", new RegExp(CREDENTIAL.source, "i")],
    ["jwt", new RegExp(JWT.source)],
    ["ip address", new RegExp(IPV4.source)],
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(serialized)) found.push(label);
  }
  return found;
}

export type TelemetryRouteClass = "excluded" | "critical" | "routine";

const EXCLUDED_PREFIXES = [
  "/_next/static",
  "/api/health",
  "/api/monitoring",
  "/api/security/csp-report",
  "/api/status",
  "/favicon",
];

const EXCLUDED_EXTENSIONS = [
  ".css",
  ".ico",
  ".jpg",
  ".js",
  ".map",
  ".png",
  ".svg",
  ".webmanifest",
  ".woff",
  ".woff2",
];

/**
 * Journeys whose failure would end a pilot day: capturing a Call, getting into
 * the product, and everything Cauli does with a Call afterwards.
 */
const CRITICAL_PREFIXES = [
  "/activate",
  "/api/auth",
  "/api/calls",
  "/api/extension-imports",
  "/api/legal",
  "/auth",
  "/login",
  "/record",
];

export function classifyTelemetryRoute(path: string): TelemetryRouteClass {
  const route = path.split("?")[0] ?? path;
  // Recording chunk uploads are high-volume and carry Source Audio; they are
  // never sampled, at any rate.
  if (/\/chunks?\//.test(route)) return "excluded";
  if (EXCLUDED_PREFIXES.some((prefix) => route.startsWith(prefix))) {
    return "excluded";
  }
  if (EXCLUDED_EXTENSIONS.some((extension) => route.endsWith(extension))) {
    return "excluded";
  }
  if (CRITICAL_PREFIXES.some((prefix) => route.startsWith(prefix))) {
    return "critical";
  }
  return "routine";
}

export interface TelemetrySampling {
  /** Traces on critical journeys and worker jobs. Configurable, default 1. */
  criticalRate: number;
  /** Routine navigation and noncritical APIs. Configurable, default 0.1. */
  routineRate: number;
}

export const DEFAULT_TELEMETRY_SAMPLING: TelemetrySampling = {
  criticalRate: 1,
  routineRate: 0.1,
};

/**
 * Errors are never sampled away — the plan's quota is spent on them first —
 * while traces follow the route's class.
 */
export function telemetrySampleRate(
  path: string,
  sampling: TelemetrySampling = DEFAULT_TELEMETRY_SAMPLING
) {
  const routeClass = classifyTelemetryRoute(path);
  if (routeClass === "excluded") return 0;
  return routeClass === "critical"
    ? sampling.criticalRate
    : sampling.routineRate;
}

function boundedRate(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export function telemetrySamplingFromEnv(
  env: Record<string, string | undefined>
): TelemetrySampling {
  return {
    criticalRate: boundedRate(
      env.TELEMETRY_CRITICAL_SAMPLE_RATE,
      DEFAULT_TELEMETRY_SAMPLING.criticalRate
    ),
    routineRate: boundedRate(
      env.TELEMETRY_ROUTINE_SAMPLE_RATE,
      DEFAULT_TELEMETRY_SAMPLING.routineRate
    ),
  };
}

export interface TelemetryQuota {
  errorsUsed: number;
  errorQuota: number;
  spansUsed: number;
  spanQuota: number;
  alertRatio: number;
}

/** The free Developer plan's monthly allowances. */
export const TELEMETRY_FREE_PLAN_QUOTA = {
  errorQuota: 5_000,
  spanQuota: 5_000_000,
  alertRatio: 0.8,
  retentionDays: 30,
} as const;

export function telemetryQuotaAlerts(usage: TelemetryQuota) {
  const alerts: string[] = [];
  if (
    usage.errorQuota > 0 &&
    usage.errorsUsed >= usage.alertRatio * usage.errorQuota
  ) {
    alerts.push("telemetry.error_quota");
  }
  if (
    usage.spanQuota > 0 &&
    usage.spansUsed >= usage.alertRatio * usage.spanQuota
  ) {
    alerts.push("telemetry.span_quota");
  }
  return alerts;
}
