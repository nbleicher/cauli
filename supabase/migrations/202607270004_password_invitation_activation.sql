create or replace function public.activate_workspace_invitation(
  target_invite_id uuid
)
returns public.workspace_members
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_email text;
  has_password boolean;
  invite_record public.workspace_invites;
  member_record public.workspace_members;
begin
  select
    lower(coalesce(user_record.email, '')),
    coalesce(user_record.encrypted_password, '') <> ''
  into actor_email, has_password
  from auth.users user_record
  where user_record.id = auth.uid();

  if actor_email = '' then
    raise exception 'An authenticated invitation session is required';
  end if;
  if not has_password then
    raise exception 'Create a password before activating the invitation';
  end if;

  select * into invite_record
  from public.workspace_invites
  where id = target_invite_id
  for update;

  if invite_record.id is null
    or invite_record.accepted_at is not null
    or invite_record.expires_at <= now()
    or lower(invite_record.email) <> actor_email
  then
    raise exception 'Invitation is invalid, expired, used, or revoked';
  end if;

  if exists (
    select 1
    from public.workspace_members existing
    where existing.user_id = auth.uid()
      and existing.workspace_id <> invite_record.workspace_id
  ) then
    raise exception 'This identity already belongs to another Workspace';
  end if;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    role,
    invited_by,
    status,
    status_changed_at,
    status_changed_by
  ) values (
    invite_record.workspace_id,
    auth.uid(),
    invite_record.role,
    invite_record.invited_by,
    'active',
    now(),
    invite_record.invited_by
  )
  returning * into member_record;

  update public.workspace_invites
  set accepted_at = now()
  where id = invite_record.id;

  perform public.record_audit_event(
    invite_record.workspace_id,
    auth.uid(),
    'workspace.invite.activated',
    'workspace_invite',
    invite_record.id::text,
    jsonb_build_object('role', invite_record.role)
  );
  return member_record;
end;
$$;

create or replace function public.record_password_reset_for_current_user()
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
    and status = 'active';
  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  return public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'auth.password_reset.completed',
    'workspace_member',
    auth.uid()::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.activate_workspace_invitation(uuid)
  from public, anon;
grant execute on function public.activate_workspace_invitation(uuid)
  to authenticated;
revoke all on function public.record_password_reset_for_current_user()
  from public, anon;
grant execute on function public.record_password_reset_for_current_user()
  to authenticated;
