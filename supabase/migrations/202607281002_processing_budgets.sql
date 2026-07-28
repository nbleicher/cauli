/**
 * Processing budgets bound transcription spending without putting captured
 * audio at risk.
 *
 * Every worker that is about to commit a Call to paid provider work charges an
 * estimate to a per-day, per-Workspace ledger first. The decision is taken
 * under one transaction-scoped advisory lock per spending day, so two workers
 * racing for the last dollar cannot both be told there is room. When a limit is
 * in the way the Transcription Job becomes Budget Paused, which is a waiting
 * state and not a failure: it consumes no attempt, leaves Source Audio and its
 * backup untouched, and returns to the queue on its own once the ledger rolls
 * over to a new day or a Platform Admin raises the limit.
 *
 * Prices are configuration, not a product assumption. Nothing is estimated
 * unless an active row exists for the model in question, and a Call whose price
 * is unknown waits in Budget Paused instead of spending blind.
 */

-- Platform-scope Audit Events have no Workspace to belong to, and the workspace
-- foreign key was dropped when Audit Events became content-free operational
-- evidence. This reserved identifier keeps them out of every Workspace Admin's
-- Audit Log while remaining a single, greppable scope.
create or replace function public.platform_audit_scope()
returns uuid
language sql
immutable
as $$
  select '00000000-0000-0000-0000-0000000000ff'::uuid;
$$;

create table if not exists public.provider_pricing (
  model text primary key check (char_length(model) between 1 and 160),
  usd_per_audio_minute numeric(12, 6) not null
    check (usd_per_audio_minute >= 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

comment on table public.provider_pricing is
  'Operator-maintained transcription prices. A model with no active row here cannot be estimated, and its work waits in Budget Paused.';

-- Seeded from the OpenRouter list price for the two models the worker is
-- configured to use. These are starting values for the operator to confirm,
-- which is why they are rows rather than constants in the estimator.
insert into public.provider_pricing (model, usd_per_audio_minute)
values
  ('openai/whisper-large-v3-turbo', 0.001667),
  ('openai/whisper-large-v3', 0.006000)
on conflict (model) do nothing;

create table if not exists public.platform_processing_budget (
  singleton boolean primary key default true check (singleton),
  daily_limit_usd numeric(10, 2) not null default 50.00
    check (daily_limit_usd >= 0),
  warning_ratio numeric(4, 3) not null default 0.800
    check (warning_ratio > 0 and warning_ratio <= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.platform_processing_budget (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.workspace_processing_budget (
  workspace_id uuid primary key
    references public.workspaces(id) on delete cascade,
  daily_limit_usd numeric(10, 2) not null default 10.00
    check (daily_limit_usd >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Reserved is estimated spend held by a job that is running right now; settled
-- is what the provider actually charged. A limit is measured against their sum
-- so in-flight work cannot be spent twice.
create table if not exists public.processing_spend (
  spend_date date not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  reserved_usd numeric(14, 6) not null default 0 check (reserved_usd >= 0),
  settled_usd numeric(14, 6) not null default 0 check (settled_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (spend_date, workspace_id)
);

create index if not exists processing_spend_date_idx
  on public.processing_spend (spend_date);

-- One warning per scope per day. The row is the claim; whoever inserts it is
-- the one that writes the Audit Event.
create table if not exists public.processing_budget_warnings (
  spend_date date not null,
  scope_key text not null,
  created_at timestamptz not null default now(),
  primary key (spend_date, scope_key)
);

alter table public.platform_processing_budget enable row level security;
alter table public.workspace_processing_budget enable row level security;
alter table public.provider_pricing enable row level security;
alter table public.processing_spend enable row level security;
alter table public.processing_budget_warnings enable row level security;

revoke all on public.platform_processing_budget
  from public, anon, authenticated;
revoke all on public.workspace_processing_budget
  from public, anon, authenticated;
revoke all on public.provider_pricing from public, anon, authenticated;
revoke all on public.processing_spend from public, anon, authenticated;
revoke all on public.processing_budget_warnings
  from public, anon, authenticated;
grant all privileges on public.platform_processing_budget to service_role;
grant all privileges on public.workspace_processing_budget to service_role;
grant all privileges on public.provider_pricing to service_role;
grant all privileges on public.processing_spend to service_role;
grant all privileges on public.processing_budget_warnings to service_role;

alter table public.processing_jobs
  add column if not exists budget_reserved_usd numeric(14, 6) not null default 0
    check (budget_reserved_usd >= 0),
  add column if not exists budget_reserved_date date,
  add column if not exists budget_paused_at timestamptz,
  add column if not exists budget_paused_reason text
    check (budget_paused_reason is null or budget_paused_reason in (
      'workspace_limit', 'platform_limit', 'pricing_unconfigured'
    ));

create index if not exists processing_jobs_budget_paused_idx
  on public.processing_jobs (created_at)
  where status = 'budget_paused';

create or replace function public.workspace_daily_budget_usd(
  target_workspace_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select daily_limit_usd
      from public.workspace_processing_budget
      where workspace_id = target_workspace_id
    ),
    10.00
  );
$$;

create or replace function public.platform_daily_budget_usd()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select daily_limit_usd from public.platform_processing_budget), 50.00
  );
$$;

create or replace function public.processing_budget_warning_ratio()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select warning_ratio from public.platform_processing_budget), 0.800
  );
$$;

/**
 * The worst active price, because the worker may fall back from its primary
 * model to a more expensive one mid-job. Returning null rather than raising
 * lets an unpriced model park the job in Budget Paused instead of failing it.
 */
create or replace function public.estimated_transcription_cost_usd(
  target_duration_ms bigint
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rate numeric;
begin
  select max(usd_per_audio_minute) into rate
  from public.provider_pricing
  where is_active;

  if rate is null then
    return null;
  end if;

  return round(rate * (greatest(coalesce(target_duration_ms, 0), 0)::numeric
    / 60000), 6);
end;
$$;

/**
 * Release valve for configuration drift: the worker calls this at startup with
 * the models it is actually about to use, so a model that nobody has priced is
 * discovered before a single Call queues behind it.
 */
create or replace function public.assert_transcription_models_priced(
  target_models text[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  missing text[];
begin
  select array_agg(candidate)
  into missing
  from unnest(target_models) as candidate
  where not exists (
    select 1
    from public.provider_pricing
    where model = candidate and is_active
  );

  if missing is not null then
    raise exception
      'No active provider pricing is configured for: %',
      array_to_string(missing, ', ')
      using errcode = '22023';
  end if;

  return true;
end;
$$;

create or replace function private.processing_spend_today(
  target_workspace_id uuid,
  charge_date date
)
returns table (workspace_spent numeric, platform_spent numeric)
language sql
set search_path = public
as $$
  select
    coalesce(sum(reserved_usd + settled_usd)
      filter (where workspace_id = target_workspace_id), 0),
    coalesce(sum(reserved_usd + settled_usd), 0)
  from public.processing_spend
  where spend_date = charge_date;
$$;

/**
 * Writes at most one Audit Event per scope per day when spending crosses the
 * configured share of a limit, so a Platform Admin hears about it before work
 * stops rather than afterwards.
 */
create or replace function private.warn_on_budget_threshold(
  charge_date date,
  target_workspace_id uuid,
  workspace_spent numeric,
  workspace_limit numeric,
  platform_spent numeric,
  platform_limit numeric
)
returns void
language plpgsql
set search_path = public
as $$
declare
  ratio numeric := public.processing_budget_warning_ratio();
  claimed integer;
begin
  if workspace_limit > 0 and workspace_spent >= ratio * workspace_limit then
    insert into public.processing_budget_warnings (spend_date, scope_key)
    values (charge_date, target_workspace_id::text)
    on conflict do nothing;
    get diagnostics claimed = row_count;
    if claimed > 0 then
      perform public.record_audit_event(
        public.platform_audit_scope(),
        null,
        'platform.budget.warned',
        'workspace_budget',
        target_workspace_id::text,
        jsonb_build_object(
          'scope', 'workspace',
          'threshold_ratio', ratio,
          'limit_usd', workspace_limit,
          'spent_usd', round(workspace_spent, 6)
        )
      );
    end if;
  end if;

  if platform_limit > 0 and platform_spent >= ratio * platform_limit then
    insert into public.processing_budget_warnings (spend_date, scope_key)
    values (charge_date, 'platform')
    on conflict do nothing;
    get diagnostics claimed = row_count;
    if claimed > 0 then
      perform public.record_audit_event(
        public.platform_audit_scope(),
        null,
        'platform.budget.warned',
        'platform_budget',
        charge_date::text,
        jsonb_build_object(
          'scope', 'platform',
          'threshold_ratio', ratio,
          'limit_usd', platform_limit,
          'spent_usd', round(platform_spent, 6)
        )
      );
    end if;
  end if;
end;
$$;

create or replace function private.processing_budget_available(
  target_workspace_id uuid,
  workspace_amount numeric,
  platform_amount numeric
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  charge_date date := (now() at time zone 'utc')::date;
  spent record;
begin
  select * into spent
  from private.processing_spend_today(target_workspace_id, charge_date);

  return spent.workspace_spent + workspace_amount
      <= public.workspace_daily_budget_usd(target_workspace_id)
    and spent.platform_spent + platform_amount
      <= public.platform_daily_budget_usd();
end;
$$;

/**
 * Reserves an estimate or explains which limit refused it. The advisory lock is
 * transaction scoped and keyed by the spending day, so every worker deciding
 * about today's money queues behind the same gate and the global limit cannot
 * be oversubscribed by workers spending in different Workspaces.
 */
create or replace function private.charge_processing_budget(
  target_workspace_id uuid,
  estimate numeric
)
returns text
language plpgsql
set search_path = public
as $$
declare
  charge_date date := (now() at time zone 'utc')::date;
  workspace_limit numeric := public.workspace_daily_budget_usd(
    target_workspace_id
  );
  platform_limit numeric := public.platform_daily_budget_usd();
  spent record;
begin
  perform pg_advisory_xact_lock(
    hashtext('cauli.processing_budget'),
    hashtext(charge_date::text)
  );

  insert into public.processing_spend (spend_date, workspace_id)
  values (charge_date, target_workspace_id)
  on conflict do nothing;

  select * into spent
  from private.processing_spend_today(target_workspace_id, charge_date);

  if spent.workspace_spent + estimate > workspace_limit then
    return 'workspace_limit';
  end if;
  if spent.platform_spent + estimate > platform_limit then
    return 'platform_limit';
  end if;

  update public.processing_spend
  set reserved_usd = reserved_usd + estimate,
      updated_at = now()
  where spend_date = charge_date
    and workspace_id = target_workspace_id;

  perform private.warn_on_budget_threshold(
    charge_date,
    target_workspace_id,
    spent.workspace_spent + estimate,
    workspace_limit,
    spent.platform_spent + estimate,
    platform_limit
  );

  return 'allowed';
end;
$$;

create or replace function private.release_processing_reservation(
  charge_date date,
  target_workspace_id uuid,
  amount numeric
)
returns void
language sql
set search_path = public
as $$
  update public.processing_spend
  set reserved_usd = greatest(0, reserved_usd - amount),
      updated_at = now()
  where spend_date = charge_date
    and workspace_id = target_workspace_id;
$$;

create or replace function private.settle_processing_spend(
  target_workspace_id uuid,
  amount numeric
)
returns void
language plpgsql
set search_path = public
as $$
declare
  charge_date date := (now() at time zone 'utc')::date;
  spent record;
begin
  if amount is null or amount <= 0 then
    return;
  end if;

  insert into public.processing_spend (spend_date, workspace_id)
  values (charge_date, target_workspace_id)
  on conflict do nothing;

  update public.processing_spend
  set settled_usd = settled_usd + amount,
      updated_at = now()
  where spend_date = charge_date
    and workspace_id = target_workspace_id;

  select * into spent
  from private.processing_spend_today(target_workspace_id, charge_date);

  perform private.warn_on_budget_threshold(
    charge_date,
    target_workspace_id,
    spent.workspace_spent,
    public.workspace_daily_budget_usd(target_workspace_id),
    spent.platform_spent,
    public.platform_daily_budget_usd()
  );
end;
$$;

/**
 * A reservation belongs to a running lease. However that lease ends — commit,
 * retry, failure, or an expired-lease sweep — the money goes back, so the
 * ledger cannot drift upward through paths that never reach a commit.
 */
-- Security definer because the worker principal reaches this trigger on its
-- ordinary retry and failure paths, and the ledger it has to correct lives in
-- the private schema that no runtime principal may enter directly.
create or replace function public.release_processing_budget_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.release_processing_reservation(
    old.budget_reserved_date,
    old.workspace_id,
    old.budget_reserved_usd
  );
  new.budget_reserved_usd := 0;
  new.budget_reserved_date := null;
  return new;
end;
$$;

drop trigger if exists processing_jobs_release_budget on public.processing_jobs;
create trigger processing_jobs_release_budget
before update on public.processing_jobs
for each row
when (
  old.status = 'processing'
  and new.status <> 'processing'
  and old.budget_reserved_usd > 0
  and old.budget_reserved_date is not null
)
execute function public.release_processing_budget_reservation();

create or replace function private.pause_job_for_budget(
  target_job public.processing_jobs,
  reason_code text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  explanation text := case reason_code
    when 'workspace_limit'
      then 'this Workspace has reached its daily processing budget'
    when 'platform_limit'
      then 'Cauli has reached its daily processing budget'
    else 'transcription pricing is not configured'
  end;
begin
  -- attempts is deliberately untouched: waiting for money is not a failed try.
  update public.processing_jobs
  set status = 'budget_paused',
      budget_paused_at = now(),
      budget_paused_reason = reason_code,
      error_message = null,
      locked_at = null,
      locked_by = null,
      lease_token = null,
      next_attempt_at = now()
  where id = target_job.id;

  if target_job.call_id is not null then
    update public.calls
    set status = 'budget_paused',
        error_message = 'Transcription is waiting because ' || explanation
          || '. Your recording is safe and processing resumes automatically.'
    where id = target_job.call_id
      and deleted_at is null;
  end if;

  perform public.record_audit_event(
    target_job.workspace_id,
    null,
    'processing.budget.paused',
    'processing_job',
    target_job.id::text,
    jsonb_build_object(
      'reason_code', reason_code,
      'attempts', target_job.attempts
    )
  );
end;
$$;

/**
 * Returns paused work to the queue as soon as there is room for it, which is
 * what both the daily ledger rollover and an authorized limit change look like
 * from here. Estimates are accumulated as the loop runs so a single opening is
 * not offered to every waiting job at once.
 */
create or replace function public.resume_budget_paused_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  paused public.processing_jobs%rowtype;
  estimate numeric;
  workspace_pending jsonb := '{}'::jsonb;
  platform_pending numeric := 0;
  pending numeric;
  resumed integer := 0;
begin
  for paused in
    select *
    from public.processing_jobs
    where status = 'budget_paused'
    order by created_at
    for update skip locked
  loop
    select public.estimated_transcription_cost_usd(call.duration_ms)
    into estimate
    from public.calls call
    where call.id = paused.call_id
      and call.deleted_at is null;

    if estimate is null then
      continue;
    end if;

    pending := coalesce(
      (workspace_pending ->> paused.workspace_id::text)::numeric, 0
    );

    if not private.processing_budget_available(
      paused.workspace_id,
      pending + estimate,
      platform_pending + estimate
    ) then
      continue;
    end if;

    workspace_pending := jsonb_set(
      workspace_pending,
      array[paused.workspace_id::text],
      to_jsonb(pending + estimate)
    );
    platform_pending := platform_pending + estimate;

    update public.processing_jobs
    set status = 'queued',
        next_attempt_at = now(),
        budget_paused_at = null,
        budget_paused_reason = null
    where id = paused.id;

    update public.calls
    set status = 'queued',
        error_message = null
    where id = paused.call_id
      and deleted_at is null
      and status = 'budget_paused';

    perform public.record_audit_event(
      paused.workspace_id,
      null,
      'processing.budget.resumed',
      'processing_job',
      paused.id::text,
      jsonb_build_object('attempts', paused.attempts)
    );

    resumed := resumed + 1;
  end loop;

  return resumed;
end;
$$;

create or replace function public.claim_processing_job(worker_name text)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.processing_jobs%rowtype;
  candidate public.processing_jobs%rowtype;
  estimate numeric;
  verdict text;
  remaining_candidates integer := 20;
begin
  update public.processing_jobs
  set status = 'failed',
      error_message = 'The associated Call no longer exists.',
      finished_at = now(),
      locked_at = null,
      locked_by = null,
      lease_token = null
  where call_id is null
    and kind in ('process_recording', 'generate_wav', 'delete_call')
    and (
      status in ('queued', 'retrying')
      or (
        status = 'processing'
        and locked_at < now() - interval '5 minutes'
      )
    );

  update public.calls as call
  set status = 'failed',
      error_message = 'Processing stopped after the final worker lease expired.'
  where exists (
    select 1
    from public.processing_jobs as job
    where job.call_id = call.id
      and job.kind = 'process_recording'
      and job.status = 'processing'
      and job.locked_at < now() - interval '5 minutes'
      and job.attempts >= job.max_attempts
  );

  update public.export_jobs as export
  set status = 'failed',
      error_message = 'Export stopped after the final worker lease expired.'
  where exists (
    select 1
    from public.processing_jobs as job
    where job.call_id = export.call_id
      and job.kind = 'generate_wav'
      and job.status = 'processing'
      and job.locked_at < now() - interval '5 minutes'
      and job.attempts >= job.max_attempts
  );

  update public.processing_jobs
  set status = 'failed',
      error_message = 'Worker lease expired after the final attempt.',
      finished_at = now(),
      locked_at = null,
      locked_by = null,
      lease_token = null
  where status = 'processing'
    and locked_at < now() - interval '5 minutes'
    and attempts >= max_attempts;

  while remaining_candidates > 0 loop
    remaining_candidates := remaining_candidates - 1;

    select * into candidate
    from public.processing_jobs
    where (
        (
          status in ('queued', 'retrying')
          and next_attempt_at <= now()
        )
        or (
          status = 'processing'
          and locked_at < now() - interval '5 minutes'
          and attempts < max_attempts
        )
      )
      and (
        call_id is not null
        or kind = 'cleanup_abandoned'
      )
    order by
      case when status = 'processing' then 0 else 1 end,
      coalesce(locked_at, next_attempt_at),
      created_at
    for update skip locked
    limit 1;

    if not found then
      return;
    end if;

    estimate := 0;

    -- Reclaimed leases still hold yesterday's reservation; give it back before
    -- pricing this attempt so the same work is never charged twice.
    if candidate.budget_reserved_usd > 0
      and candidate.budget_reserved_date is not null then
      perform private.release_processing_reservation(
        candidate.budget_reserved_date,
        candidate.workspace_id,
        candidate.budget_reserved_usd
      );
    end if;

    if candidate.kind = 'process_recording'
      and candidate.call_id is not null
      and coalesce(candidate.payload ->> 'skipTranscription', 'false')
        <> 'true'
    then
      select public.estimated_transcription_cost_usd(call.duration_ms)
      into estimate
      from public.calls call
      where call.id = candidate.call_id;

      if estimate is null then
        perform private.pause_job_for_budget(
          candidate, 'pricing_unconfigured'
        );
        continue;
      end if;

      verdict := private.charge_processing_budget(
        candidate.workspace_id, estimate
      );
      if verdict <> 'allowed' then
        perform private.pause_job_for_budget(candidate, verdict);
        continue;
      end if;
    end if;

    update public.processing_jobs
    set status = 'processing',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = worker_name,
        lease_token = gen_random_uuid(),
        error_message = null,
        finished_at = null,
        budget_reserved_usd = estimate,
        budget_reserved_date = case
          when estimate > 0 then (now() at time zone 'utc')::date
        end,
        budget_paused_at = null,
        budget_paused_reason = null
    where id = candidate.id
    returning * into claimed_job;

    if claimed_job.kind = 'process_recording'
      and claimed_job.call_id is not null then
      update public.calls
      set status = 'processing',
          error_message = null
      where id = claimed_job.call_id;
    end if;

    return next claimed_job;
    return;
  end loop;

  return;
end;
$$;

create or replace function public.commit_processed_recording(
  target_job_id uuid,
  target_lease_token uuid,
  target_source_path text,
  target_mp3_path text,
  target_source_bytes bigint,
  target_model text,
  target_language text,
  target_full_text text,
  target_provider_generation_id text,
  target_provider_cost_usd numeric,
  target_provider_duration_seconds numeric,
  target_segments jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.processing_jobs%rowtype;
  saved_transcript_id uuid;
begin
  select *
  into claimed_job
  from private.lock_owned_processing_job(
    target_job_id,
    target_lease_token,
    'process_recording'
  );

  if not found or claimed_job.call_id is null then
    return false;
  end if;

  if target_model is not null then
    if jsonb_typeof(target_segments) <> 'array' then
      raise exception 'Transcript segments must be an array';
    end if;

    insert into public.transcripts (
      call_id,
      model,
      language,
      full_text,
      provider_generation_id,
      provider_cost_usd,
      provider_duration_seconds
    )
    values (
      claimed_job.call_id,
      target_model,
      target_language,
      coalesce(target_full_text, ''),
      target_provider_generation_id,
      target_provider_cost_usd,
      target_provider_duration_seconds
    )
    on conflict (call_id) do update
    set model = excluded.model,
        language = excluded.language,
        full_text = excluded.full_text,
        provider_generation_id = excluded.provider_generation_id,
        provider_cost_usd = excluded.provider_cost_usd,
        provider_duration_seconds = excluded.provider_duration_seconds
    returning id into saved_transcript_id;

    delete from public.transcript_segments
    where transcript_id = saved_transcript_id;

    insert into public.transcript_segments (
      transcript_id,
      sequence,
      start_ms,
      end_ms,
      text
    )
    select
      saved_transcript_id,
      segment.sequence,
      segment.start_ms,
      segment.end_ms,
      segment.text
    from jsonb_to_recordset(target_segments) as segment(
      sequence integer,
      start_ms bigint,
      end_ms bigint,
      text text
    )
    order by segment.sequence;

    -- What the provider actually charged replaces the estimate this job was
    -- holding; the reservation itself is released by the lease trigger below.
    perform private.settle_processing_spend(
      claimed_job.workspace_id,
      target_provider_cost_usd
    );
  end if;

  update public.calls
  set status = 'ready',
      source_path = target_source_path,
      mp3_path = target_mp3_path,
      source_bytes = target_source_bytes,
      error_message = null
  where id = claimed_job.call_id;

  if claimed_job.payload ? 'extensionImportId' then
    update public.extension_imports
    set status = 'complete',
        error_message = null
    where id::text = claimed_job.payload ->> 'extensionImportId';
  end if;

  if not private.complete_processing_job(
    claimed_job.id,
    target_lease_token
  ) then
    raise exception 'Recording lease changed during commit';
  end if;

  return true;
end;
$$;

create or replace function public.set_platform_processing_budget(
  target_daily_limit_usd numeric,
  target_warning_ratio numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.platform_processing_budget;
  resumed integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'The Platform Admin control plane is not installed yet'
      using errcode = '42501';
  end if;

  if target_daily_limit_usd is null or target_daily_limit_usd < 0 then
    raise exception 'A platform budget must be zero or more';
  end if;

  update public.platform_processing_budget
  set daily_limit_usd = target_daily_limit_usd,
      warning_ratio = coalesce(target_warning_ratio, warning_ratio),
      updated_at = now(),
      updated_by = auth.uid()
  where singleton
  returning * into updated;

  perform public.record_audit_event(
    public.platform_audit_scope(),
    auth.uid(),
    'platform.budget.changed',
    'platform_budget',
    'daily',
    jsonb_build_object(
      'limit_usd', updated.daily_limit_usd,
      'threshold_ratio', updated.warning_ratio
    )
  );

  resumed := public.resume_budget_paused_jobs();

  return jsonb_build_object(
    'dailyLimitUsd', updated.daily_limit_usd,
    'warningRatio', updated.warning_ratio,
    'resumedJobs', resumed
  );
end;
$$;

create or replace function public.set_workspace_processing_budget(
  target_workspace_id uuid,
  target_daily_limit_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resumed integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'The Platform Admin control plane is not installed yet'
      using errcode = '42501';
  end if;

  if target_daily_limit_usd is null or target_daily_limit_usd < 0 then
    raise exception 'A Workspace budget must be zero or more';
  end if;

  insert into public.workspace_processing_budget (
    workspace_id, daily_limit_usd, updated_by
  )
  values (target_workspace_id, target_daily_limit_usd, auth.uid())
  on conflict (workspace_id) do update
  set daily_limit_usd = excluded.daily_limit_usd,
      updated_at = now(),
      updated_by = excluded.updated_by;

  -- Audited inside the Workspace as well, because its Admin is accountable for
  -- explaining the delay even though they cannot lift the limit themselves.
  perform public.record_audit_event(
    target_workspace_id,
    auth.uid(),
    'platform.budget.changed',
    'workspace_budget',
    target_workspace_id::text,
    jsonb_build_object('limit_usd', target_daily_limit_usd)
  );

  resumed := public.resume_budget_paused_jobs();

  return jsonb_build_object(
    'dailyLimitUsd', target_daily_limit_usd,
    'resumedJobs', resumed
  );
end;
$$;

create or replace function public.set_provider_pricing(
  target_model text,
  target_usd_per_audio_minute numeric,
  target_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'The Platform Admin control plane is not installed yet'
      using errcode = '42501';
  end if;

  if target_usd_per_audio_minute is null
    or target_usd_per_audio_minute < 0 then
    raise exception 'Provider pricing must be zero or more';
  end if;

  insert into public.provider_pricing (
    model, usd_per_audio_minute, is_active, updated_by
  )
  values (
    target_model, target_usd_per_audio_minute, target_is_active, auth.uid()
  )
  on conflict (model) do update
  set usd_per_audio_minute = excluded.usd_per_audio_minute,
      is_active = excluded.is_active,
      updated_at = now(),
      updated_by = excluded.updated_by;

  perform public.record_audit_event(
    public.platform_audit_scope(),
    auth.uid(),
    'platform.pricing.changed',
    'provider_pricing',
    target_model,
    jsonb_build_object(
      'usd_per_audio_minute', target_usd_per_audio_minute,
      'active', target_is_active
    )
  );

  return jsonb_build_object(
    'model', target_model,
    'usdPerAudioMinute', target_usd_per_audio_minute,
    'active', target_is_active
  );
end;
$$;

/**
 * What a Workspace Admin is allowed to know: the limit that applies, what has
 * been spent against it today, and how much of their work is waiting. The
 * platform limit is deliberately absent — it is not theirs to see or to change.
 */
create or replace function public.workspace_processing_budget_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  charge_date date := (now() at time zone 'utc')::date;
  spent record;
  paused_count integer;
  paused_reason text;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active';

  if actor_workspace_id is null
    or public.current_user_role(actor_workspace_id) <> 'admin' then
    raise exception 'Only a Workspace Admin can read the processing budget'
      using errcode = '42501';
  end if;

  select * into spent
  from private.processing_spend_today(actor_workspace_id, charge_date);

  select count(*), min(budget_paused_reason)
  into paused_count, paused_reason
  from public.processing_jobs
  where workspace_id = actor_workspace_id
    and status = 'budget_paused';

  return jsonb_build_object(
    'dailyLimitUsd', public.workspace_daily_budget_usd(actor_workspace_id),
    'spentTodayUsd', round(spent.workspace_spent, 4),
    'warningRatio', public.processing_budget_warning_ratio(),
    'pausedJobCount', paused_count,
    'pausedReason', paused_reason,
    'editable', false
  );
end;
$$;

revoke all on function public.workspace_daily_budget_usd(uuid)
  from public, anon, authenticated;
grant execute on function public.workspace_daily_budget_usd(uuid)
  to service_role;
revoke all on function public.platform_daily_budget_usd()
  from public, anon, authenticated;
grant execute on function public.platform_daily_budget_usd() to service_role;
revoke all on function public.processing_budget_warning_ratio()
  from public, anon, authenticated;
revoke all on function public.estimated_transcription_cost_usd(bigint)
  from public, anon, authenticated;
grant execute on function public.estimated_transcription_cost_usd(bigint)
  to service_role;
revoke all on function public.assert_transcription_models_priced(text[])
  from public, anon, authenticated;
grant execute on function public.assert_transcription_models_priced(text[])
  to service_role;
revoke all on function public.resume_budget_paused_jobs()
  from public, anon, authenticated;
grant execute on function public.resume_budget_paused_jobs() to service_role;
revoke all on function public.release_processing_budget_reservation()
  from public, anon, authenticated;

revoke all on function public.set_platform_processing_budget(numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.set_platform_processing_budget(numeric, numeric)
  to service_role;
revoke all on function public.set_workspace_processing_budget(uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.set_workspace_processing_budget(uuid, numeric)
  to service_role;
revoke all on function public.set_provider_pricing(text, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.set_provider_pricing(text, numeric, boolean)
  to service_role;
revoke all on function public.workspace_processing_budget_status()
  from public, anon;
grant execute on function public.workspace_processing_budget_status()
  to authenticated;
