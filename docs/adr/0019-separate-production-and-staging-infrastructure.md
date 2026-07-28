---
status: accepted
---

# Separate production and staging infrastructure

Cauli will run production and staging as separate Railway projects, each containing a public web service and a worker with no public domain, pinned to Railway's Virginia region (`us-east4-eqdc4a`). Each environment will use its own Supabase project in `us-east-1`, OpenRouter key and spending cap, credentials, storage, and deployment configuration. One free Sentry organization will contain separate `cauli-web` and `cauli-worker` projects whose events are labeled `staging` or `production`. A release will promote the exact container-image digest verified in staging to production.

The operator controls the Cloudflare account and `cauli.pro` zone. Cloudflare will route `cauli.pro` to the public site and policy pages, `app.cauli.pro` to the production application, `admin.cauli.pro` to the production Platform Admin interface, `staging.cauli.pro` and `admin.staging.cauli.pro` to their staging equivalents, and `status.cauli.pro` to the public status page; `www.cauli.pro` will redirect to the apex. Staging and both administration surfaces will be protected by Cloudflare Access. Automation will use separate least-privilege staging and production API tokens rather than a Global API Key.

The Log in option on `cauli.pro` will open `app.cauli.pro/login`. After authentication, the server will derive available functionality exclusively from the account's active Workspace membership and roles. A Workspace Member will enter their single authorized Workspace, a Platform Admin will receive the authorized Platform Admin entry point, and disabled or unassigned accounts will receive no application access. Client-side state and directly entered URLs cannot expand authorization. An already-authenticated person who selects Log in will be sent directly to their authorized landing page.
