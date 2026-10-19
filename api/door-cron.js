// Runs once a day (see "crons" in vercel.json). Vercel sends CRON_SECRET as a
// bearer token. Re-checks people waiting at the door, nudges, and sends the
// Digital Stream message three days after someone gets in.

import { hasStore, dailyRound, TG, r } from './_door.js';

const ALERTS_ROOM = '-5310077180';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CRON = String(process.env.CRON_SECRET || '').trim();
  if (!CRON || req.headers.authorization !== 'Bearer ' + CRON) return res.status(401).end();
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'no storage' });
  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || process.env.TELEGRAM_CHAT_ID || '').trim();
  const out = await dailyRound((p) => TG('sendMessage', Object.assign({ chat_id: ALERTS }, p)));

  // If the partner list is more than two days old, say so in MB Alerts.
  const updated = await r('HGET', 'p:meta', 'updated');
  const age = updated ? (Date.now() - Date.parse(updated)) / 3600000 : 9999;
  if (age > 48) {
    await TG('sendMessage', { chat_id: ALERTS, parse_mode: 'HTML',
      text: '⚠️ <b>The partner list has not refreshed in over two days.</b>\n\nThe door is still working off the last list. Open the Claude app on the Mac and sign in to the trading account partner area again, then tell Claude.' });
  }
  return res.status(200).json({ ok: true, out, listAgeHours: Math.round(age) });
}
