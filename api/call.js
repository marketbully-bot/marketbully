// Call and booking requests from the Contact page.
//
// The Contact page emails each request to info@themarketbully.com first (through
// FormSubmit, straight from the visitor's browser), so Richard's executive
// assistant can filter it and schedule the call. This handler then:
//   1. Saves the person in Viato with a tag, so there is a record.
//   2. ONLY if that email did not go through, posts the request in the private
//      alerts group on Telegram, so it is never lost.
//
// Uses secrets already saved in Vercel:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VIATO_API_KEY

// The private alerts group: Richard, Yen and the door, nobody else.
// Leave empty and every alert goes to Richard alone (TELEGRAM_CHAT_ID).
// Keep this line the same in lead.js, stuck.js, member.js and telegram.js.
const ALERTS_ROOM = '-5310077180';

const TYPES = {
  call: { icon: '📞', title: 'Call request', tag: 'call-request', about: 'A call before joining' },
  speaking: { icon: '🎤', title: 'Speaking request', tag: 'speaking-inquiry', about: 'Booking Richard to speak' },
  media: { icon: '🤝', title: 'Media or partnership request', tag: 'media-inquiry', about: 'Media or partnership' }
};

function esc(v, max) {
  return String(v == null ? '' : v)
    .slice(0, max || 300)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Friend', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function toViato(d, type) {
  const key = String(process.env.VIATO_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'no-key' };
  const who = splitName(d.name);
  try {
    const r = await fetch('https://viato.ai/api/v1/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        first_name: who.first,
        last_name: who.last,
        email: d.email || '',
        phone: d.phone || '',
        tags: [type.tag],
        notes: [
          type.about,
          d.besttime ? 'Best time: ' + d.besttime : '',
          d.tz ? 'Timezone: ' + d.tz : '',
          'Emailed to info@themarketbully.com: ' + (d.emailed ? 'yes' : 'no, sent to the alerts group instead'),
          d.note ? 'They wrote: ' + String(d.note).slice(0, 1200) : ''
        ].filter(Boolean).join('\n')
      })
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    console.error('Viato rejected the call request:', r.status, (await r.text()).slice(0, 200));
    return { ok: false, reason: 'http-' + r.status };
  } catch (err) {
    console.error('Viato call failed:', err);
    return { ok: false, reason: 'network' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

  let d = req.body;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { d = {}; }
  }
  d = d || {};

  // Honeypot: real people leave this empty.
  if (d.company) return res.status(200).json({ ok: true });

  const name = String(d.name || '').trim();
  const email = String(d.email || '').trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Name and a real email address are needed' });
  }
  const type = TYPES[d.type] || TYPES.call;

  const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const OWNER = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const CHAT = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || OWNER).trim();

  const when = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short'
  });

  let msg = `${type.icon} <b>${type.title}</b>\n\n`;
  msg += `<b>${esc(name)}</b>\n`;
  msg += `<b>Email:</b> ${esc(email)}\n`;
  if (d.phone) msg += `<b>Phone:</b> ${esc(d.phone, 40)}\n`;
  if (d.besttime || d.tz) msg += `<b>Best time:</b> ${esc(d.besttime || '—', 40)}${d.tz ? ' · ' + esc(d.tz, 60) : ''}\n`;
  if (d.note) msg += `\n<b>They wrote:</b>\n${esc(d.note, 1200)}\n`;
  msg += `\n<i>${esc(when)} PT · from the Contact page</i>`;
  msg += `\n\n⚠️ <i>The email to info@themarketbully.com did not go through, so this came here instead.</i>`;

  // The email is the normal route. Telegram is only the safety net.
  const emailed = d.emailed === '1' || d.emailed === 1 || d.emailed === true;

  const telegram = (async () => {
    if (emailed) return { ok: false, reason: 'not-needed' };
    if (!TOKEN || !CHAT) {
      console.error('Telegram not configured. Call request received:', JSON.stringify({ name, email, type: type.tag }));
      return { ok: false, reason: 'not-configured' };
    }
    const send = async (chat) => {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
      });
      return r.json();
    };
    try {
      let out = await send(CHAT);
      // If the alerts group cannot be reached, Richard still gets it.
      if (!out.ok && OWNER && OWNER !== CHAT) out = await send(OWNER);
      return { ok: !!out.ok, reason: out.ok ? undefined : out.description };
    } catch (err) {
      console.error('Telegram send failed:', err);
      return { ok: false, reason: 'send-failed' };
    }
  })();

  const [tg, viato] = await Promise.all([telegram, toViato({ name, email, phone: d.phone, besttime: d.besttime, tz: d.tz, note: d.note, emailed }, type)]);

  // The person is only told "got it" if the request actually reached somebody.
  if (!emailed && !tg.ok && !viato.ok) return res.status(502).json({ ok: false, error: 'Could not deliver the request' });
  return res.status(200).json({ ok: true, emailed, telegram: tg.ok, viato: viato.ok });
}
