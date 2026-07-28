create type public.platform_environment as enum ('staging', 'production');

-- Platform-wide evidence has its own environment scope. It must not be
-- attributed to an arbitrary customer Workspace, while Workspace-specific
-- break-glass actions remain scoped to the affected Workspace.
alter table public.audit_events
  alter column workspace_id drop not null,
  add column platform_environment public.platform_environment,
  add constraint audit_events_exactly_one_scope
    check (
      (workspace_id is not null)::integer
      + (platform_environment is not null)::integer = 1
    );

create index audit_events_platform_cursor
  on public.audit_events (platform_environment, id desc)
  where platform_environment is not null;

create table public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  environment public.platform_environment not null,
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now()
);

create index platform_admins_environment_status
  on public.platform_admins (environment, status);

create table public.platform_admin_sessions (
  session_id uuid primary key,
  user_id uuid not null references public.platform_admins(user_id)
    on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_reason text check (lock_reason in ('inactivity', 'absolute'))
);

create index platform_admin_sessions_user
  on public.platform_admin_sessions (user_id);

create table public.break_glass_grants (
  id uuid primary key default gen_random_uuid(),
  environment public.platform_environment not null,
  platform_admin_id uuid not null references public.platform_admins(user_id),
  workspace_id uuid not null references public.workspaces(id),
  call_id uuid references public.calls(id),
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.platform_admins(user_id),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '1 hour'),
  check (revoked_at is null or revoked_at >= created_at)
);

create index break_glass_grants_active_actor
  on public.break_glass_grants (platform_admin_id, expires_at)
  where revoked_at is null;
create index break_glass_grants_active_workspace
  on public.break_glass_grants (workspace_id, expires_at)
  where revoked_at is null;
create index break_glass_grants_active_call
  on public.break_glass_grants (call_id, expires_at)
  where revoked_at is null and call_id is not null;

create table public.workspace_admin_notifications (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  notification_type text not null
    check (notification_type = 'break_glass.activated'),
  entity_id uuid not null references public.break_glass_grants(id),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index workspace_admin_notifications_unread
  on public.workspace_admin_notifications (workspace_id, created_at desc)
  where read_at is null;

alter table public.platform_admins enable row level security;
alter table public.platform_admin_sessions enable row level security;
alter table public.break_glass_grants enable row level security;
alter table public.workspace_admin_notifications enable row level security;

revoke all on public.platform_admins
  from public, anon, authenticated;
revoke all on public.platform_admin_sessions
  from public, anon, authenticated;
revoke all on public.break_glass_grants
  from public, anon, authenticated;
revoke all on public.workspace_admin_notifications
  from public, anon, authenticated;
grant all privileges on public.platform_admins to service_role;
grant all privileges on public.platform_admin_sessions to service_role;
grant all privileges on public.break_glass_grants to service_role;
grant all privileges on public.workspace_admin_notifications to service_role;
grant select, update (read_at) on public.workspace_admin_notifications
  to authenticated;

create policy workspace_admin_notifications_select
on public.workspace_admin_notifications for select
using (public.current_user_role(workspace_id) = 'admin');

create policy workspace_admin_notifications_mark_read
on public.workspace_admin_notifications for update
using (public.current_user_role(workspace_id) = 'admin')
with check (public.current_user_role(workspace_id) = 'admin');

-- A Platform Admin identity is never also a Workspace Member. This makes the
-- control plane a separate authority boundary instead of an elevated role in
-- the Workspace application.
create or replace function public.enforce_platform_admin_identity_separation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
begin
  target_user_id := new.user_id;
  if tg_table_name = 'platform_admins' then
    if exists (
      select 1 from public.workspace_members
      where user_id = target_user_id
    ) then
      raise exception 'Platform Admin identities cannot be Workspace Members';
    end if;
  elsif exists (
    select 1 from public.platform_admins
    where user_id = target_user_id
  ) then
    raise exception 'Platform Admin identities cannot be Workspace Members';
  end if;
  return new;
end;
$$;

create trigger platform_admin_identity_separation
before insert or update of user_id on public.platform_admins
for each row execute function public.enforce_platform_admin_identity_separation();

create trigger workspace_member_platform_identity_separation
before insert or update of user_id on public.workspace_members
for each row execute function public.enforce_platform_admin_identity_separation();

create or replace function public.platform_admin_identity()
returns public.platform_environment
language sql
stable
security definer
set search_path = public
as $$
  select environment
  from public.platform_admins
  where user_id = auth.uid()
    and status = 'active'
  limit 1;
$$;

create or replace function public.platform_admin_session_lock_reason()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  activity public.platform_admin_sessions;
begin
  select * into activity
  from public.platform_admin_sessions
  where session_id = public.current_session_id()
    and user_id = auth.uid();

  if activity.session_id is null then
    return null;
  end if;
  if activity.locked_at is not null then
    return activity.lock_reason;
  end if;
  if activity.started_at + interval '1 hour' <= now() then
    return 'absolute';
  end if;
  if activity.last_seen_at + interval '15 minutes' <= now() then
    return 'inactivity';
  end if;
  return null;
end;
$$;

create or replace function public.record_platform_audit_event(
  target_environment public.platform_environment,
  target_actor_id uuid,
  target_action text,
  target_entity_type text,
  target_entity_id text,
  target_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  event_id bigint;
begin
  perform public.assert_safe_audit_metadata(target_metadata);

  if target_environment is null then
    raise exception 'Platform Audit Environment is required';
  end if;
  if target_actor_id is not null and not exists (
    select 1 from public.profiles where id = target_actor_id
  ) then
    raise exception 'Audit actor does not exist';
  end if;

  insert into public.audit_events (
    workspace_id,
    platform_environment,
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    null,
    target_environment,
    target_actor_id,
    target_action,
    target_entity_type,
    target_entity_id,
    target_metadata
  )
  returning id into event_id;

  return event_id;
end;
$$;

create or replace function public.touch_platform_admin_session()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  session uuid := public.current_session_id();
  reason text;
  inserted_count integer;
  target_environment public.platform_environment;
begin
  if session is null
    or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
    or public.platform_admin_identity() is null
  then
    raise exception 'Active Platform Admin AAL2 session required';
  end if;

  insert into public.platform_admin_sessions (session_id, user_id)
  values (session, auth.uid())
  on conflict (session_id) do nothing;
  get diagnostics inserted_count = row_count;

  reason := public.platform_admin_session_lock_reason();
  if reason is not null then
    update public.platform_admin_sessions
    set locked_at = coalesce(locked_at, now()),
        lock_reason = coalesce(lock_reason, reason)
    where session_id = session;
    return reason;
  end if;

  update public.platform_admin_sessions
  set last_seen_at = now()
  where session_id = session;

  if inserted_count = 1 then
    target_environment := public.platform_admin_identity();
    perform public.record_platform_audit_event(
      target_environment,
      auth.uid(),
      'platform_admin.session.started',
      'platform_admin',
      auth.uid()::text,
      '{}'::jsonb
    );
  end if;
  return null;
end;
$$;

create or replace function public.is_current_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.platform_admin_identity() is not null
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    and public.platform_admin_session_lock_reason() is null;
$$;

create or replace function public.assert_current_platform_admin(
  require_fresh_mfa boolean default false
)
returns public.platform_environment
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  lock_reason text;
begin
  target_environment := public.platform_admin_identity();
  if target_environment is null
    or coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
  then
    raise exception 'Active Platform Admin AAL2 session required';
  end if;
  lock_reason := public.touch_platform_admin_session();
  if lock_reason is not null then
    raise exception 'Active Platform Admin AAL2 session required';
  end if;
  if require_fresh_mfa
    and not public.recent_mfa_assertion(interval '5 minutes')
  then
    raise exception 'Fresh Platform Admin MFA is required';
  end if;
  return target_environment;
end;
$$;

create or replace function public.record_platform_admin_mfa_event(
  target_action text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
begin
  if target_action not in (
    'platform_admin.mfa.enrollment_started',
    'platform_admin.mfa.enrolled',
    'platform_admin.mfa.verified',
    'platform_admin.mfa.verification_failed'
  ) then
    raise exception 'Unsupported Platform Admin MFA Audit Event';
  end if;

  target_environment := public.platform_admin_identity();
  if target_environment is null then
    raise exception 'Active Platform Admin identity required';
  end if;
  if target_action in (
    'platform_admin.mfa.enrolled',
    'platform_admin.mfa.verified'
  ) and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'AAL2 is required for successful MFA Audit Events';
  end if;

  return public.record_platform_audit_event(
    target_environment,
    auth.uid(),
    target_action,
    'platform_admin',
    auth.uid()::text,
    '{}'::jsonb
  );
end;
$$;

create or replace function public.platform_workspace_health()
returns table (
  workspace_id uuid,
  workspace_name text,
  active_members bigint,
  active_calls bigint,
  queued_jobs bigint,
  failed_jobs bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
begin
  target_environment := public.assert_current_platform_admin(false);
  perform public.record_platform_audit_event(
    target_environment,
    auth.uid(),
    'platform_admin.health.inspected',
    'platform_environment',
    target_environment::text,
    '{}'::jsonb
  );

  return query
  select
    workspace.id,
    workspace.name,
    (
      select count(*)
      from public.workspace_members member
      where member.workspace_id = workspace.id
        and member.status = 'active'
    ),
    (
      select count(*)
      from public.calls call
      where call.workspace_id = workspace.id
        and call.deleted_at is null
    ),
    (
      select count(*)
      from public.processing_jobs job
      where job.workspace_id = workspace.id
        and job.status in ('queued', 'retrying', 'processing')
    ),
    (
      select count(*)
      from public.processing_jobs job
      where job.workspace_id = workspace.id
        and job.status = 'failed'
    )
  from public.workspaces workspace
  order by workspace.name, workspace.id;
end;
$$;

create or replace function public.grant_break_glass_access(
  target_workspace_id uuid,
  target_call_id uuid,
  target_reason text,
  target_expires_at timestamptz
)
returns public.break_glass_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  grant_record public.break_glass_grants;
begin
  target_environment := public.assert_current_platform_admin(true);
  if target_workspace_id is null then
    raise exception 'Break-glass scope requires one Workspace';
  end if;
  if target_expires_at is null
    or target_expires_at <= now()
    or target_expires_at > now() + interval '1 hour'
  then
    raise exception 'Break-glass expiration must be within one hour';
  end if;
  if char_length(trim(coalesce(target_reason, ''))) not between 10 and 500 then
    raise exception 'Break-glass reason must be between 10 and 500 characters';
  end if;
  if not exists (
    select 1 from public.workspaces where id = target_workspace_id
  ) then
    raise exception 'Break-glass Workspace does not exist';
  end if;
  if target_call_id is not null and not exists (
    select 1
    from public.calls
    where id = target_call_id
      and workspace_id = target_workspace_id
      and deleted_at is null
  ) then
    raise exception 'Break-glass Call does not belong to the Workspace';
  end if;

  insert into public.break_glass_grants (
    environment,
    platform_admin_id,
    workspace_id,
    call_id,
    reason,
    expires_at
  ) values (
    target_environment,
    auth.uid(),
    target_workspace_id,
    target_call_id,
    trim(target_reason),
    target_expires_at
  )
  returning * into grant_record;

  insert into public.workspace_admin_notifications (
    workspace_id,
    notification_type,
    entity_id
  ) values (
    target_workspace_id,
    'break_glass.activated',
    grant_record.id
  );

  perform public.record_audit_event(
    target_workspace_id,
    auth.uid(),
    'platform_admin.break_glass.activated',
    'break_glass_grant',
    grant_record.id::text,
    jsonb_build_object(
      'scope', case when target_call_id is null then 'workspace' else 'call' end,
      'expires_at', extract(epoch from target_expires_at)::bigint,
      'environment', target_environment
    )
  );
  return grant_record;
end;
$$;

create or replace function public.revoke_break_glass_access(
  target_grant_id uuid
)
returns public.break_glass_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  grant_record public.break_glass_grants;
begin
  target_environment := public.assert_current_platform_admin(true);
  update public.break_glass_grants
  set revoked_at = now(),
      revoked_by = auth.uid()
  where id = target_grant_id
    and environment = target_environment
    and revoked_at is null
  returning * into grant_record;

  if grant_record.id is null then
    raise exception 'Active break-glass grant not found';
  end if;
  perform public.record_audit_event(
    grant_record.workspace_id,
    auth.uid(),
    'platform_admin.break_glass.revoked',
    'break_glass_grant',
    grant_record.id::text,
    jsonb_build_object('environment', target_environment)
  );
  return grant_record;
end;
$$;

create or replace function public.platform_read_call_content(
  target_call_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  grant_record public.break_glass_grants;
  call_record public.calls;
  result jsonb;
begin
  target_environment := public.assert_current_platform_admin(false);
  select active_grant.*
  into grant_record
  from public.break_glass_grants active_grant
  join public.calls call
    on call.id = target_call_id
   and call.workspace_id = active_grant.workspace_id
   and call.deleted_at is null
  where active_grant.platform_admin_id = auth.uid()
    and active_grant.environment = target_environment
    and active_grant.revoked_at is null
    and active_grant.expires_at > now()
    and (
      active_grant.call_id is null
      or active_grant.call_id = target_call_id
    )
  order by active_grant.expires_at
  limit 1;

  if grant_record.id is null then
    raise exception 'No active break-glass grant covers this Call';
  end if;

  select * into call_record
  from public.calls
  where id = target_call_id;

  select jsonb_build_object(
    'call_id', call_record.id,
    'workspace_id', call_record.workspace_id,
    'title', call_record.title,
    'status', call_record.status,
    'source_path', call_record.source_path,
    'mp3_path', call_record.mp3_path,
    'wav_path', call_record.wav_path,
    'transcript', (
      select transcript.full_text
      from public.transcripts transcript
      where transcript.call_id = call_record.id
    ),
    'review', (
      select jsonb_build_object(
        'status', review.status,
        'summary', review.summary,
        'follow_up', review.follow_up
      )
      from public.call_reviews review
      where review.call_id = call_record.id
    )
  ) into result;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    'platform_admin.break_glass.content_read',
    'call',
    call_record.id::text,
    jsonb_build_object(
      'grant_id', grant_record.id,
      'environment', target_environment
    )
  );
  return result;
end;
$$;

revoke all on function public.platform_admin_identity()
  from public, anon;
revoke all on function public.record_platform_audit_event(
  public.platform_environment, uuid, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.platform_admin_session_lock_reason()
  from public, anon;
revoke all on function public.touch_platform_admin_session()
  from public, anon;
revoke all on function public.is_current_platform_admin()
  from public, anon;
revoke all on function public.assert_current_platform_admin(boolean)
  from public, anon, authenticated;
revoke all on function public.record_platform_admin_mfa_event(text)
  from public, anon;
revoke all on function public.platform_workspace_health()
  from public, anon;
revoke all on function public.grant_break_glass_access(
  uuid, uuid, text, timestamptz
) from public, anon;
revoke all on function public.revoke_break_glass_access(uuid)
  from public, anon;
revoke all on function public.platform_read_call_content(uuid)
  from public, anon;

grant execute on function public.platform_admin_identity()
  to authenticated;
grant execute on function public.record_platform_audit_event(
  public.platform_environment, uuid, text, text, text, jsonb
) to service_role;
grant execute on function public.platform_admin_session_lock_reason()
  to authenticated;
grant execute on function public.touch_platform_admin_session()
  to authenticated;
grant execute on function public.is_current_platform_admin()
  to authenticated;
grant execute on function public.record_platform_admin_mfa_event(text)
  to authenticated;
grant execute on function public.platform_workspace_health()
  to authenticated;
grant execute on function public.grant_break_glass_access(
  uuid, uuid, text, timestamptz
) to authenticated;
grant execute on function public.revoke_break_glass_access(uuid)
  to authenticated;
grant execute on function public.platform_read_call_content(uuid)
  to authenticated;
