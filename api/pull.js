// The daily refresh cron. Pulls BOTH sources server-side, then leaves the door
// round to api/door-cron (which runs just after). Vercel sends CRON_SECRET as a
// bearer token. One endpoint does both pulls because Vercel Hobby allows only
// two cron jobs (this one + door-cron).
//
// Env needed (set in Vercel → Settings → Environment Variables):
//   1House: ONEHOUSE_EMAIL, ONEHOUSE_PASSWORD
//   LivvFX: LIVVFX_EMAIL,  LIVVFX_PASSWORD
//
// Each source is independent: if one login fails it posts a warning to MB
// Alerts and leaves that list untouched, while the other still refreshes.

import { hasStore, TG } from './_door.js';
import { pull1House, pullLivvfx } from './_pull.js';

// Give the function the most time the plan allows; the pulls are network-bound.
export const config = { maxDuration: 300 };

const ALERTS_ROOM = '-5310077180';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CRON = String(process.env.CRON_SECRET || '').trim();
  if (!CRON || req.headers.authorization !== 'Bearer ' + CRON) return res.status(401).end();
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'no storage' });

  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  const warn = async (what, why, hint) => {
    try {
      await TG('sendMessage', { chat_id: ALERTS, parse_mode: 'HTML',
        text: `⚠️ <b>The ${what} refresh could not run today.</b>\n\nReason: ${String(why).replace(/[<>&]/g, '')}\n\nThe door is still working off the last good list. ${hint}` });
    } catch (e) {}
  };

  // Run both sources at once so the whole job finishes well inside the limit.
  const [onehouse, livvfx] = await Promise.all([pull1House(), pullLivvfx()]);
  if (!onehouse.ok) await warn('1House', onehouse.error, 'If this keeps happening, update ONEHOUSE_EMAIL / ONEHOUSE_PASSWORD in Vercel.');
  if (!livvfx.ok) await warn('trading-account (LivvFX)', livvfx.error, 'If this keeps happening, update LIVVFX_EMAIL / LIVVFX_PASSWORD in Vercel.');

  return res.status(200).json({ ok: onehouse.ok && livvfx.ok, onehouse, livvfx });
}
