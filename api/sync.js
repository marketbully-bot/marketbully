// Receives the partner list ("My Clients") once a day and saves it for the door.
// Called by the daily scheduled task from inside the partner area page.
// Needs SYNC_SECRET in Vercel; the caller sends it as the x-sync-key header.
// Only emails and whether they have traded are kept. No names, phones or balances.

import { hasStore, rp, r, normEmail, isEmail, dailyRound, TG } from './_door.js';

const ALERTS_ROOM = '-5310077180';
const ORIGIN = 'https://members.livvglobal.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-sync-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const SECRET = String(process.env.SYNC_SECRET || '').trim();
  if (!SECRET || req.headers['x-sync-key'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad key' });
  if (!hasStore()) return res.status(500).json({ ok: false, error: 'no storage' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const rows = Array.isArray(body.clients) ? body.clients : [];
  const all = new Set();
  const traded = new Set();
  for (const c of rows) {
    const e = normEmail(c && c.email);
    if (!isEmail(e)) continue;
    all.add(e);
    if (Number(c.volume) > 0) traded.add(e);
  }
  // Safety: never replace a real list with an empty or tiny one by mistake.
  const before = Number((await r('SCARD', 'p:all')) || 0);
  if (all.size === 0 || (before > 20 && all.size < before * 0.5)) {
    return res.status(409).json({ ok: false, error: 'list looks wrong, not saved', got: all.size, before });
  }

  const cmds = [['DEL', 'p:all:new', 'p:traded:new']];
  const a = [...all]; const t = [...traded];
  for (let i = 0; i < a.length; i += 200) cmds.push(['SADD', 'p:all:new', ...a.slice(i, i + 200)]);
  for (let i = 0; i < t.length; i += 200) cmds.push(['SADD', 'p:traded:new', ...t.slice(i, i + 200)]);
  cmds.push(['RENAME', 'p:all:new', 'p:all']);
  if (t.length) cmds.push(['RENAME', 'p:traded:new', 'p:traded']); else cmds.push(['DEL', 'p:traded']);
  cmds.push(['HSET', 'p:meta', 'updated', new Date().toISOString(), 'count', a.length, 'traded', t.length]);
  await rp(cmds);

  // Anyone waiting at the door whose email just showed up gets in now.
  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  let round = null;
  try { round = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS }, p))); } catch (e) { round = { error: String(e) }; }

  return res.status(200).json({ ok: true, saved: a.length, traded: t.length, round });
}
