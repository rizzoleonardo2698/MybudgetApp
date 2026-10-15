-- MyBudget: cancellazione controllata dei propri movimenti e delle categorie personali.
-- La migrazione è incrementale: non modifica le migrazioni già applicate.

drop policy if exists transactions_manage_authorized on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;
create policy transactions_delete_own on public.transactions
  for delete
  using (
    author_id = auth.uid()
    and public.has_budget_permission(budget_id, 'add')
  );

create or replace function public.category_delete_preview(p_category_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.categories
    where id = p_category_id
      and owner_id = auth.uid()
      and not is_default
  ) then
    raise exception 'Categoria non trovata o non sei il proprietario';
  end if;

  return jsonb_build_object(
    'transactions', (select count(*) from public.transactions where category_id = p_category_id),
    'recurring_transactions', (select count(*) from public.recurring_transactions where category_id = p_category_id)
  );
end;
$$;

create or replace function public.delete_category_safely(p_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_transactions bigint;
  deleted_recurring bigint;
begin
  if not exists (
    select 1
    from public.categories
    where id = p_category_id
      and owner_id = auth.uid()
      and not is_default
  ) then
    raise exception 'Categoria non trovata o non sei il proprietario';
  end if;

  delete from public.transactions where category_id = p_category_id;
  get diagnostics deleted_transactions = row_count;

  delete from public.recurring_transactions where category_id = p_category_id;
  get diagnostics deleted_recurring = row_count;

  delete from public.category_limits where category_id = p_category_id;
  delete from public.budget_categories where category_id = p_category_id;
  delete from public.categories where id = p_category_id;

  return jsonb_build_object(
    'transactions', deleted_transactions,
    'recurring_transactions', deleted_recurring
  );
end;
$$;

comment on function public.category_delete_preview(uuid) is
  'Mostra i conteggi prima di eliminare una categoria personale.';
comment on function public.delete_category_safely(uuid) is
  'Elimina una categoria personale e i movimenti/ricorrenze collegati in modo atomico.';

grant execute on function public.category_delete_preview(uuid) to authenticated;
grant execute on function public.delete_category_safely(uuid) to authenticated;

notify pgrst, 'reload schema';
