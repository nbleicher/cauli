-- Integration of #22 with the canonical Review Assignment and Follow-up
-- models introduced by #25 and #27. Discovery reads their owned tables
-- directly instead of maintaining duplicate state on call_reviews.

-- The cursor's exact sort order keeps every page an index scan rather than a
-- growing offset and sort.
create index calls_workspace_cursor_idx
  on public.calls (workspace_id, started_at desc, id desc)
  where deleted_at is null;
create index calls_owner_cursor_idx
  on public.calls (owner_id, started_at desc, id desc)
  where deleted_at is null;

create function public.call_page_size()
returns integer
language sql
immutable
as $$
  select 50;
$$;

create function public.list_calls_page(
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
  assignee_id uuid,
  assignee_name text,
  assignment_version integer
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
    assignment.assignee_id,
    nullif(
      coalesce(
        nullif(assignee_profile.display_name, ''), assignee_profile.email
      ),
      ''
    ),
    coalesce(assignment.version, 0)
  from public.calls call
  join public.profiles owner_profile
    on owner_profile.id = call.owner_id
  left join public.call_review_assignments assignment
    on assignment.call_id = call.id
  left join public.profiles assignee_profile
    on assignee_profile.id = assignment.assignee_id
  left join public.follow_ups follow_up
    on follow_up.call_id = call.id
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
    and (not target_unassigned or assignment.assignee_id is null)
    and (
      target_assignee_id is null
      or assignment.assignee_id = target_assignee_id
    )
    and (
      target_follow_up is null
      or (target_follow_up = 'open' and follow_up.status = 'open')
      or (
        target_follow_up = 'resolved'
        and follow_up.status in ('resolved', 'verified')
      )
    )
    -- Title and owner only. Transcript content is deliberately absent.
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
