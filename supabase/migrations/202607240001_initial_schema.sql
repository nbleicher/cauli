create extension if not exists pgcrypto;

create type public.app_role as enum ('member', 'manager', 'admin');
create type public.source_mode as enum ('mic', 'tab', 'both');
create type public.call_status as enum (
  'recording', 'uploading', 'queued', 'processing', 'ready', 'failed', 'abandoned'
);
create type public.review_status as enum (
  'unreviewed', 'in_progress', 'reviewed', 'needs_follow_up'
);
create type public.job_status as enum ('queued', 'processing', 'retrying', 'complete', 'failed');
create type public.job_kind as enum (
  'process_recording', 'generate_wav', 'delete_call', 'cleanup_abandoned'
);
create type public.import_status as enum ('prepared', 'uploading', 'queued', 'complete', 'failed');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  created_at timestamptz not null default now()
);

insert into public.workspaces (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'cauli', 'cauli')
on conflict (id) do nothing;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null default 'member',
  invited_by uuid references public.profiles(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role public.app_role not null default 'member',
  invited_by uuid not null references public.profiles(id),
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  title text check (title is null or char_length(title) <= 240),
  source_mode public.source_mode not null,
  status public.call_status not null default 'recording',
  review_status public.review_status not null default 'unreviewed',
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  mime_type text not null default 'audio/webm;codecs=opus',
  mic_label text not null default '',
  tab_label text not null default '',
  expected_final_chunk integer check (expected_final_chunk is null or expected_final_chunk >= 0),
  chunk_prefix text not null,
  source_path text,
  mp3_path text,
  wav_path text,
  source_bytes bigint not null default 0 check (source_bytes >= 0),
  error_message text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index calls_workspace_started_idx
  on public.calls (workspace_id, started_at desc)
  where deleted_at is null;
create index calls_owner_started_idx
  on public.calls (owner_id, started_at desc)
  where deleted_at is null;
create index calls_status_idx on public.calls (status) where deleted_at is null;

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  model text not null,
  language text,
  full_text text not null default '',
  provider_generation_id text,
  provider_cost_usd numeric(12, 6),
  provider_duration_seconds numeric(12, 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.transcripts(id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms >= start_ms),
  text text not null,
  unique (transcript_id, sequence)
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  call_id uuid references public.calls(id) on delete cascade,
  kind public.job_kind not null,
  status public.job_status not null default 'queued',
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index processing_jobs_claim_idx
  on public.processing_jobs (next_attempt_at, created_at)
  where status in ('queued', 'retrying');

create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  format text not null check (format = 'wav'),
  status public.job_status not null default 'queued',
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.scorecard_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.scorecard_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.scorecard_templates(id) on delete cascade,
  version integer not null check (version > 0),
  published_at timestamptz not null default now(),
  published_by uuid not null references public.profiles(id),
  unique (template_id, version)
);

create table public.scorecard_categories (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.scorecard_versions(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  position integer not null check (position >= 0),
  unique (version_id, position)
);

create table public.scorecard_criteria (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.scorecard_categories(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 240),
  description text not null default '',
  weight integer not null check (weight > 0),
  required boolean not null default true,
  position integer not null check (position >= 0),
  unique (category_id, position)
);

create table public.call_reviews (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  scorecard_version_id uuid not null references public.scorecard_versions(id),
  status public.review_status not null default 'in_progress',
  score numeric(5, 2),
  summary text not null default '',
  version integer not null default 1 check (version > 0),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.call_review_answers (
  review_id uuid not null references public.call_reviews(id) on delete cascade,
  criterion_id uuid not null references public.scorecard_criteria(id),
  value smallint check (value is null or value between 1 and 5),
  comment text not null default '',
  primary key (review_id, criterion_id)
);

create table public.review_revisions (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.call_reviews(id) on delete cascade,
  revision integer not null check (revision > 0),
  status public.review_status not null,
  score numeric(5, 2),
  summary text not null default '',
  answers jsonb not null,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  unique (review_id, revision)
);

create table public.extension_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  legacy_recording_id text not null,
  call_id uuid not null references public.calls(id) on delete cascade,
  status public.import_status not null default 'prepared',
  nonce_hash text not null,
  source_path text,
  converted_path text,
  metadata jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, legacy_recording_id)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger calls_updated_at before update on public.calls
for each row execute function public.set_updated_at();
create trigger transcripts_updated_at before update on public.transcripts
for each row execute function public.set_updated_at();
create trigger jobs_updated_at before update on public.processing_jobs
for each row execute function public.set_updated_at();
create trigger templates_updated_at before update on public.scorecard_templates
for each row execute function public.set_updated_at();
create trigger reviews_updated_at before update on public.call_reviews
for each row execute function public.set_updated_at();
create trigger imports_updated_at before update on public.extension_imports
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do update set email = excluded.email;

  update public.workspace_invites
  set accepted_at = now()
  where lower(email) = lower(coalesce(new.email, ''))
    and accepted_at is null
    and expires_at > now();

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  select workspace_id, new.id, role, invited_by
  from public.workspace_invites
  where lower(email) = lower(coalesce(new.email, ''))
    and accepted_at is not null
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_user_role(target_workspace_id uuid)
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.workspace_members
  where workspace_id = target_workspace_id
    and user_id = auth.uid()
  limit 1;
$$;

create or replace function public.can_view_call(target_call_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.calls c
    join public.workspace_members wm
      on wm.workspace_id = c.workspace_id
     and wm.user_id = auth.uid()
    where c.id = target_call_id
      and c.deleted_at is null
      and (wm.role in ('manager', 'admin') or c.owner_id = auth.uid())
  );
$$;

create or replace function public.can_review_call(target_call_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.calls c
    join public.workspace_members wm
      on wm.workspace_id = c.workspace_id
     and wm.user_id = auth.uid()
    where c.id = target_call_id
      and c.deleted_at is null
      and wm.role in ('manager', 'admin')
  );
$$;

create or replace function public.submit_call_review(
  target_call_id uuid,
  target_scorecard_version_id uuid,
  expected_version integer,
  target_status public.review_status,
  target_summary text,
  target_answers jsonb
)
returns public.call_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  review_record public.call_reviews;
  calculated_score numeric(5, 2);
begin
  if not public.can_review_call(target_call_id) then
    raise exception 'Not authorized to review this call';
  end if;

  if target_status = 'unreviewed' then
    raise exception 'A submitted review cannot be unreviewed';
  end if;

  if not exists (
    select 1
    from public.calls call
    join public.scorecard_templates template
      on template.workspace_id = call.workspace_id
    join public.scorecard_versions version
      on version.template_id = template.id
    where call.id = target_call_id
      and version.id = target_scorecard_version_id
  ) then
    raise exception 'Scorecard version does not belong to the call workspace';
  end if;

  select * into review_record
  from public.call_reviews
  where call_id = target_call_id
  for update;

  if review_record.id is null then
    if expected_version <> 0 then
      raise exception 'Review version conflict';
    end if;
    insert into public.call_reviews (
      call_id, scorecard_version_id, status, summary, updated_by, version
    ) values (
      target_call_id, target_scorecard_version_id, target_status,
      coalesce(target_summary, ''), auth.uid(), 1
    )
    returning * into review_record;
  else
    if review_record.version <> expected_version then
      raise exception 'Review version conflict';
    end if;
    update public.call_reviews
    set scorecard_version_id = target_scorecard_version_id,
        status = target_status,
        summary = coalesce(target_summary, ''),
        updated_by = auth.uid(),
        version = version + 1
    where id = review_record.id
    returning * into review_record;
  end if;

  delete from public.call_review_answers where review_id = review_record.id;

  insert into public.call_review_answers (review_id, criterion_id, value, comment)
  select
    review_record.id,
    (item ->> 'criterionId')::uuid,
    case when item -> 'value' = 'null'::jsonb then null else (item ->> 'value')::smallint end,
    coalesce(item ->> 'comment', '')
  from jsonb_array_elements(target_answers) item
  join public.scorecard_criteria criterion
    on criterion.id = (item ->> 'criterionId')::uuid
  join public.scorecard_categories category
    on category.id = criterion.category_id
  where category.version_id = target_scorecard_version_id;

  select round(
    100 * sum((((answer.value - 1)::numeric / 4) * criterion.weight))
      / nullif(sum(criterion.weight), 0),
    2
  )
  into calculated_score
  from public.call_review_answers answer
  join public.scorecard_criteria criterion on criterion.id = answer.criterion_id
  where answer.review_id = review_record.id
    and answer.value is not null;

  update public.call_reviews
  set score = calculated_score
  where id = review_record.id
  returning * into review_record;

  update public.calls
  set review_status = target_status
  where id = target_call_id;

  insert into public.review_revisions (
    review_id, revision, status, score, summary, answers, submitted_by
  ) values (
    review_record.id,
    review_record.version,
    review_record.status,
    review_record.score,
    review_record.summary,
    target_answers,
    auth.uid()
  );

  return review_record;
end;
$$;

create or replace function public.claim_processing_job(worker_name text)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.processing_jobs
  where status in ('queued', 'retrying')
    and next_attempt_at <= now()
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update public.processing_jobs
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = worker_name,
      error_message = null
  where id = claimed_id
  returning *;
end;
$$;

create or replace function public.finalize_call(
  target_call_id uuid,
  final_chunk_sequence integer,
  target_duration_ms bigint,
  target_mime_type text,
  target_source_mode public.source_mode,
  target_mic_label text,
  target_tab_label text
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
begin
  select * into call_record from public.calls where id = target_call_id for update;
  if call_record.id is null or call_record.deleted_at is not null then
    raise exception 'Call not found';
  end if;

  if call_record.status in ('queued', 'processing', 'ready')
    and call_record.expected_final_chunk = final_chunk_sequence then
    return call_record;
  end if;

  update public.calls
  set expected_final_chunk = final_chunk_sequence,
      duration_ms = target_duration_ms,
      mime_type = target_mime_type,
      source_mode = target_source_mode,
      mic_label = coalesce(target_mic_label, ''),
      tab_label = coalesce(target_tab_label, ''),
      stopped_at = coalesce(stopped_at, now()),
      status = 'queued',
      error_message = null
  where id = target_call_id
  returning * into call_record;

  insert into public.processing_jobs (
    workspace_id, call_id, kind, status, idempotency_key
  ) values (
    call_record.workspace_id, call_record.id, 'process_recording',
    'queued', 'process:' || call_record.id::text
  )
  on conflict (idempotency_key) do update
  set status = case
        when public.processing_jobs.status = 'complete' then public.processing_jobs.status
        else 'queued'::public.job_status
      end,
      next_attempt_at = now(),
      error_message = null;

  return call_record;
end;
$$;

create or replace function public.publish_scorecard(
  target_workspace_id uuid,
  target_template_id uuid,
  target_name text,
  target_actor_id uuid,
  target_categories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  template_id_value uuid;
  version_id_value uuid;
  version_number integer;
  category_item jsonb;
  category_position integer;
  category_id_value uuid;
  criterion_item jsonb;
  criterion_position integer;
begin
  if jsonb_array_length(target_categories) = 0 then
    raise exception 'A scorecard requires at least one category';
  end if;

  if target_template_id is null then
    insert into public.scorecard_templates (
      workspace_id, name, created_by
    ) values (
      target_workspace_id, target_name, target_actor_id
    ) returning id into template_id_value;
  else
    select id into template_id_value
    from public.scorecard_templates
    where id = target_template_id and workspace_id = target_workspace_id
    for update;
    if template_id_value is null then
      raise exception 'Scorecard template not found';
    end if;
    update public.scorecard_templates set name = target_name where id = template_id_value;
  end if;

  select coalesce(max(version), 0) + 1 into version_number
  from public.scorecard_versions
  where template_id = template_id_value;

  insert into public.scorecard_versions (
    template_id, version, published_by
  ) values (
    template_id_value, version_number, target_actor_id
  ) returning id into version_id_value;

  for category_item, category_position in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(target_categories) with ordinality
  loop
    insert into public.scorecard_categories (version_id, name, position)
    values (version_id_value, category_item ->> 'name', category_position)
    returning id into category_id_value;

    for criterion_item, criterion_position in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(category_item -> 'criteria') with ordinality
    loop
      insert into public.scorecard_criteria (
        category_id, label, description, weight, required, position
      ) values (
        category_id_value,
        criterion_item ->> 'label',
        coalesce(criterion_item ->> 'description', ''),
        (criterion_item ->> 'weight')::integer,
        coalesce((criterion_item ->> 'required')::boolean, true),
        criterion_position
      );
    end loop;
  end loop;

  return version_id_value;
end;
$$;

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.calls enable row level security;
alter table public.transcripts enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.export_jobs enable row level security;
alter table public.scorecard_templates enable row level security;
alter table public.scorecard_versions enable row level security;
alter table public.scorecard_categories enable row level security;
alter table public.scorecard_criteria enable row level security;
alter table public.call_reviews enable row level security;
alter table public.call_review_answers enable row level security;
alter table public.review_revisions enable row level security;
alter table public.extension_imports enable row level security;
alter table public.audit_events enable row level security;

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all privileges on all tables in schema public to service_role;

create policy workspaces_select on public.workspaces for select
using (public.current_user_role(id) is not null);

create policy profiles_select on public.profiles for select
using (
  id = auth.uid()
  or exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id
  )
);

create policy members_select on public.workspace_members for select
using (
  user_id = auth.uid()
  or public.current_user_role(workspace_id) in ('manager', 'admin')
);

create policy invites_admin_all on public.workspace_invites for all
using (public.current_user_role(workspace_id) = 'admin')
with check (public.current_user_role(workspace_id) = 'admin');

create policy calls_select on public.calls for select
using (public.can_view_call(id));
create policy calls_insert on public.calls for insert
with check (
  owner_id = auth.uid()
  and public.current_user_role(workspace_id) is not null
);
create policy calls_owner_update on public.calls for update
using (
  owner_id = auth.uid()
  or public.current_user_role(workspace_id) = 'admin'
)
with check (
  owner_id = auth.uid()
  or public.current_user_role(workspace_id) = 'admin'
);

create policy transcripts_select on public.transcripts for select
using (public.can_view_call(call_id));
create policy segments_select on public.transcript_segments for select
using (
  exists (
    select 1 from public.transcripts t
    where t.id = transcript_id and public.can_view_call(t.call_id)
  )
);

create policy jobs_admin_select on public.processing_jobs for select
using (public.current_user_role(workspace_id) = 'admin');
create policy export_jobs_select on public.export_jobs for select
using (public.can_view_call(call_id));

create policy templates_select on public.scorecard_templates for select
using (public.current_user_role(workspace_id) is not null);
create policy templates_admin_all on public.scorecard_templates for all
using (public.current_user_role(workspace_id) = 'admin')
with check (public.current_user_role(workspace_id) = 'admin');

create policy versions_select on public.scorecard_versions for select
using (
  exists (
    select 1 from public.scorecard_templates template
    where template.id = template_id
      and public.current_user_role(template.workspace_id) is not null
  )
);
create policy categories_select on public.scorecard_categories for select
using (
  exists (
    select 1
    from public.scorecard_versions version
    join public.scorecard_templates template on template.id = version.template_id
    where version.id = version_id
      and public.current_user_role(template.workspace_id) is not null
  )
);
create policy criteria_select on public.scorecard_criteria for select
using (
  exists (
    select 1
    from public.scorecard_categories category
    join public.scorecard_versions version on version.id = category.version_id
    join public.scorecard_templates template on template.id = version.template_id
    where category.id = category_id
      and public.current_user_role(template.workspace_id) is not null
  )
);

create policy reviews_select on public.call_reviews for select
using (public.can_view_call(call_id));
create policy reviews_write on public.call_reviews for all
using (public.can_review_call(call_id))
with check (public.can_review_call(call_id));
create policy answers_select on public.call_review_answers for select
using (
  exists (
    select 1 from public.call_reviews review
    where review.id = review_id and public.can_view_call(review.call_id)
  )
);
create policy answers_write on public.call_review_answers for all
using (
  exists (
    select 1 from public.call_reviews review
    where review.id = review_id and public.can_review_call(review.call_id)
  )
)
with check (
  exists (
    select 1 from public.call_reviews review
    where review.id = review_id and public.can_review_call(review.call_id)
  )
);
create policy revisions_select on public.review_revisions for select
using (
  exists (
    select 1 from public.call_reviews review
    where review.id = review_id and public.can_view_call(review.call_id)
  )
);

create policy imports_select on public.extension_imports for select
using (
  user_id = auth.uid()
  or public.current_user_role(workspace_id) = 'admin'
);
create policy audit_admin_select on public.audit_events for select
using (public.current_user_role(workspace_id) = 'admin');

insert into storage.buckets (id, name, public, file_size_limit)
values ('recordings', 'recordings', false, 104857600)
on conflict (id) do update
set public = excluded.public, file_size_limit = excluded.file_size_limit;

create policy recording_chunks_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1 from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
  )
);

create policy recording_chunks_update on storage.objects for update to authenticated
using (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1 from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
  )
)
with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1 from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
  )
);

revoke all on function public.claim_processing_job(text) from public, anon, authenticated;
grant execute on function public.claim_processing_job(text) to service_role;
revoke all on function public.finalize_call(
  uuid, integer, bigint, text, public.source_mode, text, text
) from public, anon, authenticated;
grant execute on function public.finalize_call(
  uuid, integer, bigint, text, public.source_mode, text, text
) to service_role;
revoke all on function public.publish_scorecard(
  uuid, uuid, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.publish_scorecard(
  uuid, uuid, text, uuid, jsonb
) to service_role;
revoke all on function public.submit_call_review(
  uuid, uuid, integer, public.review_status, text, jsonb
) from public, anon;
grant execute on function public.submit_call_review(uuid, uuid, integer, public.review_status, text, jsonb)
  to authenticated;
