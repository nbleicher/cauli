/**
 * Getting a Call's media and Transcript out, accountably.
 *
 * Extraction is the moment a Recording stops being contained by Cauli, so it
 * is the moment that most needs a record. Every media download and every
 * Transcript export writes one Audit Event naming the artifact type and the
 * Call — and nothing else. The signed URL is deliberately absent from that
 * record: an Audit Log that stored delivery URLs would become a second way to
 * reach the audio, and one that outlives the access decision that granted it.
 *
 * Authorization is not re-derived here. `can_view_call` already answers who
 * may reach a Call, and reusing it means an export cannot drift away from the
 * boundary the rest of the product enforces.
 */

create type public.export_artifact as enum (
  'mp3', 'source', 'wav', 'transcript_txt', 'transcript_srt'
);

-- Generated Transcript exports live beside the other derived artifacts, under
-- the prefix the deletion job already sweeps, so retention and manual deletion
-- remove them without needing to know they exist.
create or replace function public.transcript_export_path(
  target_workspace_id uuid,
  target_call_id uuid,
  target_format text
)
returns text
language sql
immutable
as $$
  select target_workspace_id::text || '/' || target_call_id::text
    || '/artifacts/transcript.' || target_format;
$$;

/**
 * Records that an artifact was handed over, after checking that it may be.
 *
 * Both documented limits apply: the per-Call export allowance that retries
 * share, and the per-Workspace-Member signed-download allowance. They are
 * consumed here rather than in the route so that a client reaching PostgREST
 * directly is throttled on exactly the same terms as the browser.
 */
create or replace function public.authorize_call_download(
  target_call_id uuid,
  target_artifact public.export_artifact,
  target_delivery text default 'download'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  call_record public.calls;
  is_export boolean := target_artifact in ('transcript_txt', 'transcript_srt');
begin
  if target_delivery not in ('download', 'playback') then
    raise exception 'Delivery must be a download or playback'
      using errcode = '22023';
  end if;

  if not public.can_view_call(target_call_id) then
    -- Unauthorized, cross-Workspace, and deleted all land here, and all three
    -- get the same answer: this Call does not exist for you.
    raise exception 'Call not found';
  end if;

  select * into call_record
  from public.calls
  where id = target_call_id
    and deleted_at is null;

  if call_record.id is null then
    raise exception 'Call not found';
  end if;

  if is_export
    and public.consume_rate_limit(
      'call.reprocess', target_call_id::text, 10, interval '1 hour',
      null, call_record.workspace_id
    ) <> 'allowed'
  then
    raise exception 'Too many exports for this Call this hour.'
      using errcode = '53400';
  end if;

  if public.consume_signed_download_allowance() <> 'allowed' then
    raise exception 'Too many downloads this hour.'
      using errcode = '53400';
  end if;

  -- Streaming for playback and taking a copy are both moments the audio
  -- becomes reachable outside Cauli, so both are recorded; they get separate
  -- actions because an investigation asking "who took a copy" should not have
  -- to read past every time somebody pressed play.
  perform public.record_audit_event(
    call_record.workspace_id,
    auth.uid(),
    case target_delivery
      when 'playback' then 'call.playback.created'
      else 'call.download.created'
    end,
    'call',
    call_record.id::text,
    jsonb_build_object('artifact_type', target_artifact::text)
  );

  return jsonb_build_object(
    'workspaceId', call_record.workspace_id,
    'callId', call_record.id,
    'artifact', target_artifact::text
  );
end;
$$;

/**
 * A Workspace Member who may view a Call may write its Transcript export, and
 * only that: the path pattern pins the write to one filename per format, so
 * this cannot become a way to put arbitrary objects beside a Recording.
 */
drop policy if exists transcript_exports_insert on storage.objects;
create policy transcript_exports_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'artifacts'
  and name ~ '/artifacts/transcript\.(txt|srt)$'
  and exists (
    select 1
    from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.deleted_at is null
      and public.can_view_call(call.id)
  )
);

drop policy if exists transcript_exports_update on storage.objects;
create policy transcript_exports_update on storage.objects
for update to authenticated
using (
  bucket_id = 'recordings'
  and name ~ '/artifacts/transcript\.(txt|srt)$'
  and exists (
    select 1
    from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.deleted_at is null
      and public.can_view_call(call.id)
  )
)
with check (
  bucket_id = 'recordings'
  and name ~ '/artifacts/transcript\.(txt|srt)$'
  and exists (
    select 1
    from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.deleted_at is null
      and public.can_view_call(call.id)
  )
);

revoke all on function public.authorize_call_download(
  uuid, public.export_artifact, text
) from public, anon;
grant execute on function public.authorize_call_download(
  uuid, public.export_artifact, text
) to authenticated;
revoke all on function public.transcript_export_path(uuid, uuid, text)
  from public, anon;
grant execute on function public.transcript_export_path(uuid, uuid, text)
  to authenticated, service_role;
