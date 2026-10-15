-- Crea automaticamente il profilo applicativo quando un nuovo utente si registra.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name, role, status)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'first_name', ''), 'Utente'),
    coalesce(nullif(new.raw_user_meta_data->>'last_name', ''), 'MyBudget'),
    'standard',
    'in_attesa'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
