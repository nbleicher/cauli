-- Every Workspace carries exactly one bounded Retention Policy. Because the
-- policy is a column on the Workspace rather than a row a Call can point at,
-- there is no per-Call exception and no retain-forever value to configure.
--
-- A Call's scheduled deletion is calculated from the policy instead of being
-- stored on the Call, so changing the policy moves every eligible schedule at
-- once and no Call can carry a stale date.

alter table public.workspaces
  add column if not exists retention_days integer not null default 90;

alter table public.workspaces
  add constraint workspaces_retention_days_allowed
    check (retention_days in (30, 60, 90, 180, 365));

create or replace function public.scheduled_deletion_at(
  target_started_at timestamptz,
  target_retention_days integer
)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select target_started_at + make_interval(days => target_retention_days);
$$;

-- security_invoker keeps the caller's own policies in force, so a Member Role
-- sees the schedule for their own Calls, a Manager or Admin sees the
-- Workspace's, and neither sees another Workspace's.
create or replace view public.call_retention_schedule
with (security_invoker = true) as
select
  call.id as call_id,
  call.workspace_id,
  call.owner_id,
  call.started_at,
  workspace.retention_days,
  public.scheduled_deletion_at(call.started_at, workspace.retention_days)
    as scheduled_deletion_at
from public.calls call
join public.workspaces workspace on workspace.id = call.workspace_id
where call.deleted_at is null;

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

-- The Workspace row is readable by its own Workspace Members and writable only
-- through the Admin command above.
revoke insert, update, delete on table public.workspaces from authenticated;

revoke all on function public.scheduled_deletion_at(timestamptz, integer)
  from public, anon;
grant execute on function public.scheduled_deletion_at(timestamptz, integer)
  to authenticated, service_role;

revoke all on public.call_retention_schedule from public, anon;
grant select on public.call_retention_schedule to authenticated, service_role;

revoke all on function public.set_workspace_retention_days_for_current_admin(
  integer
) from public, anon;
grant execute on function public.set_workspace_retention_days_for_current_admin(
  integer
) to authenticated;
