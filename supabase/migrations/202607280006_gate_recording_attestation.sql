alter table public.calls
  add column recording_attested_by uuid references public.profiles(id),
  add column recording_attested_at timestamptz,
  add column recording_attestation_required boolean not null default false,
  add constraint calls_recording_attestation_complete check (
    (recording_attested_by is null) = (recording_attested_at is null)
  ),
  add constraint calls_recording_attestation_actor_is_owner check (
    recording_attested_by is null or recording_attested_by = owner_id
  ),
  add constraint calls_required_recording_attestation_present check (
    not recording_attestation_required
    or (
      recording_attested_by is not null
      and recording_attested_at is not null
    )
  );

-- Existing Calls predate the attestation requirement. New Calls default to the
-- requirement, and the trigger below prevents privileged callers from opting out.
alter table public.calls
  alter column recording_attestation_required set default true;

comment on column public.calls.recording_attested_by is
  'Workspace Member who made the Recording Attestation immediately before capture.';
comment on column public.calls.recording_attested_at is
  'Server timestamp for the Recording Attestation made immediately before capture.';
comment on column public.calls.recording_attestation_required is
  'False only for Calls that existed before Recording Attestation was introduced.';

create or replace function public.enforce_recording_attestation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.recording_attestation_required := true;
  elsif old.recording_attestation_required
    and not new.recording_attestation_required then
    raise exception 'Recording Attestation cannot be removed'
      using errcode = '23514';
  end if;

  if new.recording_attestation_required
    and (
      new.recording_attested_by is null
      or new.recording_attested_at is null
    ) then
    raise exception 'Recording Attestation is required before capture'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger enforce_recording_attestation
before insert or update on public.calls
for each row execute function public.enforce_recording_attestation();

-- Keep the legacy RPC during the expand phase, but fail closed so an older web
-- process cannot create a new Call without the now-mandatory attestation.
create or replace function public.create_call_for_current_user(
  target_call_id uuid,
  target_source_mode public.source_mode,
  target_mic_label text,
  target_tab_label text
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Recording Attestation is required before capture'
    using errcode = '23514';
end;
$$;

create or replace function public.create_attested_call_for_current_user(
  target_call_id uuid,
  target_source_mode public.source_mode,
  target_mic_label text,
  target_tab_label text,
  target_title text,
  target_recording_attested boolean
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  call_record public.calls;
  clean_title text;
begin
  if target_recording_attested is distinct from true then
    raise exception 'Recording Attestation is required before capture'
      using errcode = '23514';
  end if;

  select workspace_id into actor_workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active';

  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;

  clean_title := nullif(btrim(target_title), '');
  if char_length(clean_title) > 240 then
    raise exception 'Call title must be 240 characters or fewer'
      using errcode = '22001';
  end if;

  insert into public.calls (
    id,
    workspace_id,
    owner_id,
    title,
    source_mode,
    status,
    chunk_prefix,
    mic_label,
    tab_label,
    recording_attested_by,
    recording_attested_at
  ) values (
    target_call_id,
    actor_workspace_id,
    auth.uid(),
    clean_title,
    target_source_mode,
    'recording',
    actor_workspace_id::text || '/' || target_call_id::text || '/chunks',
    coalesce(target_mic_label, ''),
    coalesce(target_tab_label, ''),
    auth.uid(),
    now()
  )
  returning * into call_record;

  return call_record;
end;
$$;

create or replace function public.rename_owned_call(
  target_call_id uuid,
  target_title text
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  clean_title text;
begin
  select call.* into call_record
  from public.calls call
  join public.workspace_members member
    on member.workspace_id = call.workspace_id
   and member.user_id = auth.uid()
   and member.status = 'active'
  where call.id = target_call_id
    and call.deleted_at is null
  for update of call;

  if call_record.id is null then
    raise exception 'Call not found';
  end if;

  if call_record.owner_id <> auth.uid() then
    raise exception 'Only the Call owner can rename it';
  end if;

  if call_record.status in ('recording', 'uploading') then
    raise exception 'A Call can be renamed only after capture';
  end if;

  clean_title := nullif(btrim(target_title), '');
  if char_length(clean_title) > 240 then
    raise exception 'Call title must be 240 characters or fewer'
      using errcode = '22001';
  end if;

  update public.calls
  set title = clean_title
  where id = target_call_id
  returning * into call_record;

  return call_record;
end;
$$;

revoke all on function public.create_attested_call_for_current_user(
  uuid, public.source_mode, text, text, text, boolean
) from public, anon;
grant execute on function public.create_attested_call_for_current_user(
  uuid, public.source_mode, text, text, text, boolean
) to authenticated;

revoke all on function public.rename_owned_call(uuid, text)
  from public, anon;
grant execute on function public.rename_owned_call(uuid, text)
  to authenticated;
