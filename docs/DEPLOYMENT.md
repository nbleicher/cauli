# Deployment

## 1. Supabase

Create a Supabase project, then apply `supabase/migrations/202607240001_initial_schema.sql` with the CLI:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

In Authentication URL Configuration, set:

- Site URL: the Railway web URL
- Redirect URL: `https://YOUR_WEB_DOMAIN/auth/callback`

The migration creates a private `recordings` bucket, the initial cauli workspace, all RLS policies, job-claim functions, review submission, and scorecard publishing.

## 2. Railway web service

Create a service from the repository and set its config file to `/railway.web.toml`.

Set:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
APP_URL
BOOTSTRAP_ADMIN_EMAIL
OPENROUTER_API_KEY
OPENROUTER_STT_MODEL=openai/whisper-large-v3-turbo
TRANSCRIPTION_LANGUAGE=en
```

`APP_URL` must be the final public origin with no trailing slash. Railway variables must be available during the Docker build because `NEXT_PUBLIC_*` values are embedded in the browser bundle.

After the first deployment, run:

```bash
npm run bootstrap -w @calllog/web
```

This invites or locates `BOOTSTRAP_ADMIN_EMAIL`, promotes it to admin, and publishes the initial Call Quality scorecard.

## 3. Railway worker service

Create a second service and set its config file to `/railway.worker.toml`. Use the same Supabase service role and OpenRouter key.

Set:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENROUTER_API_KEY
OPENROUTER_STT_MODEL=openai/whisper-large-v3-turbo
TRANSCRIPTION_LANGUAGE=en
WORKER_POLL_MS=2000
WORKER_CONCURRENCY=1
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
PORT=8080
```

The worker image installs FFmpeg. Increase `WORKER_CONCURRENCY` only after observing memory use for long calls; each active job downloads and transcodes one recording locally.

## 4. Operations

- `/api/health` reports web process health and whether required Supabase variables exist.
- Worker `/health` reports its replica name and active job count.
- `processing_jobs` records attempts, sanitized errors, lock owner, and completion time.
- Failed call processing can be retried from Call Detail.
- Calls left in recording/uploading state for seven days are marked abandoned.
  Their uploaded chunks remain available until the Workspace Member recovers,
  discards, or deletes the Incomplete Recording.
- Audio, transcript content, signed URLs, and provider credentials are never written to application logs.
