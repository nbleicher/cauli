# cauli

cauli is a deployable call recording, transcription, and QA review application. It records microphone and browser-tab audio in the browser, uploads durable chunks to private storage, transcribes recordings asynchronously, and gives managers a versioned weighted scorecard.

Copyright © 2026 Cauli. All rights reserved. Public source visibility does not
grant an open-source license; see [NOTICE](NOTICE).

## Documentation

- [Technical reference](docs/TECHNICAL_REFERENCE.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Manual verification](docs/MANUAL_TESTING.md)
- [Security policy](SECURITY.md)
- [Controlled-pilot production-readiness specification](docs/product/controlled-pilot-production-readiness.md)
- [Human production-readiness runbook](docs/operations/human-production-readiness-runbook.md)

## Repository

```text
apps/web         Next.js application and API routes
apps/worker      Railway FFmpeg and transcription worker
apps/extension   Chrome MV3 companion and legacy recorder
packages/shared  Domain types, validation, authorization, and scoring
supabase         Database migrations, RLS, and Storage policies
```

## Local development

Requirements: Node 22, npm, a Supabase project or local Supabase CLI, and FFmpeg for worker development.

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
npm run dev
```

Without Supabase variables, the web app intentionally opens a setup screen at `http://localhost:3000/setup`.

Apply the database:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
npm run bootstrap -w @calllog/web
```

Run the worker after setting its environment:

```bash
npm run dev:worker
```

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Runtime dependencies currently pass `npm audit --omit=dev`. The remaining
audit findings are in the ESLint development toolchain; the React, import, and
accessibility plugins shipped with the current Next.js preset declare
compatibility only through ESLint 9.

## Deployment

Create separate Railway services from this repository:

- Web service: config file `/railway.web.toml`
- Worker service: config file `/railway.worker.toml`
- Backup writer: config file `/railway.backup-worker.toml`
- Retention worker: config file `/railway.retention-worker.toml`

Staging and production use separate credentials. See
[Deployment](docs/DEPLOYMENT.md) for setup and
[Manual verification](docs/MANUAL_TESTING.md) for release checks.

## Archived legacy extension

`apps/extension` and the extension-import API remain only as unsupported
historical migration code. They are not part of production navigation,
deployment, or pilot support.
