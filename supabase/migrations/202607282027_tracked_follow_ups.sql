-- Ticket #27: dated, owned Follow-ups with resolution and verified closure.

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique
    references public.call_reviews(id) on delete cascade,
  call_id uuid not null unique
    references public.calls(id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  description text not null check (char_length(description) between 1 and 10000),
  due_date date not null,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'verified')),
  version integer not null default 1 check (version > 0),
  created_from_revision integer not null check (created_from_revision > 0),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'open'
      and resolved_by is null and resolved_at is null
      and verified_by is null and verified_at is null)
    or
    (status = 'resolved'
      and resolved_by is not null and resolved_at is not null
      and verified_by is null and verified_at is null)
    or
    (status = 'verified'
      and resolved_by is not null and resolved_at is not null
      and verified_by is not null and verified_at is not null)
  )
);

create index follow_ups_workspace_due_open
  on public.follow_ups (workspace_id, due_date, updated_at)
  where status <> 'verified';
create index follow_ups_owner_due_open
  on public.follow_ups (owner_id, due_date, updated_at)
  where status <> 'verified';

alter table public.follow_ups enable row level security;

create policy follow_ups_select
on public.follow_ups for select
using (
  owner_id = auth.uid()
  or public.current_user_role(workspace_id) = 'admin'
  or exists (
    select 1
    from public.call_review_assignments assignment
    where assignment.call_id = follow_ups.call_id
      and assignment.assignee_id = auth.uid()
  )
);

revoke insert, update, delete on public.follow_ups
  from public, anon, authenticated, service_role;
grant select on public.follow_ups to authenticated, service_role;

create or replace function public.follow_up_display_status(
  stored_status text,
  target_due_date date,
  as_of_date date default current_date
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when stored_status = 'open' and target_due_date < as_of_date then 'overdue'
    when stored_status = 'resolved' then 'awaiting_verification'
    else stored_status
  end;
$$;

create or replace function public.submit_call_review_with_follow_up(
  target_call_id uuid,
  target_scorecard_version_id uuid,
  expected_version integer,
  expected_assignment_version integer,
  target_status public.review_status,
  target_summary text,
  target_follow_up text,
  target_follow_up_due_date date,
  target_answers jsonb
)
returns public.call_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  review_record public.call_reviews;
  call_record public.calls;
  follow_up_record public.follow_ups;
  effective_due_date date;
  audit_action text;
begin
  if target_status = 'needs_follow_up' then
    effective_due_date := coalesce(
      target_follow_up_due_date,
      current_date + 7
    );
    if effective_due_date < current_date then
      raise exception 'Follow-up due date cannot be in the past';
    end if;
  elsif target_follow_up_due_date is not null then
    raise exception 'Only Needs Follow-up Reviews may set a Follow-up due date';
  end if;

  review_record := public.submit_call_review(
    target_call_id,
    target_scorecard_version_id,
    expected_version,
    expected_assignment_version,
    target_status,
    target_summary,
    target_follow_up,
    target_answers
  );

  if target_status <> 'needs_follow_up' then
    return review_record;
  end if;

  select call.* into call_record
  from public.calls call
  where call.id = target_call_id;

  select follow_up.* into follow_up_record
  from public.follow_ups follow_up
  where follow_up.review_id = review_record.id
  for update;

  if follow_up_record.id is null then
    insert into public.follow_ups (
      review_id,
      call_id,
      workspace_id,
      owner_id,
      description,
      due_date,
      created_from_revision
    ) values (
      review_record.id,
      call_record.id,
      call_record.workspace_id,
      call_record.owner_id,
      trim(target_follow_up),
      effective_due_date,
      review_record.version
    )
    returning * into follow_up_record;
    audit_action := 'follow_up.created';
  else
    audit_action := case follow_up_record.status
      when 'open' then 'follow_up.updated'
      else 'follow_up.reopened'
    end;
    update public.follow_ups
    set description = trim(target_follow_up),
        due_date = effective_due_date,
        status = 'open',
        created_from_revision = review_record.version,
        resolved_by = null,
        resolved_at = null,
        verified_by = null,
        verified_at = null,
        version = version + 1,
        updated_at = now()
    where id = follow_up_record.id
    returning * into follow_up_record;
  end if;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    audit_action,
    'follow_up',
    follow_up_record.id::text,
    jsonb_build_object(
      'call_id', call_record.id,
      'owner_id', call_record.owner_id,
      'due_date', follow_up_record.due_date,
      'state', follow_up_record.status,
      'version', follow_up_record.version
    )
  );

  return review_record;
end;
$$;

revoke all on function public.submit_call_review(
  uuid, uuid, integer, integer, public.review_status, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.submit_call_review_with_follow_up(
  uuid, uuid, integer, integer, public.review_status, text, text, date, jsonb
) from public, anon;
grant execute on function public.submit_call_review_with_follow_up(
  uuid, uuid, integer, integer, public.review_status, text, text, date, jsonb
) to authenticated;

create or replace function public.resolve_follow_up(
  target_follow_up_id uuid,
  expected_version integer
)
returns public.follow_ups
language plpgsql
security definer
set search_path = public
as $$
declare
  follow_up_record public.follow_ups;
begin
  select * into follow_up_record
  from public.follow_ups
  where id = target_follow_up_id
  for update;

  if follow_up_record.id is null
    or follow_up_record.owner_id <> auth.uid()
    or public.current_user_role(follow_up_record.workspace_id) is null
  then
    raise exception 'Only the Follow-up owner can resolve it';
  end if;
  if follow_up_record.version <> expected_version then
    raise exception 'Follow-up version conflict';
  end if;
  if follow_up_record.status <> 'open' then
    raise exception 'Only an open Follow-up can be resolved';
  end if;

  update public.follow_ups
  set status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where id = target_follow_up_id
  returning * into follow_up_record;

  perform public.record_audit_event(
    follow_up_record.workspace_id,
    auth.uid(),
    'follow_up.resolved',
    'follow_up',
    follow_up_record.id::text,
    jsonb_build_object(
      'call_id', follow_up_record.call_id,
      'state', follow_up_record.status,
      'version', follow_up_record.version
    )
  );

  return follow_up_record;
end;
$$;

create or replace function public.verify_follow_up(
  target_follow_up_id uuid,
  expected_version integer
)
returns public.follow_ups
language plpgsql
security definer
set search_path = public
as $$
declare
  follow_up_record public.follow_ups;
  actor_role public.app_role;
begin
  select * into follow_up_record
  from public.follow_ups
  where id = target_follow_up_id
  for update;

  if follow_up_record.id is null then
    raise exception 'Follow-up not found';
  end if;

  actor_role := public.current_user_role(follow_up_record.workspace_id);
  if actor_role <> 'admin'
    and not exists (
      select 1
      from public.call_review_assignments assignment
      where assignment.call_id = follow_up_record.call_id
        and assignment.assignee_id = auth.uid()
    )
  then
    raise exception 'Only the Review Assignee or an Admin can verify closure';
  end if;
  if follow_up_record.version <> expected_version then
    raise exception 'Follow-up version conflict';
  end if;
  if follow_up_record.status <> 'resolved' then
    raise exception 'Only a resolved Follow-up can be verified';
  end if;

  update public.follow_ups
  set status = 'verified',
      verified_by = auth.uid(),
      verified_at = now(),
      version = version + 1,
      updated_at = now()
  where id = target_follow_up_id
  returning * into follow_up_record;

  perform public.record_audit_event(
    follow_up_record.workspace_id,
    auth.uid(),
    'follow_up.verified',
    'follow_up',
    follow_up_record.id::text,
    jsonb_build_object(
      'call_id', follow_up_record.call_id,
      'state', follow_up_record.status,
      'version', follow_up_record.version
    )
  );

  return follow_up_record;
end;
$$;

revoke all on function public.resolve_follow_up(uuid, integer)
  from public, anon;
revoke all on function public.verify_follow_up(uuid, integer)
  from public, anon;
grant execute on function public.resolve_follow_up(uuid, integer)
  to authenticated;
grant execute on function public.verify_follow_up(uuid, integer)
  to authenticated;

create or replace function public.follow_up_queue(
  as_of_date date default current_date
)
returns table (
  id uuid,
  call_id uuid,
  call_title text,
  owner_id uuid,
  owner_name text,
  review_assignee_id uuid,
  review_assignee_name text,
  description text,
  due_date date,
  stored_status text,
  display_status text,
  version integer,
  can_resolve boolean,
  can_verify boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    follow_up.id,
    follow_up.call_id,
    call.title,
    follow_up.owner_id,
    coalesce(nullif(owner.display_name, ''), owner.email, 'Unknown'),
    assignment.assignee_id,
    coalesce(nullif(assignee.display_name, ''), assignee.email, 'Unassigned'),
    follow_up.description,
    follow_up.due_date,
    follow_up.status,
    public.follow_up_display_status(
      follow_up.status,
      follow_up.due_date,
      as_of_date
    ),
    follow_up.version,
    follow_up.owner_id = auth.uid() and follow_up.status = 'open',
    (
      public.current_user_role(follow_up.workspace_id) = 'admin'
      or assignment.assignee_id = auth.uid()
    ) and follow_up.status = 'resolved'
  from public.follow_ups follow_up
  join public.calls call on call.id = follow_up.call_id
  join public.workspace_members member
    on member.workspace_id = follow_up.workspace_id
   and member.user_id = auth.uid()
   and member.status = 'active'
  left join public.call_review_assignments assignment
    on assignment.call_id = follow_up.call_id
  left join public.profiles owner on owner.id = follow_up.owner_id
  left join public.profiles assignee on assignee.id = assignment.assignee_id
  where follow_up.status <> 'verified'
    and public.current_user_role(follow_up.workspace_id) = member.role
    and (
      follow_up.owner_id = auth.uid()
      or member.role = 'admin'
      or assignment.assignee_id = auth.uid()
    )
  order by
    case public.follow_up_display_status(
      follow_up.status,
      follow_up.due_date,
      as_of_date
    )
      when 'overdue' then 0
      when 'open' then 1
      else 2
    end,
    follow_up.due_date,
    follow_up.updated_at;
$$;

revoke all on function public.follow_up_queue(date) from public, anon;
grant execute on function public.follow_up_queue(date) to authenticated;
