revoke insert, update, delete on table public.calls from authenticated;

drop policy if exists calls_insert on public.calls;
drop policy if exists calls_owner_update on public.calls;
