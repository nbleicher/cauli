-- One deletion workflow. A Workspace Member asking for a Call to go and the
-- Retention Policy reaching its date are the same act from here on: they enter
-- through `begin_call_deletion`, remove the same artifacts, produce the same
-- Audit Events, and reach the same backups.
--
-- Backups are the one artifact this workflow cannot remove itself. The
-- application and worker credentials deliberately have no way to delete a VPS
-- object, so deletion instead records an authorization that a separate
-- retention principal — which can read no content and create no backup — is
-- allowed to act on.

create type public.backup_deletion_reason as enum (
  'manual',
  'retention'
);

create table public.backup_deletion_requests (
  -- The object name is the whole instruction. There is deliberately no Call or
  -- Workspace here for the retention principal to learn anything from, and no
  -- foreign key, so the authorization outlives the Call it came from.
  object_name text primary key check (object_name ~ '^[0-9a-f]{64}$'),
  reason public.backup_deletion_reason not null,
  requested_at timestamptz not null default now(),
  deleted_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text
);

create index backup_deletion_requests_claim_idx
  on public.backup_deletion_requests (next_attempt_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The single entry point
-- ---------------------------------------------------------------------------

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
  backup_record public.source_audio_backups;
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

  -- Hand the recovery copy to the only principal allowed to remove it.
  select * into backup_record
  from public.source_audio_backups
  where call_id = target_call_id;

  if backup_record.object_name is not null then
    insert into public.backup_deletion_requests (object_name, reason)
    values (backup_record.object_name, target_reason)
    on conflict (object_name) do nothing;
  end if;

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
      'backup_deletion_requested', backup_record.object_name is not null
    )
  );
  return true;
end;
$$;

-- Manual deletion keeps its authorization rules and now delegates the work.
create or replace function public.request_call_deletion(
  target_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  actor_role public.app_role;
begin
  -- A Member Role may delete their own Call and an Admin may delete any. A
  -- Manager may review every Call but not delete another person's.
  select call.*
  into call_record
  from public.calls call
  join public.workspace_members member
    on member.workspace_id = call.workspace_id
   and member.user_id = auth.uid()
   and member.status = 'active'
  where call.id = target_call_id
    and call.deleted_at is null
    and (member.role = 'admin' or call.owner_id = auth.uid())
  for update of call;

  if call_record.id is null then
    raise exception 'Call not found';
  end if;
  actor_role := public.current_user_role(call_record.workspace_id);

  return public.begin_call_deletion(
    target_call_id,
    auth.uid(),
    'manual',
    actor_role
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention expiration
-- ---------------------------------------------------------------------------

-- Expiration is the same workflow on a timer. It reads the schedule from the
-- Workspace Retention Policy rather than from anything stored on the Call, so
-- an Admin who lengthens the policy reprieves Calls that had not yet gone.
create or replace function public.expire_calls_for_retention(
  batch_size integer default 100
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_call_id uuid;
  expired_count bigint := 0;
begin
  for expired_call_id in
    select call.id
    from public.calls call
    join public.workspaces workspace on workspace.id = call.workspace_id
    where call.deleted_at is null
      and public.scheduled_deletion_at(
        call.started_at,
        workspace.retention_days
      ) <= now()
    order by call.started_at
    limit greatest(batch_size, 1)
  loop
    if public.begin_call_deletion(expired_call_id, null, 'retention') then
      expired_count := expired_count + 1;
    end if;
  end loop;

  return expired_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- The retention principal
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cauli_retention') then
    create role cauli_retention nologin noinherit;
  end if;
end;
$$;

grant cauli_retention to authenticator;
grant usage on schema public to cauli_retention;

-- It may take the next authorized instruction. It learns an object name and
-- nothing else — not whose Call it was, not which Workspace, not when.
create or replace function public.claim_backup_deletion(worker_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.backup_deletion_requests;
begin
  select * into claimed
  from public.backup_deletion_requests
  where deleted_at is null
    and next_attempt_at <= now()
  order by requested_at
  for update skip locked
  limit 1;

  if claimed.object_name is null then
    return null;
  end if;

  update public.backup_deletion_requests
  set attempts = attempts + 1,
      next_attempt_at = now() + interval '15 minutes'
  where object_name = claimed.object_name;

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

  -- Only an instruction the application authorized may be acted on, and a
  -- repeat of one already carried out changes nothing and says nothing twice.
  if request_record.object_name is null then
    raise exception 'That Source Audio Backup deletion was never authorized';
  end if;
  if request_record.deleted_at is not null then
    return false;
  end if;

  update public.backup_deletion_requests
  set deleted_at = now(),
      last_error = null
  where object_name = target_object_name;

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
begin
  update public.backup_deletion_requests
  set last_error = left(coalesce(target_reason, ''), 500)
  where object_name = target_object_name
    and deleted_at is null;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.backup_deletion_requests enable row level security;

-- Authorizing a deletion is the application's act, so the application plane
-- holds this table. The retention principal, which carries the deletions out,
-- is given no sight of it at all — it is handed one object name at a time.
revoke all on table public.backup_deletion_requests
  from public, anon, authenticated, cauli_retention;
grant all privileges on table public.backup_deletion_requests to service_role;

-- The retention principal is granted exactly three verbs and nothing else. It
-- cannot read a Call, a Transcript, a Review, or the wrapped keys that would
-- let it decrypt what it is deleting, and it cannot create a backup either.
revoke all on function public.claim_backup_deletion(text)
  from public, anon, authenticated;
grant execute on function public.claim_backup_deletion(text)
  to cauli_retention, service_role;

revoke all on function public.commit_backup_deletion(text)
  from public, anon, authenticated;
grant execute on function public.commit_backup_deletion(text)
  to cauli_retention, service_role;

revoke all on function public.fail_backup_deletion(text, text)
  from public, anon, authenticated;
grant execute on function public.fail_backup_deletion(text, text)
  to cauli_retention, service_role;

revoke all on function public.begin_call_deletion(
  uuid, uuid, public.backup_deletion_reason, public.app_role
) from public, anon, authenticated, cauli_retention;
grant execute on function public.begin_call_deletion(
  uuid, uuid, public.backup_deletion_reason, public.app_role
) to service_role;

revoke all on function public.expire_calls_for_retention(integer)
  from public, anon, authenticated, cauli_retention;
grant execute on function public.expire_calls_for_retention(integer)
  to service_role;

revoke all on function public.request_call_deletion(uuid)
  from public, anon, cauli_retention;
grant execute on function public.request_call_deletion(uuid) to authenticated;

-- Evidence that the separation is real, and the shape an operator can check it
-- with. Every answer here is the database's own, not a claim about it.
create or replace function public.retention_principal_privileges()
returns table (object_name text, privilege text, granted boolean)
language sql
stable
security definer
set search_path = public
as $$
  select object_name, privilege, granted from (
    values
      ('public.calls', 'select',
        has_table_privilege('cauli_retention', 'public.calls', 'select')),
      ('public.transcripts', 'select',
        has_table_privilege('cauli_retention', 'public.transcripts', 'select')),
      ('public.call_reviews', 'select',
        has_table_privilege('cauli_retention', 'public.call_reviews', 'select')),
      ('public.source_audio_backups', 'select',
        has_table_privilege(
          'cauli_retention', 'public.source_audio_backups', 'select'
        )),
      ('public.backup_deletion_requests', 'select',
        has_table_privilege(
          'cauli_retention', 'public.backup_deletion_requests', 'select'
        )),
      ('public.claim_backup_deletion', 'execute',
        has_function_privilege(
          'cauli_retention', 'public.claim_backup_deletion(text)', 'execute'
        )),
      ('public.commit_backup_deletion', 'execute',
        has_function_privilege(
          'cauli_retention', 'public.commit_backup_deletion(text)', 'execute'
        )),
      ('public.commit_source_audio_backup', 'execute',
        has_function_privilege(
          'cauli_retention',
          'public.commit_source_audio_backup(uuid, uuid, text, integer, text, text, text, bigint)',
          'execute'
        )),
      ('public.request_call_deletion', 'execute',
        has_function_privilege(
          'cauli_retention', 'public.request_call_deletion(uuid)', 'execute'
        ))
  ) as privileges (object_name, privilege, granted);
$$;

revoke all on function public.retention_principal_privileges()
  from public, anon, authenticated, cauli_retention;
grant execute on function public.retention_principal_privileges() to service_role;
