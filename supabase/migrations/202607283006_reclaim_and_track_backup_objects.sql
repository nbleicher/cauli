-- Two ways a Source Audio Backup could be silently lost, closed.
--
-- The first: a worker that claimed a backup and died mid-upload left the row in
-- 'in_progress', which nothing ever claimed again. That Call had no recovery
-- copy for the rest of its retention window while the lag alert complained
-- about it forever, and the stated promise — retry until it succeeds or the
-- Call is deleted — was quietly untrue.
--
-- The second: the object name was only recorded when a copy committed. A
-- deletion arriving while an upload was in flight, or an upload that landed but
-- whose commit was lost, left ciphertext on the VPS that no row named and that
-- the retention principal could therefore never be authorized to remove. A
-- deletion the Workspace asked for left a copy behind.
--
-- So every name is now reserved before it is used, and deletion authorizes
-- every name a Call ever reserved rather than only the one that succeeded.

create table public.source_audio_backup_objects (
  object_name text primary key check (object_name ~ '^[0-9a-f]{64}$'),
  call_id uuid not null references public.calls(id) on delete cascade,
  reserved_at timestamptz not null default now()
);

create index source_audio_backup_objects_call_idx
  on public.source_audio_backup_objects (call_id);

-- Claiming reserves the name the attempt will use, so the name exists in the
-- database before a single byte reaches the VPS.
create or replace function public.claim_source_audio_backup(worker_name text)
returns public.source_audio_backups
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.source_audio_backups;
  reserved_name text;
begin
  select backup.*
  into claimed
  from public.source_audio_backups backup
  where (
      backup.state in ('pending', 'failed')
      -- A lease whose worker never came back. Reclaimed on the same terms as
      -- an interrupted processing job.
      or (
        backup.state = 'in_progress'
        and backup.locked_at < now() - interval '15 minutes'
      )
    )
    and backup.next_attempt_at <= now()
  order by backup.queued_at
  for update skip locked
  limit 1;

  if claimed.call_id is null then
    return null;
  end if;

  reserved_name := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.source_audio_backup_objects (object_name, call_id)
  values (reserved_name, claimed.call_id);

  update public.source_audio_backups
  set state = 'in_progress',
      attempts = attempts + 1,
      object_name = case when state = 'stored' then object_name else reserved_name end,
      lease_token = gen_random_uuid(),
      locked_at = now(),
      locked_by = worker_name
  where call_id = claimed.call_id
  returning * into claimed;

  return claimed;
end;
$$;

-- Deletion reaches every name the Call ever reserved, not only the one that
-- committed, so an upload that landed without being recorded is still removable.
create or replace function public.begin_call_deletion(
  target_call_id uuid,
  target_actor_id uuid,
  target_reason public.backup_deletion_reason,
  target_actor_role public.app_role default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  authorized_count integer := 0;
begin
  select * into call_record
  from public.calls
  where id = target_call_id
    and deleted_at is null
  for update;

  -- Already on its way out. Saying so again must not duplicate the evidence or
  -- restart work that is already queued.
  if call_record.id is null then
    return false;
  end if;

  update public.calls
  set deleted_at = now()
  where id = target_call_id;

  insert into public.processing_jobs (
    workspace_id,
    call_id,
    kind,
    status,
    idempotency_key
  ) values (
    call_record.workspace_id,
    call_record.id,
    'delete_call',
    'queued',
    'delete:' || call_record.id::text
  )
  on conflict (idempotency_key) do nothing;

  with authorized as (
    insert into public.backup_deletion_requests (object_name, reason)
    select reserved.object_name, target_reason
    from public.source_audio_backup_objects reserved
    where reserved.call_id = target_call_id
    on conflict (object_name) do nothing
    returning 1
  )
  select count(*) into authorized_count from authorized;

  perform public.record_audit_event(
    call_record.workspace_id,
    target_actor_id,
    case
      when target_reason = 'retention' then 'call.retention.expired'
      else 'call.deletion.requested'
    end,
    'call',
    call_record.id::text,
    jsonb_build_object(
      'actor_role', target_actor_role,
      'reason', target_reason,
      'backup_deletion_requested', authorized_count > 0,
      'backup_objects_authorized', authorized_count
    )
  );
  return true;
end;
$$;

-- Peely lists what it should hold. A copy the application has already
-- authorized removing is not that, so it is dropped from the list rather than
-- re-fetched and then deleted on every run.
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
    and not exists (
      select 1
      from public.backup_deletion_requests request
      where request.object_name = backup.object_name
    )
  order by backup.object_name;
$$;

-- Calls whose Source Audio already existed before any of this shipped would
-- otherwise never have been offered a backup, because the trigger only fires on
-- a future write.
insert into public.source_audio_backups (call_id, workspace_id, queued_at)
select call.id, call.workspace_id, coalesce(call.stopped_at, call.created_at)
from public.calls call
where call.source_path is not null
  and call.deleted_at is null
on conflict (call_id) do nothing;

revoke all on table public.source_audio_backup_objects
  from public, anon, authenticated, cauli_retention, cauli_peely;
grant select on table public.source_audio_backup_objects to service_role;

-- The operational plane may correct a backup record — a stuck lease, a
-- misfiled attempt. What it may not do is overwrite or un-store a copy that
-- has already been made, and that is enforced by the immutability trigger
-- rather than by withholding the grant, so it holds for the commands too.
grant update on table public.source_audio_backups to service_role;
