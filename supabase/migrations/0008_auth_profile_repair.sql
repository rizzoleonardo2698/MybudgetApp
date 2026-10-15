-- MyBudget: garantisce un profilo applicativo per ogni utente Auth.
-- Serve sia per le nuove registrazioni sia per gli account creati prima
-- dell'installazione del trigger o durante una configurazione incompleta.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name, email, role, status)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'first_name', ''), 'Utente'),
    coalesce(nullif(new.raw_user_meta_data->>'last_name', ''), 'MyBudget'),
    new.email,
    'standard',
    'in_attesa'
  )
  on conflict (id) do update
    set email = coalesce(excluded.email, public.profiles.email),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Ripara gli utenti già presenti in Auth ma senza riga in public.profiles.
insert into public.profiles (id, first_name, last_name, email, role, status)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data->>'first_name', ''), 'Utente'),
  coalesce(nullif(u.raw_user_meta_data->>'last_name', ''), 'MyBudget'),
  u.email,
  'standard',
  'in_attesa'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

notify pgrst, 'reload schema';
