/**
 * Durable evidence for the processing service level.
 *
 * The pilot promises that a Call of an hour or less is Ready within five
 * minutes of Stop & Save. Proving that needs a record that outlives a job row
 * and does not depend on sampled telemetry, so every finished attempt writes
 * one content-free run: how long it waited for a worker, how long the work
 * itself took, and how long the Workspace Member actually waited.
 *
 * Queue and processing time are kept apart because they fail for different
 * reasons and are fixed differently — one by adding workers, the other by
 * making the work faster — while the promise itself is measured on the wall
 * clock the user experiences, which is their sum plus anything else in the way.
 *
 * Provider incidents are recorded with their error class so a bad hour at
 * OpenRouter can be reported separately from Cauli missing its own target,
 * without ever hiding it.
 */

create table if not exists public.processing_runs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  call_id uuid,
  job_id uuid not null,
  kind public.job_kind not null,
  attempt integer not null check (attempt >= 0),
  outcome text not null check (outcome in ('complete', 'failed')),
  error_category text,
  queued_at timestamptz not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  queue_ms bigint not null check (queue_ms >= 0),
  processing_ms bigint not null check (processing_ms >= 0),
  -- Null for work that has no Stop & Save to measure from, such as exports.
  service_level_ms bigint,
  audio_duration_ms bigint,
  -- Calls over an hour stay supported and stay measured; they simply are not
  -- counted against the five-minute promise.
  counts_toward_target boolean not null default false,
  met_target boolean,
  created_at timestamptz not null default now()
);

comment on table public.processing_runs is
  'Content-free timing evidence for the processing service level. Cauli''s own source of truth, not sampled telemetry.';

create index if not exists processing_runs_window_idx
  on public.processing_runs (finished_at desc);
create index if not exists processing_runs_target_idx
  on public.processing_runs (finished_at desc)
  where counts_toward_target;
create index if not exists processing_runs_incident_idx
  on public.processing_runs (finished_at desc)
  where outcome = 'failed';

alter table public.processing_runs enable row level security;
revoke all on public.processing_runs from public, anon, authenticated;
grant all privileges on public.processing_runs to service_role;

/**
 * Every attempt that reaches a terminal state records itself, whichever path
 * got it there: an atomic commit, a worker reporting exhaustion, or the sweep
 * that fails a job whose final lease expired. Budget Paused is deliberately
 * absent — it is not an attempt — but the wait it causes still lands in
 * service_level_ms of the attempt that eventually finishes, because that is
 * what the Workspace Member actually experienced.
 */
create or replace function public.record_processing_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  finished timestamptz := now();
  started timestamptz := coalesce(old.locked_at, old.created_at);
  service_ms bigint;
  eligible boolean := false;
begin
  if new.call_id is not null then
    select * into call_record from public.calls where id = new.call_id;
  end if;

  if new.kind = 'process_recording' and call_record.stopped_at is not null then
    service_ms := (extract(epoch from (finished - call_record.stopped_at))
      * 1000)::bigint;
    eligible := coalesce(call_record.duration_ms, 0) <= 3_600_000;
  end if;

  insert into public.processing_runs (
    workspace_id,
    call_id,
    job_id,
    kind,
    attempt,
    outcome,
    error_category,
    queued_at,
    started_at,
    finished_at,
    queue_ms,
    processing_ms,
    service_level_ms,
    audio_duration_ms,
    counts_toward_target,
    met_target
  ) values (
    new.workspace_id,
    new.call_id,
    new.id,
    new.kind,
    new.attempts,
    new.status::text,
    new.error_category,
    old.created_at,
    started,
    finished,
    greatest(0, (extract(epoch from (started - old.created_at)) * 1000)::bigint),
    greatest(0, (extract(epoch from (finished - started)) * 1000)::bigint),
    service_ms,
    call_record.duration_ms,
    eligible,
    case when eligible then service_ms <= 300_000 end
  );

  return null;
end;
$$;

drop trigger if exists processing_jobs_record_run on public.processing_jobs;
create trigger processing_jobs_record_run
after update on public.processing_jobs
for each row
when (
  old.status = 'processing'
  and new.status in ('complete', 'failed')
)
execute function public.record_processing_run();

/**
 * The service-level result over a window, with queue and processing time
 * reported separately so a breach points at its own cause. Provider incidents
 * are counted apart from the ratio rather than excused from it.
 */
create or replace function public.processing_service_level(
  window_hours integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  window_start timestamptz := now() - make_interval(hours => greatest(
    1, least(coalesce(window_hours, 24), 24 * 90)
  ));
  measured record;
begin
  select
    count(*) filter (where counts_toward_target) as eligible_runs,
    count(*) filter (where counts_toward_target and met_target) as met_runs,
    count(*) filter (
      where kind = 'process_recording' and not counts_toward_target
    ) as long_calls,
    count(*) filter (
      where outcome = 'failed'
        and error_category in (
          'provider_unavailable', 'rate_limit', 'timeout', 'billing',
          'authentication'
        )
    ) as provider_incidents,
    coalesce(
      percentile_cont(0.95) within group (order by queue_ms), 0
    )::bigint as p95_queue_ms,
    coalesce(
      percentile_cont(0.95) within group (order by processing_ms), 0
    )::bigint as p95_processing_ms,
    coalesce(
      percentile_cont(0.95) within group (order by service_level_ms)
        filter (where counts_toward_target),
      0
    )::bigint as p95_service_level_ms
  into measured
  from public.processing_runs
  where finished_at >= window_start;

  return jsonb_build_object(
    'windowHours', greatest(1, least(coalesce(window_hours, 24), 24 * 90)),
    'eligibleCalls', measured.eligible_runs,
    'callsWithinTarget', measured.met_runs,
    'ratioWithinTarget', case
      when measured.eligible_runs = 0 then null
      else round(measured.met_runs::numeric / measured.eligible_runs, 4)
    end,
    'longCallsExcluded', measured.long_calls,
    'providerIncidents', measured.provider_incidents,
    'p95QueueMs', measured.p95_queue_ms,
    'p95ProcessingMs', measured.p95_processing_ms,
    'p95ServiceLevelMs', measured.p95_service_level_ms
  );
end;
$$;

create or replace function public.processing_queue_age_seconds()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    max(extract(epoch from (now() - next_attempt_at)))::bigint, 0
  )
  from public.processing_jobs
  where status in ('queued', 'retrying')
    and next_attempt_at <= now()
    and (call_id is not null or kind = 'cleanup_abandoned');
$$;

/**
 * The alert set an operator is expected to act on. Kept in the database so it
 * is computed from Cauli's durable evidence rather than from sampled telemetry
 * that may have been dropped for quota.
 */
create or replace function public.processing_operational_alerts()
returns table (alert text, severity text, detail jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  queue_age bigint := public.processing_queue_age_seconds();
  level jsonb := public.processing_service_level(24);
  attention_count bigint;
  incident_count bigint;
  warned_scopes bigint;
begin
  if queue_age > 300 then
    alert := 'processing.queue_age';
    severity := 'warning';
    detail := jsonb_build_object('queueAgeSeconds', queue_age);
    return next;
  end if;

  if (level ->> 'eligibleCalls')::bigint >= 20
    and (level ->> 'ratioWithinTarget')::numeric < 0.95 then
    alert := 'processing.service_level';
    severity := 'critical';
    detail := level;
    return next;
  end if;

  select count(*) into attention_count
  from public.processing_jobs
  where status = 'failed'
    and attempts >= max_attempts
    and finished_at >= now() - interval '1 hour';
  if attention_count >= 3 then
    alert := 'processing.needs_attention';
    severity := 'critical';
    detail := jsonb_build_object('failuresLastHour', attention_count);
    return next;
  end if;

  select count(*) into incident_count
  from public.processing_runs
  where outcome = 'failed'
    and finished_at >= now() - interval '1 hour'
    and error_category in (
      'provider_unavailable', 'rate_limit', 'timeout', 'billing',
      'authentication'
    );
  if incident_count >= 3 then
    alert := 'processing.provider_incident';
    severity := 'warning';
    detail := jsonb_build_object('providerFailuresLastHour', incident_count);
    return next;
  end if;

  select count(*) into warned_scopes
  from public.processing_budget_warnings
  where spend_date = (now() at time zone 'utc')::date;
  if warned_scopes > 0 then
    alert := 'processing.budget_threshold';
    severity := 'warning';
    detail := jsonb_build_object('scopesWarnedToday', warned_scopes);
    return next;
  end if;

  return;
end;
$$;

/**
 * Timing evidence is operational, not content, and it is not needed forever.
 * Ninety days outlives any single release investigation while keeping the
 * table bounded without a sweeper of its own.
 */
create or replace function public.purge_expired_processing_runs()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.processing_runs
  where finished_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.record_processing_run()
  from public, anon, authenticated;
revoke all on function public.processing_service_level(integer)
  from public, anon, authenticated;
grant execute on function public.processing_service_level(integer)
  to service_role;
revoke all on function public.processing_queue_age_seconds()
  from public, anon, authenticated;
grant execute on function public.processing_queue_age_seconds() to service_role;
revoke all on function public.processing_operational_alerts()
  from public, anon, authenticated;
grant execute on function public.processing_operational_alerts()
  to service_role;
revoke all on function public.purge_expired_processing_runs()
  from public, anon, authenticated;
grant execute on function public.purge_expired_processing_runs()
  to service_role;
