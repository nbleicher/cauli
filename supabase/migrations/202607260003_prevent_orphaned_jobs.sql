update public.processing_jobs
set status = 'failed',
    error_message = 'The associated Call no longer exists.',
    finished_at = now(),
    locked_at = null,
    locked_by = null,
    lease_token = null
where call_id is null
  and kind in ('process_recording', 'generate_wav', 'delete_call')
  and (
    status in ('queued', 'retrying')
    or (
      status = 'processing'
      and locked_at < now() - interval '5 minutes'
    )
  );

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
  update public.processing_jobs
  set status = 'failed',
      error_message = 'The associated Call no longer exists.',
      finished_at = now(),
      locked_at = null,
      locked_by = null,
      lease_token = null
  where call_id is null
    and kind in ('process_recording', 'generate_wav', 'delete_call')
    and (
      status in ('queued', 'retrying')
      or (
        status = 'processing'
        and locked_at < now() - interval '5 minutes'
      )
    );

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
      (
        status in ('queued', 'retrying')
        and next_attempt_at <= now()
      )
      or (
        status = 'processing'
        and locked_at < now() - interval '5 minutes'
        and attempts < max_attempts
      )
    )
    and (
      call_id is not null
      or kind = 'cleanup_abandoned'
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
