const json = (response, status, body) => response.status(status).json(body);

const readJson = async (response) => response.json().catch(() => null);

export default async function handler(request, response) {
  if (request.method !== 'POST') return json(response, 405, { error: 'Metodo non consentito.' });

  const accessToken = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !supabaseUrl || !publicKey || !serviceRoleKey) return json(response, 500, { error: 'Configurazione server incompleta.' });

  const publicHeaders = { apikey: publicKey, Authorization: `Bearer ${accessToken}` };
  const actorResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: publicHeaders });
  const actor = await readJson(actorResponse);
  if (!actorResponse.ok || !actor?.id) return json(response, 401, { error: 'Sessione amministratore non valida.' });

  const actorProfileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(actor.id)}&select=role,status&limit=1`,
    { headers: { ...publicHeaders, Accept: 'application/json' } },
  );
  const actorProfiles = await readJson(actorProfileResponse);
  const actorProfile = Array.isArray(actorProfiles) ? actorProfiles[0] : null;
  if (!actorProfileResponse.ok) return json(response, 500, { error: 'Impossibile verificare i permessi amministrativi.' });
  if (actorProfile?.role !== 'admin' || actorProfile.status !== 'attivo') return json(response, 403, { error: 'Solo un amministratore attivo può sincronizzare gli utenti.' });

  const adminHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const authUsers = [];
  const pageSize = 1000;
  for (let page = 1; page <= 10; page += 1) {
    const usersResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${pageSize}`, { headers: adminHeaders });
    const usersPayload = await readJson(usersResponse);
    if (!usersResponse.ok) return json(response, 502, { error: usersPayload?.message || 'Impossibile leggere gli utenti di Supabase Auth.' });
    const pageUsers = Array.isArray(usersPayload?.users) ? usersPayload.users : [];
    authUsers.push(...pageUsers);
    if (pageUsers.length < pageSize) break;
  }

  const profilesResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id`, { headers: { ...adminHeaders, Accept: 'application/json' } });
  const profiles = await readJson(profilesResponse);
  if (!profilesResponse.ok || !Array.isArray(profiles)) return json(response, 502, { error: 'Impossibile leggere i profili MyBudget.' });
  const existingIds = new Set(profiles.map((profile) => profile.id));
  const missingProfiles = authUsers
    .filter((user) => user.id && !existingIds.has(user.id))
    .map((user) => ({
      id: user.id,
      first_name: String(user.user_metadata?.first_name || 'Utente').trim() || 'Utente',
      last_name: String(user.user_metadata?.last_name || 'MyBudget').trim() || 'MyBudget',
      email: user.email || null,
      role: 'standard',
      status: 'in_attesa',
    }));

  if (missingProfiles.length) {
    const insertResponse = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
      method: 'POST',
      headers: { ...adminHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(missingProfiles),
    });
    const insertPayload = await readJson(insertResponse);
    if (!insertResponse.ok) return json(response, 502, { error: insertPayload?.message || 'Impossibile creare i profili applicativi mancanti.' });
  }

  return json(response, 200, { ok: true, synced: missingProfiles.length, total: authUsers.length });
}
