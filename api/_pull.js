// Server-side pullers that fetch the source lists directly and save them.
// No browser, no scraping through a human session. Called by api/pull.js (the
// daily cron) and by the manual test endpoints api/pull-1house / api/pull-livvfx.
//
//   pull1House()  — logs into the 1House API, reads genealogy + referrals.
//   pullLivvfx()  — logs into the LivvFX broker portal, reads the IB client
//                   list web page, decodes the Cloudflare-masked emails.
//
// Each returns a small result object and NEVER throws for a bad login: it
// returns { ok:false, error } so one source failing can't take down the other.

import { saveOneHouse, saveCommunity, savePartners } from './_sync.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ========================= 1House =========================
const OH_API = () => String(process.env.ONEHOUSE_API || 'https://backend.1houseglobal.dev/api').trim().replace(/\/+$/, '');
const OH_LEVELS = () => String(process.env.ONEHOUSE_LEVELS || '1,2,3,4,5,6-20').split(',').map((s) => s.trim()).filter(Boolean);

function findArray(o) {
  if (Array.isArray(o)) return o;
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const v = findArray(o[k]); if (v) return v; } }
  return null;
}
function lastPage(j) { const m = JSON.stringify(j).match(/"last_page":\s*(\d+)/); return m ? Number(m[1]) : 1; }

async function ohLogin() {
  const email = String(process.env.ONEHOUSE_EMAIL || '').trim();
  const password = String(process.env.ONEHOUSE_PASSWORD || '').trim();
  if (!email || !password) throw new Error('ONEHOUSE_EMAIL / ONEHOUSE_PASSWORD not set');
  const fd = new FormData();
  fd.append('email', email);
  fd.append('password', password);
  const res = await fetch(OH_API() + '/login', { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const j = await res.json().catch(() => ({}));
  const token = j && (j.access_token || j.token || (j.data && j.data.access_token));
  if (res.status !== 200 || !token) throw new Error('1House login failed (' + res.status + ') ' + String((j && j.message) || '').slice(0, 120));
  return String(token);
}
async function ohGet(token, path) {
  const res = await fetch(OH_API() + path, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('GET ' + path + ' -> ' + res.status);
  return res.json();
}

export async function pull1House() {
  try {
    const token = await ohLogin();
    const com = [];
    for (const lv of OH_LEVELS()) {
      let p = 1, last = 1;
      do {
        const j = await ohGet(token, '/user/genealogy-list?page=' + p + '&level=' + lv);
        (findArray(j) || []).forEach((x) => com.push({
          u: String((x.user && x.user.username) || '').toLowerCase(),
          paid: x.paid_subscription === 'Yes',
          lv: String(x.level)
        }));
        last = lastPage(j); p++;
      } while (p <= last && p < 120);
    }
    let refs = [];
    for (let p = 1; p < 40; p++) {
      const b = await ohGet(token, '/user/referrals?paginate=1&per_page=200&page=' + p);
      const data = (b && b.referrals && b.referrals.data) || [];
      refs = refs.concat(data);
      const lp = (b && b.referrals && b.referrals.last_page) || 1;
      if (p >= lp) break;
    }
    const l1 = new Map(com.filter((x) => x.lv === '1').map((x) => [x.u, x.paid]));
    const onehouse = refs.filter((x) => x && x.email).map((x) => ({
      email: x.email,
      name: [x.first_name, x.last_name].filter(Boolean).join(' '),
      paid: l1.get(String(x.username || '').toLowerCase()) === true
    }));
    const community = com.map((x) => ({ u: x.u, paid: x.paid }));
    const out = { ok: true, pulled: { community: community.length, referrals: onehouse.length } };
    out.community = (await saveCommunity(community) || {}).community;
    out.onehouse = (await saveOneHouse(onehouse) || {}).onehouse;
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// ========================= LivvFX =========================
const LV_BASE = () => String(process.env.LIVVFX_BASE || 'https://members.livvglobal.com').trim().replace(/\/+$/, '');

// Cloudflare "email protection": the real address is XOR-encoded in data-cfemail.
// Browsers decode it with this exact routine; we do the same server-side.
function decodeCf(hex) {
  const r = parseInt(hex.substr(0, 2), 16);
  let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ r);
  return s;
}

// Parse the IB client list HTML into [{ email, name, balance, volume, level }].
// Columns are read by header name, so the odd table that drops a column (e.g.
// level 7 has no Balance) still maps correctly.
export function parseLivvfx(html) {
  const clients = [];
  const ids = [...html.matchAll(/id=["'](level(\d+)listing)["']/g)];
  for (const m of ids) {
    const level = m[2]; const start = m.index; const end = html.indexOf('</table>', start);
    const tbl = html.slice(start, end < 0 ? start + 400000 : end);
    const thead = (tbl.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
    const headers = (thead.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || []).map((h) => h.replace(/<[^>]*>/g, '').trim());
    const col = (n) => headers.indexOf(n);
    const tbody = (tbl.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];
    const rows = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
      if (!cells.length) continue;
      const cell = (i) => (i >= 0 && i < cells.length) ? cells[i] : '';
      const ec = cell(col('Email'));
      const cf = ec.match(/data-cfemail=["']([0-9a-f]+)["']/i);
      const email = cf ? decodeCf(cf[1]) : ec.replace(/<[^>]*>/g, '').trim();
      const name = cell(col('Name')).replace(/<[^>]*>/g, '').trim();
      const balance = parseFloat(String(cell(col('Balance'))).replace(/<[^>]*>/g, '').replace(/[^0-9.\-]/g, '')) || 0;
      const volume = parseFloat(String(cell(col('Total Volume'))).replace(/<[^>]*>/g, '').replace(/[^0-9.\-]/g, '')) || 0;
      if (email) clients.push({ email, name: level === '1' ? name : '', balance, volume, level });
    }
  }
  return clients;
}

// --- tiny cookie jar so the Laravel session survives login -> list fetch ---
function addCookies(jar, res) {
  const sc = (typeof res.headers.getSetCookie === 'function') ? res.headers.getSetCookie() : [];
  for (const line of sc) { const p = line.split(';')[0]; const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '); }

async function lvLogin(jar) {
  const email = String(process.env.LIVVFX_EMAIL || '').trim();
  const password = String(process.env.LIVVFX_PASSWORD || '').trim();
  if (!email || !password) throw new Error('LIVVFX_EMAIL / LIVVFX_PASSWORD not set');
  // 1) GET the login page: collect the session cookies and the CSRF _token.
  const g = await fetch(LV_BASE() + '/login', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  addCookies(jar, g);
  const html = await g.text();
  const token = (html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i) ||
                 html.match(/value=["']([^"']+)["'][^>]*name=["']_token["']/i) || [])[1] || '';
  if (!token) throw new Error('LivvFX: could not read login token');
  // 2) POST the credentials with the same cookies.
  const body = new URLSearchParams({ _token: token, email, password }).toString();
  const p = await fetch(LV_BASE() + '/login', {
    method: 'POST', redirect: 'manual',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html', Origin: LV_BASE(), Referer: LV_BASE() + '/login', Cookie: cookieHeader(jar)
    },
    body
  });
  addCookies(jar, p);
  // A successful Laravel login answers 302 to a dashboard; staying on /login (200)
  // or redirecting back to /login means the credentials were rejected.
  const loc = p.headers.get('location') || '';
  if (p.status !== 302 || /\/login(\?|$)/.test(loc)) {
    throw new Error('LivvFX login failed (' + p.status + (loc ? ' -> ' + loc.replace(LV_BASE(), '') : '') + ')');
  }
}

export async function pullLivvfx() {
  try {
    const jar = {};
    await lvLogin(jar);
    const res = await fetch(LV_BASE() + '/client/ib/myclientslist', {
      headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: cookieHeader(jar) }
    });
    if (!res.ok) throw new Error('client list -> ' + res.status);
    const html = await res.text();
    if (/name=["']password["']/i.test(html) && /id=["']level1listing["']/i.test(html) === false) {
      throw new Error('LivvFX: got the login page, not the client list (session not established)');
    }
    const clients = parseLivvfx(html);
    const out = { ok: true, pulled: { clients: clients.length } };
    out.partners = await savePartners(clients);
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}
