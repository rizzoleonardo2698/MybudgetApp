-- MyBudget: gestione dei budget, archiviazione, cancellazione controllata e condivisione.
-- Le funzioni amministrative restituiscono solo metadati organizzativi e non importi o movimenti.

create or replace function public.has_budget_permission(target_budget uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.budget_members bm
    join public.profiles p on p.id = bm.user_id
    join public.budgets b on b.id = bm.budget_id
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

drop policy if exists budgets_view_owner on public.budgets;
drop policy if exists budgets_view_authorized on public.budgets;
drop policy if exists budgets_manage_admin_or_member on public.budgets;
drop policy if exists budgets_insert_own on public.budgets;
drop policy if exists budgets_update_owner on public.budgets;
drop policy if exists budgets_delete_owner on public.budgets;

create policy budgets_view_owner_or_shared on public.budgets
  for select using (created_by = auth.uid() or (archived_at is null and public.has_budget_permission(id, 'view')));
create policy budgets_insert_own on public.budgets
  for insert with check (created_by = auth.uid());
create policy budgets_update_owner on public.budgets
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy budgets_delete_owner on public.budgets
  for delete using (created_by = auth.uid());

drop policy if exists members_view_owner on public.budget_members;
drop policy if exists members_view_authorized on public.budget_members;
drop policy if exists members_manage_owner on public.budget_members;
drop policy if exists members_manage_authorized on public.budget_members;
drop policy if exists members_insert_own_budget on public.budget_members;

create policy members_view_owner_or_self on public.budget_members
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.budgets b where b.id = budget_id and b.created_by = auth.uid())
  );
create policy members_manage_owner on public.budget_members
  for all using (exists (select 1 from public.budgets b where b.id = budget_id and b.created_by = auth.uid()))
  with check (exists (select 1 from public.budgets b where b.id = budget_id and b.created_by = auth.uid()));

drop policy if exists categories_view_authorized on public.categories;
create policy categories_view_authorized on public.categories
  for select using (
    is_default
    or owner_id = auth.uid()
    or exists (
      select 1 from public.budget_categories bc
      where bc.category_id = id and public.has_budget_permission(bc.budget_id, 'view')
    )
  );

create or replace function public.budget_delete_preview(p_budget_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then
    raise exception 'Solo il proprietario può gestire questo budget';
  end if;
  return jsonb_build_object(
    'transactions', (select count(*) from public.transactions where budget_id = p_budget_id),
    'recurring_transactions', (select count(*) from public.recurring_transactions where budget_id = p_budget_id),
    'members', (select count(*) from public.budget_members where budget_id = p_budget_id),
    'categories', (select count(*) from public.budget_categories where budget_id = p_budget_id)
  );
end;
$$;

create or replace function public.admin_budget_delete_preview(p_budget_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Solo un amministratore può eseguire questa operazione'; end if;
  if not exists (select 1 from public.budgets where id = p_budget_id) then raise exception 'Budget non trovato'; end if;
  return jsonb_build_object(
    'transactions', (select count(*) from public.transactions where budget_id = p_budget_id),
    'recurring_transactions', (select count(*) from public.recurring_transactions where budget_id = p_budget_id),
    'members', (select count(*) from public.budget_members where budget_id = p_budget_id),
    'categories', (select count(*) from public.budget_categories where budget_id = p_budget_id)
  );
end;
$$;

create or replace function public.archive_budget(p_budget_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.budgets set archived_at = now() where id = p_budget_id and created_by = auth.uid();
  if not found then raise exception 'Budget non trovato o non sei il proprietario'; end if;
end;
$$;

create or replace function public.admin_archive_budget(p_budget_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Solo un amministratore può eseguire questa operazione'; end if;
  update public.budgets set archived_at = now() where id = p_budget_id;
  if not found then raise exception 'Budget non trovato'; end if;
end;
$$;

create or replace function public.delete_budget_safely(p_budget_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then
    raise exception 'Solo il proprietario può eliminare questo budget';
  end if;
  delete from public.transactions where budget_id = p_budget_id;
  delete from public.recurring_transactions where budget_id = p_budget_id;
  delete from public.category_limits where budget_id = p_budget_id;
  delete from public.budget_categories where budget_id = p_budget_id;
  delete from public.budget_members where budget_id = p_budget_id;
  delete from public.budgets where id = p_budget_id and created_by = auth.uid();
end;
$$;

create or replace function public.admin_delete_budget_safely(p_budget_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Solo un amministratore può eseguire questa operazione'; end if;
  delete from public.transactions where budget_id = p_budget_id;
  delete from public.recurring_transactions where budget_id = p_budget_id;
  delete from public.category_limits where budget_id = p_budget_id;
  delete from public.budget_categories where budget_id = p_budget_id;
  delete from public.budget_members where budget_id = p_budget_id;
  delete from public.budgets where id = p_budget_id;
end;
$$;

create or replace function public.admin_create_budget_for_user(p_user_id uuid, p_name text, p_color text default '#5e9b87')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_budget_id uuid;
begin
  if not public.is_admin() then raise exception 'Solo un amministratore può creare budget per un utente'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id and status <> 'sospeso') then raise exception 'Utente non trovato o disabilitato'; end if;
  insert into public.budgets (name, color, created_by) values (trim(p_name), coalesce(nullif(trim(p_color), ''), '#5e9b87'), p_user_id) returning id into new_budget_id;
  insert into public.budget_members (budget_id, user_id, can_view, can_add, can_edit, can_manage) values (new_budget_id, p_user_id, true, true, true, true);
  return new_budget_id;
end;
$$;

create or replace function public.list_budget_access(p_budget_id uuid)
returns table (user_id uuid, first_name text, last_name text, email text, can_view boolean, can_add boolean, can_edit boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then raise exception 'Solo il proprietario può visualizzare gli accessi'; end if;
  return query
    select p.id, p.first_name, p.last_name, p.email, bm.can_view, bm.can_add, bm.can_edit
    from public.budget_members bm join public.profiles p on p.id = bm.user_id
    where bm.budget_id = p_budget_id order by (p.id = auth.uid()) desc, p.last_name, p.first_name;
end;
$$;

create or replace function public.share_budget_with_email(p_budget_id uuid, p_email text, p_can_view boolean default true, p_can_add boolean default false, p_can_edit boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare target_user_id uuid;
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then raise exception 'Solo il proprietario può condividere questo budget'; end if;
  select id into target_user_id from public.profiles where lower(email) = lower(trim(p_email)) and status = 'attivo' limit 1;
  if target_user_id is null then raise exception 'Utente non trovato o non attivo'; end if;
  if target_user_id = auth.uid() then raise exception 'Il proprietario è già associato al budget'; end if;
  insert into public.budget_members (budget_id, user_id, can_view, can_add, can_edit, can_manage)
  values (p_budget_id, target_user_id, coalesce(p_can_view, true), coalesce(p_can_add, false), coalesce(p_can_edit, false), false)
  on conflict (budget_id, user_id) do update set can_view = excluded.can_view, can_add = excluded.can_add, can_edit = excluded.can_edit, can_manage = false;
  return target_user_id;
end;
$$;

create or replace function public.update_budget_access(p_budget_id uuid, p_user_id uuid, p_can_view boolean, p_can_add boolean, p_can_edit boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then raise exception 'Solo il proprietario può modificare gli accessi'; end if;
  update public.budget_members set can_view = coalesce(p_can_view, true), can_add = coalesce(p_can_add, false), can_edit = coalesce(p_can_edit, false), can_manage = false where budget_id = p_budget_id and user_id = p_user_id and user_id <> auth.uid();
  if not found then raise exception 'Accesso non trovato'; end if;
end;
$$;

create or replace function public.remove_budget_access(p_budget_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.budgets where id = p_budget_id and created_by = auth.uid()) then raise exception 'Solo il proprietario può modificare gli accessi'; end if;
  delete from public.budget_members where budget_id = p_budget_id and user_id = p_user_id and user_id <> auth.uid();
end;
$$;

create or replace function public.admin_list_user_budget_summaries()
returns table (user_id uuid, first_name text, last_name text, email text, status public.profile_status, budget_id uuid, budget_name text, budget_color text, budget_created_by uuid, archived_at timestamptz, member_count bigint, transaction_count bigint, recurring_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.first_name, p.last_name, p.email, p.status, b.id, b.name, b.color, b.created_by, b.archived_at,
    (select count(*) from public.budget_members bm2 where bm2.budget_id = b.id),
    (select count(*) from public.transactions t where t.budget_id = b.id),
    (select count(*) from public.recurring_transactions r where r.budget_id = b.id)
  from public.profiles p
  left join public.budget_members bm on bm.user_id = p.id
  left join public.budgets b on b.id = bm.budget_id
  where public.is_admin()
  order by p.last_name, p.first_name, b.created_at;
$$;

notify pgrst, 'reload schema';
