// Shared save logic for the 1House lists (personal sign-ups + whole community).
//
// This is the exact code that used to live inside api/sync.js. It was pulled
// out so TWO callers can use it with identical behaviour:
//   1. api/sync.js        — the old browser-pushed POST (kept as a fallback).
//   2. api/pull-1house.js — the daily server-side cron that fetches the lists
//                           itself from the 1House API. No browser involved.
//
// Nothing here changes what gets saved or which emails/alerts go out; it only
// moved. Only emails, usernames and whether someone is paid are kept.

import { hasStore, rp, r, normEmail, isEmail, TG, viato } from './_door.js';

const ALERTS_ROOM = '-5310077180';

// Richard's personal 1House sign-ups: [{ email, name, paid }]
// Returns a result fragment, e.g. { saved, paid, new } or { saved:false, error }.
export async function saveOneHouse(onehouse) {
  if (!Array.isArray(onehouse)) return null;
  const out = {};
  const hall = new Set(); const hpaid = new Set();
  for (const c of onehouse) {
    const e = normEmail(c && c.email);
    if (!isEmail(e)) continue;
    hall.add(e); if (c.paid) hpaid.add(e);
  }
  const hbefore = Number((await r('SCARD', 'h:all')) || 0);
  // New personal sign-ups since the last refresh go into Viato with a welcome tag.
  // The very first refresh only records who is there; nobody old gets a "welcome".
  const names = {};
  for (const c of onehouse) { const e = normEmail(c && c.email); if (e) names[e] = { name: c.name || '', paid: !!c.paid }; }
  const newOnes = [];
  if (hbefore > 0) {
    const prev = new Set(((await r('SMEMBERS', 'h:all')) || []).map(String));
    for (const e of hall) if (!prev.has(e) && !/@themarketbully\.com$/.test(e)) newOnes.push(e);
  }
  if (hall.size === 0 || (hbefore > 20 && hall.size < hbefore * 0.5)) {
    out.onehouse = { saved: false, error: 'list looks wrong, not saved', got: hall.size, before: hbefore };
    return out;
  }
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
  // Is this person already on Richard's broker list? If not, they get the
  // "open your trading account" series instead of the plain upgrade series.
  const onBroker = async (e) => Number(await r('SISMEMBER', 'p:all', e)) === 1;
  for (const e of newOnes.slice(0, 50)) {
    const n = names[e] || {};
    const b = await onBroker(e);
    await viato(e, n.name, ['1house-new', n.paid ? (b ? '1house-paid' : '1house-nobroker-paid') : (b ? '1house-free' : '1house-nobroker-free')]);
  }

  // One-time catch-up for Richard's EXISTING personal sign-ups (approved 22 Oct 2026):
  // no trading account -> 1house-nobroker-free / -paid; free on his broker level 1 -> 1house-free.
  // Broker level 2 and below are left alone. Built once, then sent ~50 a day.
  try {
    const brokerReady = Number((await r('SCARD', 'p:all')) || 0) > 0 && Number((await r('EXISTS', 'p:l1')) || 0) === 1;
    if (brokerReady && Number((await r('EXISTS', 'h:bf:built')) || 0) !== 1) {
      const q = [];
      for (const e of hall) {
        if (/@themarketbully\.com$/.test(e) || newOnes.includes(e)) continue;
        const [inAll, inL1] = (await rp([['SISMEMBER', 'p:all', e], ['SISMEMBER', 'p:l1', e]])).map((x) => Number(x) === 1);
        const paid = hpaid.has(e);
        if (!inAll) q.push(e + '|' + (paid ? '1house-nobroker-paid' : '1house-nobroker-free'));
        else if (inL1 && !paid) q.push(e + '|1house-free');
      }
      const bc = [['SET', 'h:bf:built', new Date().toISOString()]];
      for (let i = 0; i < q.length; i += 200) bc.push(['SADD', 'h:bfq', ...q.slice(i, i + 200)]);
      await rp(bc);
      out.backfillQueued = q.length;
    }
    const room = Math.max(0, 50 - Math.min(newOnes.length, 50));
    if (room > 0 && Number((await r('EXISTS', 'h:bfq')) || 0) === 1) {
      const batch = ((await r('SPOP', 'h:bfq', room)) || []).map(String);
      let sentBf = 0;
      for (const x of batch) { const [e, tag] = x.split('|'); if (await viato(e, (names[e] || {}).name || '', [tag])) sentBf++; }
      out.backfillSent = sentBf;
      out.backfillLeft = Number((await r('SCARD', 'h:bfq')) || 0);
    }
  } catch (err) { out.backfillError = String(err).slice(0, 120); }
  if (newOnes.length) {
    await TG('sendMessage', { chat_id: ALERTSW, parse_mode: 'HTML',
      text: `🎉 <b>${newOnes.length} new 1House sign-up${newOnes.length > 1 ? 's' : ''} under you</b> since yesterday:\n` +
            newOnes.slice(0, 20).map((e) => '• ' + String((names[e] || {}).name || e).replace(/[<>&]/g, '') + ((names[e] || {}).paid ? ' (paid)' : ' (free)')).join('\n') +
            '\n\nThey were added to Viato and get your welcome email.' });
  }
  return out;
}

// The partner ("My Clients") list: [{ email, name, balance, volume, level }].
// Saves it, works out who moved up a rung since yesterday, and starts the
// matching Viato email series (capped at 50/day). Does NOT run the door round
// — the caller does that after. Lifted verbatim from api/sync.js so the POST
// endpoint and the server-side LivvFX cron share one code path.
// Returns { saved, traded, moves } on success, { rows: 0 } if empty, or
// { error: 'list looks wrong, not saved', got, before } if the guard trips.
export async function savePartners(rows) {
  if (!Array.isArray(rows) || !rows.length) return { rows: 0 };
  const ALERTS_ROOM = '-5310077180';
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
    return { error: 'list looks wrong, not saved', got: all.size, before };
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
  if (now50.length) {
    await TG('sendMessage', { chat_id: ALERTSM, parse_mode: 'HTML',
      text: '📈 <b>Trading account updates since yesterday</b>\n' +
            `• ${sentMoves['rung-2-registered']} opened an account (got "Do not fund it yet")\n` +
            `• ${sentMoves['rung-3-funded']} funded (got "Money is in. Come get your invite")\n` +
            `• ${sentMoves['rung-4-trading']} started trading (got "Where I actually teach")` +
            (later.length ? `\n\n${later.length} more will go out tomorrow.` : '') });
  }
  return { saved: a.length, traded: t.length, moves: Object.assign({ waiting: later.length }, sentMoves) };
}

// Richard's whole 1House community, every level, by username: [{ u, paid }]
// Returns { community: { saved, paid } } or { community: { saved:false, error } }.
export async function saveCommunity(community) {
  if (!Array.isArray(community)) return null;
  const out = {};
  const ua = new Set(); const up = new Set();
  for (const c of community) {
    const n = String((c && c.u) || '').trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(n)) continue;
    ua.add(n); if (c.paid) up.add(n);
  }
  const ubefore = Number((await r('SCARD', 'u:all')) || 0);
  if (ua.size === 0 || (ubefore > 50 && ua.size < ubefore * 0.5)) {
    out.community = { saved: false, error: 'list looks wrong, not saved', got: ua.size, before: ubefore };
    return out;
  }
  const uc = [['DEL', 'u:all:new', 'u:paid:new']];
  const aa = [...ua]; const pp = [...up];
  for (let i = 0; i < aa.length; i += 300) uc.push(['SADD', 'u:all:new', ...aa.slice(i, i + 300)]);
  for (let i = 0; i < pp.length; i += 300) uc.push(['SADD', 'u:paid:new', ...pp.slice(i, i + 300)]);
  uc.push(['RENAME', 'u:all:new', 'u:all']);
  if (pp.length) uc.push(['RENAME', 'u:paid:new', 'u:paid']); else uc.push(['DEL', 'u:paid']);
  uc.push(['HSET', 'u:meta', 'updated', new Date().toISOString(), 'count', aa.length, 'paid', pp.length]);
  await rp(uc);
  out.community = { saved: aa.length, paid: pp.length };
  return out;
}
