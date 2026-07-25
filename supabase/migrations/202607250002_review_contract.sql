alter table public.call_reviews
  add column follow_up text not null default '';

alter table public.review_revisions
  add column follow_up text not null default '';

drop policy reviews_select on public.call_reviews;
drop policy answers_select on public.call_review_answers;
drop policy revisions_select on public.review_revisions;

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
    where review.id = target_review_id
      and call.deleted_at is null
      and (
        member.role in ('manager', 'admin')
        or (call.owner_id = auth.uid() and review.status <> 'in_progress')
      )
  );
$$;

create policy reviews_select on public.call_reviews for select
using (public.can_view_review(id));

create policy answers_select on public.call_review_answers for select
using (public.can_view_review(review_id));

create policy revisions_select on public.review_revisions for select
using (
  exists (
    select 1
    from public.call_reviews review
    join public.calls call on call.id = review.call_id
    join public.workspace_members member
      on member.workspace_id = call.workspace_id
     and member.user_id = auth.uid()
    where review.id = review_id
      and call.deleted_at is null
      and (
        member.role in ('manager', 'admin')
        or (
          call.owner_id = auth.uid()
          and review_revisions.status <> 'in_progress'
        )
      )
  )
);

drop function public.submit_call_review(
  uuid, uuid, integer, public.review_status, text, jsonb
);

create function public.submit_call_review(
  target_call_id uuid,
  target_scorecard_version_id uuid,
  expected_version integer,
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
  calculated_score numeric(5, 2);
begin
  if not public.can_review_call(target_call_id) then
    raise exception 'Not authorized to review this call';
  end if;

  if target_status = 'unreviewed' then
    raise exception 'A submitted review cannot be unreviewed';
  end if;
  if target_status <> 'in_progress'
    and char_length(trim(coalesce(target_summary, ''))) = 0 then
    raise exception 'Submitted Reviews require a summary';
  end if;
  if target_status = 'needs_follow_up'
    and char_length(trim(coalesce(target_follow_up, ''))) = 0 then
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
    raise exception 'Scorecard version does not belong to the call workspace';
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
    case when item -> 'value' = 'null'::jsonb then null else (item ->> 'value')::smallint end,
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
  uuid, uuid, integer, public.review_status, text, text, jsonb
) from public, anon;
grant execute on function public.submit_call_review(
  uuid, uuid, integer, public.review_status, text, text, jsonb
) to authenticated;
