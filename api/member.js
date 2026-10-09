// The member area's sign-in. No passwords and no access codes.
//
// How it works:
//   1. On the site, a member taps "Sign in with Telegram". That opens the door
//      with ?start=members.
//   2. The door (api/telegram.js) checks they are in THE VAULT and sends them a
//      private button: https://themarketbully.com/members?k=<signed pass>.
//      The pass is good for 10 minutes.
//   3. The site posts that pass here. If it is genuine and they are still in
//      THE VAULT, this sets a sign-in cookie that lasts 30 days.
//   4. Every time the member area opens, it asks here again, and this checks
//      with Telegram that the person is STILL in THE VAULT. Remove someone
//      from the room and they lose the member area at once.
//
// Uses secrets already saved in Vercel. Nothing new to set up:
//   TELEGRAM_BOT_TOKEN  - also signs the passes, so they cannot be forged
//   SIGNALS_CHAT_ID     - THE VAULT
//   TELEGRAM_CHAT_ID    - Richard, for the "finished onboarding" message

const COOKIE = 'mb_member';
const THIRTY_DAYS = 60 * 60 * 24 * 30;

async function keyFor(botToken) {
  const c = await import('node:crypto');
  return c.createHash('sha256').update('mb-member:' + botToken).digest();
}

async function signPass(payload, botToken) {
  const c = await import('node:crypto');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = c.createHmac('sha256', await keyFor(botToken)).update(body).digest('base64url');
  return body + '.' + sig;
}

// Returns the payload if the pass is genuine and not expired, otherwise null.
async function readPass(pass, botToken) {
  try {
    const c = await import('node:crypto');
    const parts = String(pass || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const want = c.createHmac('sha256', await keyFor(botToken)).update(parts[0]).digest();
    const got = Buffer.from(parts[1], 'base64url');
    if (got.length !== want.length || !c.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!p || !p.u || !p.e || Date.now() / 1000 > p.e) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function cookieFrom(req) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

// Asks Telegram whether this person is in THE VAULT right now.
//   { member: true,  name, username }  in the room
//   { member: false }                  not in it
//   { member: null }                   Telegram could not be reached
async function inTheVault(botToken, room, userId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: room, user_id: userId })
    });
    const out = await r.json();
    if (!out || !out.ok || !out.result) {
      // Telegram answers "user not found" style errors for people who never joined.
      return { member: out && out.error_code === 400 ? false : null };
    }
    const st = out.result.status;
    const u = out.result.user || {};
    const inRoom = st === 'creator' || st === 'administrator' || st === 'member' ||
                   (st === 'restricted' && !!out.result.is_member);
    return {
      member: inRoom,
      name: String(u.first_name || '').slice(0, 40),
      username: String(u.username || '').slice(0, 40)
    };
  } catch (e) {
    return { member: null };
  }
}

function esc(v) {
  return String(v == null ? '' : v).slice(0, 120)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
  const ADMIN = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!TOKEN || !ROOM) return res.status(503).json({ ok: false, reason: 'not-configured' });

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  if (req.method === 'POST' && body.action === 'signout') {
    setCookie(res, '', 0);
    return res.status(200).json({ ok: true });
  }

  // Who is this? Either a fresh pass from the door, or the sign-in cookie.
  let who = null;
  let fresh = false;
  if (req.method === 'POST' && body.k) {
    who = await readPass(body.k, TOKEN);
    if (!who || who.t !== 'l') return res.status(401).json({ ok: false, reason: 'link-expired' });
    fresh = true;
  } else {
    who = await readPass(cookieFrom(req), TOKEN);
    if (!who || who.t !== 's') return res.status(401).json({ ok: false, reason: 'signed-out' });
  }

  if (fresh) {
    const session = await signPass(
      { t: 's', u: who.u, e: Math.floor(Date.now() / 1000) + THIRTY_DAYS },
      TOKEN
    );
    setCookie(res, session, THIRTY_DAYS);
  }

  const seat = await inTheVault(TOKEN, ROOM, who.u);
  if (seat.member === null) return res.status(502).json({ ok: false, reason: 'try-again' });
  if (!seat.member) {
    return res.status(403).json({ ok: false, reason: 'not-member', name: seat.name || '', username: seat.username || '' });
  }
  who.n = seat.name; who.h = seat.username;

  if (req.method === 'POST' && body.action === 'done') {
    if (ADMIN) {
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN,
            parse_mode: 'HTML',
            text:
              `🎓 <b>${esc(who.n || 'A member')}</b> finished member onboarding.\n` +
              (who.h ? `@${esc(who.h)}\n` : '') +
              `id ${esc(who.u)}\n\n` +
              'All six steps ticked: apps, five lessons, quiz, hello in the chat, first live session.'
          })
        });
      } catch (e) { /* the member still sees their confirmation */ }
    }
    return res.status(200).json({ ok: true, sent: true });
  }

  // A link that opens THE VAULT for someone who is already in it.
  const inner = /^-100(\d+)$/.exec(ROOM);
  return res.status(200).json({
    ok: true,
    name: who.n || '',
    username: who.h || '',
    chat: inner ? `https://t.me/c/${inner[1]}/999999999` : ''
  });
}
