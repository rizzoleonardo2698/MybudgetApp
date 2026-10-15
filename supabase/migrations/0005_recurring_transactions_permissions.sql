-- MyBudget: completa i movimenti ricorrenti per gli utenti standard.
-- Un utente può creare e modificare le ricorrenze dei budget a cui può aggiungere movimenti.

alter table public.recurring_transactions
  add column if not exists is_received boolean not null default true;

comment on column public.recurring_transactions.is_received is
  'Per le entrate ricorrenti: true se effettivamente incassate, false se previste.';

drop policy if exists recurring_manage_authorized on public.recurring_transactions;
drop policy if exists recurring_view_authorized on public.recurring_transactions;

create policy recurring_view_authorized on public.recurring_transactions
  for select using (public.has_budget_permission(budget_id, 'view'));

create policy recurring_insert_authorized on public.recurring_transactions
  for insert with check (
    public.has_budget_permission(budget_id, 'add')
    and author_id = auth.uid()
  );

create policy recurring_update_authorized on public.recurring_transactions
  for update using (
    public.has_budget_permission(budget_id, 'edit')
    and author_id = auth.uid()
  ) with check (
    public.has_budget_permission(budget_id, 'edit')
    and author_id = auth.uid()
  );

create policy recurring_delete_authorized on public.recurring_transactions
  for delete using (
    public.has_budget_permission(budget_id, 'edit')
    and author_id = auth.uid()
  );

-- Il job server-side mantiene la stessa distinzione tra entrate previste ed effettive.
create or replace function public.generate_due_recurring_transactions(run_until date default current_date)
returns integer language plpgsql security definer set search_path = public as $$
declare
  created_count integer := 0;
  item record;
  due_date date;
begin
  for item in select * from public.recurring_transactions where active and next_insert_date <= run_until loop
    due_date := item.next_insert_date;
    while due_date <= run_until and (item.end_date is null or due_date <= item.end_date) loop
      insert into public.transactions (budget_id, category_id, author_id, transaction_date, amount, type, description, recurring_transaction_id, is_received)
      values (item.budget_id, item.category_id, item.author_id, due_date, item.amount, item.type, item.description, item.id, item.is_received)
      on conflict (recurring_transaction_id, transaction_date) where recurring_transaction_id is not null do nothing;
      created_count := created_count + 1;
      due_date := case when item.frequency = 'mensile' then (due_date + interval '1 month')::date else (due_date + interval '1 year')::date end;
    end loop;
    update public.recurring_transactions set next_insert_date = due_date where id = item.id;
  end loop;
  return created_count;
end;
$$;

notify pgrst, 'reload schema';
