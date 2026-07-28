# Monitoring with content-scrubbed Sentry

Observability that never becomes a content store. See
[ADR 0012](../adr/0012-use-content-scrubbed-managed-sentry.md) for the decision.

## What the code enforces

These are in `packages/shared/src/telemetry.ts` and
`apps/web/src/lib/server/telemetry-tunnel.ts`, and they hold regardless of how
the organization is configured. `packages/shared/src/telemetry.test.ts` is the
canary: it builds an event containing every forbidden value in the shapes a
real event carries them and fails if any survives.

**Scrubbed before sending.** Emails, IP addresses, URLs of every scheme, query
strings, signed URLs, bearer tokens, OpenRouter and Supabase credentials, JWTs,
and absolute file paths are replaced wherever they appear — as a field, nested
in a breadcrumb, or in free-form message text. Fields named for content
(`title`, `transcript`, `summary`, `comment`, `body`, `cookie`,
`authorization`, `email`, `filename`, `query`, `url`, and their variants) are
replaced whatever they hold. A value whose shape the scrubber cannot reason
about is dropped rather than serialized.

**What is allowed through.** Release, route or job kind, timing, queue depth,
provider and model identity, error class, and pseudonymous identifiers.

**Sampling.** Errors are never sampled away. Traces follow the route:

| Route class                                                       | Rate |
| ----------------------------------------------------------------- | ---- |
| Critical journeys — recording, auth, activation, Call APIs        | 100% |
| Routine navigation and noncritical APIs                           | 10%  |
| Static assets, health and status polling, Recording chunk uploads | 0%   |

Both configurable rates come from `TELEMETRY_CRITICAL_SAMPLE_RATE` and
`TELEMETRY_ROUTINE_SAMPLE_RATE`; a value outside 0–1 falls back to the default
rather than being obeyed.

**Same-origin tunnel.** `connect-src` names only Cauli and Supabase, so the
browser cannot reach Sentry directly and widening the policy is not on the
table. Browser events go to `POST /api/monitoring`, which is the last
enforcement point rather than a relay: it refuses envelopes addressed to any
other project, drops item types that could carry content (attachments,
screenshots, profiles), drops events from routes that are never sampled, and
scrubs what remains.

**Fail open.** A missing DSN, an unreachable provider, and a quota-limited
provider all return 202 to the browser and leave the failure in Cauli's own
logs. Cauli's durable `processing_runs` metrics, not sampled Sentry events,
remain the processing service-level source of truth.

## What the operator must configure

The organization's own server-side scrubbing is the second layer; the code
above is the first. Both are required.

1. **Organization.** Dedicated, Cauli-owned, free Developer plan, U.S. data
   region, operator as sole initial owner.
2. **Projects.** `cauli-web` and `cauli-worker`, each with `staging` and
   `production` environments.
3. **Release identity.** `SENTRY_RELEASE` is the `main` commit SHA and the
   immutable image digest being promoted — the same identity the promotion gate
   uses. Upload source maps during the build with a build-only token, and
   exclude them from published artifacts.
4. **Disabled features.** Session Replay, screenshots, attachments, User
   Feedback, profiling, console and log ingestion, Seer/AI, automatic
   request-body capture, and default PII. The list is asserted in
   `TELEMETRY_DISABLED_FEATURES`; the organization settings must match it.
5. **Server-side scrubbing.** Organization-level data-scrubbing rules covering
   the same field names and value patterns as the code, so a future SDK path
   that bypasses the tunnel is still scrubbed.
6. **Quota alerts.** Alert at 80% of the plan's 5,000 monthly errors and
   5,000,000 monthly spans (`telemetryQuotaAlerts`).
7. **Retention.** The free plan's 30-day lookback. Sentry is not an operational
   record beyond that; Audit Events and `processing_runs` are.

## Environment

| Variable                         | Purpose                                    |
| -------------------------------- | ------------------------------------------ |
| `SENTRY_DSN`                     | Server-side only; the tunnel's destination |
| `SENTRY_ENVIRONMENT`             | `staging` or `production`                  |
| `SENTRY_RELEASE`                 | Commit SHA and image digest                |
| `TELEMETRY_CRITICAL_SAMPLE_RATE` | Default 1                                  |
| `TELEMETRY_ROUTINE_SAMPLE_RATE`  | Default 0.1                                |

The DSN is deliberately not exposed to the browser: the browser posts to
`/api/monitoring` and the server holds the destination.
