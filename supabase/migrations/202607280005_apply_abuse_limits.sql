/**
 * The documented limits are attached to the tables the actions land in rather
 * than to the routes that call them, so an authenticated client reaching
 * PostgREST directly is throttled on exactly the same terms as the browser.
 * Every guard is skipped for non-authenticated roles, which keeps the worker,
 * the identity principal, and fixtures out of the counters.
 */
create or replace function public.enforce_call_creation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and public.consume_rate_limit(
      'call.create', new.owner_id::text, 10, interval '1 minute',
      null, new.workspace_id
    ) <> 'allowed'
  then
    raise exception 'Too many Calls created. Try again shortly.'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

drop trigger if exists calls_creation_rate_limit on public.calls;
create trigger calls_creation_rate_limit
before insert on public.calls
for each row execute function public.enforce_call_creation_limit();

create or replace function public.enforce_invitation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and public.consume_rate_limit(
      'workspace.invite', new.workspace_id::text, 20, interval '1 hour',
      null, new.workspace_id
    ) <> 'allowed'
  then
    raise exception 'Too many Workspace Invitations this hour.'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_invites_rate_limit on public.workspace_invites;
create trigger workspace_invites_rate_limit
before insert on public.workspace_invites
for each row execute function public.enforce_invitation_limit();

-- Retry and export both land here, and the documented allowance is per Call
-- rather than per operation, so they share one counter.
create or replace function public.enforce_reprocessing_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and new.call_id is not null
    and new.kind in ('process_recording', 'generate_wav')
    and public.consume_rate_limit(
      'call.reprocess', new.call_id::text, 10, interval '1 hour',
      null, new.workspace_id
    ) <> 'allowed'
  then
    raise exception 'Too many retries or exports for this Call this hour.'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

drop trigger if exists processing_jobs_rate_limit on public.processing_jobs;
create trigger processing_jobs_rate_limit
before insert on public.processing_jobs
for each row execute function public.enforce_reprocessing_limit();

create or replace function public.enforce_review_submission_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reviewer uuid := coalesce(auth.uid(), new.updated_by);
  actor_workspace_id uuid;
begin
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
    and new.version is not distinct from old.version
  then
    return new;
  end if;

  select call.workspace_id into actor_workspace_id
  from public.calls call
  where call.id = new.call_id;

  if public.consume_rate_limit(
    'review.submit', reviewer::text, 30, interval '1 hour',
    null, actor_workspace_id
  ) <> 'allowed'
  then
    raise exception 'Too many Review submissions this hour.'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

drop trigger if exists call_reviews_rate_limit on public.call_reviews;
create trigger call_reviews_rate_limit
before insert or update on public.call_reviews
for each row execute function public.enforce_review_submission_limit();

/**
 * Signed delivery produces no row of its own, so this is the one limit the
 * application must ask for. Spending it early is harmless: the allowance is
 * derived from the caller, so the worst a client can do is exhaust its own.
 */
create or replace function public.consume_signed_download_allowance()
returns text
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
  limit 1;
  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  return public.consume_rate_limit(
    'call.signed_download', auth.uid()::text, 60, interval '1 hour',
    null, actor_workspace_id
  );
end;
$$;

revoke all on function public.consume_signed_download_allowance()
  from public, anon;
grant execute on function public.consume_signed_download_allowance()
  to authenticated;

/**
 * Audits one Recovery Code failure and counts it toward the lockout. Returns
 * 'allowed' while attempts remain and 'locked' once the window has been spent,
 * at which point a second Audit Event carries the alert an Admin acts on.
 */
create or replace function public.register_mfa_recovery_failure(
  target_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  outcome text;
begin
  perform public.record_mfa_recovery_failure(target_user_id);

  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = target_user_id
    and status = 'active'
  limit 1;

  outcome := public.consume_rate_limit(
    'auth.recovery', target_user_id::text, 5, interval '15 minutes',
    interval '1 hour', actor_workspace_id
  );
  if outcome = 'locked' then
    perform public.record_audit_event(
      actor_workspace_id,
      target_user_id,
      'auth.mfa.recovery_locked',
      'workspace_member',
      target_user_id::text,
      jsonb_build_object('locked_minutes', 60)
    );
  end if;
  return outcome;
end;
$$;

create or replace function public.mfa_recovery_locked(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.rate_limit_locked_until(
    'auth.recovery', target_user_id::text
  ) is not null;
$$;

revoke all on function public.register_mfa_recovery_failure(uuid)
  from public, anon, authenticated;
revoke all on function public.mfa_recovery_locked(uuid)
  from public, anon, authenticated;
grant execute on function public.register_mfa_recovery_failure(uuid)
  to service_role;
grant execute on function public.mfa_recovery_locked(uuid) to service_role;

/**
 * Reports Recovery Code lockouts so a Workspace Admin has somewhere to see the
 * alert beyond the Audit Log. It answers only for the Admin's own Workspace and
 * says who is locked and until when, never why a code failed.
 */
create or replace function public.workspace_recovery_lockouts()
returns table (user_id uuid, locked_until timestamptz)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select member.user_id, state.locked_until
  from public.workspace_members member
  join public.rate_limit_state state
    on state.bucket = 'auth.recovery'
   and state.subject_digest = encode(
     extensions.digest('auth.recovery|' || member.user_id::text, 'sha256'),
     'hex'
   )
  where member.workspace_id = (
      select workspace_id
      from public.workspace_members actor
      where actor.user_id = auth.uid()
        and actor.status = 'active'
      limit 1
    )
    and public.current_user_role(member.workspace_id) = 'admin'
    and state.locked_until > now();
$$;

revoke all on function public.workspace_recovery_lockouts() from public, anon;
grant execute on function public.workspace_recovery_lockouts() to authenticated;

-- A refusal raised from a trigger takes its own Audit Event down with the
-- transaction it aborts, so evidence for those limits is recorded afterwards,
-- by the application, once the refusal has been observed. The counter is
-- checked here rather than trusted from the caller, and the subject is derived
-- from the session, so this cannot be used to write invented evidence.
alter table public.rate_limit_state
  add column if not exists max_attempts integer;

create or replace function public.record_rate_limit_evidence(
  target_bucket text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_workspace_id uuid;
  subject text;
  spent boolean;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
  limit 1;
  if actor_workspace_id is null then
    return false;
  end if;

  subject := case target_bucket
    when 'call.create' then auth.uid()::text
    when 'call.signed_download' then auth.uid()::text
    when 'review.submit' then auth.uid()::text
    when 'workspace.invite' then actor_workspace_id::text
    else null
  end;
  if subject is null then
    return false;
  end if;

  select state.attempts >= state.max_attempts
  into spent
  from public.rate_limit_state state
  where state.bucket = target_bucket
    and state.subject_digest = encode(
      extensions.digest(target_bucket || '|' || subject, 'sha256'),
      'hex'
    );
  if not coalesce(spent, false) then
    return false;
  end if;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'security.rate_limit.exceeded',
    'rate_limit',
    target_bucket,
    jsonb_build_object('outcome', 'limited')
  );
  return true;
end;
$$;

revoke all on function public.record_rate_limit_evidence(text)
  from public, anon;
grant execute on function public.record_rate_limit_evidence(text)
  to authenticated;
