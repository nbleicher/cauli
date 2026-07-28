-- Auth user creation proves only that Supabase has an identity record. A
-- Workspace Invitation becomes active exclusively through
-- activate_workspace_invitation after the email link establishes the invited
-- session and that identity creates a password.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do update set email = excluded.email;

  return new;
end;
$$;
