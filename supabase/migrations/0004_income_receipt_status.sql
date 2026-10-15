-- MyBudget: distingue le entrate previste da quelle effettivamente incassate.
-- I movimenti storici già presenti vengono considerati effettivi.

alter table public.transactions
  add column if not exists is_received boolean not null default true;

-- Le uscite non usano ancora questo flag: per loro il movimento resta effettivo.
update public.transactions
set is_received = true
where type = 'uscita' or is_received is null;

comment on column public.transactions.is_received is
  'Per le entrate: true se il bonifico è stato incassato, false se l''entrata è solo prevista.';

-- Rende subito disponibile la nuova colonna all'API REST di Supabase.
notify pgrst, 'reload schema';
