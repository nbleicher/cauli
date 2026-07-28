create table if not exists public.session_activity (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_reason text check (lock_reason in ('inactivity', 'absolute'))
);

create index if not exists session_activity_user on public.session_activity (user_id);

alter table public.session_activity enable row level security;
revoke all on public.session_activity from public, anon, authenticated;
grant all privileges on public.session_activity to service_role;

create or replace function public.session_absolute_lifetime()
returns interval
language sql
immutable
as $$
  select interval '12 hours';
$$;

create or replace function public.session_inactivity_timeout()
returns interval
language sql
immutable
as $$
  select interval '30 minutes';
$$;

create or replace function public.current_session_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

-- An active Recording suspends the inactivity threshold without resetting it,
-- so capture is never interrupted and the session locks on the first request
-- after Stop & Save if the threshold had already passed.
create or replace function public.has_active_recording(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.calls
    where owner_id = target_user_id
      and status in ('recording', 'uploading')
      and deleted_at is null
  );
$$;

create or replace function public.session_lock_reason()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  activity public.session_activity;
begin
  select * into activity
  from public.session_activity
  where session_id = public.current_session_id();

  -- A session this boundary has never seen cannot be judged stale yet.
  if activity.session_id is null then
    return null;
  end if;
  if activity.locked_at is not null then
    return activity.lock_reason;
  end if;
  if activity.started_at + public.session_absolute_lifetime() <= now() then
    return 'absolute';
  end if;
  if activity.last_seen_at + public.session_inactivity_timeout() <= now()
    and not public.has_active_recording(activity.user_id)
  then
    return 'inactivity';
  end if;
  return null;
end;
$$;

/**
 * Records that the current session is in use and reports whether it may
 * continue. Returns null while the session is usable, otherwise the reason it
 * is locked. Locking is written down so a session cannot be revived by a later
 * request, and the last-seen stamp deliberately does not advance during an
 * active Recording.
 */
create or replace function public.touch_session_activity()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  session uuid := public.current_session_id();
  reason text;
  recording boolean;
begin
  if session is null or auth.uid() is null then
    return null;
  end if;

  insert into public.session_activity (session_id, user_id)
  values (session, auth.uid())
  on conflict (session_id) do nothing;

  reason := public.session_lock_reason();
  if reason is not null then
    update public.session_activity
    set locked_at = coalesce(locked_at, now()),
        lock_reason = coalesce(lock_reason, reason)
    where session_id = session;
    return reason;
  end if;

  select public.has_active_recording(auth.uid()) into recording;
  if not recording then
    update public.session_activity
    set last_seen_at = now()
    where session_id = session;
  end if;
  return null;
end;
$$;

/**
 * True when the caller presented a second factor within the given age. Reads
 * the authentication methods the session was actually minted with, so a
 * long-lived AAL2 session does not stay "fresh" forever.
 */
create or replace function public.recent_mfa_assertion(max_age interval)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) entry
    where entry ->> 'method' in ('totp', 'mfa/totp')
      and to_timestamp((entry ->> 'timestamp')::numeric) > now() - max_age
  );
$$;

revoke all on function public.session_lock_reason() from public, anon;
revoke all on function public.touch_session_activity() from public, anon;
revoke all on function public.recent_mfa_assertion(interval) from public, anon;
grant execute on function public.session_lock_reason() to authenticated;
grant execute on function public.touch_session_activity() to authenticated;
grant execute on function public.recent_mfa_assertion(interval) to authenticated;

-- A locked session keeps its identity but loses its authority, so every policy
-- built on current_user_role closes at the same moment the browser does.
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
    and mfa_recovery_pending_at is null
    and public.authentication_assurance_satisfies_role(role)
    and public.session_lock_reason() is null
  limit 1;
$$;

/**
 * One fixed window per (bucket, subject). Storing a counter instead of an event
 * per attempt keeps the table bounded without a sweeper, and the subject is
 * only ever held as a digest so no address, email, or identifier is retained
 * here in the clear.
 */
create table if not exists public.rate_limit_state (
  bucket text not null check (bucket ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  locked_until timestamptz,
  primary key (bucket, subject_digest)
);

alter table public.rate_limit_state enable row level security;
revoke all on public.rate_limit_state from public, anon, authenticated;
grant all privileges on public.rate_limit_state to service_role;

/**
 * Counts one attempt against a limit and reports the outcome as 'allowed',
 * 'limited', or 'locked'. Passing a lock duration turns the limit into a
 * lockout that outlives its window, which is what repeated Recovery Code
 * failures need. The row is taken for update first so two concurrent attempts
 * cannot both read the same remaining allowance.
 */
create or replace function public.consume_rate_limit(
  target_bucket text,
  target_subject text,
  max_attempts integer,
  target_window interval,
  lock_duration interval default null,
  target_workspace_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  digest_value text := encode(
    extensions.digest(target_bucket || '|' || target_subject, 'sha256'),
    'hex'
  );
  state public.rate_limit_state;
  outcome text;
begin
  if max_attempts < 1 then
    raise exception 'A rate limit must allow at least one attempt';
  end if;

  insert into public.rate_limit_state (bucket, subject_digest)
  values (target_bucket, digest_value)
  on conflict (bucket, subject_digest) do nothing;

  select * into state
  from public.rate_limit_state
  where bucket = target_bucket
    and subject_digest = digest_value
  for update;

  if state.locked_until is not null and state.locked_until > now() then
    return 'locked';
  end if;

  if state.window_started_at + target_window <= now()
    or (state.locked_until is not null and state.locked_until <= now())
  then
    state.window_started_at := now();
    state.attempts := 0;
    state.locked_until := null;
  end if;

  state.attempts := state.attempts + 1;
  if state.attempts > max_attempts then
    outcome := case when lock_duration is null then 'limited' else 'locked' end;
    if lock_duration is not null then
      state.locked_until := now() + lock_duration;
    end if;
  else
    outcome := 'allowed';
  end if;

  update public.rate_limit_state
  set window_started_at = state.window_started_at,
      attempts = state.attempts,
      locked_until = state.locked_until,
      max_attempts = consume_rate_limit.max_attempts
  where bucket = target_bucket
    and subject_digest = digest_value;

  -- Evidence names the limit that closed, never who tripped it.
  if outcome <> 'allowed' and target_workspace_id is not null then
    perform public.record_audit_event(
      target_workspace_id,
      auth.uid(),
      'security.rate_limit.exceeded',
      'rate_limit',
      target_bucket,
      jsonb_build_object('outcome', outcome, 'window_seconds',
        extract(epoch from target_window)::bigint)
    );
  end if;
  return outcome;
end;
$$;

create or replace function public.rate_limit_locked_until(
  target_bucket text,
  target_subject text
)
returns timestamptz
language sql
stable
security definer
set search_path = public, extensions
as $$
  select locked_until
  from public.rate_limit_state
  where bucket = target_bucket
    and subject_digest = encode(
      extensions.digest(target_bucket || '|' || target_subject, 'sha256'),
      'hex'
    )
    and locked_until > now();
$$;

revoke all on function public.consume_rate_limit(
  text, text, integer, interval, interval, uuid
) from public, anon, authenticated;
revoke all on function public.rate_limit_locked_until(text, text)
  from public, anon, authenticated;
grant execute on function public.consume_rate_limit(
  text, text, integer, interval, interval, uuid
) to service_role;
grant execute on function public.rate_limit_locked_until(text, text)
  to service_role;
