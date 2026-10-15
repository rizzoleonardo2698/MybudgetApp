-- MyBudget: gestione delle singole occorrenze future di una ricorrenza.
-- Una riga qui presente nasconde soltanto la data indicata senza terminare la serie.

create table if not exists public.recurring_transaction_exceptions (
  id uuid primary key default gen_random_uuid(),
  recurring_transaction_id uuid not null references public.recurring_transactions(id) on delete cascade,
  occurrence_date date not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (recurring_transaction_id, occurrence_date)
);

create index if not exists recurring_exceptions_lookup_idx
  on public.recurring_transaction_exceptions (recurring_transaction_id, occurrence_date);

alter table public.recurring_transaction_exceptions enable row level security;

create policy recurring_exceptions_view_authorized
  on public.recurring_transaction_exceptions
  for select using (
    exists (
      select 1
      from public.recurring_transactions recurring
      where recurring.id = recurring_transaction_id
        and public.has_budget_permission(recurring.budget_id, 'view')
    )
  );

create policy recurring_exceptions_insert_authorized
  on public.recurring_transaction_exceptions
  for insert with check (
    created_by = auth.uid()
    and exists (
      select 1
      from public.recurring_transactions recurring
      where recurring.id = recurring_transaction_id
        and public.has_budget_permission(recurring.budget_id, 'add')
    )
  );

create policy recurring_exceptions_delete_authorized
  on public.recurring_transaction_exceptions
  for delete using (
    created_by = auth.uid()
    and exists (
      select 1
      from public.recurring_transactions recurring
      where recurring.id = recurring_transaction_id
        and public.has_budget_permission(recurring.budget_id, 'add')
    )
  );

comment on table public.recurring_transaction_exceptions is
  'Date singole escluse da una ricorrenza senza disattivare le occorrenze successive.';

notify pgrst, 'reload schema';
