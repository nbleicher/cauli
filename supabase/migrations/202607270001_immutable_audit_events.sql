-- Audit Events are append-only, content-free operational evidence retained
-- independently from Workspace and Call content.

alter table public.audit_events
  drop constraint if exists audit_events_workspace_id_fkey,
  drop constraint if exists audit_events_actor_id_fkey;

alter table public.audit_events
  add column if not exists retained_until timestamptz
  not null default (now() + interval '1 year');

alter table public.audit_events
  add constraint audit_events_action_format
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  add constraint audit_events_entity_type_format
    check (entity_type ~ '^[a-z][a-z0-9_]{0,79}$'),
  add constraint audit_events_entity_id_length
    check (char_length(entity_id) between 1 and 240),
  add constraint audit_events_retention_term
    check (retained_until >= created_at + interval '1 year');

create index if not exists audit_events_workspace_cursor_idx
  on public.audit_events (workspace_id, id desc);
create index if not exists audit_events_workspace_created_idx
  on public.audit_events (workspace_id, created_at desc, id desc);
create index if not exists audit_events_workspace_actor_idx
  on public.audit_events (workspace_id, actor_id, id desc);
create index if not exists audit_events_workspace_action_idx
  on public.audit_events (workspace_id, action, id desc);
create index if not exists audit_events_workspace_entity_idx
  on public.audit_events (workspace_id, entity_type, entity_id, id desc);
create index if not exists audit_events_retention_idx
  on public.audit_events (retained_until);

create or replace function public.assert_safe_audit_metadata(
  target_metadata jsonb
)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  serialized text;
begin
  if target_metadata is null or jsonb_typeof(target_metadata) <> 'object' then
    raise exception 'Audit metadata must be a JSON object';
  end if;

  serialized := target_metadata::text;
  if octet_length(serialized) > 4096 then
    raise exception 'Audit metadata exceeds the safe size limit';
  end if;

  if serialized ~* '"(?:email|display_name|title|transcript|review|comment|summary|content|body|signed_url|url|uri|password|passphrase|secret|token|authorization|cookie|api_key|private_key|credential|audio|media)"\s*:'
    or serialized ~* 'https?://'
    or serialized ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    or serialized ~* '\bBearer\s+[[:graph:]]+'
    or serialized ~* '\b(?:sk-or-v1-|sb_secret_)[[:alnum:]_-]+'
    or serialized ~* '\beyJ[[:alnum:]_-]+\.[[:alnum:]_-]+\.[[:alnum:]_-]+\b'
  then
    raise exception 'Audit metadata contains prohibited content';
  end if;
end;
$$;

create or replace function public.record_audit_event(
  target_workspace_id uuid,
  target_actor_id uuid,
  target_action text,
  target_entity_type text,
  target_entity_id text,
  target_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  event_id bigint;
begin
  perform public.assert_safe_audit_metadata(target_metadata);

  if target_workspace_id is null then
    raise exception 'Audit Workspace is required';
  end if;

  if target_actor_id is not null and not exists (
    select 1 from public.profiles where id = target_actor_id
  ) then
    raise exception 'Audit actor does not exist';
  end if;

  insert into public.audit_events (
    workspace_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    target_workspace_id,
    target_actor_id,
    target_action,
    target_entity_type,
    target_entity_id,
    target_metadata
  )
  returning id into event_id;

  return event_id;
end;
$$;

create or replace function public.protect_audit_event()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Audit Events are immutable';
  end if;

  if old.retained_until > now()
    or current_setting('app.audit_retention_purge', true) <> 'enabled'
  then
    raise exception 'Audit Events cannot be deleted before authorized retention expiry';
  end if;

  return old;
end;
$$;

drop trigger if exists audit_events_immutable on public.audit_events;
create trigger audit_events_immutable
before update or delete on public.audit_events
for each row execute function public.protect_audit_event();

create or replace function public.purge_expired_audit_events()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  perform set_config('app.audit_retention_purge', 'enabled', true);
  delete from public.audit_events
  where retained_until <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke insert, update, delete, truncate on public.audit_events
  from public, anon, authenticated, service_role;
grant select on public.audit_events to authenticated, service_role;

revoke all on function public.assert_safe_audit_metadata(jsonb)
  from public, anon, authenticated;
revoke all on function public.record_audit_event(
  uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_audit_event(
  uuid, uuid, text, text, text, jsonb
) to service_role;
revoke all on function public.purge_expired_audit_events()
  from public, anon, authenticated;
grant execute on function public.purge_expired_audit_events()
  to service_role;
