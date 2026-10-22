// Receives the partner list ("My Clients") once a day and saves it for the door.
// Called by the daily scheduled task from inside the partner area page.
// Needs SYNC_SECRET in Vercel; the caller sends it as the x-sync-key header.
// Only emails and whether they have traded are kept. No names, phones or balances.

import { hasStore, rp, r, normEmail, isEmail, dailyRound, TG, viato } from './_door.js';

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
    // New personal sign-ups since the last refresh go into Viato with a welcome tag.
    // The very first refresh only records who is there; nobody old gets a "welcome".
    const names = {};
    for (const c of body.onehouse) { const e = normEmail(c && c.email); if (e) names[e] = { name: c.name || '', paid: !!c.paid }; }
    const newOnes = [];
    if (hbefore > 0) {
      const prev = new Set(((await r('SMEMBERS', 'h:all')) || []).map(String));
      for (const e of hall) if (!prev.has(e) && !/@themarketbully\.com$/.test(e)) newOnes.push(e);
    }
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
      out.onehouse = { saved: ha.length, paid: hp.length, new: newOnes.length };
      const ALERTSW = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
      for (const e of newOnes.slice(0, 50)) {
        const n = names[e] || {};
        await viato(e, n.name, ['1house-new', n.paid ? '1house-paid' : '1house-free']);
      }
      if (newOnes.length) {
        await TG('sendMessage', { chat_id: ALERTSW, parse_mode: 'HTML',
          text: `\ud83c\udf89 <b>${newOnes.length} new 1House sign-up${newOnes.length > 1 ? 's' : ''} under you</b> since yesterday:\n` +
                newOnes.slice(0, 20).map((e) => '\u2022 ' + String((names[e] || {}).name || e).replace(/[<>&]/g, '') + ((names[e] || {}).paid ? ' (paid)' : ' (free)')).join('\n') +
                '\n\nThey were added to Viato and get your welcome email.' });
      }
    }
  }

  // Richard's whole 1House community, every level, by username: [{ u, paid }]
  if (Array.isArray(body.community)) {
    const ua = new Set(); const up = new Set();
    for (const c of body.community) {
      const n = String((c && c.u) || '').trim().replace(/^@+/, '').toLowerCase();
      if (!/^[a-z0-9._-]{2,40}$/.test(n)) continue;
      ua.add(n); if (c.paid) up.add(n);
    }
    const ubefore = Number((await r('SCARD', 'u:all')) || 0);
    if (ua.size === 0 || (ubefore > 50 && ua.size < ubefore * 0.5)) {
      out.community = { saved: false, error: 'list looks wrong, not saved', got: ua.size, before: ubefore };
    } else {
      const uc = [['DEL', 'u:all:new', 'u:paid:new']];
      const aa = [...ua]; const pp = [...up];
      for (let i = 0; i < aa.length; i += 300) uc.push(['SADD', 'u:all:new', ...aa.slice(i, i + 300)]);
      for (let i = 0; i < pp.length; i += 300) uc.push(['SADD', 'u:paid:new', ...pp.slice(i, i + 300)]);
      uc.push(['RENAME', 'u:all:new', 'u:all']);
      if (pp.length) uc.push(['RENAME', 'u:paid:new', 'u:paid']); else uc.push(['DEL', 'u:paid']);
      uc.push(['HSET', 'u:meta', 'updated', new Date().toISOString(), 'count', aa.length, 'paid', pp.length]);
      await rp(uc);
      out.community = { saved: aa.length, paid: pp.length };
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
  const funded = new Set();
  const cname = {};
  for (const c of rows) {
    const e = normEmail(c && c.email);
    if (!isEmail(e)) continue;
    all.add(e);
    if (Number(c.volume) > 0) traded.add(e);
    if (Number(c.balance) > 0) funded.add(e);
    if (c.name) cname[e] = String(c.name).slice(0, 80);
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
