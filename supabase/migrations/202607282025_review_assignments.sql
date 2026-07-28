-- Ticket #25: atomic Review claiming, individual assignment, and filtered
-- bulk assignment with ownership-aware optimistic concurrency.

create table public.call_review_assignments (
  call_id uuid primary key references public.calls(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  assignee_id uuid not null references public.profiles(id),
  version integer not null default 1 check (version > 0),
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index call_review_assignments_workspace_assignee
  on public.call_review_assignments (workspace_id, assignee_id, updated_at desc);

alter table public.call_review_assignments enable row level security;

create policy call_review_assignments_select
on public.call_review_assignments for select
using (public.can_view_call(call_id));

revoke insert, update, delete
  on public.call_review_assignments
  from public, anon, authenticated;
grant select on public.call_review_assignments to authenticated, service_role;
grant all privileges on public.call_review_assignments to service_role;

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
    left join public.call_review_assignments assignment
      on assignment.call_id = call.id
    where call.id = target_call_id
      and call.deleted_at is null
      and public.current_user_role(call.workspace_id) = member.role
      and (
        member.role = 'admin'
        or (
          member.role = 'manager'
          and assignment.assignee_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.claim_review(
  target_call_id uuid
)
returns public.call_review_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  assignment_record public.call_review_assignments;
  actor_role public.app_role;
begin
  select call.* into call_record
  from public.calls call
  where call.id = target_call_id
    and call.deleted_at is null
  for update;

  if call_record.id is null then
    raise exception 'Reviewable Call not found';
  end if;

  actor_role := public.current_user_role(call_record.workspace_id);
  if actor_role not in ('manager', 'admin') then
    raise exception 'Manager or Admin access is required';
  end if;

  begin
    insert into public.call_review_assignments (
      call_id, workspace_id, assignee_id, assigned_by
    ) values (
      call_record.id, call_record.workspace_id, auth.uid(), auth.uid()
    )
    returning * into assignment_record;
  exception
    when unique_violation then
      raise exception 'Review is already assigned';
  end;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    'review.claimed',
    'call',
    call_record.id::text,
    jsonb_build_object(
      'assignee_id', auth.uid(),
      'assignment_version', assignment_record.version
    )
  );

  return assignment_record;
end;
$$;

create or replace function public.assign_review(
  target_call_id uuid,
  target_assignee_id uuid,
  expected_assignment_version integer
)
returns public.call_review_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  assignment_record public.call_review_assignments;
  previous_assignee_id uuid;
  action_name text;
begin
  select call.* into call_record
  from public.calls call
  where call.id = target_call_id
    and call.deleted_at is null
  for update;

  if call_record.id is null
    or public.current_user_role(call_record.workspace_id) <> 'admin'
  then
    raise exception 'Workspace Admin access is required';
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = call_record.workspace_id
      and member.user_id = target_assignee_id
      and member.status = 'active'
      and member.role in ('manager', 'admin')
  ) then
    raise exception 'Review Assignee must be an active Manager or Admin in the Workspace';
  end if;

  select assignment.* into assignment_record
  from public.call_review_assignments assignment
  where assignment.call_id = target_call_id
  for update;

  if assignment_record.call_id is null then
    if expected_assignment_version <> 0 then
      raise exception 'Review assignment version conflict';
    end if;

    insert into public.call_review_assignments (
      call_id, workspace_id, assignee_id, assigned_by
    ) values (
      call_record.id,
      call_record.workspace_id,
      target_assignee_id,
      auth.uid()
    )
    returning * into assignment_record;
    action_name := 'review.assigned';
  else
    if assignment_record.version <> expected_assignment_version then
      raise exception 'Review assignment version conflict';
    end if;

    previous_assignee_id := assignment_record.assignee_id;
    update public.call_review_assignments
    set assignee_id = target_assignee_id,
        assigned_by = auth.uid(),
        assigned_at = now(),
        updated_at = now(),
        version = version + 1
    where call_id = target_call_id
    returning * into assignment_record;
    action_name := case
      when previous_assignee_id = target_assignee_id then 'review.assigned'
      else 'review.reassigned'
    end;
  end if;

  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    action_name,
    'call',
    call_record.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'assignee_id', target_assignee_id,
      'previous_assignee_id', previous_assignee_id,
      'assignment_version', assignment_record.version
    ))
  );

  return assignment_record;
end;
$$;

create or replace function public.bulk_assign_unassigned_reviews(
  target_call_ids uuid[],
  target_assignee_id uuid
)
returns table (call_id uuid, assignment_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  requested_count integer;
  matched_count integer;
  bulk_operation_id uuid := gen_random_uuid();
  assigned_record record;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null
    or public.current_user_role(actor_workspace_id) <> 'admin'
  then
    raise exception 'Workspace Admin access is required';
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = actor_workspace_id
      and member.user_id = target_assignee_id
      and member.status = 'active'
      and member.role in ('manager', 'admin')
  ) then
    raise exception 'Review Assignee must be an active Manager or Admin in the Workspace';
  end if;

  select count(distinct requested_id)
  into requested_count
  from unnest(target_call_ids) requested_id;

  if requested_count < 1 or requested_count > 250 then
    raise exception 'Bulk Review assignment requires between 1 and 250 Calls';
  end if;

  select count(*) into matched_count
  from public.calls call
  where call.id = any(target_call_ids)
    and call.workspace_id = actor_workspace_id
    and call.deleted_at is null;

  if matched_count <> requested_count then
    raise exception 'Every selected Call must belong to the Admin Workspace';
  end if;

  for assigned_record in
    insert into public.call_review_assignments (
      call_id, workspace_id, assignee_id, assigned_by
    )
    select
      call.id,
      call.workspace_id,
      target_assignee_id,
      auth.uid()
    from public.calls call
    where call.id = any(target_call_ids)
      and call.workspace_id = actor_workspace_id
      and call.deleted_at is null
    on conflict on constraint call_review_assignments_pkey do nothing
    returning call_review_assignments.call_id,
      call_review_assignments.version
  loop
    perform public.record_audit_event(
      actor_workspace_id,
      auth.uid(),
      'review.bulk_assigned',
      'call',
      assigned_record.call_id::text,
      jsonb_build_object(
        'assignee_id', target_assignee_id,
        'assignment_version', assigned_record.version,
        'bulk_operation_id', bulk_operation_id
      )
    );
    call_id := assigned_record.call_id;
    assignment_version := assigned_record.version;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_review(uuid) from public, anon;
revoke all on function public.assign_review(uuid, uuid, integer)
  from public, anon;
revoke all on function public.bulk_assign_unassigned_reviews(uuid[], uuid)
  from public, anon;
grant execute on function public.claim_review(uuid) to authenticated;
grant execute on function public.assign_review(uuid, uuid, integer)
  to authenticated;
grant execute on function public.bulk_assign_unassigned_reviews(uuid[], uuid)
  to authenticated;

revoke all on function public.submit_call_review(
  uuid, uuid, integer, public.review_status, text, text, jsonb
) from public, anon, authenticated;

create function public.submit_call_review(
  target_call_id uuid,
  target_scorecard_version_id uuid,
  expected_version integer,
  expected_assignment_version integer,
  target_status public.review_status,
  target_summary text,
  target_follow_up text,
  target_answers jsonb
)
returns public.call_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  review_record public.call_reviews;
  assignment_record public.call_review_assignments;
  actor_role public.app_role;
  calculated_score numeric(5, 2);
begin
  select assignment.* into assignment_record
  from public.call_review_assignments assignment
  where assignment.call_id = target_call_id
  for update;

  if coalesce(assignment_record.version, 0) <> expected_assignment_version then
    raise exception 'Review assignment version conflict';
  end if;

  select public.current_user_role(call.workspace_id) into actor_role
  from public.calls call
  where call.id = target_call_id
    and call.deleted_at is null;

  if actor_role is null
    or (
      actor_role <> 'admin'
      and (
        actor_role <> 'manager'
        or assignment_record.assignee_id <> auth.uid()
      )
    )
  then
    raise exception 'Only the Review Assignee or an Admin can edit this Review';
  end if;

  if target_status = 'unreviewed' then
    raise exception 'A submitted Review cannot be unreviewed';
  end if;
  if target_status <> 'in_progress'
    and char_length(trim(coalesce(target_summary, ''))) = 0
  then
    raise exception 'Submitted Reviews require a summary';
  end if;
  if target_status = 'needs_follow_up'
    and char_length(trim(coalesce(target_follow_up, ''))) = 0
  then
    raise exception 'Needs Follow-up requires an explanation';
  end if;

  if not exists (
    select 1
    from public.calls call
    join public.scorecard_templates template
      on template.workspace_id = call.workspace_id
    join public.scorecard_versions version
      on version.template_id = template.id
    where call.id = target_call_id
      and version.id = target_scorecard_version_id
  ) then
    raise exception 'Scorecard Version does not belong to the Call Workspace';
  end if;

  select * into review_record
  from public.call_reviews
  where call_id = target_call_id
  for update;

  if review_record.id is null then
    if expected_version <> 0 then
      raise exception 'Review version conflict';
    end if;
    insert into public.call_reviews (
      call_id, scorecard_version_id, status, summary, follow_up, updated_by, version
    ) values (
      target_call_id, target_scorecard_version_id, target_status,
      coalesce(target_summary, ''), coalesce(target_follow_up, ''), auth.uid(), 1
    )
    returning * into review_record;
  else
    if review_record.version <> expected_version then
      raise exception 'Review version conflict';
    end if;
    if review_record.scorecard_version_id <> target_scorecard_version_id then
      raise exception 'A Review cannot change Scorecard Version';
    end if;
    update public.call_reviews
    set status = target_status,
        summary = coalesce(target_summary, ''),
        follow_up = coalesce(target_follow_up, ''),
        updated_by = auth.uid(),
        version = version + 1
    where id = review_record.id
    returning * into review_record;
  end if;

  delete from public.call_review_answers where review_id = review_record.id;

  insert into public.call_review_answers (review_id, criterion_id, value, comment)
  select
    review_record.id,
    (item ->> 'criterionId')::uuid,
    case
      when item -> 'value' = 'null'::jsonb then null
      else (item ->> 'value')::smallint
    end,
    coalesce(item ->> 'comment', '')
  from jsonb_array_elements(target_answers) item
  join public.scorecard_criteria criterion
    on criterion.id = (item ->> 'criterionId')::uuid
  join public.scorecard_categories category
    on category.id = criterion.category_id
  where category.version_id = target_scorecard_version_id;

  if target_status <> 'in_progress' and exists (
    select 1
    from public.scorecard_criteria criterion
    join public.scorecard_categories category
      on category.id = criterion.category_id
    left join public.call_review_answers answer
      on answer.review_id = review_record.id
     and answer.criterion_id = criterion.id
    where category.version_id = target_scorecard_version_id
      and criterion.required
      and answer.value is null
  ) then
    raise exception 'Required criteria must have a score from 1 to 5';
  end if;

  select round(
    100 * sum((((answer.value - 1)::numeric / 4) * criterion.weight))
      / nullif(sum(criterion.weight), 0),
    2
  )
  into calculated_score
  from public.call_review_answers answer
  join public.scorecard_criteria criterion on criterion.id = answer.criterion_id
  where answer.review_id = review_record.id
    and answer.value is not null;

  update public.call_reviews
  set score = calculated_score
  where id = review_record.id
  returning * into review_record;

  update public.calls
  set review_status = case
    when target_status = 'in_progress' then 'unreviewed'::public.review_status
    else target_status
  end
  where id = target_call_id;

  insert into public.review_revisions (
    review_id, revision, status, score, summary, follow_up, answers, submitted_by
  ) values (
    review_record.id,
    review_record.version,
    review_record.status,
    review_record.score,
    review_record.summary,
    review_record.follow_up,
    target_answers,
    auth.uid()
  );

  return review_record;
end;
$$;

revoke all on function public.submit_call_review(
  uuid, uuid, integer, integer, public.review_status, text, text, jsonb
) from public, anon;
grant execute on function public.submit_call_review(
  uuid, uuid, integer, integer, public.review_status, text, text, jsonb
) to authenticated;
