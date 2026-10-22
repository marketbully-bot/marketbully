// Shared pieces for the door's memory and its automatic steps.
// Files that start with "_" are not web addresses on Vercel; they are only
// imported by api/telegram.js, api/sync.js and api/door-cron.js.
//
// Storage is Upstash Redis, added from Vercel → Storage. Vercel puts the
// address and key into KV_REST_API_URL / KV_REST_API_TOKEN by itself.
//
// Test mode: until DOOR_MODE is set to "live" in Vercel, only Richard
// (TELEGRAM_CHAT_ID) and the Telegram ids in DOOR_TESTERS (comma separated)
// get the new door. Everyone else keeps the screenshot door.

const RURL = () => String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
const RTOK = () => String(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

export function hasStore() { return !!(RURL() && RTOK()); }

export async function r(...args) {
  const res = await fetch(RURL(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String))
  });
  const j = await res.json();
  if (j && j.error) throw new Error('store: ' + j.error);
  return j ? j.result : null;
}

export async function rp(cmds) {
  if (!cmds.length) return [];
  const res = await fetch(RURL() + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK(), 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String)))
  });
  const j = await res.json();
  return Array.isArray(j) ? j.map((x) => x.result) : [];
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmail = (e) => /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(String(e || '').trim());

export function testers() {
  const admin = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const list = String(process.env.DOOR_TESTERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (admin) list.push(admin);
  return list;
}
export function isLive() { return String(process.env.DOOR_MODE || '').trim().toLowerCase() === 'live'; }
export function newDoorFor(id) { return isLive() || testers().indexOf(String(id)) !== -1; }

export const TG = (method, payload) => fetch(
  `https://api.telegram.org/bot${String(process.env.TELEGRAM_BOT_TOKEN || '').trim()}/${method}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
).then((x) => x.json());

export function esc(v) {
  return String(v == null ? '' : v).slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// ---------- person records ----------
// d:p:<telegram id>  hash: email, name, state (waiting | in), at, inAt, upsell, nudged
export async function getPerson(id) {
  const arr = await r('HGETALL', 'd:p:' + id);
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

export async function onList(email) {
  return (await r('SISMEMBER', 'p:all', normEmail(email))) === 1;
}

// Anyone in Richard's 1House community (all levels), by username. Returns 'paid', 'free' or ''.
export const normUser = (u) => String(u || '').trim().replace(/^@+/, '').toLowerCase();
export async function onHouseUser(u) {
  const n = normUser(u);
  if (!n) return '';
  const [paid, any] = await rp([['SISMEMBER', 'u:paid', n], ['SISMEMBER', 'u:all', n]]);
  return paid === 1 ? 'paid' : any === 1 ? 'free' : '';
}

// Richard's personal 1House sign-ups. Returns 'paid', 'free' or ''.
export async function onHouse(email) {
  const e = normEmail(email);
  const [paid, any] = await rp([['SISMEMBER', 'h:paid', e], ['SISMEMBER', 'h:all', e]]);
  return paid === 1 ? 'paid' : any === 1 ? 'free' : '';
}

// Sends the single use invite and records the person as in.
// People Richard does not want in THE VAULT. Matched by Telegram name, email,
// 1House username or Telegram id. More can be added to the d:block set
// (values: an email, "u:<1house username>", or "id:<telegram id>").
const BLOCK_NAMES = ['jalen jones'];
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
export async function isBlocked(id, name, email, house) {
  const n = normName(name);
  if (n && BLOCK_NAMES.some((b) => n === b || n.startsWith(b + ' '))) return true;
  if (!hasStore()) return false;
  try {
    const keys = ['id:' + id];
    if (email) keys.push(normEmail(email));
    if (house) keys.push('u:' + String(house).toLowerCase());
    const res = await rp(keys.map((k) => ['SISMEMBER', 'd:block', k]));
    return res.some((x) => Number(x) === 1);
  } catch (e) { return false; }
}

export async function letIn(id, name, email, how, via) {
  {
    const p0 = hasStore() ? await getPerson(id) : {};
    if (await isBlocked(id, name || p0.name, email || p0.email, p0.house)) {
      await TG('sendMessage', { chat_id: id, text: 'I can\u2019t send a Vault invite for this account. If you think that is a mistake, reply here.' });
      if (hasStore()) await rp([['HSET', 'd:p:' + id, 'state', 'blocked'], ['SREM', 'd:waiting', id]]);
      return { ok: false, why: 'this person is on your do-not-admit list, so no invite was sent' };
    }
  }
  const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
  if (!ROOM) return { ok: false, why: 'SIGNALS_CHAT_ID is not set' };
  // Already in the room (an existing member confirming their seat): no invite needed.
  let already = false;
  try {
    const m = await TG('getChatMember', { chat_id: ROOM, user_id: Number(id) });
    const st = m && m.ok && m.result ? m.result.status : '';
    already = st === 'member' || st === 'administrator' || st === 'creator' || (st === 'restricted' && m.result.is_member);
  } catch (e) { already = false; }
  if (already) {
    await TG('sendMessage', { chat_id: id, parse_mode: 'HTML', text: '\u2705 <b>Seat confirmed.</b> You\u2019re all set in THE VAULT. Nothing else to do. \ud83e\udd1d' });
    if (hasStore()) {
      const cmds = [['HSET', 'd:p:' + id, 'state', 'in', 'inAt', now(), 'name', name || '', 'via', via || 'broker', 'upsell', '1'], ['SREM', 'd:waiting', id], ['SADD', 'd:in', id]];
      if (email) cmds.push(['HSET', 'd:p:' + id, 'email', normEmail(email)], ['SET', 'd:claim:' + normEmail(email), id]);
      await rp(cmds);
    }
    return { ok: true, confirmed: true };
  }
  const inv = await TG('createChatInviteLink', {
    chat_id: ROOM, member_limit: 1, expire_date: now() + DAY, name: 'door ' + id
  });
  if (!inv || !inv.ok) return { ok: false, why: (inv && inv.description) || 'invite failed' };
  await TG('sendMessage', {
    chat_id: id,
    parse_mode: 'HTML',
    text:
      (how === 'later' ? '⏰ Checked again and you’re cleared.\n\n' : '✅ <b>Found you. YOU’RE IN.</b>\n\n') +
      'Here is your private invite to THE VAULT 👇\n\n' + inv.result.invite_link +
      '\n\n⚡ It works <b>once</b>, it is yours only, and it dies in 24 hours. Use it now.\n\nWelcome to the room. 🤝'
  });
  if (hasStore()) {
    const cmds = [
      ['HSET', 'd:p:' + id, 'state', 'in', 'inAt', now(), 'name', name || '', 'via', via || 'broker'],
      ['SREM', 'd:waiting', id],
      ['SADD', 'd:in', id]
    ];
    if (email) cmds.push(['HSET', 'd:p:' + id, 'email', normEmail(email)], ['SET', 'd:claim:' + normEmail(email), id]);
    await rp(cmds);
  }
  return { ok: true };
}

export function upsellMessage(id) {
  return {
    chat_id: id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      '🔥 <b>You’ve had a few days in THE VAULT.</b> The calls are the start.\n\n' +
      'Want the reasoning behind every one? <b>Digital Stream</b> on 1House gets you every live session I teach, ' +
      'the MB Strategy taught in modules, and the full replay library.\n\n' +
      '$99.99 a month, cancel any time. On the checkout page pick <b>Digital Stream All-Access</b>.',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📺 Get Digital Stream', url: 'https://subscribe.1house.tv/MARKETBULLY' }],
        [{ text: '💬 I have a question', callback_data: 'ask' }]
      ]
    }
  };
}

export async function qualifies(p) {
  if (p.email && await onList(p.email)) return true;
  if (p.house && (await onHouseUser(p.house)) === 'paid') return true;
  if (p.email && (await onHouse(p.email)) === 'paid') return true;
  return false;
}

// VIPs are never paused: Richard, admins of THE VAULT (make Yen, Arin and Amina admins), and ids in DOOR_VIPS.
export async function isVip(id) {
  if (String(id) === String(process.env.TELEGRAM_CHAT_ID || '').trim()) return true;
  if (String(process.env.DOOR_VIPS || '').split(',').map((x) => x.trim()).indexOf(String(id)) !== -1) return true;
  const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
  try {
    const m = await TG('getChatMember', { chat_id: ROOM, user_id: Number(id) });
    const st = m && m.ok && m.result ? m.result.status : '';
    return st === 'creator' || st === 'administrator';
  } catch (e) { return false; }
}

export function seatMessage(id, kind) {
  const buttons = { inline_keyboard: [
    [{ text: '\ud83d\udcfa Get Digital Stream', url: 'https://subscribe.1house.tv/MARKETBULLY' }],
    [{ text: 'Open my trading account', url: String(process.env.BROKER_LINK || '').trim() || 'https://themarketbully.com/steps' }]
  ] };
  const text = kind === 'warn'
    ? '\u26a0\ufe0f <b>Your seat in THE VAULT needs attention.</b>\n\nYour seat is held by a paid 1House plan or a trading account opened through my link, and I can\u2019t see either one on my side right now.\n\nYou have <b>7 days</b>. Renew Digital Stream or open your trading account and your seat stays. If you think this is a mistake, reply here.'
    : kind === 'remind'
    ? '\u23f0 <b>4 days left</b> to keep your seat in THE VAULT. Renew Digital Stream or open your trading account and you\u2019re all set.'
    : '\u23f8 <b>Your seat in THE VAULT is paused.</b>\n\nNo hard feelings. The moment you renew Digital Stream or open your trading account through my link, I let you back in automatically, usually the next morning.';
  return { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true, text, reply_markup: buttons };
}

// Adds or tags a contact in Viato. Best effort; never blocks the door.
export async function viato(email, name, tags, opts) {
  const key = String(process.env.VIATO_API_KEY || '').trim();
  if (!key || !email) return false;
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  // Viato makes a new copy of a contact every time we send the same email, so
  // remember what we already sent and only send tags this person has not had.
  const e = normEmail(email);
  // Who goes into Viato: everyone in Richard's 1House community, at every level
  // (opts.oneHouse, or a personal 1House sign-up in h:all), and only his direct
  // level-1 trading-account clients (p:l1). Broker level 2 and below are other
  // leaders' people; they can still use the door, but never go into Viato.
  if (hasStore() && !(opts && opts.oneHouse)) {
    try {
      const lv = await rp([['SISMEMBER', 'h:all', e], ['SISMEMBER', 'p:l1', e]]);
      if (Number(lv[0]) !== 1 && Number(lv[1]) !== 1) return false;
    } catch (err) { return false; }
  }
  if (hasStore()) {
    try {
      const had = await rp(tags.map((t) => ['SISMEMBER', 'v:tags:' + e, t]));
      tags = tags.filter((t, i) => Number(had[i]) !== 1);
      if (!tags.length) return true;
    } catch (err) {}
  }
  try {
    const res = await fetch('https://viato.ai/api/v1/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ first_name: parts[0] || 'Friend', last_name: parts.slice(1).join(' '), email: normEmail(email), tags, notes: 'Added by THE VAULT door: ' + tags.join(', ') })
    });
    const ok = res.status >= 200 && res.status < 300;
    if (ok && hasStore()) { try { await r('SADD', 'v:tags:' + e, ...tags); } catch (err) {} }
    return ok;
  } catch (err) { return false; }
}

// The daily round: re-check waiting people, nudge, give up after a week,
// and send the Digital Stream message three days after someone gets in.
export async function dailyRound(alert) {
  const out = { cleared: 0, nudged: 0, dropped: 0, upsold: 0 };
  const LINK = String(process.env.BROKER_LINK || '').trim() || 'https://themarketbully.com/steps';
  const waiting = (await r('SMEMBERS', 'd:waiting')) || [];
  for (const id of waiting) {
    if (!newDoorFor(id)) continue;
    const p = await getPerson(id);
    const age = now() - Number(p.at || now());
    const house = p.email ? await onHouse(p.email) : (p.house ? await onHouseUser(p.house) : '');
    if ((p.email && await onList(p.email)) || house === 'paid') {
      const res = await letIn(id, p.name, p.email, 'later', house === 'paid' && !(p.email && await onList(p.email)) ? '1house' : 'broker');
      if (res.ok) {
        out.cleared++;
        if (alert) await alert({ parse_mode: 'HTML', text: `✅ <b>${esc(p.name || 'Someone')}</b> was let into THE VAULT automatically. Their email showed up on today’s partner list.\n${esc(p.email)}` });
      }
      continue;
    }
    // Free 1House members keep waiting until they go paid or open an account. No "can't find you" message.
    if (house === 'free') continue;
    if (age > 7 * DAY) {
      await TG('sendMessage', { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true,
        text: 'I still can’t find that email on my side. No stress. When you’re ready, open your account through your steps page and type the email here again 👇\n\nhttps://themarketbully.com/steps' });
      await rp([['SREM', 'd:waiting', id], ['HSET', 'd:p:' + id, 'state', 'gave-up']]);
      out.dropped++;
      continue;
    }
    if (age > DAY && p.nudged !== '1') {
      await TG('sendMessage', { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `⏰ Still not seeing <b>${esc(p.email)}</b> on my side.\n\nDid you open your account through the button on your steps page? If you signed up with a different email, just type it here.`,
        reply_markup: { inline_keyboard: [[{ text: 'Open my trading account', url: LINK }]] } });
      await r('HSET', 'd:p:' + id, 'nudged', '1');
      out.nudged++;
    }
  }
  // ---- seat checks: qualify = trading account on the list, or a paid 1House plan ----
  const listsReady = Number((await r('SCARD', 'p:all')) || 0) > 0 && Number((await r('SCARD', 'u:all')) || 0) > 0;
  const inside = (await r('SMEMBERS', 'd:in')) || [];
  out.warned = 0; out.reminded = 0; out.paused = 0;
  for (const id of inside) {
    if (!newDoorFor(id)) continue;
    const p = await getPerson(id);
    if (p.blockAlerted !== '1' && (await isBlocked(id, p.name, p.email, p.house))) {
      if (alert) await alert({ parse_mode: 'HTML', text: `\u26d4 <b>${esc(p.name || 'Someone')}</b> is on your do-not-admit list but is inside THE VAULT. Remove them in Telegram: open THE VAULT, tap the name at the top, tap Members, find them, then Remove.` });
      await r('HSET', 'd:p:' + id, 'blockAlerted', '1');
    }
    if (listsReady && p.manual !== '1' && (p.email || p.house) && !(await isVip(id))) {
      const ok = await qualifies(p);
      if (ok) {
        if (p.warnAt) await rp([['HDEL', 'd:p:' + id, 'warnAt', 'reminded']]);
      } else if (!p.warnAt) {
        await TG('sendMessage', seatMessage(id, 'warn'));
        await r('HSET', 'd:p:' + id, 'warnAt', now());
        await viato(p.email, p.name, ['vault-seat-warning'], { oneHouse: !!p.house || p.via === '1house' });
        if (alert) await alert({ parse_mode: 'HTML', text: `\u26a0\ufe0f <b>${esc(p.name || 'A member')}</b> no longer qualifies for THE VAULT (${esc(p.email || '@' + p.house)}).\n\nThey were told. If nothing changes in 7 days, the door pauses their seat by itself.` });
        out.warned++;
        continue;
      } else if (now() - Number(p.warnAt) >= 7 * DAY) {
        const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
        const ban = await TG('banChatMember', { chat_id: ROOM, user_id: Number(id), until_date: now() + 60 });
        await TG('unbanChatMember', { chat_id: ROOM, user_id: Number(id), only_if_banned: true });
        await TG('sendMessage', seatMessage(id, 'paused'));
        await rp([['SREM', 'd:in', id], ['SADD', 'd:paused', id], ['HSET', 'd:p:' + id, 'state', 'paused', 'pausedAt', now()], ['HDEL', 'd:p:' + id, 'warnAt', 'reminded']]);
        await viato(p.email, p.name, ['vault-paused'], { oneHouse: !!p.house || p.via === '1house' });
        if (alert) await alert({ parse_mode: 'HTML', text: (ban && ban.ok ? '\u23f8 ' : '\u26a0\ufe0f Tried to pause ') + `<b>${esc(p.name || 'A member')}</b>'s seat in THE VAULT after 7 days (${esc(p.email || '@' + p.house)}).` + (ban && ban.ok ? '\nThey can come back any time they renew or open their trading account. The door lets them back in by itself.' : '\nTelegram said: ' + esc(ban && ban.description)) });
        out.paused++;
        continue;
      } else if (now() - Number(p.warnAt) >= 3 * DAY && p.reminded !== '1') {
        await TG('sendMessage', seatMessage(id, 'remind'));
        await r('HSET', 'd:p:' + id, 'reminded', '1');
        out.reminded++;
      }
    }
    if (p.via === '1house') continue;
    if (p.upsell === '1' || !p.inAt) continue;
    if (now() - Number(p.inAt) < 3 * DAY) continue;
    await TG('sendMessage', upsellMessage(id));
    await r('HSET', 'd:p:' + id, 'upsell', '1');
    out.upsold++;
  }

  // Paused people who qualify again come straight back.
  out.back = 0;
  if (listsReady) {
    const paused = (await r('SMEMBERS', 'd:paused')) || [];
    for (const id of paused) {
      if (!newDoorFor(id)) continue;
      const p = await getPerson(id);
      if (await qualifies(p)) {
        const res = await letIn(id, p.name, p.email, 'later', p.via);
        if (res.ok) {
          await rp([['SREM', 'd:paused', id]]);
          await viato(p.email, p.name, ['vault-member'], { oneHouse: !!p.house || p.via === '1house' });
          if (alert) await alert({ parse_mode: 'HTML', text: `\u2705 <b>${esc(p.name || 'A member')}</b> qualifies again and was let back into THE VAULT.` });
          out.back++;
        }
      }
    }
  }
  return out;
}
