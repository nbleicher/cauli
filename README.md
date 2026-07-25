# cauli

cauli is a deployable call recording, transcription, and QA review application. It records microphone and browser-tab audio in the browser, uploads durable chunks to private storage, transcribes recordings asynchronously, and gives managers a versioned weighted scorecard.

The legacy Chrome extension is retained as a launcher and one-time migration bridge.

## Documentation

- [Technical reference](docs/TECHNICAL_REFERENCE.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Manual verification](docs/MANUAL_TESTING.md)

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

Runtime dependencies currently pass `npm audit --omit=dev`. The remaining audit findings are in the ESLint development toolchain; ESLint 10 cannot be adopted until the React plugin shipped with the current Next.js preset supports its context API.

## Deployment

Create separate Railway services from this repository:

- Web service: config file `/railway.web.toml`
- Worker service: config file `/railway.worker.toml`

Both services use the same Supabase and OpenRouter secrets. See [Deployment](docs/DEPLOYMENT.md) for the complete setup and [Manual verification](docs/MANUAL_TESTING.md) for the release checklist.

## Companion extension

Build the extension for the exact deployed origin:

```bash
CALLLOG_WEB_ORIGIN=https://your-calllog-domain.example \
CALLLOG_SUPABASE_ORIGIN=https://your-project.supabase.co \
  npm run build -w @calllog/extension
```

Load `apps/extension/dist` as the unpacked extension or package that directory for Chrome distribution. The production origin is compiled into both the manifest match pattern and the runtime origin check.
