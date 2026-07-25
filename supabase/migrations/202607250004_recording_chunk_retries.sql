create policy recording_chunks_select on storage.objects
for select to authenticated
using (
  bucket_id = 'recordings'
  and (storage.foldername(name))[3] = 'chunks'
  and exists (
    select 1
    from public.calls call
    where call.id = ((storage.foldername(name))[2])::uuid
      and call.workspace_id = ((storage.foldername(name))[1])::uuid
      and call.owner_id = auth.uid()
      and call.deleted_at is null
  )
);
