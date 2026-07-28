-- Ticket #24: optional criteria, immutable published definitions, and explicit
-- Scorecard Version comparability.

alter table public.scorecard_versions
  add column name text;

update public.scorecard_versions version
set name = template.name
from public.scorecard_templates template
where template.id = version.template_id
  and version.name is null;

alter table public.scorecard_versions
  alter column name set not null,
  add constraint scorecard_versions_name_length
    check (char_length(name) between 1 and 120);

create table public.scorecard_comparison_sets (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.scorecard_templates(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id),
  revoked_at timestamptz,
  check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null)
  )
);

create table public.scorecard_comparison_set_versions (
  comparison_set_id uuid not null
    references public.scorecard_comparison_sets(id) on delete cascade,
  scorecard_version_id uuid not null
    references public.scorecard_versions(id) on delete cascade,
  active boolean not null default true,
  primary key (comparison_set_id, scorecard_version_id)
);

create unique index scorecard_version_one_active_comparison_set
  on public.scorecard_comparison_set_versions (scorecard_version_id)
  where active;

create index scorecard_comparison_sets_template_active
  on public.scorecard_comparison_sets (template_id, created_at desc)
  where revoked_at is null;

alter table public.scorecard_comparison_sets enable row level security;
alter table public.scorecard_comparison_set_versions enable row level security;

create policy scorecard_comparison_sets_select
on public.scorecard_comparison_sets for select
using (
  exists (
    select 1
    from public.scorecard_templates template
    where template.id = template_id
      and public.current_user_role(template.workspace_id) is not null
  )
);

create policy scorecard_comparison_set_versions_select
on public.scorecard_comparison_set_versions for select
using (
  exists (
    select 1
    from public.scorecard_comparison_sets comparison_set
    join public.scorecard_templates template
      on template.id = comparison_set.template_id
    where comparison_set.id = comparison_set_id
      and public.current_user_role(template.workspace_id) is not null
  )
);

revoke insert, update, delete
  on public.scorecard_comparison_sets,
     public.scorecard_comparison_set_versions
  from public, anon, authenticated;
grant select
  on public.scorecard_comparison_sets,
     public.scorecard_comparison_set_versions
  to authenticated, service_role;
grant all privileges
  on public.scorecard_comparison_sets,
     public.scorecard_comparison_set_versions
  to service_role;

create or replace function public.prepare_scorecard_template_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform set_config('app.scorecard_template_delete', old.id::text, true);
  return old;
end;
$$;

create or replace function public.protect_published_scorecard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  template_id_value uuid;
begin
  if tg_table_name = 'scorecard_versions' then
    template_id_value := coalesce(new.template_id, old.template_id);
  elsif tg_table_name = 'scorecard_categories' then
    select version.template_id into template_id_value
    from public.scorecard_versions version
    where version.id = coalesce(new.version_id, old.version_id);
  else
    select version.template_id into template_id_value
    from public.scorecard_categories category
    join public.scorecard_versions version on version.id = category.version_id
    where category.id = coalesce(new.category_id, old.category_id);
  end if;

  if tg_op = 'INSERT'
    and current_setting('app.scorecard_publish', true) = 'enabled'
  then
    return new;
  end if;

  if tg_op = 'DELETE'
    and nullif(
      current_setting('app.scorecard_template_delete', true),
      ''
    ) is not null
  then
    return old;
  end if;

  raise exception 'Published Scorecard Versions are immutable';
end;
$$;

drop trigger if exists scorecard_template_prepare_delete
  on public.scorecard_templates;
create trigger scorecard_template_prepare_delete
before delete on public.scorecard_templates
for each row execute function public.prepare_scorecard_template_delete();

drop trigger if exists scorecard_versions_immutable
  on public.scorecard_versions;
create trigger scorecard_versions_immutable
before insert or update or delete on public.scorecard_versions
for each row execute function public.protect_published_scorecard();

drop trigger if exists scorecard_categories_immutable
  on public.scorecard_categories;
create trigger scorecard_categories_immutable
before insert or update or delete on public.scorecard_categories
for each row execute function public.protect_published_scorecard();

drop trigger if exists scorecard_criteria_immutable
  on public.scorecard_criteria;
create trigger scorecard_criteria_immutable
before insert or update or delete on public.scorecard_criteria
for each row execute function public.protect_published_scorecard();

create or replace function public.publish_scorecard(
  target_workspace_id uuid,
  target_template_id uuid,
  target_name text,
  target_actor_id uuid,
  target_categories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  template_id_value uuid;
  version_id_value uuid;
  version_number integer;
  category_item jsonb;
  category_position integer;
  category_id_value uuid;
  criterion_item jsonb;
  criterion_position integer;
begin
  if jsonb_typeof(target_categories) <> 'array'
    or jsonb_array_length(target_categories) = 0
  then
    raise exception 'A Scorecard requires at least one category';
  end if;
  if char_length(trim(coalesce(target_name, ''))) not between 1 and 120 then
    raise exception 'A Scorecard name is required';
  end if;

  if target_template_id is null then
    insert into public.scorecard_templates (
      workspace_id, name, created_by
    ) values (
      target_workspace_id, trim(target_name), target_actor_id
    ) returning id into template_id_value;
  else
    select id into template_id_value
    from public.scorecard_templates
    where id = target_template_id and workspace_id = target_workspace_id
    for update;
    if template_id_value is null then
      raise exception 'Scorecard template not found';
    end if;
    update public.scorecard_templates
    set name = trim(target_name)
    where id = template_id_value;
  end if;

  select coalesce(max(version), 0) + 1 into version_number
  from public.scorecard_versions
  where template_id = template_id_value;

  perform set_config('app.scorecard_publish', 'enabled', true);

  insert into public.scorecard_versions (
    template_id, version, name, published_by
  ) values (
    template_id_value, version_number, trim(target_name), target_actor_id
  ) returning id into version_id_value;

  for category_item, category_position in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(target_categories) with ordinality
  loop
    if jsonb_typeof(category_item -> 'criteria') <> 'array'
      or jsonb_array_length(category_item -> 'criteria') = 0
    then
      raise exception 'Each Scorecard category requires at least one criterion';
    end if;

    insert into public.scorecard_categories (version_id, name, position)
    values (version_id_value, category_item ->> 'name', category_position)
    returning id into category_id_value;

    for criterion_item, criterion_position in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(category_item -> 'criteria') with ordinality
    loop
      insert into public.scorecard_criteria (
        category_id, label, description, weight, required, position
      ) values (
        category_id_value,
        criterion_item ->> 'label',
        coalesce(criterion_item ->> 'description', ''),
        (criterion_item ->> 'weight')::integer,
        coalesce((criterion_item ->> 'required')::boolean, true),
        criterion_position
      );
    end loop;
  end loop;

  perform set_config('app.scorecard_publish', 'disabled', true);

  perform public.record_audit_event(
    target_workspace_id,
    target_actor_id,
    'scorecard.version.published',
    'scorecard_version',
    version_id_value::text,
    jsonb_build_object(
      'template_id', template_id_value,
      'version', version_number
    )
  );

  return version_id_value;
end;
$$;

create or replace function public.publish_scorecard_for_current_admin(
  target_template_id uuid,
  target_name text,
  target_categories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null
    or public.current_user_role(actor_workspace_id) <> 'admin'
  then
    raise exception 'Active Workspace Admin access is required';
  end if;

  return public.publish_scorecard(
    actor_workspace_id,
    target_template_id,
    target_name,
    auth.uid(),
    target_categories
  );
end;
$$;

create or replace function public.mark_scorecard_versions_comparable(
  target_version_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  template_id_value uuid;
  comparison_set_id uuid;
  normalized_version_ids uuid[];
  found_count integer;
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null
    or public.current_user_role(actor_workspace_id) <> 'admin'
  then
    raise exception 'Active Workspace Admin access is required';
  end if;

  select array_agg(version.id order by version.version),
         min(version.template_id::text)::uuid,
         count(*)
  into normalized_version_ids, template_id_value, found_count
  from public.scorecard_versions version
  join public.scorecard_templates template on template.id = version.template_id
  where version.id = any(target_version_ids)
    and template.workspace_id = actor_workspace_id;

  if found_count < 2
    or found_count <> (
      select count(distinct requested_id)
      from unnest(target_version_ids) requested_id
    )
    or exists (
      select 1
      from public.scorecard_versions version
      where version.id = any(normalized_version_ids)
        and version.template_id <> template_id_value
    )
  then
    raise exception 'Select at least two Scorecard Versions from one template';
  end if;

  if exists (
    select 1
    from public.scorecard_comparison_set_versions membership
    where membership.scorecard_version_id = any(normalized_version_ids)
      and membership.active
  ) then
    raise exception 'A selected Scorecard Version is already in an active comparison set';
  end if;

  insert into public.scorecard_comparison_sets (
    template_id, created_by
  ) values (
    template_id_value, auth.uid()
  ) returning id into comparison_set_id;

  insert into public.scorecard_comparison_set_versions (
    comparison_set_id, scorecard_version_id
  )
  select comparison_set_id, version_id
  from unnest(normalized_version_ids) version_id;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'scorecard.versions.comparable',
    'scorecard_comparison_set',
    comparison_set_id::text,
    jsonb_build_object('version_ids', normalized_version_ids)
  );

  return comparison_set_id;
end;
$$;

create or replace function public.revoke_scorecard_version_comparability(
  target_comparison_set_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  comparison_set_record public.scorecard_comparison_sets;
  version_ids uuid[];
begin
  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'admin';

  if actor_workspace_id is null
    or public.current_user_role(actor_workspace_id) <> 'admin'
  then
    raise exception 'Active Workspace Admin access is required';
  end if;

  select comparison_set.* into comparison_set_record
  from public.scorecard_comparison_sets comparison_set
  join public.scorecard_templates template
    on template.id = comparison_set.template_id
  where comparison_set.id = target_comparison_set_id
    and comparison_set.revoked_at is null
    and template.workspace_id = actor_workspace_id
  for update;

  if comparison_set_record.id is null then
    raise exception 'Active Scorecard comparison set not found';
  end if;

  select array_agg(scorecard_version_id order by scorecard_version_id)
  into version_ids
  from public.scorecard_comparison_set_versions
  where comparison_set_id = target_comparison_set_id
    and active;

  update public.scorecard_comparison_sets
  set revoked_by = auth.uid(),
      revoked_at = now()
  where id = target_comparison_set_id;

  update public.scorecard_comparison_set_versions
  set active = false
  where comparison_set_id = target_comparison_set_id;

  perform public.record_audit_event(
    actor_workspace_id,
    auth.uid(),
    'scorecard.versions.comparability_revoked',
    'scorecard_comparison_set',
    target_comparison_set_id::text,
    jsonb_build_object('version_ids', version_ids)
  );
end;
$$;

revoke all on function public.mark_scorecard_versions_comparable(uuid[])
  from public, anon;
revoke all on function public.revoke_scorecard_version_comparability(uuid)
  from public, anon;
grant execute on function public.mark_scorecard_versions_comparable(uuid[])
  to authenticated;
grant execute on function public.revoke_scorecard_version_comparability(uuid)
  to authenticated;

-- Consumers group by analytics_segment_id. Without an explicit active
-- comparison set it is the Scorecard Version id, so version breaks are the
-- default and historical Reviews are never rewritten.
create or replace view public.review_score_segments
with (security_invoker = true)
as
select
  call.workspace_id,
  review.id as review_id,
  review.call_id,
  version.template_id,
  review.scorecard_version_id,
  membership.comparison_set_id,
  coalesce(membership.comparison_set_id, review.scorecard_version_id)
    as analytics_segment_id,
  review.score
from public.call_reviews review
join public.calls call on call.id = review.call_id
join public.scorecard_versions version
  on version.id = review.scorecard_version_id
left join public.scorecard_comparison_set_versions membership
  on membership.scorecard_version_id = review.scorecard_version_id
 and membership.active
where review.status in ('reviewed', 'needs_follow_up');

grant select on public.review_score_segments to authenticated, service_role;
