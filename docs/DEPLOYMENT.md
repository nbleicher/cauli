# Deployment

Production releases come only from accepted commits on `main`. The release is
built once as a single web-and-worker image, deployed to the isolated staging
stack, and promoted to production by the exact image digest. Railway must never
rebuild the candidate during promotion.

## Provider topology

Create separate private `Cauli Staging` and `Cauli Production` Railway projects.
Each project contains:

- `web`, the only public service, with separate Workspace and Platform Admin
  domains enforced again by the application host boundary;
- `worker`, with private networking only and no generated or custom public
  domain.

Both services use the same `ghcr.io/nbleicher/cauli@sha256:…` source and are
pinned to Railway Virginia `us-east4-eqdc4a`. Railway uses
`node apps/web/server.js` for web and `node apps/worker/dist/index.js` for the
worker.

Each environment has its own Supabase project and Storage in `us-east-1`,
OpenRouter key and cap, Sentry environment, credentials, and data. Staging is
synthetic-data-only and may not contain or reach production content.

## Runtime variables

Set these directly in each environment's provider secret/configuration store.
Never copy values between staging and production.

Web:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
APP_URL
PLATFORM_ADMIN_HOST
CSP_MODE=report-only        # staging
CSP_MODE=enforce            # production candidate after CSP acceptance
HSTS_INCLUDE_SUBDOMAINS=false
```

`APP_URL` is `https://staging.cauli.pro` in staging and
`https://app.cauli.pro` in production. Public Supabase configuration is read at
request time and emitted into the HTML; it is not compiled into the image.
`PLATFORM_ADMIN_HOST` is `admin.staging.cauli.pro` in staging and
`admin.cauli.pro` in production. Requests for control-plane paths on any other
host, and Workspace application paths on the Platform Admin host, fail closed.
`HSTS_INCLUDE_SUBDOMAINS` remains false until every `cauli.pro` subdomain is
proven HTTPS during Phase B, then production sets it to true.

Worker:

```text
SUPABASE_URL
SUPABASE_WORKER_KEY
OPENROUTER_API_KEY
OPENROUTER_STT_MODEL=openai/whisper-large-v3-turbo
TRANSCRIPTION_LANGUAGE=en
WORKER_POLL_MS=2000
WORKER_CONCURRENCY=1
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
PORT=8080
```

Only the worker receives its environment's OpenRouter key. The web runtime
holds neither OpenRouter access nor a Supabase service-role credential. The
worker key must be the separately inventoried worker principal; do not reuse it
for identity, backup, retention, migration, Platform Admin, Sentry, or web.

Identity Edge Function (`identity-admin`):

```text
APP_URL
MFA_RECOVERY_CODE_KEY
```

Set these with `supabase secrets set --project-ref <ref>` per environment;
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and the service-role credential are
injected by the Supabase runtime. `MFA_RECOVERY_CODE_KEY` is the key that
Recovery Code hashes are computed with, so it is the one value that makes those
hashes verifiable. Generate at least 32 random bytes per environment, never
share it between staging and production, and treat rotating it as invalidating
every outstanding Recovery Code — every Workspace Member must generate a new
set from Account afterwards. The function refuses to serve any request while it
is unset.

## GitHub release environments

Create `staging` and `production` GitHub environments. Use the same variable
names in each environment but distinct values:

Variables:

```text
RAILWAY_WEB_SERVICE_ID
RAILWAY_WORKER_SERVICE_ID
RAILWAY_ENVIRONMENT_ID
SUPABASE_PROJECT_REF
CAULI_APP_URL
```

Secrets:

```text
RAILWAY_PROJECT_TOKEN
SUPABASE_ACCESS_TOKEN
SUPABASE_DB_PASSWORD
```

The Railway token is scoped to only that project/environment. The Supabase
credential is a migration/release credential used by the deployment workflow,
not a runtime variable. Protect the `production` environment with operator
approval.

## Build an immutable candidate

Run the `Build release image` workflow on `main`. It:

1. reruns public-source, claim, dependency, and release checks;
2. builds the root `Dockerfile` without environment-specific build arguments;
3. publishes `ghcr.io/nbleicher/cauli:<main-commit>`;
4. records its immutable digest and GitHub build provenance;
5. creates and attests an SPDX JSON SBOM;
6. scans the runtime image with Trivy;
7. blocks unexcepted High or Critical findings; and
8. retains a release manifest, SBOM, and scan report.

Vulnerability exceptions live in
`release/vulnerability-exceptions.json`. An exception must name the exact CVE,
owner, rationale, mitigation, and future expiration. Expired or incomplete
exceptions fail the build.

## Deploy staging, then promote

Run `Deploy immutable release` from `main` with the exact commit and digest.
The workflow verifies signed provenance and main ancestry, applies compatible
database migrations, configures both Railway services to the exact digest and
Virginia region, waits for their health checks, and validates the public login
path plus browser headers.

Staging requires report-only CSP. Production promotion runs only after staging
passes and requires:

- the recorded pre-migration recovery timestamp;
- exact-candidate staging evidence;
- current region evidence;
- the production-principal denial matrix;
- enforced CSP/security-header evidence;
- SBOM/vulnerability evidence;
- Phase B manual sign-off; and
- closed human gates #41–#44.

The workflow fails closed when any item is absent and reverifies the same image
attestation immediately before production deployment.

## Cloudflare and Auth

Configure the approved domain topology from ADR-0019. The public
`cauli.pro` page links Log in to `app.cauli.pro/login`; staging uses
`staging.cauli.pro/login`. Cloudflare Access protects staging and both Platform
Admin surfaces. Add Supabase Auth site/redirect URLs for the exact application
origins, including `/auth/callback`.

Create a Cloudflare Access application for each exact Platform Admin origin:
`admin.staging.cauli.pro` and `admin.cauli.pro`. Do not use a wildcard that also
admits the Workspace application. Configure both custom domains on the web
service, then verify that `/platform-admin` returns 404 on the Workspace domain
and `/record` returns 404 on the Platform Admin domain.

Provision each Platform Admin as a dedicated Supabase Auth identity, then add
only its environment-scoped `platform_admins` row. The database rejects an
identity that is also a Workspace Member. Platform Admin identities require
TOTP, use a 15-minute inactivity timeout and one-hour absolute session, and
must freshly assert TOTP within five minutes before activating or revoking a
break-glass grant. Never provide this identity or the web service with worker,
backup-writer, retention-deleter, Peely, migration/release, Sentry build, or
service-role credentials.

Do not enable HSTS `includeSubDomains` until every Cauli subdomain is HTTPS.
Preload is not used during the pilot.

## Operational verification

- Web `/api/health` reports process and runtime configuration health.
- Worker `/health` reports its replica and active job count through Railway's
  private health check only.
- `processing_jobs` records attempts, sanitized errors, leases, and completion.
- Customer content, signed URLs, credentials, and request bodies never enter
  release logs or monitoring.
- Region evidence and the exact deployment digest are refreshed after
  infrastructure changes and at least quarterly.
