-- A Retention Policy cannot reach back before it existed.
--
-- Giving every Workspace a mandatory 90-day policy made every Call recorded
-- more than 90 days ago instantly eligible for deletion, so the first worker to
-- run the expiry sweep would have destroyed years of recordings that were made
-- under no policy at all and that nobody agreed to give up. A Retention Policy
-- is a rule going forward, not a verdict on the past.
--
-- Nothing is now deleted sooner than one full retention period after the policy
-- began, so every Workspace gets its whole window from the day the rule started.
-- For a Call recorded after that day — which is every Call from here on — this
-- changes nothing at all.

alter table public.workspaces
  add column if not exists retention_effective_from timestamptz
  not null default now();

create or replace view public.call_retention_schedule
with (security_invoker = true) as
select
  call.id as call_id,
  call.workspace_id,
  call.owner_id,
  call.started_at,
  workspace.retention_days,
  public.scheduled_deletion_at(
    greatest(call.started_at, workspace.retention_effective_from),
    workspace.retention_days
  ) as scheduled_deletion_at,
  workspace.retention_effective_from
from public.calls call
join public.workspaces workspace on workspace.id = call.workspace_id
where call.deleted_at is null;

-- Scoping the sweep to one Workspace keeps a Platform Admin's action, and a
-- test's, from reaching every other Workspace in the database.
create or replace function public.expire_calls_for_retention(
  batch_size integer,
  target_workspace_id uuid
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
      and (
        target_workspace_id is null
        or call.workspace_id = target_workspace_id
      )
      and public.scheduled_deletion_at(
        greatest(call.started_at, workspace.retention_effective_from),
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

-- The single-argument form stays, so nothing that already calls it breaks. It
-- takes no default of its own beyond the batch size, which keeps the two forms
-- unambiguous.
create or replace function public.expire_calls_for_retention(
  batch_size integer default 100
)
returns bigint
language sql
security definer
set search_path = public
as $$
  select public.expire_calls_for_retention(batch_size, null::uuid);
$$;

-- One Workspace per person is enforced by a unique index today, but a bare
-- SELECT INTO would silently pick an arbitrary row if that ever changed, and
-- moving the wrong Workspace's Retention Policy is not a failure anyone would
-- notice from the screen that appeared to succeed.
create or replace function public.set_workspace_retention_days_for_current_admin(
  target_retention_days integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  workspace_record public.workspaces;
  previous_days integer;
begin
  if target_retention_days is null
    or target_retention_days not in (30, 60, 90, 180, 365)
  then
    raise exception
      'A Retention Policy must be 30, 60, 90, 180, or 365 days';
  end if;

  select workspace.*
  into workspace_record
  from public.workspaces workspace
  join public.workspace_members member
    on member.workspace_id = workspace.id
   and member.user_id = auth.uid()
   and member.status = 'active'
  where public.current_user_role(workspace.id) = 'admin'
  order by workspace.id
  limit 1
  for update of workspace;

  if workspace_record.id is null then
    raise exception 'Only an Admin can change the Retention Policy';
  end if;

  previous_days := workspace_record.retention_days;
  if previous_days = target_retention_days then
    return previous_days;
  end if;

  update public.workspaces
  set retention_days = target_retention_days
  where id = workspace_record.id;

  perform public.record_audit_event(
    workspace_record.id,
    auth.uid(),
    'workspace.retention.changed',
    'workspace',
    workspace_record.id::text,
    jsonb_build_object(
      'previous_days', previous_days,
      'retention_days', target_retention_days
    )
  );

  return target_retention_days;
end;
$$;

-- How much authorized backup deletion is outstanding. A deletion the
-- application promised and the retention principal has not carried out is a
-- copy still sitting on the VPS, so it needs to be visible rather than implied.
create or replace function public.backup_deletion_backlog()
returns table (outstanding bigint, oldest_seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    coalesce(
      max(floor(extract(epoch from (now() - requested_at)))::bigint), 0
    )
  from public.backup_deletion_requests
  where deleted_at is null;
$$;

revoke all on function public.expire_calls_for_retention(integer, uuid)
  from public, anon, authenticated, cauli_retention, cauli_peely;
grant execute on function public.expire_calls_for_retention(integer, uuid)
  to service_role;

revoke all on function public.backup_deletion_backlog()
  from public, anon, authenticated, cauli_retention, cauli_peely;
grant execute on function public.backup_deletion_backlog() to service_role;
