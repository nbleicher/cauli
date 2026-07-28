-- The additional offline copy on Peely, and the evidence that recovery has
-- actually been demonstrated rather than assumed.
--
-- Peely is deliberately the least capable principal in the system. It learns
-- which opaque objects exist and what they should hash to — enough to copy and
-- verify them, and nothing else. It cannot tell which Workspace or Call any
-- object belongs to, it holds no wrapped key, and it removes its copy only when
-- the application has authorized that deletion. An object vanishing from the
-- VPS is not an instruction; only an authorization is.

create table public.peely_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  objects_verified integer not null default 0 check (objects_verified >= 0),
  objects_copied integer not null default 0 check (objects_copied >= 0),
  objects_removed integer not null default 0 check (objects_removed >= 0),
  failure_reason text
);

create index peely_sync_runs_success_idx
  on public.peely_sync_runs (completed_at desc)
  where completed_at is not null and failure_reason is null;

create table public.recovery_drills (
  id bigint generated always as identity primary key,
  kind text not null check (
    kind in (
      'database_point_in_time',
      'kms_source_audio_restore',
      'offline_age_restore',
      'seal_inspection'
    )
  ),
  performed_at timestamptz not null,
  -- Content-free evidence only: a reference to the record, never the record.
  evidence_reference text not null
    check (char_length(evidence_reference) between 1 and 240),
  recovery_seconds integer check (recovery_seconds is null or recovery_seconds >= 0),
  succeeded boolean not null,
  remediation text check (
    succeeded or (remediation is not null and char_length(remediation) > 0)
  ),
  created_at timestamptz not null default now()
);

create index recovery_drills_kind_idx
  on public.recovery_drills (kind, performed_at desc);

-- ---------------------------------------------------------------------------
-- What Peely is allowed to know
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cauli_peely') then
    create role cauli_peely nologin noinherit;
  end if;
end;
$$;

grant cauli_peely to authenticator;
grant usage on schema public to cauli_peely;

-- An opaque name and the digest it must match. No Call, no Workspace, no
-- wrapped key — Peely can verify a copy without being able to open one.
create or replace function public.list_backup_objects_for_sync()
returns table (object_name text, ciphertext_sha256 text)
language sql
stable
security definer
set search_path = public
as $$
  select backup.object_name, backup.ciphertext_sha256
  from public.source_audio_backups backup
  where backup.state = 'stored'
    and backup.object_name is not null
  order by backup.object_name;
$$;

-- The only reason Peely ever removes anything. A copy that has merely gone
-- missing upstream is not in here, so an unauthenticated deletion on the VPS
-- cannot propagate to the offline copy.
create or replace function public.list_authorized_backup_deletions()
returns table (object_name text)
language sql
stable
security definer
set search_path = public
as $$
  select request.object_name
  from public.backup_deletion_requests request
  order by request.requested_at;
$$;

create or replace function public.record_peely_sync(
  target_objects_verified integer,
  target_objects_copied integer,
  target_objects_removed integer,
  target_failure_reason text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  run_id bigint;
begin
  insert into public.peely_sync_runs (
    completed_at,
    objects_verified,
    objects_copied,
    objects_removed,
    failure_reason
  ) values (
    now(),
    greatest(coalesce(target_objects_verified, 0), 0),
    greatest(coalesce(target_objects_copied, 0), 0),
    greatest(coalesce(target_objects_removed, 0), 0),
    nullif(left(coalesce(target_failure_reason, ''), 500), '')
  )
  returning id into run_id;

  return run_id;
end;
$$;

-- Freshness, not activity: a run that failed is not a sync, and no run at all
-- is the same problem as a failing one.
create or replace function public.peely_sync_freshness()
returns table (
  last_success_at timestamptz,
  stale_hours numeric,
  alerting boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select max(completed_at) as last_success_at
    from public.peely_sync_runs
    where completed_at is not null and failure_reason is null
  )
  select
    latest.last_success_at,
    round(
      extract(epoch from (now() - coalesce(latest.last_success_at, 'epoch'::timestamptz)))
        / 3600.0,
      2
    ),
    coalesce(latest.last_success_at, 'epoch'::timestamptz)
      < now() - interval '48 hours'
  from latest;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.peely_sync_runs enable row level security;
alter table public.recovery_drills enable row level security;

revoke all on table public.peely_sync_runs
  from public, anon, authenticated, cauli_peely, cauli_retention;
grant all privileges on table public.peely_sync_runs to service_role;

revoke all on table public.recovery_drills
  from public, anon, authenticated, cauli_peely, cauli_retention;
grant all privileges on table public.recovery_drills to service_role;

revoke all on function public.list_backup_objects_for_sync()
  from public, anon, authenticated, cauli_retention;
grant execute on function public.list_backup_objects_for_sync()
  to cauli_peely, service_role;

revoke all on function public.list_authorized_backup_deletions()
  from public, anon, authenticated, cauli_retention;
grant execute on function public.list_authorized_backup_deletions()
  to cauli_peely, service_role;

revoke all on function public.record_peely_sync(integer, integer, integer, text)
  from public, anon, authenticated, cauli_retention;
grant execute on function public.record_peely_sync(integer, integer, integer, text)
  to cauli_peely, service_role;

revoke all on function public.peely_sync_freshness()
  from public, anon, authenticated, cauli_retention;
grant execute on function public.peely_sync_freshness()
  to cauli_peely, service_role;

-- Evidence that Peely's confinement is the database's own answer, not a claim.
create or replace function public.peely_principal_privileges()
returns table (object_name text, privilege text, granted boolean)
language sql
stable
security definer
set search_path = public
as $$
  select object_name, privilege, granted from (
    values
      ('public.calls', 'select',
        has_table_privilege('cauli_peely', 'public.calls', 'select')),
      ('public.transcripts', 'select',
        has_table_privilege('cauli_peely', 'public.transcripts', 'select')),
      ('public.source_audio_backups', 'select',
        has_table_privilege(
          'cauli_peely', 'public.source_audio_backups', 'select'
        )),
      ('public.backup_deletion_requests', 'select',
        has_table_privilege(
          'cauli_peely', 'public.backup_deletion_requests', 'select'
        )),
      ('public.list_backup_objects_for_sync', 'execute',
        has_function_privilege(
          'cauli_peely', 'public.list_backup_objects_for_sync()', 'execute'
        )),
      ('public.list_authorized_backup_deletions', 'execute',
        has_function_privilege(
          'cauli_peely',
          'public.list_authorized_backup_deletions()',
          'execute'
        )),
      ('public.record_peely_sync', 'execute',
        has_function_privilege(
          'cauli_peely',
          'public.record_peely_sync(integer, integer, integer, text)',
          'execute'
        )),
      ('public.commit_source_audio_backup', 'execute',
        has_function_privilege(
          'cauli_peely',
          'public.commit_source_audio_backup(uuid, uuid, text, integer, text, text, text, bigint)',
          'execute'
        )),
      ('public.commit_backup_deletion', 'execute',
        has_function_privilege(
          'cauli_peely', 'public.commit_backup_deletion(text)', 'execute'
        )),
      ('public.begin_call_deletion', 'execute',
        has_function_privilege(
          'cauli_peely',
          'public.begin_call_deletion(uuid, uuid, public.backup_deletion_reason, public.app_role)',
          'execute'
        ))
  ) as privileges (object_name, privilege, granted);
$$;

revoke all on function public.peely_principal_privileges()
  from public, anon, authenticated, cauli_peely, cauli_retention;
grant execute on function public.peely_principal_privileges() to service_role;
