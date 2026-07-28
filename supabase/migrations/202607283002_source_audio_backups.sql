-- An encrypted recovery copy of every Source Audio object, held outside the
-- Supabase and Railway failure domains.
--
-- Nothing here holds plaintext, key material that can open one, or any fact
-- that would tell the VPS which Workspace or Call it is storing. The row
-- records only that a copy exists, which wrapping generation opened it, and
-- whether the copy is late.

create type public.backup_state as enum (
  'pending',
  'in_progress',
  'stored',
  'failed'
);

-- The wrapping generations. Only public material and digests of it are
-- recorded; the KMS private half lives in AWS and the age identity is sealed
-- offline, so neither is representable in this table.
create table public.backup_key_versions (
  version integer primary key check (version > 0),
  kms_key_id text not null check (char_length(kms_key_id) between 1 and 240),
  kms_public_key_sha256 text not null
    check (kms_public_key_sha256 ~ '^[0-9a-f]{64}$'),
  age_recipient text not null check (age_recipient ~ '^age1[0-9a-z]{58}$'),
  age_recipient_sha256 text not null
    check (age_recipient_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create table public.source_audio_backups (
  call_id uuid primary key references public.calls(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  state public.backup_state not null default 'pending',
  -- Opaque, so a directory listing on either target reveals nothing.
  object_name text unique check (object_name ~ '^[0-9a-f]{64}$'),
  key_version integer references public.backup_key_versions(version),
  kms_wrapped_key text,
  age_wrapped_key text,
  ciphertext_sha256 text check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_bytes bigint check (ciphertext_bytes >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  -- Stop & Save, not the moment processing happened to finish, so the
  -- 15-minute objective is measured against what the Workspace Member did.
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  stored_at timestamptz,
  lease_token uuid,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_audio_backups_stored_is_complete check (
    state <> 'stored'
    or (
      object_name is not null
      and key_version is not null
      and kms_wrapped_key is not null
      and age_wrapped_key is not null
      and ciphertext_sha256 is not null
      and stored_at is not null
    )
  )
);

create index source_audio_backups_claim_idx
  on public.source_audio_backups (next_attempt_at, queued_at)
  where state in ('pending', 'failed');
create index source_audio_backups_lag_idx
  on public.source_audio_backups (queued_at)
  where state <> 'stored';
create index source_audio_backups_key_version_idx
  on public.source_audio_backups (key_version);
create index source_audio_backups_workspace_idx
  on public.source_audio_backups (workspace_id, state);

create trigger source_audio_backups_updated_at
before update on public.source_audio_backups
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Enqueue
-- ---------------------------------------------------------------------------

-- A Call earns a backup the moment its Source Audio exists. This is an insert
-- of one small row, so it never gates the Call reaching Ready.
create or replace function public.enqueue_source_audio_backup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source_path is null or new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.source_path is not distinct from new.source_path then
    return new;
  end if;

  insert into public.source_audio_backups (
    call_id,
    workspace_id,
    queued_at
  ) values (
    new.id,
    new.workspace_id,
    coalesce(new.stopped_at, now())
  )
  on conflict (call_id) do nothing;

  return new;
end;
$$;

create trigger calls_enqueue_source_audio_backup
after insert or update of source_path on public.calls
for each row execute function public.enqueue_source_audio_backup();

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

-- A stored copy is the recovery copy. Its identity and its checksum are frozen,
-- and it cannot be walked back to an earlier state; only the wrapping may still
-- change, and only through the rewrap command below.
--
-- Removal is deliberately not guarded here. This row is the record of a copy,
-- not the copy: it follows its Call through the ordinary deletion cascade,
-- while the object it names is removed from the VPS by the separate retention
-- principal, which is the credential boundary that actually protects it.
create or replace function public.protect_source_audio_backup()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.state = 'stored' then
    if new.state <> 'stored' then
      raise exception 'A stored Source Audio Backup cannot be un-stored';
    end if;
    if new.object_name is distinct from old.object_name
      or new.ciphertext_sha256 is distinct from old.ciphertext_sha256
      or new.ciphertext_bytes is distinct from old.ciphertext_bytes
      or new.stored_at is distinct from old.stored_at
    then
      raise exception 'A stored Source Audio Backup cannot be overwritten';
    end if;
  end if;

  return new;
end;
$$;

create trigger source_audio_backups_immutable
before update on public.source_audio_backups
for each row execute function public.protect_source_audio_backup();

-- ---------------------------------------------------------------------------
-- Worker commands
-- ---------------------------------------------------------------------------

-- Retry spacing, kept as its own function so the schedule is a stated rule
-- rather than an expression buried in a command. It doubles from 30 seconds
-- and stops doubling at 32 minutes, so a target that is down for a day is
-- neither hammered nor quietly abandoned.
create or replace function public.source_audio_backup_backoff(
  attempt_count integer
)
returns interval
language sql
immutable
set search_path = public
as $$
  select make_interval(
    secs => 15 * power(2, least(greatest(attempt_count, 1), 7))::integer
  );
$$;

create or replace function public.claim_source_audio_backup(worker_name text)
returns public.source_audio_backups
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.source_audio_backups;
begin
  select backup.*
  into claimed
  from public.source_audio_backups backup
  where backup.state in ('pending', 'failed')
    and backup.next_attempt_at <= now()
  order by backup.queued_at
  for update skip locked
  limit 1;

  if claimed.call_id is null then
    return null;
  end if;

  update public.source_audio_backups
  set state = 'in_progress',
      attempts = attempts + 1,
      lease_token = gen_random_uuid(),
      locked_at = now(),
      locked_by = worker_name
  where call_id = claimed.call_id
  returning * into claimed;

  return claimed;
end;
$$;

create or replace function public.commit_source_audio_backup(
  target_call_id uuid,
  target_lease_token uuid,
  target_object_name text,
  target_key_version integer,
  target_kms_wrapped_key text,
  target_age_wrapped_key text,
  target_ciphertext_sha256 text,
  target_ciphertext_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_record public.source_audio_backups;
begin
  select * into backup_record
  from public.source_audio_backups
  where call_id = target_call_id
  for update;

  if backup_record.call_id is null then
    return false;
  end if;

  -- A worker that already lost its lease must not be able to declare success.
  if backup_record.state = 'stored' then
    return backup_record.ciphertext_sha256 = target_ciphertext_sha256;
  end if;
  if backup_record.lease_token is distinct from target_lease_token then
    return false;
  end if;

  update public.source_audio_backups
  set state = 'stored',
      object_name = target_object_name,
      key_version = target_key_version,
      kms_wrapped_key = target_kms_wrapped_key,
      age_wrapped_key = target_age_wrapped_key,
      ciphertext_sha256 = target_ciphertext_sha256,
      ciphertext_bytes = target_ciphertext_bytes,
      stored_at = now(),
      lease_token = null,
      locked_at = null,
      locked_by = null,
      last_error = null
  where call_id = target_call_id;

  perform public.record_audit_event(
    backup_record.workspace_id,
    null,
    'call.backup.stored',
    'call',
    target_call_id::text,
    jsonb_build_object(
      'key_version', target_key_version,
      'attempts', backup_record.attempts,
      'lag_seconds', floor(
        extract(epoch from (now() - backup_record.queued_at))
      )::bigint
    )
  );
  return true;
end;
$$;

create or replace function public.fail_source_audio_backup(
  target_call_id uuid,
  target_lease_token uuid,
  target_reason text,
  target_retryable boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_record public.source_audio_backups;
begin
  select * into backup_record
  from public.source_audio_backups
  where call_id = target_call_id
  for update;

  if backup_record.call_id is null
    or backup_record.state = 'stored'
    or backup_record.lease_token is distinct from target_lease_token
  then
    return false;
  end if;

  -- Backup retries until it succeeds or the Call is deleted. There is no
  -- attempt ceiling that would let a missing recovery copy become permanent.
  update public.source_audio_backups
  set state = case
        when target_retryable then 'pending'::public.backup_state
        else 'failed'::public.backup_state
      end,
      next_attempt_at = now() + public.source_audio_backup_backoff(attempts),
      lease_token = null,
      locked_at = null,
      locked_by = null,
      last_error = left(coalesce(target_reason, ''), 500)
  where call_id = target_call_id;

  perform public.record_audit_event(
    backup_record.workspace_id,
    null,
    'call.backup.attempt_failed',
    'call',
    target_call_id::text,
    jsonb_build_object(
      'attempts', backup_record.attempts,
      'retryable', target_retryable
    )
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lag
-- ---------------------------------------------------------------------------

-- The recovery-point objective, expressed so it can be alerted on without
-- naming a Workspace Member, a Call title, or anything else about the content.
create or replace view public.source_audio_backup_lag
with (security_invoker = true) as
select
  backup.call_id,
  backup.workspace_id,
  backup.state,
  backup.attempts,
  backup.queued_at,
  floor(extract(epoch from (now() - backup.queued_at)))::bigint as lag_seconds
from public.source_audio_backups backup
where backup.state <> 'stored'
  and backup.queued_at < now() - interval '15 minutes';

create or replace function public.source_audio_backup_lag_alert()
returns table (lagging bigint, worst_lag_seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    coalesce(
      max(floor(extract(epoch from (now() - queued_at)))::bigint), 0
    )
  from public.source_audio_backups
  where state <> 'stored'
    and queued_at < now() - interval '15 minutes';
$$;

-- ---------------------------------------------------------------------------
-- Key versioning and rewrapping
-- ---------------------------------------------------------------------------

-- Rewrapping replaces how the data key is wrapped and never the ciphertext, so
-- the stored object and its checksum survive a recovery-key rotation intact.
create or replace function public.rewrap_source_audio_backup(
  target_call_id uuid,
  target_key_version integer,
  target_kms_wrapped_key text,
  target_age_wrapped_key text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_record public.source_audio_backups;
begin
  select * into backup_record
  from public.source_audio_backups
  where call_id = target_call_id
  for update;

  if backup_record.call_id is null or backup_record.state <> 'stored' then
    return false;
  end if;
  if not exists (
    select 1 from public.backup_key_versions
    where version = target_key_version and retired_at is null
  ) then
    raise exception 'A Source Audio Backup cannot be rewrapped to a retired key version';
  end if;

  update public.source_audio_backups
  set key_version = target_key_version,
      kms_wrapped_key = target_kms_wrapped_key,
      age_wrapped_key = target_age_wrapped_key
  where call_id = target_call_id;

  perform public.record_audit_event(
    backup_record.workspace_id,
    null,
    'call.backup.rewrapped',
    'call',
    target_call_id::text,
    jsonb_build_object(
      'previous_key_version', backup_record.key_version,
      'key_version', target_key_version
    )
  );
  return true;
end;
$$;

-- A wrapping generation stays restorable until nothing depends on it. Retiring
-- one early would strand every backup still wrapped under it.
create or replace function public.retire_backup_key_version(
  target_version integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  dependent_count bigint;
begin
  select count(*) into dependent_count
  from public.source_audio_backups
  where key_version = target_version;

  if dependent_count > 0 then
    raise exception
      'A backup key version keeps % unexpired Source Audio Backup(s) and cannot be retired until each is rewrapped or deleted',
      dependent_count;
  end if;

  update public.backup_key_versions
  set retired_at = now()
  where version = target_version and retired_at is null;

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.backup_key_versions enable row level security;
alter table public.source_audio_backups enable row level security;

-- Backup state is operational evidence, not Workspace content. An Admin may
-- see that their Workspace's Calls are protected and whether a copy is late.
create policy source_audio_backups_admin_select
on public.source_audio_backups for select
using (public.current_user_role(workspace_id) = 'admin');

revoke all on table public.backup_key_versions
  from public, anon, authenticated;
grant all privileges on table public.backup_key_versions to service_role;

-- Every change goes through a command, so not even the worker's own service
-- role can edit a backup record directly.
revoke insert, update, delete on table public.source_audio_backups
  from public, anon, authenticated, service_role;
grant select on table public.source_audio_backups to authenticated, service_role;

revoke all on public.source_audio_backup_lag from public, anon;
grant select on public.source_audio_backup_lag to authenticated, service_role;

revoke all on function public.enqueue_source_audio_backup()
  from public, anon, authenticated;
revoke all on function public.protect_source_audio_backup()
  from public, anon, authenticated;

revoke all on function public.source_audio_backup_backoff(integer)
  from public, anon, authenticated;
grant execute on function public.source_audio_backup_backoff(integer) to service_role;

revoke all on function public.claim_source_audio_backup(text)
  from public, anon, authenticated;
grant execute on function public.claim_source_audio_backup(text) to service_role;

revoke all on function public.commit_source_audio_backup(
  uuid, uuid, text, integer, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.commit_source_audio_backup(
  uuid, uuid, text, integer, text, text, text, bigint
) to service_role;

revoke all on function public.fail_source_audio_backup(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_source_audio_backup(uuid, uuid, text, boolean)
  to service_role;

revoke all on function public.source_audio_backup_lag_alert()
  from public, anon, authenticated;
grant execute on function public.source_audio_backup_lag_alert() to service_role;

revoke all on function public.rewrap_source_audio_backup(uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.rewrap_source_audio_backup(uuid, integer, text, text)
  to service_role;

revoke all on function public.retire_backup_key_version(integer)
  from public, anon, authenticated;
grant execute on function public.retire_backup_key_version(integer) to service_role;
