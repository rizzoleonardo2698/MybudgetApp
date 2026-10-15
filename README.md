# MyBudget

Web app responsive per la gestione di budget personali e familiari. L’app usa Supabase per autenticazione e dati online e può essere pubblicata su Vercel.

## Requisiti

- Node.js 20 o successivo
- Un progetto Supabase configurato

## Configurazione locale

1. Installa le dipendenze con `npm install`.
2. Copia `.env.example` in `.env.local` e configura `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. Avvia l’app con `npm run dev`.

Per creare una build eseguibile usa `npm run build`.

Le funzioni amministrative in `api/admin/` richiedono anche `SUPABASE_SERVICE_ROLE_KEY` come variabile server in Vercel. Non inserirla nel frontend o nei file versionati.

## Database

Applica in ordine i file `supabase/migrations/`. La migrazione `0013_transaction_attachments.sql` abilita allegati privati ai movimenti e il relativo controllo per categoria.

Le immagini sono compresse nel browser prima del caricamento. I file restano in un bucket privato di Supabase e sono accessibili secondo le policy del budget e del movimento.

## Struttura

- `src/` — interfaccia, logica applicativa, importazione ed esportazione Excel
- `api/admin/` — funzioni server per le operazioni amministrative
- `supabase/migrations/` — schema e policy del database
- `public/template-import-movimenti.xlsx` — modello vuoto per l’importazione dei movimenti
