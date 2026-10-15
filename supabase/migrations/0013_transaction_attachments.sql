-- Foto degli scontrini e delle fatture collegate ai movimenti.
alter table public.categories
  add column if not exists allow_attachments boolean not null default false;

create table if not exists public.transaction_attachments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  budget_id uuid not null references public.budgets(id) on delete cascade,
  object_path text not null unique,
  file_name text not null,
  content_type text not null check (content_type in ('image/jpeg')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 8388608),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists transaction_attachments_transaction_idx
  on public.transaction_attachments (transaction_id, created_at);

alter table public.transaction_attachments enable row level security;
grant select, insert on public.transaction_attachments to authenticated;

create policy transaction_attachments_view_authorized
  on public.transaction_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.transactions t
      where t.id = transaction_id
        and t.budget_id = transaction_attachments.budget_id
        and t.archived_at is null
        and public.has_budget_permission(t.budget_id, 'view')
    )
  );

create policy transaction_attachments_add_authorized
  on public.transaction_attachments
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id
        and t.budget_id = transaction_attachments.budget_id
        and t.archived_at is null
        and exists (select 1 from public.categories c where c.id = t.category_id and c.allow_attachments)
        and (
          (t.author_id = (select auth.uid()) and public.has_budget_permission(t.budget_id, 'add'))
          or public.has_budget_permission(t.budget_id, 'edit')
        )
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transaction-attachments', 'transaction-attachments', false, 8388608, array['image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy transaction_attachments_storage_view
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'transaction-attachments'
    and exists (
      select 1 from public.transactions t
      where t.id::text = (storage.foldername(name))[2]
        and t.budget_id::text = (storage.foldername(name))[1]
        and t.archived_at is null
        and public.has_budget_permission(t.budget_id, 'view')
    )
  );

create policy transaction_attachments_storage_cleanup
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'transaction-attachments'
    and exists (
      select 1 from public.transactions t
      where t.id::text = (storage.foldername(name))[2]
        and t.budget_id::text = (storage.foldername(name))[1]
        and (
          (t.author_id = (select auth.uid()) and public.has_budget_permission(t.budget_id, 'add'))
          or public.has_budget_permission(t.budget_id, 'edit')
        )
    )
  );

create policy transaction_attachments_storage_add
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'transaction-attachments'
    and exists (
      select 1 from public.transactions t
      where t.id::text = (storage.foldername(name))[2]
        and t.budget_id::text = (storage.foldername(name))[1]
        and t.archived_at is null
        and exists (select 1 from public.categories c where c.id = t.category_id and c.allow_attachments)
        and (
          (t.author_id = (select auth.uid()) and public.has_budget_permission(t.budget_id, 'add'))
          or public.has_budget_permission(t.budget_id, 'edit')
        )
    )
  );

notify pgrst, 'reload schema';
