// Receives the partner list ("My Clients") once a day and saves it for the door.
// Called by the daily scheduled task from inside the partner area page.
// Needs SYNC_SECRET in Vercel; the caller sends it as the x-sync-key header.
// Only emails and whether they have traded are kept. No names, phones or balances.
//
// The 1House lists (onehouse + community) are now also pulled server-side by
// api/pull-1house.js on a cron; both paths call the same saveOneHouse /
// saveCommunity in _sync.js, so this endpoint still works as a fallback.

import { hasStore, rp, r, normEmail, isEmail, dailyRound, TG, viato } from './_door.js';
import { saveOneHouse, saveCommunity } from './_sync.js';

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
  let out = { ok: true };

  // Richard's personal 1House sign-ups: [{ email, name, paid }]
  if (Array.isArray(body.onehouse)) out = Object.assign(out, await saveOneHouse(body.onehouse));

  // Richard's whole 1House community, every level, by username: [{ u, paid }]
  if (Array.isArray(body.community)) out = Object.assign(out, await saveCommunity(body.community));

  const rows = Array.isArray(body.clients) ? body.clients : [];
  if (!rows.length) {
    const ALERTS0 = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
    try { out.round = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS0 }, p))); } catch (e) { out.round = { error: String(e) }; }
    return res.status(200).json(out);
  }
  const all = new Set();
  const traded = new Set();
  const funded = new Set();
  const l1 = new Set(); let hasLevels = false;
  const cname = {};
  for (const c of rows) {
    const e = normEmail(c && c.email);
    if (!isEmail(e)) continue;
    all.add(e);
    if (Number(c.volume) > 0) traded.add(e);
    if (Number(c.balance) > 0) funded.add(e);
    if (c.name) cname[e] = String(c.name).slice(0, 80);
    if (c.level !== undefined && c.level !== null && c.level !== '') { hasLevels = true; if (String(c.level).trim() === '1') l1.add(e); }
  }
  // Safety: never replace a real list with an empty or tiny one by mistake.
  const before = Number((await r('SCARD', 'p:all')) || 0);
  if (all.size === 0 || (before > 20 && all.size < before * 0.5)) {
    return res.status(409).json({ ok: false, error: 'list looks wrong, not saved', got: all.size, before });
  }

  // Who moved up a step since the last refresh? Compared before the lists are replaced.
  // Only changes count, so people already on the list never get these emails.
  // The very first time a list is seen it is only recorded.
  const hadFunded = Number((await r('EXISTS', 'p:funded:seen')) || 0) === 1;
  const prevAll = new Set(before > 0 ? ((await r('SMEMBERS', 'p:all')) || []).map(String) : []);
  const prevTraded = new Set(((await r('SMEMBERS', 'p:traded')) || []).map(String));
  const prevFunded = new Set(((await r('SMEMBERS', 'p:funded')) || []).map(String));
  const moves = [];
  for (const e of all) {
    if (/@themarketbully\.com$/.test(e)) continue;
    if (!l1.has(e)) continue; // level 1 only; level 2 and below belong to other leaders' emails
    let tag = '';
    if (hadFunded && funded.has(e) && !prevFunded.has(e)) tag = 'rung-3-funded';
    else if (before > 0 && traded.has(e) && !prevTraded.has(e)) tag = 'rung-4-trading';
    else if (before > 0 && !prevAll.has(e) && !funded.has(e)) tag = 'rung-2-registered';
    if (tag) moves.push([e, tag]);
  }

  const cmds = [['DEL', 'p:all:new', 'p:traded:new', 'p:funded:new']];
  const a = [...all]; const t = [...traded]; const f = [...funded];
  for (let i = 0; i < a.length; i += 200) cmds.push(['SADD', 'p:all:new', ...a.slice(i, i + 200)]);
  for (let i = 0; i < t.length; i += 200) cmds.push(['SADD', 'p:traded:new', ...t.slice(i, i + 200)]);
  for (let i = 0; i < f.length; i += 200) cmds.push(['SADD', 'p:funded:new', ...f.slice(i, i + 200)]);
  cmds.push(['RENAME', 'p:all:new', 'p:all']);
  if (t.length) cmds.push(['RENAME', 'p:traded:new', 'p:traded']); else cmds.push(['DEL', 'p:traded']);
  if (f.length) cmds.push(['RENAME', 'p:funded:new', 'p:funded']); else cmds.push(['DEL', 'p:funded']);
  cmds.push(['SET', 'p:funded:seen', '1']);
  if (hasLevels) {
    const l = [...l1];
    cmds.push(['DEL', 'p:l1:new']);
    for (let i = 0; i < l.length; i += 200) cmds.push(['SADD', 'p:l1:new', ...l.slice(i, i + 200)]);
    if (l.length) cmds.push(['RENAME', 'p:l1:new', 'p:l1']); else cmds.push(['DEL', 'p:l1']);
  }
  cmds.push(['HSET', 'p:meta', 'updated', new Date().toISOString(), 'count', a.length, 'traded', t.length, 'funded', f.length]);
  await rp(cmds);

  // Start the matching email series in Viato (at most 50 a day, as a safety cap).
  const ALERTSM = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  const sentMoves = { 'rung-2-registered': 0, 'rung-3-funded': 0, 'rung-4-trading': 0 };
  const queued = (((await r('SMEMBERS', 'p:moves:q')) || []).map(String)).map((x) => x.split('|'));
  const todo = queued.concat(moves);
  const now50 = todo.slice(0, 50); const later = todo.slice(50);
  for (const [e, tag] of now50) {
    if (await viato(e, cname[e] || '', [tag])) sentMoves[tag]++;
  }
  const qc = [['DEL', 'p:moves:q']];
  if (later.length) qc.push(['SADD', 'p:moves:q', ...later.map(([e, tag]) => e + '|' + tag)]);
  await rp(qc);
  out.moves = Object.assign({ waiting: later.length }, sentMoves);
  if (now50.length) {
    await TG('sendMessage', { chat_id: ALERTSM, parse_mode: 'HTML',
      text: '📈 <b>Trading account updates since yesterday</b>\n' +
            `• ${sentMoves['rung-2-registered']} opened an account (got "Do not fund it yet")\n` +
            `• ${sentMoves['rung-3-funded']} funded (got "Money is in. Come get your invite")\n` +
            `• ${sentMoves['rung-4-trading']} started trading (got "Where I actually teach")` +
            (later.length ? `\n\n${later.length} more will go out tomorrow.` : '') });
  }

  // Anyone waiting at the door whose email just showed up gets in now.
  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  let round = null;
  try { round = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS }, p))); } catch (e) { round = { error: String(e) }; }

  return res.status(200).json(Object.assign(out, { saved: a.length, traded: t.length, round }));
}
