-- MyBudget: account, budget e permessi aggiornati.
-- Un amministratore gestisce gli utenti, ma accede ai soli budget a lui associati.

alter table public.profiles add column if not exists email text;

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and (p.email is null or p.email <> u.email);

create or replace function public.has_budget_permission(target_budget uuid, permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.budget_members bm
    join public.profiles p on p.id = bm.user_id
    where bm.budget_id = target_budget
      and bm.user_id = auth.uid()
      and p.status = 'attivo'
      and case permission
        when 'view' then bm.can_view
        when 'add' then bm.can_add
        when 'edit' then bm.can_edit
        when 'manage' then bm.can_manage
        else false
      end
  );
$$;

drop policy if exists budgets_manage_admin_or_member on public.budgets;
drop policy if exists budgets_view_authorized on public.budgets;
create policy budgets_view_authorized on public.budgets
  for select using (
    (created_by = auth.uid() or public.has_budget_permission(id, 'view'))
    and archived_at is null
  );
create policy budgets_insert_own on public.budgets
  for insert with check (created_by = auth.uid());
create policy budgets_update_authorized on public.budgets
  for update using (public.has_budget_permission(id, 'manage'))
  with check (public.has_budget_permission(id, 'manage'));
create policy budgets_delete_authorized on public.budgets
  for delete using (public.has_budget_permission(id, 'manage'));

drop policy if exists members_manage_authorized on public.budget_members;
create policy members_manage_authorized on public.budget_members
  for all using (public.has_budget_permission(budget_id, 'manage'))
  with check (public.has_budget_permission(budget_id, 'manage'));
create policy members_insert_own_budget on public.budget_members
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.budgets b where b.id = budget_id and b.created_by = auth.uid())
  );

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
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Il demo può inserire e correggere i propri movimenti nel proprio budget.
update public.budget_members
set can_view = true, can_add = true, can_edit = true, can_manage = false
where user_id = '571eebe5-3ee5-4d2a-a4d3-5240f5795963'
  and budget_id in (
    select id from public.budgets
    where created_by = '571eebe5-3ee5-4d2a-a4d3-5240f5795963'
      and name = 'Portafoglio personale demo'
  );
