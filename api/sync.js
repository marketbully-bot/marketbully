// Receives the partner list ("My Clients") once a day and saves it for the door.
// Called by the daily scheduled task from inside the partner area page.
// Needs SYNC_SECRET in Vercel; the caller sends it as the x-sync-key header.
// Only emails and whether they have traded are kept. No names, phones or balances.

import { hasStore, rp, r, normEmail, isEmail, dailyRound, TG } from './_door.js';

const ALERTS_ROOM = '-5310077180';
const ORIGINS = ['https://members.livvglobal.com', 'https://office.1houseglobal.com'];

export default async function handler(req, res) {
  const o = String(req.headers.origin || '');
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.indexOf(o) !== -1 ? o : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-sync-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const SECRET = String(process.env.SYNC_SECRET || '').trim();
  if (!SECRET || req.headers['x-sync-key'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad key' });
  if (!hasStore()) return res.status(500).json({ ok: false, error: 'no storage' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const out = { ok: true };

  // Richard's personal 1House sign-ups: [{ email, paid }]
  if (Array.isArray(body.onehouse)) {
    const hall = new Set(); const hpaid = new Set();
    for (const c of body.onehouse) {
      const e = normEmail(c && c.email);
      if (!isEmail(e)) continue;
      hall.add(e); if (c.paid) hpaid.add(e);
    }
    const hbefore = Number((await r('SCARD', 'h:all')) || 0);
    if (hall.size === 0 || (hbefore > 20 && hall.size < hbefore * 0.5)) {
      out.onehouse = { saved: false, error: 'list looks wrong, not saved', got: hall.size, before: hbefore };
    } else {
      const hc = [['DEL', 'h:all:new', 'h:paid:new']];
      const ha = [...hall]; const hp = [...hpaid];
      for (let i = 0; i < ha.length; i += 200) hc.push(['SADD', 'h:all:new', ...ha.slice(i, i + 200)]);
      for (let i = 0; i < hp.length; i += 200) hc.push(['SADD', 'h:paid:new', ...hp.slice(i, i + 200)]);
      hc.push(['RENAME', 'h:all:new', 'h:all']);
      if (hp.length) hc.push(['RENAME', 'h:paid:new', 'h:paid']); else hc.push(['DEL', 'h:paid']);
      hc.push(['HSET', 'h:meta', 'updated', new Date().toISOString(), 'count', ha.length, 'paid', hp.length]);
      await rp(hc);
      out.onehouse = { saved: ha.length, paid: hp.length };
    }
  }

  const rows = Array.isArray(body.clients) ? body.clients : [];
  if (!rows.length) {
    const ALERTS0 = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
    try { out.round = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS0 }, p))); } catch (e) { out.round = { error: String(e) }; }
    return res.status(200).json(out);
  }
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

  return res.status(200).json(Object.assign(out, { saved: a.length, traded: t.length, round }));
}
