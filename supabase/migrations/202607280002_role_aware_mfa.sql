create or replace function public.authentication_assurance_satisfies_role(
  target_role public.app_role
)
returns boolean
language sql
stable
set search_path = public
as $$
  select target_role = 'member'
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

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
    and public.authentication_assurance_satisfies_role(role)
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
    from public.calls call
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
     and member.status = 'active'
    where call.id = target_call_id
      and call.deleted_at is null
      and public.authentication_assurance_satisfies_role(member.role)
      and (
        member.role in ('manager', 'admin')
        or call.owner_id = auth.uid()
      )
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
    from public.calls call
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
     and member.status = 'active'
    where call.id = target_call_id
      and call.deleted_at is null
      and member.role in ('manager', 'admin')
      and public.authentication_assurance_satisfies_role(member.role)
  );
$$;

create or replace function public.can_view_review(target_review_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.call_reviews review
    join public.calls call on call.id = review.call_id
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
     and member.status = 'active'
    where review.id = target_review_id
      and call.deleted_at is null
      and public.authentication_assurance_satisfies_role(member.role)
      and (
        member.role in ('manager', 'admin')
        or (call.owner_id = auth.uid() and review.status <> 'in_progress')
      )
  );
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
using (
  id = auth.uid()
  or exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs
      on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = profiles.id
      and public.authentication_assurance_satisfies_role(mine.role)
      and (theirs.status = 'active' or mine.role = 'admin')
  )
);

create or replace function public.enforce_privileged_actor_assurance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
    and exists (
      select 1
      from public.workspace_members actor
      where actor.user_id = auth.uid()
        and actor.status = 'active'
        and actor.role in ('manager', 'admin')
    )
  then
    raise exception 'Verified TOTP MFA is required for this role';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_members_privileged_aal
  on public.workspace_members;
create trigger workspace_members_privileged_aal
before insert or update or delete on public.workspace_members
for each row execute function public.enforce_privileged_actor_assurance();

drop trigger if exists workspace_invites_privileged_aal
  on public.workspace_invites;
create trigger workspace_invites_privileged_aal
before insert or update or delete on public.workspace_invites
for each row execute function public.enforce_privileged_actor_assurance();

create or replace function public.audit_privileged_role_enforcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role in ('manager', 'admin')
    and (
      tg_op = 'INSERT'
      or old.role is distinct from new.role
    )
  then
    perform public.record_audit_event(
      new.workspace_id,
      auth.uid(),
      'auth.mfa.role_enforced',
      'workspace_member',
      new.user_id::text,
      jsonb_build_object('required_role', new.role)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_members_mfa_role_audit
  on public.workspace_members;
create trigger workspace_members_mfa_role_audit
after insert or update of role on public.workspace_members
for each row execute function public.audit_privileged_role_enforcement();

create or replace function public.pending_invitation_role(
  target_invite_id uuid
)
returns public.app_role
language sql
stable
security definer
set search_path = public, auth
as $$
  select invite.role
  from public.workspace_invites invite
  join auth.users actor on actor.id = auth.uid()
  where invite.id = target_invite_id
    and invite.accepted_at is null
    and invite.expires_at > now()
    and lower(invite.email) = lower(coalesce(actor.email, ''))
  limit 1;
$$;

create or replace function public.record_current_user_mfa_event(
  target_action text,
  target_invite_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_workspace_id uuid;
begin
  if target_action not in (
    'auth.mfa.enrollment_started',
    'auth.mfa.enrolled',
    'auth.mfa.verified',
    'auth.mfa.verification_failed'
  ) then
    raise exception 'Unsupported MFA Audit Event';
  end if;

  if target_action in ('auth.mfa.enrolled', 'auth.mfa.verified')
    and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
  then
    raise exception 'AAL2 is required for successful MFA Audit Events';
  end if;

  select member.workspace_id
  into actor_workspace_id
  from public.workspace_members member
  where member.user_id = auth.uid()
    and member.status = 'active'
  limit 1;

  if actor_workspace_id is null and target_invite_id is not null then
    select invite.workspace_id
    into actor_workspace_id
    from public.workspace_invites invite
    join auth.users actor on actor.id = auth.uid()
    where invite.id = target_invite_id
      and invite.accepted_at is null
      and invite.expires_at > now()
      and lower(invite.email) = lower(coalesce(actor.email, ''));
  end if;

  if actor_workspace_id is null then
    raise exception 'Active membership or valid Invitation is required';
  end if;

  return public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    target_action,
    'workspace_member',
    auth.uid()::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.pending_invitation_role(uuid)
  from public, anon;
grant execute on function public.pending_invitation_role(uuid)
  to authenticated;

revoke all on function public.record_current_user_mfa_event(text, uuid)
  from public, anon;
grant execute on function public.record_current_user_mfa_event(text, uuid)
  to authenticated;

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

  select *
  into invite_record
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

  if not public.authentication_assurance_satisfies_role(invite_record.role)
  then
    raise exception 'Verified TOTP MFA is required before activation';
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
