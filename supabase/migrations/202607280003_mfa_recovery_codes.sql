alter table public.workspace_members
  add column if not exists mfa_recovery_pending_at timestamptz;

comment on column public.workspace_members.mfa_recovery_pending_at is
  'Set when a Recovery Code is redeemed. While it is present the Workspace '
  'Member may only replace their second factor, never reach the application.';

-- Redeeming a Recovery Code leaves the account with no factor at all, which
-- would otherwise read as "a Member needs no second factor". While the stamp
-- is present only an AAL2 session carries authority, and the only way back to
-- AAL2 is enrolling and verifying the replacement factor.
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
    and (
      mfa_recovery_pending_at is null
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    )
    and public.authentication_assurance_satisfies_role(role)
  limit 1;
$$;

create table if not exists public.mfa_recovery_code_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);

create unique index if not exists mfa_recovery_code_sets_current
  on public.mfa_recovery_code_sets (user_id)
  where superseded_at is null;

create table if not exists public.mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null
    references public.mfa_recovery_code_sets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Keyed hash only. The plaintext Recovery Code is shown once and never
  -- stored, so an exfiltrated table cannot be replayed without the key.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (set_id, code_hash)
);

create index if not exists mfa_recovery_codes_unused
  on public.mfa_recovery_codes (user_id)
  where used_at is null;

alter table public.mfa_recovery_code_sets enable row level security;
alter table public.mfa_recovery_codes enable row level security;

-- No policy is defined for either table: hashes and lifecycle rows are reached
-- only by the identity principal through the security definer functions below.
revoke all on public.mfa_recovery_code_sets from public, anon, authenticated;
revoke all on public.mfa_recovery_codes from public, anon, authenticated;
grant all privileges on public.mfa_recovery_code_sets to service_role;
grant all privileges on public.mfa_recovery_codes to service_role;

create or replace function public.replace_mfa_recovery_codes(
  target_user_id uuid,
  target_code_hashes text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  previous_set_id uuid;
  new_set_id uuid;
  code_hash text;
begin
  if cardinality(target_code_hashes) <> 10 then
    raise exception 'A Recovery Code set is exactly ten codes';
  end if;

  select workspace_id
  into actor_workspace_id
  from public.workspace_members
  where user_id = target_user_id
    and status = 'active'
  limit 1;
  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  -- Superseding the set is what invalidates its unused codes: every read of a
  -- live code joins through the set, so there is no second place to forget.
  update public.mfa_recovery_code_sets
  set superseded_at = now()
  where user_id = target_user_id
    and superseded_at is null
  returning id into previous_set_id;

  insert into public.mfa_recovery_code_sets (user_id, workspace_id)
  values (target_user_id, actor_workspace_id)
  returning id into new_set_id;

  foreach code_hash in array target_code_hashes loop
    insert into public.mfa_recovery_codes (set_id, user_id, code_hash)
    values (new_set_id, target_user_id, code_hash);
  end loop;

  update public.workspace_members
  set mfa_recovery_pending_at = null
  where user_id = target_user_id
    and mfa_recovery_pending_at is not null;

  perform public.record_audit_event(
    actor_workspace_id,
    target_user_id,
    case
      when previous_set_id is null then 'auth.mfa.recovery_codes_generated'
      else 'auth.mfa.recovery_codes_regenerated'
    end,
    'workspace_member',
    target_user_id::text,
    jsonb_build_object('codes_issued', cardinality(target_code_hashes))
  );
  return new_set_id;
end;
$$;

create or replace function public.active_mfa_recovery_codes(
  target_user_id uuid
)
returns table (id uuid, code_hash text)
language sql
stable
security definer
set search_path = public
as $$
  select code.id, code.code_hash
  from public.mfa_recovery_codes code
  join public.mfa_recovery_code_sets code_set on code_set.id = code.set_id
  where code.user_id = target_user_id
    and code.used_at is null
    and code_set.superseded_at is null
  order by code.created_at, code.id;
$$;

-- Consumption is a single conditional update, so two requests presenting the
-- same code race for one row and exactly one of them wins.
create or replace function public.consume_mfa_recovery_code(
  target_code_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  consumed_user_id uuid;
  actor_workspace_id uuid;
  remaining integer;
begin
  update public.mfa_recovery_codes code
  set used_at = now()
  from public.mfa_recovery_code_sets code_set
  where code.id = target_code_id
    and code_set.id = code.set_id
    and code.used_at is null
    and code_set.superseded_at is null
  returning code.user_id into consumed_user_id;

  if consumed_user_id is null then
    return null;
  end if;

  update public.workspace_members
  set mfa_recovery_pending_at = now()
  where user_id = consumed_user_id
    and status = 'active'
  returning workspace_id into actor_workspace_id;

  select count(*)
  into remaining
  from public.active_mfa_recovery_codes(consumed_user_id);

  perform public.record_audit_event(
    actor_workspace_id,
    consumed_user_id,
    'auth.mfa.recovery_used',
    'workspace_member',
    consumed_user_id::text,
    jsonb_build_object('codes_remaining', remaining)
  );
  return remaining;
end;
$$;

create or replace function public.record_mfa_recovery_failure(
  target_user_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
begin
  select workspace_id
  into actor_workspace_id
  from public.workspace_members
  where user_id = target_user_id
    and status = 'active'
  limit 1;
  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  return public.record_audit_event(
    actor_workspace_id,
    target_user_id,
    'auth.mfa.recovery_failed',
    'workspace_member',
    target_user_id::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.replace_mfa_recovery_codes(uuid, text[])
  from public, anon, authenticated;
revoke all on function public.active_mfa_recovery_codes(uuid)
  from public, anon, authenticated;
revoke all on function public.consume_mfa_recovery_code(uuid)
  from public, anon, authenticated;
revoke all on function public.record_mfa_recovery_failure(uuid)
  from public, anon, authenticated;
grant execute on function public.replace_mfa_recovery_codes(uuid, text[])
  to service_role;
grant execute on function public.active_mfa_recovery_codes(uuid)
  to service_role;
grant execute on function public.consume_mfa_recovery_code(uuid)
  to service_role;
grant execute on function public.record_mfa_recovery_failure(uuid)
  to service_role;

-- Downloading the printed set is a Workspace Member action, so it joins the
-- self-service MFA Audit Events rather than the identity principal's.
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
    'auth.mfa.verification_failed',
    'auth.mfa.recovery_codes_downloaded'
  ) then
    raise exception 'Unsupported MFA Audit Event';
  end if;

  if target_action in (
    'auth.mfa.enrolled',
    'auth.mfa.verified',
    'auth.mfa.recovery_codes_downloaded'
  )
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

revoke all on function public.record_current_user_mfa_event(text, uuid)
  from public, anon;
grant execute on function public.record_current_user_mfa_event(text, uuid)
  to authenticated;
