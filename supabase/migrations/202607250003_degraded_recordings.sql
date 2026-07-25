alter table public.calls
  add column degraded_intervals jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(degraded_intervals) = 'array'
      and jsonb_array_length(degraded_intervals) <= 2
    ),
  add column degraded boolean generated always as (
    jsonb_array_length(degraded_intervals) > 0
  ) stored;

create function public.finalize_call(
  target_call_id uuid,
  final_chunk_sequence integer,
  target_duration_ms bigint,
  target_mime_type text,
  target_source_mode public.source_mode,
  target_mic_label text,
  target_tab_label text,
  target_degraded_intervals jsonb
)
returns public.calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
begin
  if jsonb_typeof(target_degraded_intervals) <> 'array'
    or jsonb_array_length(target_degraded_intervals) > 2 then
    raise exception 'Invalid degraded intervals';
  end if;

  select * into call_record
  from public.finalize_call(
    target_call_id,
    final_chunk_sequence,
    target_duration_ms,
    target_mime_type,
    target_source_mode,
    target_mic_label,
    target_tab_label
  );

  update public.calls
  set degraded_intervals = target_degraded_intervals
  where id = target_call_id
  returning * into call_record;

  return call_record;
end;
$$;

revoke all on function public.finalize_call(
  uuid, integer, bigint, text, public.source_mode, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_call(
  uuid, integer, bigint, text, public.source_mode, text, text, jsonb
) to service_role;
