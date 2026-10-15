-- MyBudget: schema iniziale Postgres/Supabase.
-- Le password restano esclusivamente in auth.users gestita da Supabase Auth.

create extension if not exists "pgcrypto";

create type public.app_role as enum ('admin', 'standard');
create type public.profile_status as enum ('in_attesa', 'attivo', 'sospeso');
create type public.transaction_type as enum ('entrata', 'uscita');
create type public.category_type as enum ('entrata', 'uscita', 'entrambi');
create type public.recurrence_frequency as enum ('mensile', 'annuale');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  role public.app_role not null default 'standard',
  status public.profile_status not null default 'in_attesa',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#e9775b',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.budget_members (
  budget_id uuid not null references public.budgets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  can_view boolean not null default false,
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_manage boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (budget_id, user_id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type public.category_type not null default 'entrambi',
  is_default boolean not null default false,
  is_archived boolean not null default false,
  owner_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (name, owner_id)
);

create table public.budget_categories (
  budget_id uuid not null references public.budgets(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  enabled boolean not null default true,
  primary key (budget_id, category_id)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  author_id uuid not null references public.profiles(id) on delete restrict,
  transaction_date date not null,
  amount numeric(12, 2) not null check (amount > 0),
  type public.transaction_type not null,
  description text not null,
  recurring_transaction_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  author_id uuid not null references public.profiles(id) on delete restrict,
  description text not null,
  amount numeric(12, 2) not null check (amount > 0),
  type public.transaction_type not null,
  frequency public.recurrence_frequency not null,
  day_of_period smallint not null check (day_of_period between 1 and 31),
  start_date date not null,
  end_date date,
  next_insert_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);

alter table public.transactions
  add constraint transactions_recurring_fk
  foreign key (recurring_transaction_id) references public.recurring_transactions(id) on delete set null;

create table public.category_limits (
  budget_id uuid not null references public.budgets(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  monthly_limit numeric(12, 2) not null check (monthly_limit >= 0),
  primary key (budget_id, category_id)
);

create index transactions_budget_date_idx on public.transactions (budget_id, transaction_date desc) where archived_at is null;
create index budget_members_user_idx on public.budget_members (user_id, budget_id) where can_view;
create unique index recurring_due_once_idx on public.transactions (recurring_transaction_id, transaction_date) where recurring_transaction_id is not null;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and status = 'attivo');
$$;

create or replace function public.has_budget_permission(target_budget uuid, permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.budget_members bm
    join public.profiles p on p.id = bm.user_id
    where bm.budget_id = target_budget and bm.user_id = auth.uid() and p.status = 'attivo'
      and case permission when 'view' then bm.can_view when 'add' then bm.can_add when 'edit' then bm.can_edit when 'manage' then bm.can_manage else false end
  );
$$;

alter table public.profiles enable row level security;
alter table public.budgets enable row level security;
alter table public.budget_members enable row level security;
alter table public.categories enable row level security;
alter table public.budget_categories enable row level security;
alter table public.transactions enable row level security;
alter table public.recurring_transactions enable row level security;
alter table public.category_limits enable row level security;

create policy profiles_self_or_admin on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update using (public.is_admin()) with check (public.is_admin());
create policy profiles_admin_delete on public.profiles for delete using (public.is_admin());
create policy budgets_view_authorized on public.budgets for select using (public.has_budget_permission(id, 'view') and archived_at is null);
create policy budgets_manage_admin_or_member on public.budgets for all using (public.has_budget_permission(id, 'manage')) with check (public.has_budget_permission(id, 'manage'));
create policy members_view_authorized on public.budget_members for select using (public.has_budget_permission(budget_id, 'view'));
create policy members_manage_authorized on public.budget_members for all using (public.has_budget_permission(budget_id, 'manage')) with check (public.has_budget_permission(budget_id, 'manage'));
create policy categories_view_authorized on public.categories for select using (is_default or owner_id = auth.uid() or public.is_admin());
create policy categories_manage_owner_or_admin on public.categories for all using (owner_id = auth.uid() or public.is_admin()) with check (owner_id = auth.uid() or public.is_admin());
create policy budget_categories_view_authorized on public.budget_categories for select using (public.has_budget_permission(budget_id, 'view'));
create policy budget_categories_manage_authorized on public.budget_categories for all using (public.has_budget_permission(budget_id, 'manage')) with check (public.has_budget_permission(budget_id, 'manage'));
create policy transactions_view_authorized on public.transactions for select using (public.has_budget_permission(budget_id, 'view') and archived_at is null);
create policy transactions_add_authorized on public.transactions for insert with check (public.has_budget_permission(budget_id, 'add') and author_id = auth.uid());
create policy transactions_edit_authorized on public.transactions for update using (public.has_budget_permission(budget_id, 'edit')) with check (public.has_budget_permission(budget_id, 'edit'));
create policy transactions_manage_authorized on public.transactions for delete using (public.has_budget_permission(budget_id, 'manage'));
create policy recurring_view_authorized on public.recurring_transactions for select using (public.has_budget_permission(budget_id, 'view'));
create policy recurring_manage_authorized on public.recurring_transactions for all using (public.has_budget_permission(budget_id, 'manage')) with check (public.has_budget_permission(budget_id, 'manage'));
create policy limits_view_authorized on public.category_limits for select using (public.has_budget_permission(budget_id, 'view'));
create policy limits_manage_authorized on public.category_limits for all using (public.has_budget_permission(budget_id, 'manage')) with check (public.has_budget_permission(budget_id, 'manage'));

-- Il job server-side da configurare in produzione deve chiamare questa funzione
-- con service_role e inserire ogni scadenza una sola volta grazie all'indice unico.
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
      insert into public.transactions (budget_id, category_id, author_id, transaction_date, amount, type, description, recurring_transaction_id)
      values (item.budget_id, item.category_id, item.author_id, due_date, item.amount, item.type, item.description, item.id)
      on conflict (recurring_transaction_id, transaction_date) where recurring_transaction_id is not null do nothing;
      created_count := created_count + 1;
      due_date := case when item.frequency = 'mensile' then (due_date + interval '1 month')::date else (due_date + interval '1 year')::date end;
    end loop;
    update public.recurring_transactions set next_insert_date = due_date where id = item.id;
  end loop;
  return created_count;
end;
$$;
