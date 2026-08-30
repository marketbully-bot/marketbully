// Receives an application from the site and sends it to Telegram.
// Secrets live in Vercel Environment Variables, never in this file.
//   TELEGRAM_BOT_TOKEN  - from @BotFather
//   TELEGRAM_CHAT_ID    - the chat this should post into
//   VIATO_API_KEY       - Viato, Settings, Integrations, API Keys
//
// Every application does two things: it pings Telegram so Richard sees it
// straight away, and it creates the contact in Viato tagged rung-1-new-lead,
// which is what starts campaign 1. Neither one can block the other, and
// neither one can block the person getting their confirmation screen.

const LABELS = {
  motive: {
    'side-income': 'Build something on the side',
    'replace-income': 'Eventually walk away from the job',
    'tired-guessing': 'Already trades, tired of guessing',
    'saw-someone': 'Knows someone who does it'
  },
  experience: {
    'never': 'Never placed a trade',
    'dabbled': 'Dabbled, mostly losing',
    '1-3y': 'One to three years, inconsistent',
    'experienced': 'Experienced, wants a system'
  },
  pain: {
    'entries': 'Cannot explain their entries',
    'giving-back': 'Keeps giving profits back',
    'discipline': 'Cannot stay disciplined',
    'not-started': 'Has not started yet'
  },
  time: {
    'under-1h': 'Under an hour a day',
    '1-2h': 'One to two hours a day',
    '3h-plus': 'Three or more hours a day',
    'weekends': 'Weekends only'
  },
  capital: {
    '100-200': '$100 to $200 ready',
    '200-plus': 'More than $200 ready',
    'soon': 'Not yet, coming soon',
    'none': 'Nothing right now'
  }
};

const HEADINGS = {
  motive: 'Why',
  experience: 'Where they are',
  pain: 'What is going wrong',
  time: 'Time per day',
  capital: 'Capital'
};

function esc(v) {
  return String(v == null ? '' : v)
    .slice(0, 400)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function line(label, value) {
  return value ? `<b>${label}:</b> ${esc(value)}\n` : '';
}


// ---------------------------------------------------------------
// Viato. Creates the contact and tags it, which starts campaign 1.
// ---------------------------------------------------------------
const VIATO_URL = 'https://viato.ai/api/contacts';

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Friend', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function noteFor(d) {
  const rows = [];
  for (const key of ['motive', 'experience', 'pain', 'time', 'capital']) {
    const raw = d[key];
    if (!raw) continue;
    const nice = (LABELS[key] && LABELS[key][raw]) || raw;
    rows.push(HEADINGS[key] + ': ' + nice);
  }
  if (d.besttime) rows.push('Best time to call: ' + d.besttime);
  if (d.tz) rows.push('Timezone: ' + d.tz);
  const src = [d.utm_source, d.utm_campaign, d.src, d.ref, d.referrer].filter(Boolean).join(' / ');
  rows.push('Came from: ' + (src || 'direct'));
  return rows.join('\n');
}

async function toViato(d) {
  const key = String(process.env.VIATO_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'no-key' };

  const who = splitName(d.name);
  const body = {
    first_name: who.first,
    last_name: who.last,
    email: d.email || '',
    phone: d.phone || '',
    tags: ['rung-1-new-lead'],
    notes: noteFor(d)
  };

  // Different builds accept the key on different headers, so send both.
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key,
    'x-api-key': key
  };

  try {
    const r = await fetch(VIATO_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 200 && r.status < 300) return { ok: true };
    console.error('Viato rejected the contact:', r.status, text.slice(0, 400));
    return { ok: false, reason: 'http-' + r.status, detail: text.slice(0, 200) };
  } catch (err) {
    console.error('Viato call failed:', err);
    return { ok: false, reason: 'network' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT = process.env.TELEGRAM_CHAT_ID;

  let d = req.body;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { d = {}; }
  }
  d = d || {};

  // Basic sanity. Never block a real lead over formatting.
  if (!d.name && !d.email) {
    return res.status(400).json({ ok: false, error: 'Missing name and email' });
  }
  // Honeypot: real people leave this empty.
  if (d.company) return res.status(200).json({ ok: true });

  const when = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  let msg = '🔔 <b>New application</b>\n\n';
  msg += `<b>${esc(d.name || 'No name given')}</b>\n`;
  msg += line('Email', d.email);
  msg += line('Phone', d.phone);
  if (d.besttime || d.tz) {
    msg += `<b>Best time:</b> ${esc(d.besttime || '—')}${d.tz ? ' · ' + esc(d.tz) : ''}\n`;
  }

  msg += '\n<b>Their answers</b>\n';
  for (const key of ['motive', 'experience', 'pain', 'time', 'capital']) {
    const raw = d[key];
    if (!raw) continue;
    const nice = (LABELS[key] && LABELS[key][raw]) || raw;
    msg += `${HEADINGS[key]}: ${esc(nice)}\n`;
  }

  const src = [d.utm_source, d.utm_campaign, d.src, d.ref, d.referrer]
    .filter(Boolean).map(esc).join(' · ');
  msg += `\n<b>Came from:</b> ${src || 'direct'}\n`;
  msg += `<i>${esc(when)} PT</i>`;

  // Both of these run. Neither is allowed to sink the other, and neither
  // is allowed to stop the person seeing their confirmation screen.
  const jobs = [];

  jobs.push(
    (async () => {
      if (!TOKEN || !CHAT) {
        console.error('Telegram not configured. Lead received:', JSON.stringify(d));
        return { ok: false, reason: 'not-configured' };
      }
      try {
        const tg = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT,
            text: msg,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          })
        });
        const out = await tg.json();
        if (!out.ok) {
          console.error('Telegram rejected the message:', out);
          return { ok: false, reason: out.description };
        }
        return { ok: true };
      } catch (err) {
        console.error('Telegram send failed:', err);
        return { ok: false, reason: 'send-failed' };
      }
    })()
  );

  jobs.push(toViato(d));

  const [telegram, viato] = await Promise.all(jobs);

  return res.status(200).json({
    ok: true,
    telegram: telegram.ok,
    viato: viato.ok,
    reason: [telegram.reason, viato.reason].filter(Boolean).join(' | ') || undefined
  });
}
