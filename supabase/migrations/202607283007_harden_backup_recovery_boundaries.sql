-- Close the remaining recovery-boundary gaps:
--   * a deletion tombstone wins over an upload that has not started;
--   * an upload already in flight finishes (or times out) before DELETE;
--   * the backup writer is a narrow principal, separate from processing;
--   * deletion lifecycle evidence survives the Call row it describes.

alter table public.source_audio_backup_objects
  drop constraint source_audio_backup_objects_call_id_fkey;
alter table public.source_audio_backup_objects
  alter column call_id drop not null,
  add column deletion_requested_at timestamptz,
  add column upload_authorized_at timestamptz,
  add column upload_finished_at timestamptz;
alter table public.source_audio_backup_objects
  add constraint source_audio_backup_objects_call_id_fkey
  foreign key (call_id) references public.calls(id) on delete set null;

alter table public.backup_deletion_requests
  add column workspace_id uuid,
  add column call_id uuid,
  add column actor_id uuid,
  add column execution_started_at timestamptz,
  add column failure_audited_attempt integer not null default 0;

create table private.call_deletion_lifecycle (
  call_id uuid primary key,
  workspace_id uuid not null,
  actor_id uuid,
  reason public.backup_deletion_reason not null,
  execution_started_at timestamptz,
  primary_failure_audited_attempt integer not null default 0,
  primary_completed_at timestamptz,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'cauli_backup_writer'
  ) then
    create role cauli_backup_writer nologin noinherit;
  end if;
end;
$$;

grant cauli_backup_writer to authenticator;
grant usage on schema public, storage to cauli_backup_writer;

create or replace function public.active_backup_recipients()
returns table (
  version integer,
  kms_key_id text,
  age_recipient text,
  kms_public_key_sha256 text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    key.version,
    key.kms_key_id,
    key.age_recipient,
    key.kms_public_key_sha256
  from public.backup_key_versions key
  where key.retired_at is null
  order by key.version desc
  limit 1;
$$;

create or replace function public.claimed_source_audio_backup_source(
  target_call_id uuid,
  target_lease_token uuid
)
returns table (source_path text, mime_type text)
language sql
stable
security definer
set search_path = public
as $$
  select call.source_path, call.mime_type
  from public.source_audio_backups backup
  join public.calls call on call.id = backup.call_id
  where backup.call_id = target_call_id
    and backup.state = 'in_progress'
    and backup.lease_token = target_lease_token
    and call.deleted_at is null
    and call.source_path is not null;
$$;

create or replace function public.authorize_source_audio_backup_upload(
  target_call_id uuid,
  target_lease_token uuid,
  target_object_name text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  object_record public.source_audio_backup_objects;
begin
  select object.* into object_record
  from public.source_audio_backup_objects object
  join public.source_audio_backups backup
    on backup.call_id = object.call_id
  where object.object_name = target_object_name
    and object.call_id = target_call_id
    and backup.lease_token = target_lease_token
    and backup.state = 'in_progress'
  for update of object;

  if object_record.object_name is null
    or object_record.deletion_requested_at is not null
  then
    return null;
  end if;

  update public.source_audio_backup_objects
  set upload_authorized_at = now(),
      upload_finished_at = null
  where object_name = target_object_name;
  return now() + interval '60 seconds';
end;
$$;

create or replace function public.finish_source_audio_backup_upload(
  target_call_id uuid,
  target_lease_token uuid,
  target_object_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.source_audio_backup_objects object
  set upload_finished_at = now()
  from public.source_audio_backups backup
  where object.object_name = target_object_name
    and object.call_id = target_call_id
    and backup.call_id = target_call_id
    and backup.lease_token = target_lease_token
    and object.upload_authorized_at is not null;
  return found;
end;
$$;

-- Storage may reveal only the source object for this principal's active claim.
create or replace function public.backup_writer_may_read_source(
  storage_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = public, storage
as $$
  select exists (
    select 1
    from public.source_audio_backups backup
    join public.calls call on call.id = backup.call_id
    where backup.state = 'in_progress'
      and backup.lease_token is not null
      and call.deleted_at is null
      and call.source_path = storage_object_name
  );
$$;

drop policy if exists backup_writer_source_select on storage.objects;
create policy backup_writer_source_select
on storage.objects for select to cauli_backup_writer
using (
  bucket_id = 'recordings'
  and public.backup_writer_may_read_source(name)
);

-- A deletion first tombstones every reserved name. New uploads cannot start
-- after this transaction commits; an already authorized PUT is visible to the
-- retention claim and gets a bounded window to finish.
create or replace function public.begin_call_deletion(
  target_call_id uuid,
  target_actor_id uuid,
  target_reason public.backup_deletion_reason,
  target_actor_role public.app_role default null
)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $$
declare
  call_record public.calls;
  authorized_count integer := 0;
begin
  select * into call_record
  from public.calls
  where id = target_call_id and deleted_at is null
  for update;

  if call_record.id is null then return false; end if;

  update public.calls set deleted_at = now() where id = target_call_id;

  insert into private.call_deletion_lifecycle (
    call_id, workspace_id, actor_id, reason
  ) values (
    call_record.id, call_record.workspace_id, target_actor_id, target_reason
  ) on conflict (call_id) do nothing;

  insert into public.processing_jobs (
    workspace_id, call_id, kind, status, idempotency_key
  ) values (
    call_record.workspace_id, call_record.id, 'delete_call', 'queued',
    'delete:' || call_record.id::text
  ) on conflict (idempotency_key) do nothing;

  update public.source_audio_backup_objects
  set deletion_requested_at = coalesce(deletion_requested_at, now())
  where call_id = target_call_id;

  with authorized as (
    insert into public.backup_deletion_requests (
      object_name, reason, workspace_id, call_id, actor_id
    )
    select
      reserved.object_name, target_reason, call_record.workspace_id,
      call_record.id, target_actor_id
    from public.source_audio_backup_objects reserved
    where reserved.call_id = target_call_id
    on conflict (object_name) do update
      set workspace_id = excluded.workspace_id,
          call_id = excluded.call_id,
          actor_id = excluded.actor_id
    returning 1
  )
  select count(*) into authorized_count from authorized;

  perform public.record_audit_event(
    call_record.workspace_id,
    target_actor_id,
    case when target_reason = 'retention'
      then 'call.retention.expired'
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

create or replace function public.start_call_deletion_execution(
  target_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $$
declare
  lifecycle private.call_deletion_lifecycle;
begin
  update private.call_deletion_lifecycle
  set execution_started_at = now()
  where call_id = target_call_id
    and execution_started_at is null
  returning * into lifecycle;
  if lifecycle.call_id is null then return false; end if;

  perform public.record_audit_event(
    lifecycle.workspace_id, lifecycle.actor_id,
    'call.deletion.execution_started', 'call', lifecycle.call_id::text,
    jsonb_build_object('reason', lifecycle.reason)
  );
  return true;
end;
$$;

create or replace function public.commit_call_deletion(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $$
declare
  claimed_job public.processing_jobs%rowtype;
  lifecycle private.call_deletion_lifecycle;
begin
  select * into claimed_job
  from private.lock_owned_processing_job(
    target_job_id, target_lease_token, 'delete_call'
  );
  if not found or claimed_job.call_id is null then return false; end if;

  select * into lifecycle
  from private.call_deletion_lifecycle
  where call_id = claimed_job.call_id
  for update;

  delete from public.calls where id = claimed_job.call_id;

  if not private.complete_processing_job(
    claimed_job.id, target_lease_token
  ) then
    raise exception 'Deletion lease changed during commit';
  end if;

  if lifecycle.call_id is not null
    and lifecycle.primary_completed_at is null
  then
    update private.call_deletion_lifecycle
    set primary_completed_at = now()
    where call_id = lifecycle.call_id;
    perform public.record_audit_event(
      lifecycle.workspace_id, lifecycle.actor_id,
      'call.deletion.primary_completed', 'call', lifecycle.call_id::text,
      jsonb_build_object('reason', lifecycle.reason)
    );
  end if;
  return true;
end;
$$;

create or replace function public.fail_call_deletion_execution(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $$
declare
  claimed_job public.processing_jobs%rowtype;
  lifecycle private.call_deletion_lifecycle;
begin
  select * into claimed_job
  from private.lock_owned_processing_job(
    target_job_id, target_lease_token, 'delete_call'
  );
  if not found or claimed_job.call_id is null then return false; end if;

  select * into lifecycle
  from private.call_deletion_lifecycle
  where call_id = claimed_job.call_id
  for update;
  if lifecycle.call_id is null
    or lifecycle.primary_failure_audited_attempt >= claimed_job.attempts
  then
    return false;
  end if;

  update private.call_deletion_lifecycle
  set primary_failure_audited_attempt = claimed_job.attempts
  where call_id = lifecycle.call_id;

  perform public.record_audit_event(
    lifecycle.workspace_id, lifecycle.actor_id,
    'call.deletion.primary_failed', 'call', lifecycle.call_id::text,
    jsonb_build_object(
      'reason', lifecycle.reason,
      'attempts', claimed_job.attempts
    )
  );
  return true;
end;
$$;

create or replace function public.claim_backup_deletion(worker_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.backup_deletion_requests;
begin
  select request.* into claimed
  from public.backup_deletion_requests request
  left join public.source_audio_backup_objects object
    on object.object_name = request.object_name
  where request.deleted_at is null
    and request.next_attempt_at <= now()
    and (
      object.object_name is null
      or object.upload_authorized_at is null
      or object.upload_finished_at is not null
      or object.upload_authorized_at < now() - interval '90 seconds'
    )
  order by request.requested_at
  for update of request skip locked
  limit 1;

  if claimed.object_name is null then return null; end if;

  update public.backup_deletion_requests
  set attempts = attempts + 1,
      next_attempt_at = now() + interval '15 minutes',
      execution_started_at = coalesce(execution_started_at, now())
  where object_name = claimed.object_name;

  if claimed.execution_started_at is null and claimed.workspace_id is not null then
    perform public.record_audit_event(
      claimed.workspace_id, claimed.actor_id,
      'call.deletion.backup_execution_started', 'call',
      claimed.call_id::text,
      jsonb_build_object('reason', claimed.reason)
    );
  end if;
  return claimed.object_name;
end;
$$;

create or replace function public.commit_backup_deletion(
  target_object_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  request_record public.backup_deletion_requests;
begin
  select * into request_record
  from public.backup_deletion_requests
  where object_name = target_object_name
  for update;
  if request_record.object_name is null then
    raise exception 'That Source Audio Backup deletion was never authorized';
  end if;
  if request_record.deleted_at is not null then return false; end if;

  update public.backup_deletion_requests
  set deleted_at = now(), last_error = null
  where object_name = target_object_name;

  if request_record.workspace_id is not null then
    perform public.record_audit_event(
      request_record.workspace_id, request_record.actor_id,
      'call.deletion.backup_completed', 'call', request_record.call_id::text,
      jsonb_build_object(
        'reason', request_record.reason,
        'attempts', request_record.attempts
      )
    );
  end if;
  return true;
end;
$$;

create or replace function public.fail_backup_deletion(
  target_object_name text,
  target_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  request_record public.backup_deletion_requests;
begin
  select * into request_record
  from public.backup_deletion_requests
  where object_name = target_object_name and deleted_at is null
  for update;
  if request_record.object_name is null then return false; end if;

  update public.backup_deletion_requests
  set last_error = left(coalesce(target_reason, ''), 500),
      failure_audited_attempt = greatest(
        failure_audited_attempt, request_record.attempts
      )
  where object_name = target_object_name;

  if request_record.workspace_id is not null
    and request_record.failure_audited_attempt < request_record.attempts
  then
    perform public.record_audit_event(
      request_record.workspace_id, request_record.actor_id,
      'call.deletion.backup_failed', 'call', request_record.call_id::text,
      jsonb_build_object(
        'reason', request_record.reason,
        'attempts', request_record.attempts
      )
    );
  end if;
  return true;
end;
$$;

-- A commit cannot resurrect an object after deletion won the race.
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
  select backup.* into backup_record
  from public.source_audio_backups backup
  join public.source_audio_backup_objects object
    on object.object_name = target_object_name
   and object.call_id = backup.call_id
  where backup.call_id = target_call_id
    and object.deletion_requested_at is null
  for update of backup;

  if backup_record.call_id is null then return false; end if;
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
    backup_record.workspace_id, null, 'call.backup.stored', 'call',
    target_call_id::text,
    jsonb_build_object(
      'key_version', target_key_version,
      'attempts', backup_record.attempts,
      'lag_seconds',
      floor(extract(epoch from (now() - backup_record.queued_at)))::bigint
    )
  );
  return true;
end;
$$;

revoke all on table private.call_deletion_lifecycle
  from public, anon, authenticated, service_role,
       cauli_backup_writer, cauli_retention, cauli_peely;

revoke all on function public.active_backup_recipients()
  from public, anon, authenticated, cauli_retention, cauli_peely;
revoke all on function public.claimed_source_audio_backup_source(uuid, uuid)
  from public, anon, authenticated, cauli_retention, cauli_peely;
revoke all on function public.authorize_source_audio_backup_upload(uuid, uuid, text)
  from public, anon, authenticated, cauli_retention, cauli_peely;
revoke all on function public.finish_source_audio_backup_upload(uuid, uuid, text)
  from public, anon, authenticated, cauli_retention, cauli_peely;
revoke all on function public.backup_writer_may_read_source(text)
  from public, anon, authenticated, cauli_retention, cauli_peely;
grant execute on function public.active_backup_recipients(),
  public.claimed_source_audio_backup_source(uuid, uuid),
  public.authorize_source_audio_backup_upload(uuid, uuid, text),
  public.finish_source_audio_backup_upload(uuid, uuid, text),
  public.backup_writer_may_read_source(text)
to cauli_backup_writer, service_role;

grant execute on function public.claim_source_audio_backup(text),
  public.commit_source_audio_backup(uuid, uuid, text, integer, text, text, text, bigint),
  public.fail_source_audio_backup(uuid, uuid, text, boolean),
  public.source_audio_backup_lag_alert()
to cauli_backup_writer;

revoke all on function public.start_call_deletion_execution(uuid)
  from public, anon, authenticated, cauli_backup_writer, cauli_retention, cauli_peely;
grant execute on function public.start_call_deletion_execution(uuid)
  to service_role;
revoke all on function public.fail_call_deletion_execution(uuid, uuid)
  from public, anon, authenticated, cauli_backup_writer, cauli_retention, cauli_peely;
grant execute on function public.fail_call_deletion_execution(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Ordinary processing worker
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cauli_worker') then
    create role cauli_worker nologin noinherit;
  end if;
end;
$$;

grant cauli_worker to authenticator;
grant usage on schema public, storage to cauli_worker;

grant select, update on table public.calls to cauli_worker;
grant select, update on table public.processing_jobs to cauli_worker;
grant select, insert, update on table public.transcription_chunks
  to cauli_worker;
grant select, update on table public.export_jobs to cauli_worker;
grant select, insert, update, delete on table storage.objects to cauli_worker;

create policy worker_calls_operational_access
on public.calls for all to cauli_worker
using (true) with check (true);
create policy worker_jobs_operational_access
on public.processing_jobs for all to cauli_worker
using (true) with check (true);
create policy worker_transcription_checkpoints_access
on public.transcription_chunks for all to cauli_worker
using (true) with check (true);
create policy worker_export_jobs_operational_access
on public.export_jobs for all to cauli_worker
using (true) with check (true);

create policy worker_recordings_select
on storage.objects for select to cauli_worker
using (bucket_id = 'recordings');
create policy worker_recordings_insert
on storage.objects for insert to cauli_worker
with check (bucket_id = 'recordings');
create policy worker_recordings_update
on storage.objects for update to cauli_worker
using (bucket_id = 'recordings')
with check (bucket_id = 'recordings');
create policy worker_recordings_delete
on storage.objects for delete to cauli_worker
using (bucket_id = 'recordings');

grant execute on function public.claim_processing_job(text),
  public.renew_processing_job_lease(uuid, uuid),
  public.commit_processed_recording(
    uuid, uuid, text, text, bigint, text, text, text, text, numeric, numeric, jsonb
  ),
  public.commit_wav_export(uuid, uuid, text),
  public.commit_call_deletion(uuid, uuid),
  public.start_call_deletion_execution(uuid),
  public.fail_call_deletion_execution(uuid, uuid),
  public.expire_calls_for_retention(integer),
  public.expire_calls_for_retention(integer, uuid),
  public.backup_deletion_backlog()
to cauli_worker;

create or replace function public.worker_principal_privileges()
returns table (object_name text, privilege text, granted boolean)
language sql
stable
security definer
set search_path = public
as $$
  select object_name, privilege, granted from (
    values
      ('public.calls', 'select',
        has_table_privilege('cauli_worker', 'public.calls', 'select')),
      ('public.processing_jobs', 'update',
        has_table_privilege('cauli_worker', 'public.processing_jobs', 'update')),
      ('storage.objects', 'delete',
        has_table_privilege('cauli_worker', 'storage.objects', 'delete')),
      ('public.workspace_members', 'select',
        has_table_privilege('cauli_worker', 'public.workspace_members', 'select')),
      ('public.platform_admins', 'select',
        has_table_privilege('cauli_worker', 'public.platform_admins', 'select')),
      ('public.audit_events', 'insert',
        has_table_privilege('cauli_worker', 'public.audit_events', 'insert')),
      ('public.source_audio_backups', 'select',
        has_table_privilege('cauli_worker', 'public.source_audio_backups', 'select')),
      ('public.backup_deletion_requests', 'select',
        has_table_privilege('cauli_worker', 'public.backup_deletion_requests', 'select')),
      ('public.peely_sync_runs', 'select',
        has_table_privilege('cauli_worker', 'public.peely_sync_runs', 'select')),
      ('public.claim_source_audio_backup', 'execute',
        has_function_privilege(
          'cauli_worker', 'public.claim_source_audio_backup(text)', 'execute'
        )),
      ('public.claim_backup_deletion', 'execute',
        has_function_privilege(
          'cauli_worker', 'public.claim_backup_deletion(text)', 'execute'
        )),
      ('public.list_backup_objects_for_sync', 'execute',
        has_function_privilege(
          'cauli_worker', 'public.list_backup_objects_for_sync()', 'execute'
        )),
      ('public.claim_processing_job', 'execute',
        has_function_privilege(
          'cauli_worker', 'public.claim_processing_job(text)', 'execute'
        ))
  ) as privileges (object_name, privilege, granted);
$$;

revoke all on function public.worker_principal_privileges()
  from public, anon, authenticated, cauli_worker, cauli_backup_writer,
       cauli_retention, cauli_peely;
grant execute on function public.worker_principal_privileges()
  to service_role;
