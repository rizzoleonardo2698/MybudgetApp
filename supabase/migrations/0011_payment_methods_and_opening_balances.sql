-- MyBudget: metodi/conti per budget e saldi iniziali.
-- Il metodo di pagamento è una dimensione distinta dalla categoria:
-- la categoria descrive cosa riguarda il movimento, il metodo/conto da dove
-- parte o su quale conto arriva.

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  kind text not null default 'altro' check (kind in ('contanti', 'carta', 'conto_bancario', 'paypal', 'conto_comune', 'altro', 'non_specificato')),
  opening_balance numeric(12, 2) not null default 0,
  opening_balance_date date not null default current_date,
  is_default boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_methods_budget_name_idx
  on public.payment_methods (budget_id, lower(name));

create unique index if not exists payment_methods_one_default_idx
  on public.payment_methods (budget_id)
  where is_default;

alter table public.transactions
  add column if not exists payment_method_id uuid references public.payment_methods(id) on delete set null;

alter table public.recurring_transactions
  add column if not exists payment_method_id uuid references public.payment_methods(id) on delete set null;

create index if not exists transactions_payment_method_idx
  on public.transactions (budget_id, payment_method_id)
  where archived_at is null;

create or replace function public.payment_method_available(target_budget uuid, target_method uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.payment_methods
    where id = target_method
      and budget_id = target_budget
      and not is_archived
  );
$$;

-- Garantisce che ogni nuovo budget abbia sempre il valore opzionale
-- “Non specificato”, senza doverlo creare manualmente dall’interfaccia.
create or replace function public.ensure_default_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_methods (budget_id, owner_id, name, kind, opening_balance, opening_balance_date, is_default)
  values (new.id, new.created_by, 'Non specificato', 'non_specificato', 0, current_date, true)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists budgets_default_payment_method on public.budgets;
create trigger budgets_default_payment_method
  after insert on public.budgets
  for each row execute procedure public.ensure_default_payment_method();

-- Inizializza il valore opzionale per i budget già presenti.
insert into public.payment_methods (budget_id, owner_id, name, kind, opening_balance, opening_balance_date, is_default)
select b.id, b.created_by, 'Non specificato', 'non_specificato', 0, current_date, true
from public.budgets b
where not exists (
  select 1 from public.payment_methods pm
  where pm.budget_id = b.id and pm.is_default
);

-- I dati storici restano validi e vengono classificati nel valore opzionale.
update public.transactions t
set payment_method_id = pm.id
from public.payment_methods pm
where t.payment_method_id is null
  and pm.budget_id = t.budget_id
  and pm.is_default;

update public.recurring_transactions r
set payment_method_id = pm.id
from public.payment_methods pm
where r.payment_method_id is null
  and pm.budget_id = r.budget_id
  and pm.is_default;

alter table public.payment_methods enable row level security;

drop policy if exists payment_methods_view_authorized on public.payment_methods;
drop policy if exists payment_methods_insert_authorized on public.payment_methods;
drop policy if exists payment_methods_update_owner on public.payment_methods;
drop policy if exists payment_methods_delete_owner on public.payment_methods;

create policy payment_methods_view_authorized on public.payment_methods
  for select using (public.has_budget_permission(budget_id, 'view'));

create policy payment_methods_insert_authorized on public.payment_methods
  for insert with check (
    public.has_budget_permission(budget_id, 'add')
    and owner_id = auth.uid()
    and not is_default
  );

create policy payment_methods_update_owner on public.payment_methods
  for update
  using (
    owner_id = auth.uid()
    and not is_default
    and public.has_budget_permission(budget_id, 'add')
  )
  with check (
    owner_id = auth.uid()
    and not is_default
    and public.has_budget_permission(budget_id, 'add')
  );

create policy payment_methods_delete_owner on public.payment_methods
  for delete using (
    owner_id = auth.uid()
    and not is_default
    and public.has_budget_permission(budget_id, 'add')
    and not exists (select 1 from public.transactions t where t.payment_method_id = id)
    and not exists (select 1 from public.recurring_transactions r where r.payment_method_id = id)
  );

-- Un metodo non può essere usato per un budget diverso né dopo essere stato archiviato.
drop policy if exists transactions_add_authorized on public.transactions;
create policy transactions_add_authorized on public.transactions
  for insert with check (
    public.has_budget_permission(budget_id, 'add')
    and author_id = auth.uid()
    and (payment_method_id is null or public.payment_method_available(budget_id, payment_method_id))
  );

drop policy if exists transactions_edit_authorized on public.transactions;
create policy transactions_edit_authorized on public.transactions
  for update
  using (public.can_edit_budget(budget_id))
  with check (
    public.can_edit_budget(budget_id)
    and (payment_method_id is null or public.payment_method_available(budget_id, payment_method_id))
  );

drop policy if exists recurring_insert_authorized on public.recurring_transactions;
create policy recurring_insert_authorized on public.recurring_transactions
  for insert with check (
    public.has_budget_permission(budget_id, 'add')
    and author_id = auth.uid()
    and (payment_method_id is null or public.payment_method_available(budget_id, payment_method_id))
  );

drop policy if exists recurring_update_authorized on public.recurring_transactions;
create policy recurring_update_authorized on public.recurring_transactions
  for update
  using (public.can_edit_budget(budget_id))
  with check (
    public.can_edit_budget(budget_id)
    and (payment_method_id is null or public.payment_method_available(budget_id, payment_method_id))
  );

comment on table public.payment_methods is
  'Metodi e conti configurabili per ciascun budget, con saldo iniziale e storico archiviabile.';
comment on column public.payment_methods.opening_balance is
  'Saldo disponibile al giorno indicato in opening_balance_date.';
comment on column public.payment_methods.opening_balance_date is
  'Data da cui il saldo iniziale viene sommato ai movimenti effettivi.';

notify pgrst, 'reload schema';
