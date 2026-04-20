-- 00011_profile_on_email_confirm.sql
-- Move profile creation from "auth.users INSERT" to "email confirmed".
--
-- The old trigger inserted a profile as soon as Supabase created the
-- auth user, which happens the moment anyone calls signInWithOtp with
-- an unknown email — even a typo on the sign-in page. That polluted
-- the admin residents list and fired spam admin notifications. The
-- new trigger only runs when email_confirmed_at transitions from null
-- to non-null, i.e. when the user actually clicks the magic link.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();

create or replace function handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    insert into profiles (id, full_name, unit_number, phone)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      coalesce(new.raw_user_meta_data->>'unit_number', ''),
      coalesce(new.raw_user_meta_data->>'phone', '')
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_confirmed
  after update on auth.users
  for each row execute function handle_email_confirmed();
