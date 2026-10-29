// Pulls Richard's 1House lists straight from the 1House API, server-side, on a
// daily cron. This REPLACES the old browser scrape: no Claude, no browser, no
// logging in by hand, no cross-site data trip. It logs into 1House with stored
// credentials, reads the same two things the scrape read (the whole community
// genealogy by username, and Richard's personal referrals by email), and hands
// them to the same saveOneHouse / saveCommunity used by api/sync.js.
//
// Vercel sends CRON_SECRET as a bearer token (same as door-cron). Set these in
// Vercel → Settings → Environment Variables:
//   ONEHOUSE_EMAIL     — the email Richard logs into office.1houseglobal.com with
//   ONEHOUSE_PASSWORD  — that account's password
// Optional:
//   ONEHOUSE_API       — defaults to https://backend.1houseglobal.dev/api
//   ONEHOUSE_LEVELS    — defaults to "1,2,3,4,5,6-20"
//
// You can also run it by hand to test: GET /api/pull-1house with header
//   Authorization: Bearer <CRON_SECRET>

import { hasStore, TG, r } from './_door.js';
import { saveOneHouse, saveCommunity } from './_sync.js';

const ALERTS_ROOM = '-5310077180';
const API = () => String(process.env.ONEHOUSE_API || 'https://backend.1houseglobal.dev/api').trim().replace(/\/+$/, '');
const LEVELS = () => String(process.env.ONEHOUSE_LEVELS || '1,2,3,4,5,6-20').split(',').map((s) => s.trim()).filter(Boolean);

// Find the first array anywhere in a JSON object (the API wraps the rows in
// different shapes per endpoint; the old scrape did exactly this).
function findArray(o) {
  if (Array.isArray(o)) return o;
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const v = findArray(o[k]); if (v) return v; } }
  return null;
}
function lastPage(j) { const m = JSON.stringify(j).match(/"last_page":\s*(\d+)/); return m ? Number(m[1]) : 1; }

async function login() {
  const email = String(process.env.ONEHOUSE_EMAIL || '').trim();
  const password = String(process.env.ONEHOUSE_PASSWORD || '').trim();
  if (!email || !password) throw new Error('ONEHOUSE_EMAIL / ONEHOUSE_PASSWORD not set');
  const fd = new FormData();
  fd.append('email', email);
  fd.append('password', password);
  const res = await fetch(API() + '/login', { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const j = await res.json().catch(() => ({}));
  const token = j && (j.access_token || j.token || (j.data && j.data.access_token));
  if (res.status !== 200 || !token) throw new Error('login failed (' + res.status + ') ' + String(j && j.message || '').slice(0, 120));
  return String(token);
}

async function getJson(token, path) {
  const res = await fetch(API() + path, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('GET ' + path + ' -> ' + res.status);
  return res.json();
}

async function pullCommunity(token) {
  const com = [];
  for (const lv of LEVELS()) {
    let p = 1, last = 1;
    do {
      const j = await getJson(token, '/user/genealogy-list?page=' + p + '&level=' + lv);
      (findArray(j) || []).forEach((x) => com.push({
        u: String((x.user && x.user.username) || '').toLowerCase(),
        paid: x.paid_subscription === 'Yes',
        lv: String(x.level)
      }));
      last = lastPage(j);
      p++;
    } while (p <= last && p < 120);
  }
  return com;
}

async function pullReferrals(token) {
  let refs = [];
  for (let p = 1; p < 40; p++) {
    const b = await getJson(token, '/user/referrals?paginate=1&per_page=200&page=' + p);
    const data = (b && b.referrals && b.referrals.data) || [];
    refs = refs.concat(data);
    const lp = (b && b.referrals && b.referrals.last_page) || 1;
    if (p >= lp) break;
  }
  return refs;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CRON = String(process.env.CRON_SECRET || '').trim();
  if (!CRON || req.headers.authorization !== 'Bearer ' + CRON) return res.status(401).end();
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'no storage' });

  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  const out = { ok: true };
  try {
    const token = await login();
    const com = await pullCommunity(token);
    const refs = await pullReferrals(token);

    // Level-1 paid status by username, so a personal sign-up is marked paid only
    // when they are paid on Richard's direct (level 1) line — same rule as before.
    const l1 = new Map(com.filter((x) => x.lv === '1').map((x) => [x.u, x.paid]));
    const onehouse = refs.filter((x) => x && x.email).map((x) => ({
      email: x.email,
      name: [x.first_name, x.last_name].filter(Boolean).join(' '),
      paid: l1.get(String(x.username || '').toLowerCase()) === true
    }));
    const community = com.map((x) => ({ u: x.u, paid: x.paid }));

    out.pulled = { community: community.length, referrals: onehouse.length };
    out.community = (await saveCommunity(community) || {}).community;
    out.onehouse = (await saveOneHouse(onehouse) || {}).onehouse;
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.message || e).slice(0, 200);
    // Tell Richard in MB Alerts rather than failing silently. The lists are NOT
    // touched on an error, so the door keeps working off the last good pull.
    try {
      await TG('sendMessage', { chat_id: ALERTS, parse_mode: 'HTML',
        text: '⚠️ <b>The 1House refresh could not run today.</b>\n\n' +
              'Reason: ' + String(out.error).replace(/[<>&]/g, '') + '\n\n' +
              'The door is still working off the last good list. If this keeps happening, the 1House login or password may have changed — update ONEHOUSE_EMAIL / ONEHOUSE_PASSWORD in Vercel.' });
    } catch (err) {}
    return res.status(200).json(out);
  }
  return res.status(200).json(out);
}
