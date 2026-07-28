-- Review follow-up from the #24-#27 integration review: keep direct table
-- reads on the same active-session boundary as the RPCs, and record the
-- actual Follow-up state produced by a Needs Follow-up submission.

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
      and public.current_user_role(call.workspace_id) = member.role
      and (
        member.role in ('manager', 'admin')
        or (call.owner_id = auth.uid() and review.status <> 'in_progress')
      )
  );
$$;

drop policy if exists revisions_select on public.review_revisions;
create policy revisions_select
on public.review_revisions for select
using (
  exists (
    select 1
    from public.call_reviews review
    join public.calls call on call.id = review.call_id
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
     and member.status = 'active'
    where review.id = review_revisions.review_id
      and call.deleted_at is null
      and public.current_user_role(call.workspace_id) = member.role
      and (
        member.role in ('manager', 'admin')
        or (
          member.role = 'member'
          and call.owner_id = auth.uid()
          and review_revisions.status <> 'in_progress'
        )
      )
  )
);

drop policy if exists follow_ups_select on public.follow_ups;
create policy follow_ups_select
on public.follow_ups for select
using (
  exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = follow_ups.workspace_id
      and member.user_id = auth.uid()
      and member.status = 'active'
      and public.current_user_role(follow_ups.workspace_id) = member.role
      and (
        follow_ups.owner_id = auth.uid()
        or member.role = 'admin'
        or exists (
          select 1
          from public.call_review_assignments assignment
          where assignment.call_id = follow_ups.call_id
            and assignment.assignee_id = auth.uid()
        )
      )
  )
);

create or replace function public.snapshot_review_revision_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  review_record public.call_reviews;
begin
  select * into review_record
  from public.call_reviews
  where id = new.review_id;

  if review_record.id is null
    or new.revision <> review_record.version
    or new.status <> review_record.status
    or new.score is distinct from review_record.score
    or new.summary <> review_record.summary
    or new.follow_up <> review_record.follow_up
    or new.submitted_by <> review_record.updated_by
  then
    raise exception 'Review Revision must snapshot the current Review';
  end if;

  new.scorecard_version_id := review_record.scorecard_version_id;
  new.follow_up_state := case
    when review_record.status = 'needs_follow_up' then 'open'
    else 'not_required'
  end;
  return new;
end;
$$;
