const json = (response, status, body) => response.status(status).json(body);

export default async function handler(request, response) {
  if (request.method !== 'POST') return json(response, 405, { error: 'Metodo non consentito.' });

  const authorization = request.headers.authorization || '';
  const accessToken = authorization.replace(/^Bearer\s+/i, '');
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !supabaseUrl || !publicKey || !serviceRoleKey) return json(response, 500, { error: 'Configurazione server incompleta.' });

  const publicHeaders = { apikey: publicKey, Authorization: `Bearer ${accessToken}` };
  const actorResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: publicHeaders });
  const actor = await actorResponse.json().catch(() => null);
  if (!actorResponse.ok || !actor?.id) return json(response, 401, { error: 'Sessione amministratore non valida.' });

  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(actor.id)}&select=role,status&limit=1`,
    { headers: { ...publicHeaders, Accept: 'application/json' } },
  );
  const profiles = await profileResponse.json().catch(() => []);
  const actorProfile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profileResponse.ok) return json(response, 500, { error: 'Impossibile verificare i permessi amministrativi.' });
  if (actorProfile?.role !== 'admin' || actorProfile.status !== 'attivo') return json(response, 403, { error: 'Solo un amministratore attivo può creare utenti.' });

  let body = request.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return json(response, 400, { error: 'Richiesta non valida.' }); }
  }
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!firstName || !lastName || !email || password.length < 8) return json(response, 400, { error: 'Nome, cognome, email e una password di almeno 8 caratteri sono obbligatori.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(response, 400, { error: 'Inserisci un indirizzo email valido.' });

  const adminHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
  const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName },
    }),
  });
  const created = await createResponse.json().catch(() => null);
  if (!createResponse.ok || !created?.id) return json(response, 400, { error: created?.msg || created?.message || 'Impossibile creare l’utente.' });

  const profileResponseAfterCreate = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
    id: created.id,
    first_name: firstName,
    last_name: lastName,
    email,
    role: 'standard',
    status: 'in_attesa',
    }),
  });
  if (!profileResponseAfterCreate.ok) return json(response, 500, { error: 'Account creato, ma impossibile completare il profilo applicativo.' });

  return json(response, 201, { ok: true });
}
