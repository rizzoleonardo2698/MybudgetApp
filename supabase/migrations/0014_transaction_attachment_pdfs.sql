-- Consente di salvare anche le fatture PDF insieme alle foto.
alter table public.transaction_attachments
  drop constraint if exists transaction_attachments_content_type_check;

alter table public.transaction_attachments
  add constraint transaction_attachments_content_type_check
  check (content_type in ('image/jpeg', 'application/pdf'));

update storage.buckets
set public = false,
    file_size_limit = 8388608,
    allowed_mime_types = array['image/jpeg', 'application/pdf']
where id = 'transaction-attachments';

notify pgrst, 'reload schema';
