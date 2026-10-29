// Manual/test endpoint: pulls ONLY 1House. The daily cron is api/pull (both
// sources). Gated by CRON_SECRET, same as the cron. Handy to re-run 1House by
// hand: GET /api/pull-1house with header  Authorization: Bearer <CRON_SECRET>.

import { hasStore } from './_door.js';
import { pull1House } from './_pull.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CRON = String(process.env.CRON_SECRET || '').trim();
  if (!CRON || req.headers.authorization !== 'Bearer ' + CRON) return res.status(401).end();
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'no storage' });
  return res.status(200).json(await pull1House());
}
