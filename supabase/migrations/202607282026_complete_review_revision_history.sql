-- Ticket #26: complete, immutable Review Revision snapshots with draft-safe
-- history visibility.

alter table public.review_revisions
  add column scorecard_version_id uuid
    references public.scorecard_versions(id),
  add column follow_up_state text;

update public.review_revisions revision
set scorecard_version_id = review.scorecard_version_id,
    follow_up_state = case
      when revision.status = 'needs_follow_up' then 'required'
      else 'not_required'
    end
from public.call_reviews review
where review.id = revision.review_id;

alter table public.review_revisions
  alter column scorecard_version_id set not null,
  alter column follow_up_state set not null,
  add constraint review_revisions_follow_up_state
    check (
      follow_up_state in (
        'not_required', 'required', 'open', 'resolved', 'verified'
      )
    );

create or replace function public.prepare_call_content_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform set_config('app.call_content_delete', old.id::text, true);
  return old;
end;
$$;

create or replace function public.protect_review_revision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE'
    and nullif(current_setting('app.call_content_delete', true), '') is not null
  then
    return old;
  end if;

  raise exception 'Review Revisions are immutable outside whole-Call deletion';
end;
$$;

drop trigger if exists calls_prepare_content_delete on public.calls;
create trigger calls_prepare_content_delete
before delete on public.calls
for each row execute function public.prepare_call_content_delete();

drop trigger if exists review_revisions_immutable on public.review_revisions;
create trigger review_revisions_immutable
before update or delete on public.review_revisions
for each row execute function public.protect_review_revision();

revoke insert, update, delete on public.review_revisions
  from public, anon, authenticated, service_role;
grant select on public.review_revisions to authenticated, service_role;

create or replace function public.review_revision_history(
  target_call_id uuid
)
returns table (
  id uuid,
  review_id uuid,
  revision integer,
  scorecard_version_id uuid,
  status public.review_status,
  score numeric,
  summary text,
  follow_up text,
  follow_up_state text,
  answers jsonb,
  submitted_by uuid,
  submitted_by_name text,
  submitted_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    snapshot.id,
    snapshot.review_id,
    snapshot.revision,
    snapshot.scorecard_version_id,
    snapshot.status,
    snapshot.score,
    snapshot.summary,
    snapshot.follow_up,
    snapshot.follow_up_state,
    snapshot.answers,
    snapshot.submitted_by,
    coalesce(nullif(profile.display_name, ''), profile.email, 'Unknown'),
    snapshot.submitted_at
  from public.review_revisions snapshot
  join public.call_reviews review on review.id = snapshot.review_id
  join public.calls call on call.id = review.call_id
  join public.workspace_members member
    on member.workspace_id = call.workspace_id
   and member.user_id = auth.uid()
   and member.status = 'active'
  left join public.profiles profile on profile.id = snapshot.submitted_by
  where call.id = target_call_id
    and call.deleted_at is null
    and public.current_user_role(call.workspace_id) = member.role
    and (
      member.role in ('manager', 'admin')
      or (
        member.role = 'member'
        and call.owner_id = auth.uid()
        and snapshot.status <> 'in_progress'
      )
    )
  order by snapshot.revision desc;
$$;

revoke all on function public.review_revision_history(uuid)
  from public, anon;
grant execute on function public.review_revision_history(uuid)
  to authenticated;

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
    when review_record.status = 'needs_follow_up' then 'required'
    else 'not_required'
  end;
  return new;
end;
$$;

drop trigger if exists review_revisions_snapshot_fields
  on public.review_revisions;
create trigger review_revisions_snapshot_fields
before insert on public.review_revisions
for each row execute function public.snapshot_review_revision_fields();
