// Manual/test endpoint: pulls ONLY the LivvFX trading-account client list. The
// daily cron is api/pull (both sources). Gated by CRON_SECRET.
// Run by hand: GET /api/pull-livvfx with header  Authorization: Bearer <CRON_SECRET>.

import { hasStore } from './_door.js';
import { pullLivvfx } from './_pull.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CRON = String(process.env.CRON_SECRET || '').trim();
  if (!CRON || req.headers.authorization !== 'Bearer ' + CRON) return res.status(401).end();
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'no storage' });
  return res.status(200).json(await pullLivvfx());
}
