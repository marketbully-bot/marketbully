// Receives the partner list ("My Clients") once a day and saves it for the door.
// Called by the daily scheduled task from inside the partner area page.
// Needs SYNC_SECRET in Vercel; the caller sends it as the x-sync-key header.
// Only emails and whether they have traded are kept. No names, phones or balances.
//
// The 1House lists (onehouse + community) are now also pulled server-side by
// api/pull-1house.js on a cron; both paths call the same saveOneHouse /
// saveCommunity in _sync.js, so this endpoint still works as a fallback.

import { hasStore, dailyRound, TG } from './_door.js';
import { saveOneHouse, saveCommunity, savePartners } from './_sync.js';

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
  const pr = rows.length ? await savePartners(rows) : null;
  if (pr && pr.error === 'list looks wrong, not saved') {
    return res.status(409).json({ ok: false, error: pr.error, got: pr.got, before: pr.before });
  }
  if (pr) out = Object.assign(out, { saved: pr.saved, traded: pr.traded, moves: pr.moves });

  // Anyone waiting at the door whose email just showed up gets in now.
  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  try { out.round = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS }, p))); } catch (e) { out.round = { error: String(e) }; }

  return res.status(200).json(out);
}
