create table public.transcription_chunks (
  call_id uuid not null references public.calls(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  text text not null,
  segments jsonb not null default '[]'::jsonb,
  language text,
  duration_seconds numeric(12, 3) not null default 0
    check (duration_seconds >= 0),
  cost_usd numeric(12, 6) not null default 0
    check (cost_usd >= 0),
  provider_generation_id text,
  model text not null,
  completed_at timestamptz not null default now(),
  primary key (call_id, chunk_index)
);

alter table public.transcription_chunks enable row level security;

create policy transcription_chunks_select on public.transcription_chunks
for select using (public.can_view_call(call_id));

grant select on public.transcription_chunks to authenticated;
grant all privileges on public.transcription_chunks to service_role;

alter table public.processing_jobs
  add column error_category text,
  add column error_chunk_index integer
    check (error_chunk_index is null or error_chunk_index >= 0),
  add column provider_generation_id text;

create index processing_jobs_attention_idx
  on public.processing_jobs (workspace_id, finished_at desc)
  where status = 'failed';

create unique index workspace_members_one_workspace_per_user
  on public.workspace_members (user_id);

create unique index scorecard_templates_one_active_per_workspace
  on public.scorecard_templates (workspace_id)
  where is_active;
