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
export async function letIn(id, name, email, how, via) {
  const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
  if (!ROOM) return { ok: false, why: 'SIGNALS_CHAT_ID is not set' };
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
  const inside = (await r('SMEMBERS', 'd:in')) || [];
  const houseListed = Number((await r('SCARD', 'h:all')) || 0) > 0;
  for (const id of inside) {
    if (!newDoorFor(id)) continue;
    const p = await getPerson(id);
    // In through a paid 1House plan, and the plan is no longer paid: tell them once, tell Richard. Nobody is removed.
    if (houseListed && p.via === '1house' && (p.email || p.house) && p.lapsed !== '1') {
      const stillPaid = (p.house && (await onHouseUser(p.house)) === 'paid') || (p.email && (await onHouse(p.email)) === 'paid') || (p.email && await onList(p.email));
      if (!stillPaid) {
        await TG('sendMessage', { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true,
          text: 'Heads up \ud83d\udc4b Your paid 1House plan looks like it ended, and that plan is what holds your seat in THE VAULT.\n\n' +
                'To keep your seat, renew Digital Stream \ud83d\udc49 https://subscribe.1house.tv/MARKETBULLY\n\nor open your trading account through your steps page \ud83d\udc49 https://themarketbully.com/steps',
          reply_markup: { inline_keyboard: [[{ text: '\ud83d\udcfa Renew Digital Stream', url: 'https://subscribe.1house.tv/MARKETBULLY' }]] } });
        await r('HSET', 'd:p:' + id, 'lapsed', '1');
        if (alert) await alert({ parse_mode: 'HTML', text: `\u26a0\ufe0f <b>${esc(p.name || 'A member')}</b> got into THE VAULT through a paid 1House plan, and it no longer shows as paid.\n${esc(p.email || '@' + p.house)}\n\nThey were sent a renewal note. They are still in the room. Remove them in Telegram only if you want to.` });
      }
    }
    if (p.via === '1house') continue;
    if (p.upsell === '1' || !p.inAt) continue;
    if (now() - Number(p.inAt) < 3 * DAY) continue;
    await TG('sendMessage', upsellMessage(id));
    await r('HSET', 'd:p:' + id, 'upsell', '1');
    out.upsold++;
  }
  return out;
}
