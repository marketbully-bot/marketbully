// "Tell me what's holding you up". One tap on the finish screen of the
// application lands here and pings Richard on Telegram so he can follow up.
// Uses the same two secrets as api/lead.js, already saved in Vercel:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//
// This never blocks the person: the page shows its reply straight away and
// does not wait on this call.

// The private alerts group: Richard, Yen and the door, nobody else.
// Leave empty and every alert goes to Richard alone (TELEGRAM_CHAT_ID).
// Keep this line the same in lead.js, stuck.js, member.js and telegram.js.
const ALERTS_ROOM = '';

const REASONS = {
  funding: 'Not ready to fund an account yet',
  broker: 'Not sure about the broker',
  confused: 'Got confused on a step',
  country: 'Not available in their country'
};

const STEPS = {
  2: 'Step 2, opening the account',
  3: 'Step 3, sending the screenshot',
  4: 'Step 4, waiting on approval'
};

function esc(v) {
  return String(v == null ? '' : v)
    .slice(0, 200)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  let d = req.body;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { d = {}; }
  }
  d = d || {};

  const reason = REASONS[d.reason];
  if (!reason) return res.status(400).json({ ok: false, error: 'Unknown reason' });

  const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const OWNER = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const CHAT = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || OWNER).trim();
  if (!TOKEN || !CHAT) {
    console.error('Telegram not configured. Stuck reason received:', JSON.stringify(d));
    return res.status(200).json({ ok: true, telegram: false });
  }

  const when = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  let msg = '🚧 <b>Someone is stuck on the way to THE VAULT</b>\n\n';
  msg += `<b>${esc(d.name || 'Name not known')}</b>\n`;
  msg += d.email ? `<b>Email:</b> ${esc(d.email)}\n` : 'Opened the steps page on a device that has not applied, so no email.\n';
  msg += `\n<b>What is holding them up:</b> ${esc(reason)}\n`;
  if (STEPS[d.step]) msg += `<b>Where they are:</b> ${STEPS[d.step]}\n`;
  if (/^[A-Z0-9]{4,12}$/.test(String(d.ref || ''))) msg += `Ref: <code>${d.ref}</code>\n`;
  msg += `<i>${esc(when)} PT</i>`;

  try {
    const send = async (chat) => {
      const tg = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      return tg.json();
    };
    let out = await send(CHAT);
    // If the alerts group cannot be reached, Richard still gets it.
    if (!out.ok && OWNER && OWNER !== CHAT) out = await send(OWNER);
    if (!out.ok) console.error('Telegram rejected the message:', out);
    return res.status(200).json({ ok: true, telegram: !!out.ok });
  } catch (err) {
    console.error('Telegram send failed:', err);
    return res.status(200).json({ ok: true, telegram: false });
  }
}
