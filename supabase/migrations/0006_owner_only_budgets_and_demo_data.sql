-- MyBudget: ogni budget appartiene esclusivamente al suo proprietario.
-- L'amministratore continua a gestire gli account e le categorie, ma non legge
-- i budget o i movimenti degli altri utenti.

alter table public.profiles add column if not exists email text;
alter table public.transactions add column if not exists is_received boolean not null default true;
alter table public.recurring_transactions add column if not exists is_received boolean not null default true;

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and (p.email is null or p.email <> u.email);

create or replace function public.has_budget_permission(target_budget uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.budgets b
    join public.budget_members bm on bm.budget_id = b.id
    join public.profiles p on p.id = bm.user_id
    where b.id = target_budget
      and b.created_by = auth.uid()
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

drop policy if exists budgets_view_authorized on public.budgets;
drop policy if exists budgets_manage_admin_or_member on public.budgets;
drop policy if exists budgets_insert_own on public.budgets;
drop policy if exists budgets_update_authorized on public.budgets;
drop policy if exists budgets_delete_authorized on public.budgets;

create policy budgets_view_owner on public.budgets
  for select using (created_by = auth.uid() and archived_at is null);
create policy budgets_insert_own on public.budgets
  for insert with check (created_by = auth.uid());
create policy budgets_update_owner on public.budgets
  for update using (created_by = auth.uid())
  with check (created_by = auth.uid());
create policy budgets_delete_owner on public.budgets
  for delete using (created_by = auth.uid());

drop policy if exists members_view_authorized on public.budget_members;
drop policy if exists members_manage_authorized on public.budget_members;
drop policy if exists members_insert_own_budget on public.budget_members;

create policy members_view_owner on public.budget_members
  for select using (
    exists (
      select 1 from public.budgets b
      where b.id = budget_id and b.created_by = auth.uid()
    )
  );
create policy members_manage_owner on public.budget_members
  for all using (public.has_budget_permission(budget_id, 'manage'))
  with check (public.has_budget_permission(budget_id, 'manage'));
create policy members_insert_own_budget on public.budget_members
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.budgets b
      where b.id = budget_id and b.created_by = auth.uid()
    )
  );

-- Il profilo demo può usare il proprio portafoglio, senza alcun accesso ai dati admin.
do $$
declare
  demo_id uuid := '571eebe5-3ee5-4d2a-a4d3-5240f5795963';
  demo_budget_id uuid;
  category_id uuid;
  movement record;
begin
  select id into demo_budget_id
  from public.budgets
  where created_by = demo_id and name = 'Portafoglio personale demo' and archived_at is null
  limit 1;

  if demo_budget_id is null then
    raise notice 'Portafoglio personale demo non trovato: nessun movimento inserito.';
    return;
  end if;

  insert into public.budget_members (budget_id, user_id, can_view, can_add, can_edit, can_manage)
  values (demo_budget_id, demo_id, true, true, true, false)
  on conflict (budget_id, user_id) do update set
    can_view = true,
    can_add = true,
    can_edit = true,
    can_manage = false;

  for movement in
    select * from (values
      ('2026-01-05'::date, 1900.00::numeric, 'entrata', 'Stipendio gennaio', 'Stipendio', true),
      ('2026-01-11'::date, 245.80::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-01-18'::date, 82.40::numeric, 'uscita', 'Luce e gas', 'Utenze', true),
      ('2026-01-27'::date, 64.00::numeric, 'uscita', 'Carburante', 'Trasporti', true),
      ('2026-02-05'::date, 1900.00::numeric, 'entrata', 'Stipendio febbraio', 'Stipendio', true),
      ('2026-02-10'::date, 218.35::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-02-14'::date, 95.00::numeric, 'uscita', 'Condominio casa al mare', 'Condominio', true),
      ('2026-02-21'::date, 71.50::numeric, 'uscita', 'Farmacia', 'Salute', true),
      ('2026-03-05'::date, 1900.00::numeric, 'entrata', 'Stipendio marzo', 'Stipendio', true),
      ('2026-03-09'::date, 274.60::numeric, 'uscita', 'Spesa mensile', 'Spesa alimentare', true),
      ('2026-03-16'::date, 118.00::numeric, 'uscita', 'Manutenzione ordinaria', 'Manutenzione', true),
      ('2026-03-26'::date, 42.00::numeric, 'uscita', 'Cinema e cena', 'Tempo libero', true),
      ('2026-04-05'::date, 1900.00::numeric, 'entrata', 'Stipendio aprile', 'Stipendio', true),
      ('2026-04-12'::date, 86.50::numeric, 'uscita', 'Utenze casa al mare', 'Utenze', true),
      ('2026-04-18'::date, 231.75::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-04-25'::date, 79.00::numeric, 'uscita', 'Carburante', 'Trasporti', true),
      ('2026-05-05'::date, 1900.00::numeric, 'entrata', 'Stipendio maggio', 'Stipendio', true),
      ('2026-05-12'::date, 240.20::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-05-20'::date, 132.00::numeric, 'uscita', 'Pulizia prima dell’estate', 'Pulizia', true),
      ('2026-05-28'::date, 97.00::numeric, 'uscita', 'Piccole riparazioni', 'Casa al Mare', true),
      ('2026-06-05'::date, 1900.00::numeric, 'entrata', 'Stipendio giugno', 'Stipendio', true),
      ('2026-06-15'::date, 1200.00::numeric, 'entrata', 'Affitto estivo casa al mare', 'Casa al Mare', true),
      ('2026-06-12'::date, 310.00::numeric, 'uscita', 'Pulizia e preparazione affitto', 'Pulizia', true),
      ('2026-06-18'::date, 124.40::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-06-23'::date, 95.00::numeric, 'uscita', 'Utenze casa al mare', 'Utenze', true),
      ('2026-07-05'::date, 1900.00::numeric, 'entrata', 'Stipendio luglio', 'Stipendio', true),
      ('2026-07-10'::date, 1650.00::numeric, 'entrata', 'Affitto estivo casa al mare', 'Casa al Mare', true),
      ('2026-07-14'::date, 145.00::numeric, 'uscita', 'Pulizia casa al mare', 'Pulizia', true),
      ('2026-07-20'::date, 132.70::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-07-26'::date, 88.00::numeric, 'uscita', 'Cena e attività estive', 'Tempo libero', true),
      ('2026-08-05'::date, 1900.00::numeric, 'entrata', 'Stipendio agosto', 'Stipendio', true),
      ('2026-08-12'::date, 1500.00::numeric, 'entrata', 'Affitto estivo casa al mare', 'Casa al Mare', true),
      ('2026-08-16'::date, 155.00::numeric, 'uscita', 'Pulizia e piccole forniture', 'Casa al Mare', true),
      ('2026-08-22'::date, 105.00::numeric, 'uscita', 'Utenze casa al mare', 'Utenze', true),
      ('2026-08-28'::date, 128.90::numeric, 'uscita', 'Spesa settimanale', 'Spesa alimentare', true),
      ('2026-09-02'::date, 1900.00::numeric, 'entrata', 'Stipendio settembre', 'Stipendio', true),
      ('2026-09-08'::date, 275.00::numeric, 'uscita', 'Spesa di rientro', 'Spesa alimentare', true),
      ('2026-09-15'::date, 950.00::numeric, 'entrata', 'Affitto settembre previsto', 'Casa al Mare', false),
      ('2026-09-18'::date, 96.00::numeric, 'uscita', 'Utenze casa al mare', 'Utenze', true)
    ) as item(transaction_date, amount, movement_type, description, category_name, is_received)
  loop
    select id into category_id
    from public.categories
    where owner_id = demo_id and lower(name) = lower(movement.category_name) and is_archived = false
    limit 1;

    if category_id is not null and not exists (
      select 1 from public.transactions t
      where t.budget_id = demo_budget_id
        and t.transaction_date = movement.transaction_date
        and t.description = '[DEMO] ' || movement.description
    ) then
      insert into public.transactions (budget_id, category_id, author_id, transaction_date, amount, type, description, is_received)
      values (demo_budget_id, category_id, demo_id, movement.transaction_date, movement.amount, movement.movement_type::public.transaction_type, '[DEMO] ' || movement.description, movement.is_received);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
