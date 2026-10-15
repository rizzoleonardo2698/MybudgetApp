-- MyBudget: permessi coerenti per proprietari, collaboratori e categorie personali.
-- La migrazione è incrementale: non modifica le migrazioni già applicate.

create or replace function public.can_edit_budget(target_budget uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.budgets
    where id = target_budget and created_by = auth.uid()
  ) or public.has_budget_permission(target_budget, 'edit');
$$;

comment on function public.can_edit_budget(uuid) is
  'Consente modifiche al proprietario del budget o a un membro con can_edit.';

drop policy if exists transactions_edit_authorized on public.transactions;
create policy transactions_edit_authorized on public.transactions
  for update
  using (public.can_edit_budget(budget_id))
  with check (public.can_edit_budget(budget_id));

drop policy if exists transactions_manage_authorized on public.transactions;
create policy transactions_manage_authorized on public.transactions
  for delete
  using (public.can_edit_budget(budget_id));

-- Il proprietario può correggere o archiviare anche una ricorrenza creata da un
-- altro membro con accesso in modifica. L'inserimento resta vincolato all'autore.
drop policy if exists recurring_update_authorized on public.recurring_transactions;
create policy recurring_update_authorized on public.recurring_transactions
  for update
  using (public.can_edit_budget(budget_id))
  with check (public.can_edit_budget(budget_id));

drop policy if exists recurring_delete_authorized on public.recurring_transactions;
create policy recurring_delete_authorized on public.recurring_transactions
  for delete
  using (public.can_edit_budget(budget_id));

notify pgrst, 'reload schema';
