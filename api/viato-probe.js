// Temporary, read-only check of what Viato's public API supports for finding
// an existing contact. Protected by SYNC_SECRET. Will be removed after use.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const SECRET = String(process.env.SYNC_SECRET || '').trim();
  if (!SECRET || req.headers['x-sync-key'] !== SECRET) return res.status(401).end();
  const key = String(process.env.VIATO_API_KEY || '').trim();
  const email = String(req.query.email || '');
  const base = 'https://viato.ai/api/v1/contacts';
  const urls = [
    base + '?email=' + encodeURIComponent(email),
    base + '?search=' + encodeURIComponent(email),
    base + '?q=' + encodeURIComponent(email),
    base + '?limit=1'
  ];
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key } });
      const t = await r.text();
      out.push({ u: u.replace(email, '<email>'), status: r.status, allow: r.headers.get('allow'), body: t.slice(0, 600) });
    } catch (e) { out.push({ u, err: String(e) }); }
  }
  // Which methods does the single-contact route accept?
  for (const m of ['OPTIONS']) {
    try { const r = await fetch(base + '/1', { method: m, headers: { Authorization: 'Bearer ' + key } }); out.push({ m, status: r.status, allow: r.headers.get('allow'), acam: r.headers.get('access-control-allow-methods') }); } catch (e) {}
  }
  return res.status(200).json(out);
}
