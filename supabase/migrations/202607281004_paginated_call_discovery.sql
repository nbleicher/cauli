/**
 * Finding a Call without reading every Call.
 *
 * The list was a fixed 250-row window, which is two failures at once: it goes
 * slower as a Workspace grows, and it silently stops showing Calls once it
 * fills. This replaces it with keyset pagination — a cursor on the same
 * (started_at, id) pair the list is ordered by — so a page costs the same on
 * the thousandth Call as on the first, and so Calls added or deleted between
 * two page requests can neither duplicate a row nor skip one. Offsets cannot
 * promise that; a row inserted above page two shifts everything under it.
 *
 * Search is deliberately narrow. A Transcript is the most sensitive text
 * Cauli holds, and making it searchable would put it in an index, in query
 * plans, and in every log line that ever carries a parameter. Title and owner
 * are enough to find a Call, so those are all that is matched.
 *
 * The function is security invoker on purpose: the caller's own row-level
 * policy decides which Calls exist, so a Member's page, a Manager's page, and
 * a cross-Workspace request are all answered by the same code with no branch
 * that could get the boundary wrong.
 */

-- Assignment and Follow-up resolution are owned by #25 and #27; these columns
-- exist now so the filters that name them actually filter rather than quietly
-- doing nothing.
alter table public.call_reviews
  add column if not exists assignee_id uuid
    references public.profiles(id) on delete set null,
  add column if not exists follow_up_resolved_at timestamptz;

comment on column public.call_reviews.assignee_id is
  'Review Assignee. The assignment workflow itself belongs to #25.';
comment on column public.call_reviews.follow_up_resolved_at is
  'When a Needs Follow-up outcome was resolved. The workflow belongs to #27.';

-- The cursor's exact sort order, so a page is an index scan rather than a sort.
create index if not exists calls_workspace_cursor_idx
  on public.calls (workspace_id, started_at desc, id desc)
  where deleted_at is null;
create index if not exists calls_owner_cursor_idx
  on public.calls (owner_id, started_at desc, id desc)
  where deleted_at is null;
create index if not exists call_reviews_assignee_idx
  on public.call_reviews (assignee_id)
  where assignee_id is not null;

create or replace function public.call_page_size()
returns integer
language sql
immutable
as $$
  select 50;
$$;

/**
 * One page of Calls, newest first.
 *
 * Returns at most one row more than the page size. That extra row is the
 * answer to "is there another page", and the caller drops it — asking the
 * database to count the remainder would put the cost back that keyset
 * pagination just removed.
 *
 * A null filter means "no opinion". `target_unassigned` is separate from
 * `target_assignee_id` because "nobody" is a real answer and a null argument
 * cannot express it.
 */
create or replace function public.list_calls_page(
  target_owner_id uuid default null,
  target_from timestamptz default null,
  target_to timestamptz default null,
  target_statuses public.call_status[] default null,
  target_review_statuses public.review_status[] default null,
  target_quality text default null,
  target_assignee_id uuid default null,
  target_unassigned boolean default false,
  target_follow_up text default null,
  target_search text default null,
  cursor_started_at timestamptz default null,
  cursor_id uuid default null
)
returns table (
  id uuid,
  title text,
  source_mode public.source_mode,
  status public.call_status,
  review_status public.review_status,
  started_at timestamptz,
  duration_ms bigint,
  degraded boolean,
  owner_id uuid,
  owner_name text,
  assignee_name text
)
language plpgsql
stable
set search_path = public
as $$
declare
  clean_search text := nullif(btrim(coalesce(target_search, '')), '');
begin
  if char_length(coalesce(clean_search, '')) > 120 then
    raise exception 'Search text must be 120 characters or fewer'
      using errcode = '22001';
  end if;

  if target_quality is not null
    and target_quality not in ('complete', 'degraded') then
    raise exception 'Quality outcome must be complete or degraded'
      using errcode = '22023';
  end if;

  if target_follow_up is not null
    and target_follow_up not in ('open', 'resolved') then
    raise exception 'Follow-up state must be open or resolved'
      using errcode = '22023';
  end if;

  if (cursor_started_at is null) <> (cursor_id is null) then
    raise exception 'A page cursor needs both its parts'
      using errcode = '22023';
  end if;

  if target_from is not null and target_to is not null
    and target_from > target_to then
    raise exception 'The date range starts after it ends'
      using errcode = '22023';
  end if;

  return query
  select
    call.id,
    call.title,
    call.source_mode,
    call.status,
    call.review_status,
    call.started_at,
    call.duration_ms,
    call.degraded,
    call.owner_id,
    coalesce(
      nullif(owner_profile.display_name, ''), owner_profile.email, 'Unknown'
    ),
    nullif(
      coalesce(
        nullif(assignee_profile.display_name, ''), assignee_profile.email
      ),
      ''
    )
  from public.calls call
  join public.profiles owner_profile
    on owner_profile.id = call.owner_id
  left join public.call_reviews review
    on review.call_id = call.id
  left join public.profiles assignee_profile
    on assignee_profile.id = review.assignee_id
  where call.deleted_at is null
    and (target_owner_id is null or call.owner_id = target_owner_id)
    and (target_from is null or call.started_at >= target_from)
    and (target_to is null or call.started_at <= target_to)
    and (target_statuses is null or call.status = any(target_statuses))
    and (
      target_review_statuses is null
      or call.review_status = any(target_review_statuses)
    )
    and (
      target_quality is null
      or call.degraded = (target_quality = 'degraded')
    )
    and (not target_unassigned or review.assignee_id is null)
    and (
      target_assignee_id is null or review.assignee_id = target_assignee_id
    )
    and (
      target_follow_up is null
      or (
        call.review_status = 'needs_follow_up'
        and (review.follow_up_resolved_at is null)
          = (target_follow_up = 'open')
      )
    )
    -- Title and owner only. `transcripts` is deliberately absent from this
    -- query, and there is no index that would make it searchable.
    and (
      clean_search is null
      or call.title ilike '%' || clean_search || '%'
      or owner_profile.display_name ilike '%' || clean_search || '%'
      or owner_profile.email ilike '%' || clean_search || '%'
    )
    and (
      cursor_started_at is null
      or (call.started_at, call.id) < (cursor_started_at, cursor_id)
    )
  order by call.started_at desc, call.id desc
  limit public.call_page_size() + 1;
end;
$$;

revoke all on function public.list_calls_page(
  uuid, timestamptz, timestamptz, public.call_status[], public.review_status[],
  text, uuid, boolean, text, text, timestamptz, uuid
) from public, anon;
grant execute on function public.list_calls_page(
  uuid, timestamptz, timestamptz, public.call_status[], public.review_status[],
  text, uuid, boolean, text, text, timestamptz, uuid
) to authenticated, service_role;
revoke all on function public.call_page_size() from public, anon;
grant execute on function public.call_page_size()
  to authenticated, service_role;
