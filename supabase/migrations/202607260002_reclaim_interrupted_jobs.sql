drop index if exists public.processing_jobs_claim_idx;

alter table public.processing_jobs
  add column lease_token uuid;

alter table public.processing_jobs
  drop constraint processing_jobs_call_id_fkey,
  add constraint processing_jobs_call_id_fkey
    foreign key (call_id) references public.calls(id) on delete set null;

create index processing_jobs_claim_idx
  on public.processing_jobs (status, next_attempt_at, locked_at, created_at)
  where status in ('queued', 'retrying', 'processing');

create schema if not exists private;

create or replace function private.lock_owned_processing_job(
  target_job_id uuid,
  target_lease_token uuid,
  expected_kind public.job_kind
)
returns setof public.processing_jobs
language sql
security definer
set search_path = public
as $$
  select *
  from public.processing_jobs
  where id = target_job_id
    and status = 'processing'
    and lease_token = target_lease_token
    and kind = expected_kind
  for update;
$$;

create or replace function private.complete_processing_job(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.processing_jobs
  set status = 'complete',
      finished_at = now(),
      error_message = null,
      error_category = null,
      error_chunk_index = null,
      provider_generation_id = null,
      locked_at = null,
      locked_by = null,
      lease_token = null
  where id = target_job_id
    and status = 'processing'
    and lease_token = target_lease_token;

  return found;
end;
$$;

revoke all on schema private
  from public, anon, authenticated, service_role;
revoke execute on all functions in schema private
  from public, anon, authenticated, service_role;

create or replace function public.claim_processing_job(worker_name text)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  claimed_job public.processing_jobs%rowtype;
begin
  update public.calls as call
  set status = 'failed',
      error_message = 'Processing stopped after the final worker lease expired.'
  where exists (
    select 1
    from public.processing_jobs as job
    where job.call_id = call.id
      and job.kind = 'process_recording'
      and job.status = 'processing'
      and job.locked_at < now() - interval '5 minutes'
      and job.attempts >= job.max_attempts
  );

  update public.export_jobs as export
  set status = 'failed',
      error_message = 'Export stopped after the final worker lease expired.'
  where exists (
    select 1
    from public.processing_jobs as job
    where job.call_id = export.call_id
      and job.kind = 'generate_wav'
      and job.status = 'processing'
      and job.locked_at < now() - interval '5 minutes'
      and job.attempts >= job.max_attempts
  );

  update public.processing_jobs
  set status = 'failed',
      error_message = 'Worker lease expired after the final attempt.',
      finished_at = now(),
      locked_at = null,
      locked_by = null,
      lease_token = null
  where status = 'processing'
    and locked_at < now() - interval '5 minutes'
    and attempts >= max_attempts;

  select id into claimed_id
  from public.processing_jobs
  where (
      status in ('queued', 'retrying')
      and next_attempt_at <= now()
    )
    or (
      status = 'processing'
      and locked_at < now() - interval '5 minutes'
      and attempts < max_attempts
    )
  order by
    case when status = 'processing' then 0 else 1 end,
    coalesce(locked_at, next_attempt_at),
    created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.processing_jobs
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = worker_name,
      lease_token = gen_random_uuid(),
      error_message = null,
      finished_at = null
  where id = claimed_id
  returning * into claimed_job;

  if claimed_job.kind = 'process_recording'
    and claimed_job.call_id is not null then
    update public.calls
    set status = 'processing',
        error_message = null
    where id = claimed_job.call_id;
  end if;

  return next claimed_job;
end;
$$;

create or replace function public.renew_processing_job_lease(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.processing_jobs
  set locked_at = now()
  where id = target_job_id
    and status = 'processing'
    and lease_token = target_lease_token;

  return found;
end;
$$;

create or replace function public.commit_processed_recording(
  target_job_id uuid,
  target_lease_token uuid,
  target_source_path text,
  target_mp3_path text,
  target_source_bytes bigint,
  target_model text,
  target_language text,
  target_full_text text,
  target_provider_generation_id text,
  target_provider_cost_usd numeric,
  target_provider_duration_seconds numeric,
  target_segments jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.processing_jobs%rowtype;
  saved_transcript_id uuid;
begin
  select *
  into claimed_job
  from private.lock_owned_processing_job(
    target_job_id,
    target_lease_token,
    'process_recording'
  );

  if not found or claimed_job.call_id is null then
    return false;
  end if;

  if target_model is not null then
    if jsonb_typeof(target_segments) <> 'array' then
      raise exception 'Transcript segments must be an array';
    end if;

    insert into public.transcripts (
      call_id,
      model,
      language,
      full_text,
      provider_generation_id,
      provider_cost_usd,
      provider_duration_seconds
    )
    values (
      claimed_job.call_id,
      target_model,
      target_language,
      coalesce(target_full_text, ''),
      target_provider_generation_id,
      target_provider_cost_usd,
      target_provider_duration_seconds
    )
    on conflict (call_id) do update
    set model = excluded.model,
        language = excluded.language,
        full_text = excluded.full_text,
        provider_generation_id = excluded.provider_generation_id,
        provider_cost_usd = excluded.provider_cost_usd,
        provider_duration_seconds = excluded.provider_duration_seconds
    returning id into saved_transcript_id;

    delete from public.transcript_segments
    where transcript_id = saved_transcript_id;

    insert into public.transcript_segments (
      transcript_id,
      sequence,
      start_ms,
      end_ms,
      text
    )
    select
      saved_transcript_id,
      segment.sequence,
      segment.start_ms,
      segment.end_ms,
      segment.text
    from jsonb_to_recordset(target_segments) as segment(
      sequence integer,
      start_ms bigint,
      end_ms bigint,
      text text
    )
    order by segment.sequence;
  end if;

  update public.calls
  set status = 'ready',
      source_path = target_source_path,
      mp3_path = target_mp3_path,
      source_bytes = target_source_bytes,
      error_message = null
  where id = claimed_job.call_id;

  if claimed_job.payload ? 'extensionImportId' then
    update public.extension_imports
    set status = 'complete',
        error_message = null
    where id::text = claimed_job.payload ->> 'extensionImportId';
  end if;

  if not private.complete_processing_job(
    claimed_job.id,
    target_lease_token
  ) then
    raise exception 'Recording lease changed during commit';
  end if;

  return true;
end;
$$;

create or replace function public.commit_wav_export(
  target_job_id uuid,
  target_lease_token uuid,
  target_wav_path text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.processing_jobs%rowtype;
begin
  select *
  into claimed_job
  from private.lock_owned_processing_job(
    target_job_id,
    target_lease_token,
    'generate_wav'
  );

  if not found or claimed_job.call_id is null then
    return false;
  end if;

  update public.calls
  set wav_path = target_wav_path
  where id = claimed_job.call_id;

  if claimed_job.payload ? 'exportJobId' then
    update public.export_jobs
    set status = 'complete',
        error_message = null,
        completed_at = now()
    where id::text = claimed_job.payload ->> 'exportJobId';
  end if;

  if not private.complete_processing_job(
    claimed_job.id,
    target_lease_token
  ) then
    raise exception 'WAV export lease changed during commit';
  end if;

  return true;
end;
$$;

create or replace function public.commit_call_deletion(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.processing_jobs%rowtype;
begin
  select *
  into claimed_job
  from private.lock_owned_processing_job(
    target_job_id,
    target_lease_token,
    'delete_call'
  );

  if not found or claimed_job.call_id is null then
    return false;
  end if;

  delete from public.calls
  where id = claimed_job.call_id;

  if not private.complete_processing_job(
    claimed_job.id,
    target_lease_token
  ) then
    raise exception 'Deletion lease changed during commit';
  end if;

  return true;
end;
$$;

revoke execute on function public.claim_processing_job(text)
  from public, anon, authenticated;
grant execute on function public.claim_processing_job(text)
  to service_role;

revoke execute on function public.renew_processing_job_lease(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.renew_processing_job_lease(uuid, uuid)
  to service_role;

revoke execute on function public.commit_processed_recording(
  uuid, uuid, text, text, bigint, text, text, text, text, numeric, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_processed_recording(
  uuid, uuid, text, text, bigint, text, text, text, text, numeric, numeric, jsonb
) to service_role;

revoke execute on function public.commit_wav_export(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.commit_wav_export(uuid, uuid, text)
  to service_role;

revoke execute on function public.commit_call_deletion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.commit_call_deletion(uuid, uuid)
  to service_role;
