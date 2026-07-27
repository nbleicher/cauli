create type public.membership_status as enum (
  'active',
  'suspended',
  'former'
);

alter table public.workspace_members
  add column status public.membership_status not null default 'active',
  add column status_changed_at timestamptz not null default now(),
  add column status_changed_by uuid;

create unique index if not exists workspace_members_one_workspace_per_user
  on public.workspace_members (user_id);

create index workspace_members_active_cap_idx
  on public.workspace_members (status)
  where status = 'active';

create or replace function public.enforce_active_member_cap()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  active_count integer;
begin
  if new.status <> 'active'
    or (tg_op = 'UPDATE' and old.status = 'active')
  then
    return new;
  end if;

  -- Serialize activations across every Workspace so two concurrent requests
  -- cannot both observe the tenth seat as available.
  perform pg_advisory_xact_lock(hashtextextended('cauli.active-member-cap', 0));
  select count(*) into active_count
  from public.workspace_members
  where status = 'active';

  if active_count >= 10 then
    raise exception using
      errcode = 'P0001',
      message = 'The controlled pilot is limited to ten active Workspace Members';
  end if;

  return new;
end;
$$;

create trigger workspace_members_active_cap
before insert or update of status on public.workspace_members
for each row execute function public.enforce_active_member_cap();

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
    and status = 'active'
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
     and wm.status = 'active'
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
     and wm.status = 'active'
    where c.id = target_call_id
      and c.deleted_at is null
      and wm.role in ('manager', 'admin')
  );
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
using (
  id = auth.uid()
  or exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = profiles.id
      and (theirs.status = 'active' or mine.role = 'admin')
  )
);

drop policy if exists members_select on public.workspace_members;
create policy members_select on public.workspace_members for select
using (
  user_id = auth.uid()
  or public.current_user_role(workspace_id) in ('manager', 'admin')
);

create or replace function public.change_workspace_member_role(
  target_user_id uuid,
  target_role public.app_role
)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  previous_role public.app_role;
  member_record public.workspace_members;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  select * into member_record
  from public.workspace_members
  where workspace_id = actor_workspace_id
    and user_id = target_user_id
    and status = 'active'
  for update;

  if member_record.user_id is null then
    raise exception 'Active Workspace Member not found';
  end if;
  previous_role := member_record.role;

  if member_record.role = 'admin'
    and target_role <> 'admin'
    and not exists (
      select 1 from public.workspace_members
      where workspace_id = actor_workspace_id
        and user_id <> target_user_id
        and role = 'admin'
        and status = 'active'
    )
  then
    raise exception 'The Workspace must retain at least one Admin';
  end if;

  update public.workspace_members
  set role = target_role
  where workspace_id = actor_workspace_id
    and user_id = target_user_id
  returning * into member_record;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'workspace.member.role_changed',
    'workspace_member',
    target_user_id::text,
    jsonb_build_object(
      'previous_role', previous_role,
      'new_role', target_role
    )
  );

  return member_record;
end;
$$;

create or replace function public.set_workspace_member_status(
  target_user_id uuid,
  target_status public.membership_status
)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  previous_status public.membership_status;
  member_record public.workspace_members;
  event_action text;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  select status into previous_status
  from public.workspace_members
  where workspace_id = actor_workspace_id
    and user_id = target_user_id
  for update;

  if previous_status is null then
    raise exception 'Workspace Member not found';
  end if;

  if target_user_id = auth.uid() and target_status <> 'active' then
    raise exception 'An Admin cannot suspend or remove their own active membership';
  end if;

  update public.workspace_members
  set status = target_status,
      status_changed_at = now(),
      status_changed_by = auth.uid()
  where workspace_id = actor_workspace_id
    and user_id = target_user_id
  returning * into member_record;

  event_action := case target_status
    when 'active' then 'workspace.member.activated'
    when 'suspended' then 'workspace.member.suspended'
    when 'former' then 'workspace.member.offboarded'
  end;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    event_action,
    'workspace_member',
    target_user_id::text,
    jsonb_build_object(
      'previous_status', previous_status,
      'new_status', target_status
    )
  );

  return member_record;
end;
$$;

revoke all on function public.change_workspace_member_role(
  uuid, public.app_role
) from public, anon;
grant execute on function public.change_workspace_member_role(
  uuid, public.app_role
) to authenticated;
revoke all on function public.set_workspace_member_status(
  uuid, public.membership_status
) from public, anon;
grant execute on function public.set_workspace_member_status(
  uuid, public.membership_status
) to authenticated;

create or replace function public.audit_workspace_member_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_audit_event(
    new.workspace_id,
    new.invited_by,
    'workspace.member.activated',
    'workspace_member',
    new.user_id::text,
    jsonb_build_object(
      'new_role', new.role,
      'new_status', new.status
    )
  );
  return new;
end;
$$;

create trigger workspace_member_insert_audit
after insert on public.workspace_members
for each row execute function public.audit_workspace_member_insert();

create or replace function public.create_call_for_current_user(
  target_call_id uuid,
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
  actor_workspace_id uuid;
  call_record public.calls;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active';

  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  insert into public.calls (
    id,
    workspace_id,
    owner_id,
    source_mode,
    status,
    chunk_prefix,
    mic_label,
    tab_label
  ) values (
    target_call_id,
    actor_workspace_id,
    auth.uid(),
    target_source_mode,
    'recording',
    actor_workspace_id::text || '/' || target_call_id::text || '/chunks',
    coalesce(target_mic_label, ''),
    coalesce(target_tab_label, '')
  )
  returning * into call_record;

  return call_record;
end;
$$;

create or replace function public.finalize_owned_call(
  target_call_id uuid,
  final_chunk_sequence integer,
  target_duration_ms bigint,
  target_mime_type text,
  target_source_mode public.source_mode,
  target_mic_label text,
  target_tab_label text,
  target_degraded_intervals jsonb
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
begin
  if not exists (
    select 1
    from public.calls call
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
     and member.status = 'active'
    where call.id = target_call_id
      and call.owner_id = auth.uid()
      and call.deleted_at is null
  ) then
    raise exception 'Call not found';
  end if;

  select * into call_record
  from public.finalize_call(
    target_call_id,
    final_chunk_sequence,
    target_duration_ms,
    target_mime_type,
    target_source_mode,
    target_mic_label,
    target_tab_label,
    target_degraded_intervals
  );
  return call_record;
end;
$$;

create or replace function public.request_call_retry(
  target_call_id uuid
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
begin
  if not public.can_view_call(target_call_id) then
    raise exception 'Call not found';
  end if;

  select * into call_record
  from public.calls
  where id = target_call_id
    and deleted_at is null
  for update;

  if call_record.status <> 'failed' then
    raise exception 'Only failed calls can be retried';
  end if;

  update public.calls
  set status = 'queued',
      error_message = null
  where id = target_call_id
  returning * into call_record;

  insert into public.processing_jobs (
    workspace_id,
    call_id,
    kind,
    status,
    idempotency_key,
    attempts,
    next_attempt_at
  ) values (
    call_record.workspace_id,
    call_record.id,
    'process_recording',
    'queued',
    'process:' || call_record.id::text,
    0,
    now()
  )
  on conflict (idempotency_key) do update
  set status = 'queued',
      attempts = 0,
      next_attempt_at = now(),
      error_message = null,
      error_category = null,
      error_chunk_index = null,
      provider_generation_id = null,
      locked_at = null,
      locked_by = null,
      lease_token = null,
      finished_at = null;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    'call.processing.retried',
    'call',
    call_record.id::text,
    '{}'::jsonb
  );
  return call_record;
end;
$$;

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

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    'call.deletion.requested',
    'call',
    call_record.id::text,
    jsonb_build_object('actor_role', actor_role)
  );
  return true;
end;
$$;

create or replace function public.request_wav_export(
  target_call_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  export_record public.export_jobs;
begin
  if not public.can_view_call(target_call_id) then
    raise exception 'Call not found';
  end if;

  select * into call_record
  from public.calls
  where id = target_call_id
    and deleted_at is null
  for update;

  if call_record.wav_path is not null then
    return jsonb_build_object('status', 'complete');
  end if;

  select * into export_record
  from public.export_jobs
  where call_id = target_call_id
    and format = 'wav'
  for update;

  if export_record.id is null then
    insert into public.export_jobs (call_id, requested_by, format)
    values (target_call_id, auth.uid(), 'wav')
    returning * into export_record;
  elsif export_record.status = 'failed' then
    update public.export_jobs
    set status = 'queued',
        error_message = null,
        completed_at = null
    where id = export_record.id
    returning * into export_record;
  end if;

  if export_record.status in ('queued', 'retrying', 'failed') then
    insert into public.processing_jobs (
      workspace_id,
      call_id,
      kind,
      status,
      idempotency_key,
      payload,
      attempts,
      next_attempt_at
    ) values (
      call_record.workspace_id,
      call_record.id,
      'generate_wav',
      'queued',
      'wav:' || call_record.id::text,
      jsonb_build_object('exportJobId', export_record.id),
      0,
      now()
    )
    on conflict (idempotency_key) do update
    set status = case
          when public.processing_jobs.status = 'complete'
            then public.processing_jobs.status
          else 'queued'::public.job_status
        end,
        attempts = case
          when public.processing_jobs.status = 'complete'
            then public.processing_jobs.attempts
          else 0
        end,
        next_attempt_at = now(),
        error_message = null,
        locked_at = null,
        locked_by = null,
        lease_token = null,
        finished_at = null;
  end if;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    'call.export.requested',
    'call',
    call_record.id::text,
    jsonb_build_object('format', 'wav')
  );

  return jsonb_build_object(
    'status', export_record.status,
    'exportJobId', export_record.id
  );
end;
$$;

create or replace function public.publish_scorecard_for_current_admin(
  target_template_id uuid,
  target_name text,
  target_categories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  version_id uuid;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  version_id := public.publish_scorecard(
    actor_workspace_id,
    target_template_id,
    target_name,
    auth.uid(),
    target_categories
  );

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'scorecard.version.published',
    'scorecard_version',
    version_id::text,
    '{}'::jsonb
  );
  return version_id;
end;
$$;

create or replace function public.create_workspace_invite(
  target_email text,
  target_role public.app_role
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  invite_id uuid;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  insert into public.workspace_invites (
    workspace_id,
    email,
    role,
    invited_by,
    accepted_at,
    expires_at
  ) values (
    actor_workspace_id,
    lower(trim(target_email)),
    target_role,
    auth.uid(),
    null,
    now() + interval '7 days'
  )
  on conflict (workspace_id, email) do update
  set role = excluded.role,
      invited_by = excluded.invited_by,
      accepted_at = null,
      expires_at = excluded.expires_at
  returning id into invite_id;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'workspace.invite.created',
    'workspace_invite',
    invite_id::text,
    jsonb_build_object('role', target_role)
  );
  return invite_id;
end;
$$;

create or replace function public.revoke_workspace_invite(
  target_invite_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  deleted_id uuid;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  delete from public.workspace_invites
  where id = target_invite_id
    and workspace_id = actor_workspace_id
    and accepted_at is null
  returning id into deleted_id;

  if deleted_id is null then
    raise exception 'Pending invite not found';
  end if;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'workspace.invite.revoked',
    'workspace_invite',
    deleted_id::text,
    '{}'::jsonb
  );
  return true;
end;
$$;

create or replace function public.record_audit_export_for_current_admin(
  exported_rows integer,
  filters_applied integer
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null then
    raise exception 'Active Workspace Admin access is required';
  end if;

  return public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'audit.export.created',
    'workspace',
    actor_workspace_id::text,
    jsonb_build_object(
      'exported_rows', exported_rows,
      'filters_applied', filters_applied
    )
  );
end;
$$;

drop policy if exists recording_chunks_insert on storage.objects;
create policy recording_chunks_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1 from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
      and public.current_user_role(call.workspace_id) is not null
  )
);

drop policy if exists recording_chunks_update on storage.objects;
create policy recording_chunks_update on storage.objects
for update to authenticated
using (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1 from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
      and public.current_user_role(call.workspace_id) is not null
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
      and public.current_user_role(call.workspace_id) is not null
  )
);

drop policy if exists recording_chunks_select on storage.objects;
create policy recording_objects_select on storage.objects
for select to authenticated
using (
  bucket_id = 'recordings'
  and public.can_view_call(((storage.foldername(name))[2])::uuid)
);

revoke insert, update, delete on public.processing_jobs
  from authenticated;
revoke insert, update, delete on public.export_jobs
  from authenticated;
revoke insert, update, delete on public.extension_imports
  from authenticated;

revoke all on function public.create_call_for_current_user(
  uuid, public.source_mode, text, text
) from public, anon;
grant execute on function public.create_call_for_current_user(
  uuid, public.source_mode, text, text
) to authenticated;
revoke all on function public.finalize_owned_call(
  uuid, integer, bigint, text, public.source_mode, text, text, jsonb
) from public, anon;
grant execute on function public.finalize_owned_call(
  uuid, integer, bigint, text, public.source_mode, text, text, jsonb
) to authenticated;
revoke all on function public.request_call_retry(uuid)
  from public, anon;
grant execute on function public.request_call_retry(uuid)
  to authenticated;
revoke all on function public.request_call_deletion(uuid)
  from public, anon;
grant execute on function public.request_call_deletion(uuid)
  to authenticated;
revoke all on function public.request_wav_export(uuid)
  from public, anon;
grant execute on function public.request_wav_export(uuid)
  to authenticated;
revoke all on function public.publish_scorecard_for_current_admin(
  uuid, text, jsonb
) from public, anon;
grant execute on function public.publish_scorecard_for_current_admin(
  uuid, text, jsonb
) to authenticated;
revoke all on function public.create_workspace_invite(text, public.app_role)
  from public, anon;
grant execute on function public.create_workspace_invite(
  text, public.app_role
) to authenticated;
revoke all on function public.revoke_workspace_invite(uuid)
  from public, anon;
grant execute on function public.revoke_workspace_invite(uuid)
  to authenticated;
revoke all on function public.record_audit_export_for_current_admin(
  integer, integer
) from public, anon;
grant execute on function public.record_audit_export_for_current_admin(
  integer, integer
) to authenticated;
