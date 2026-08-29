// The doorman. Runs as a Telegram webhook.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN      - from @BotFather
//   TELEGRAM_CHAT_ID        - Richard's personal chat id (approvals land here)
//   SIGNALS_CHAT_ID         - the gated signals chat, e.g. -1002345678901
//   BROKER_LINK             - the LIVVFX referral link
//   TELEGRAM_WEBHOOK_SECRET - any long random string you make up
//
// One time setup, once the variables are saved and deployed, open in a browser:
//   https://themarketbully.com/api/telegram?setup=YOUR_WEBHOOK_SECRET

const API = (m) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${m}`;

async function tg(method, payload) {
  const r = await fetch(API(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

function esc(v) {
  return String(v == null ? '' : v).slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Approvals are allowed for the configured owner, or anyone who is an
// admin of the signals chat itself. That way a mismatched chat id can
// never lock Richard out of his own door.
async function canApprove(userId, admin, room) {
  if (admin && String(userId) === String(admin)) return true;
  if (!room) return false;
  try {
    const r = await tg('getChatMember', { chat_id: room, user_id: userId });
    return !!(r && r.ok && r.result &&
      (r.result.status === 'creator' || r.result.status === 'administrator'));
  } catch (e) {
    return false;
  }
}

function who(u) {
  if (!u) return 'Someone';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return esc(name || u.username || ('id ' + u.id));
}

export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN = String(process.env.TELEGRAM_CHAT_ID || '');
  const ROOM = process.env.SIGNALS_CHAT_ID;
  const LINK = process.env.BROKER_LINK || '';
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  // ---- one time webhook registration, no token ever in the URL ----
  if (req.method === 'GET') {
    if (!SECRET || req.query.setup !== SECRET) {
      return res.status(200).send('Doorman is running.');
    }
    const url = `https://${req.headers.host}/api/telegram`;
    const out = await tg('setWebhook', {
      url,
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    return res.status(200).json({ registeredTo: url, telegram: out });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Telegram signs every call with the secret. Anything else is not Telegram.
  if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
    return res.status(401).end();
  }
  if (!TOKEN) return res.status(200).end();

  const u = req.body || {};
  // Always answer Telegram fast. Failures must never retry-loop.
  try {
    // ================= buttons =================
    if (u.callback_query) {
      const cq = u.callback_query;
      const data = cq.data || '';
      const from = cq.from || {};
      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      // applicant says they have opened the account
      if (data === 'opened') {
        await tg('sendMessage', {
          chat_id: from.id,
          parse_mode: 'HTML',
          text:
            '<b>Step 2.</b> Send me a screenshot of your account confirmation.\n\n' +
            'The confirmation screen or the welcome email is fine. ' +
            '<b>Do not send passwords, card details or anything with a balance on it.</b>\n\n' +
            'I read every one of these myself, usually the same day.'
        });
        return res.status(200).end();
      }

      // Richard approving or declining. Only he can.
      if (data.startsWith('ok:') || data.startsWith('no:')) {
        const allowed = await canApprove(from.id, ADMIN, ROOM);
        if (!allowed) {
          await tg('sendMessage', {
            chat_id: from.id,
            parse_mode: 'HTML',
            text:
              'Only an admin of the signals chat can approve.\n\n' +
              `Your Telegram ID is <code>${esc(from.id)}</code>\n` +
              `TELEGRAM_CHAT_ID is set to <code>${esc(ADMIN || 'nothing')}</code>\n` +
              `SIGNALS_CHAT_ID is set to <code>${esc(ROOM || 'nothing')}</code>\n\n` +
              'Put your own ID into TELEGRAM_CHAT_ID, or make yourself an admin of the signals chat.'
          });
          return res.status(200).end();
        }
        const REPLY_TO = ADMIN || from.id;
        const target = data.slice(3);

        if (data.startsWith('no:')) {
          await tg('sendMessage', {
            chat_id: target,
            text:
              'Thanks for applying. I am not able to let you into The Vault Key right now.\n\n' +
              'The free sessions are still open to you and there is a lot in there. ' +
              'https://www.1house.tv/educators/richard-hall'
          });
          await tg('sendMessage', { chat_id: from.id, text: 'Declined. They have been told.' });
          return res.status(200).end();
        }

        if (!ROOM) {
          await tg('sendMessage', { chat_id: from.id, text: 'SIGNALS_CHAT_ID is not set, so I cannot make an invite.' });
          return res.status(200).end();
        }

        // single use link, expires in 24h, one member only
        const inv = await tg('createChatInviteLink', {
          chat_id: ROOM,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400,
          name: 'approved ' + target
        });

        if (!inv.ok) {
          await tg('sendMessage', {
            chat_id: from.id,
            text: 'Could not create the invite: ' + esc(inv.description) +
                  '\n\nUsually this means I am not an admin in the signals chat, or I do not have the invite users permission.'
          });
          return res.status(200).end();
        }

        await tg('sendMessage', {
          chat_id: target,
          parse_mode: 'HTML',
          text:
            "<b>You're in.</b> 🤝\n\n" +
            'Here is your invite to The Vault Key. It works <b>once</b>, for you only, and it expires in 24 hours. ' +
            'Passing it on will not work, so use it now.\n\n' +
            inv.result.invite_link
        });
        await tg('sendMessage', { chat_id: from.id, text: 'Approved. Single use invite sent.' });
        return res.status(200).end();
      }
      return res.status(200).end();
    }

    // ================= messages =================
    const m = u.message;
    if (!m) return res.status(200).end();

    // In a group: only answer /id, and only for Richard. Everything else is ignored.
    if (m.chat && m.chat.type !== 'private') {
      const t = (m.text || '').trim();
      if (/^\/id/i.test(t) && String((m.from || {}).id) === ADMIN) {
        await tg('sendMessage', {
          chat_id: ADMIN,
          parse_mode: 'HTML',
          text: `This chat is:\n\n<code>${esc(m.chat.id)}</code>\n\n` +
                `Name: ${esc(m.chat.title || '')}\n\n` +
                `Put that number in Vercel as <b>SIGNALS_CHAT_ID</b>, then redeploy.`
        });
      }
      return res.status(200).end();
    }

    const from = m.from || {};
    const text = (m.text || '').trim();

    if (/^\/start/i.test(text)) {
      await tg('sendMessage', {
        chat_id: from.id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          `<b>Welcome to The Vault Key.</b>\n\n` +
          `The room is free. What it costs you is opening a trading account through my link, ` +
          `because that is how the room gets paid for. I tell you that now rather than after you are in.\n\n` +
          `<b>Three steps and you are done.</b>\n\n` +
          `<b>STEP 1 — Open your account</b>\n` +
          `${LINK || '(link coming shortly)'}\n\n` +
          `<b>STEP 2 — Send me a screenshot</b>\n` +
          `Once you are logged in, screenshot the confirmation and send it right here in this chat. ` +
          `No passwords, no card details, nothing with a balance on it.\n\n` +
          `<b>STEP 3 — I approve you</b>\n` +
          `I read every one of these myself. Approved and you get a private invite that works once, for you alone.\n\n` +
          `Before you fund anything, read the risk notes: https://themarketbully.com/legal\n\n` +
          `Tap below once step 1 is done.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'I opened my account', callback_data: 'opened' }]]
        }
      });
      return res.status(200).end();
    }

    // a screenshot arrives
    if (m.photo || m.document) {
      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Got it. I will look at this myself and come back to you, usually the same day.'
      });

      await tg('forwardMessage', {
        chat_id: ADMIN,
        from_chat_id: from.id,
        message_id: m.message_id
      });

      await tg('sendMessage', {
        chat_id: ADMIN,
        parse_mode: 'HTML',
        text:
          `📸 <b>Confirmation from ${who(from)}</b>\n` +
          (from.username ? `@${esc(from.username)}\n` : '') +
          `id ${esc(from.id)}\n\n` +
          `Approve and I will send them a single use invite.`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: 'ok:' + from.id },
            { text: '✕ Decline', callback_data: 'no:' + from.id }
          ]]
        }
      });
      return res.status(200).end();
    }

    // anything else
    await tg('sendMessage', {
      chat_id: from.id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        '<b>To get into The Vault Key:</b>\n\n' +
        `<b>1.</b> Open your account here:\n${LINK || '(link coming shortly)'}\n\n` +
        '<b>2.</b> Send me a screenshot of the confirmation\n\n' +
        '<b>3.</b> I review it and send you a private invite\n\n' +
        'Send /start to see this again.'
    });
    return res.status(200).end();

  } catch (err) {
    console.error('Doorman error:', err);
    return res.status(200).end();
  }
}
  const ADMIN = String(process.env.TELEGRAM_CHAT_ID || '');
  const ROOM = process.env.SIGNALS_CHAT_ID;
  const LINK = process.env.BROKER_LINK || '';
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  // ---- one time webhook registration, no token ever in the URL ----
  if (req.method === 'GET') {
    if (!SECRET || req.query.setup !== SECRET) {
      return res.status(200).send('Doorman is running.');
    }
    const url = `https://${req.headers.host}/api/telegram`;
    const out = await tg('setWebhook', {
      url,
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    return res.status(200).json({ registeredTo: url, telegram: out });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Telegram signs every call with the secret. Anything else is not Telegram.
  if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
    return res.status(401).end();
  }
  if (!TOKEN) return res.status(200).end();

  const u = req.body || {};
  // Always answer Telegram fast. Failures must never retry-loop.
  try {
    // ================= buttons =================
    if (u.callback_query) {
      const cq = u.callback_query;
      const data = cq.data || '';
      const from = cq.from || {};
      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      // applicant says they have opened the account
      if (data === 'opened') {
        await tg('sendMessage', {
          chat_id: from.id,
          parse_mode: 'HTML',
          text:
            'Good. Now send me a screenshot of your account confirmation.\n\n' +
            'Just the confirmation screen or the welcome email is fine. ' +
            '<b>Do not send passwords, card details or anything with your balance on it.</b>\n\n' +
            'I look at every one of these myself.'
        });
        return res.status(200).end();
      }

      // Richard approving or declining. Only he can.
      if (data.startsWith('ok:') || data.startsWith('no:')) {
        if (String(from.id) !== ADMIN) {
          await tg('sendMessage', { chat_id: from.id, text: 'Not your call to make.' });
          return res.status(200).end();
        }
        const target = data.slice(3);

        if (data.startsWith('no:')) {
          await tg('sendMessage', {
            chat_id: target,
            text:
              'Thanks for applying. I am not able to let you into the signals chat right now.\n\n' +
              'The free sessions are still open to you and there is a lot in there. ' +
              'https://www.1house.tv/educators/richard-hall'
          });
          await tg('sendMessage', { chat_id: ADMIN, text: 'Declined. They have been told.' });
          return res.status(200).end();
        }

        if (!ROOM) {
          await tg('sendMessage', { chat_id: ADMIN, text: 'SIGNALS_CHAT_ID is not set, so I cannot make an invite.' });
          return res.status(200).end();
        }

        // single use link, expires in 24h, one member only
        const inv = await tg('createChatInviteLink', {
          chat_id: ROOM,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400,
          name: 'approved ' + target
        });

        if (!inv.ok) {
          await tg('sendMessage', {
            chat_id: ADMIN,
            text: 'Could not create the invite: ' + esc(inv.description) +
                  '\n\nUsually this means I am not an admin in the signals chat, or I do not have the invite users permission.'
          });
          return res.status(200).end();
        }

        await tg('sendMessage', {
          chat_id: target,
          parse_mode: 'HTML',
          text:
            "You're in. 🤝\n\n" +
            'Here is your invite. It works <b>once</b>, for you only, and it expires in 24 hours. ' +
            'Passing it on will not work, so use it now.\n\n' +
            inv.result.invite_link
        });
        await tg('sendMessage', { chat_id: ADMIN, text: 'Approved. Single use invite sent.' });
        return res.status(200).end();
      }
      return res.status(200).end();
    }

    // ================= messages =================
    const m = u.message;
    if (!m) return res.status(200).end();

    // In a group: only answer /id, and only for Richard. Everything else is ignored.
    if (m.chat && m.chat.type !== 'private') {
      const t = (m.text || '').trim();
      if (/^\/id/i.test(t) && String((m.from || {}).id) === ADMIN) {
        await tg('sendMessage', {
          chat_id: ADMIN,
          parse_mode: 'HTML',
          text: `This chat is:\n\n<code>${esc(m.chat.id)}</code>\n\n` +
                `Name: ${esc(m.chat.title || '')}\n\n` +
                `Put that number in Vercel as <b>SIGNALS_CHAT_ID</b>, then redeploy.`
        });
      }
      return res.status(200).end();
    }

    const from = m.from || {};
    const text = (m.text || '').trim();

    if (/^\/start/i.test(text)) {
      await tg('sendMessage', {
        chat_id: from.id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          `Welcome. Good to have you.\n\n` +
          `The signals chat is free. What it costs you is opening a trading account through my link, ` +
          `because that is how the room gets paid for. I say that up front rather than after you have joined.\n\n` +
          `<b>Before you fund anything, read the risk notes:</b> https://themarketbully.com/legal\n\n` +
          `Step one, open your account here:\n${LINK || '(link coming shortly)'}\n\n` +
          `Then tap the button below.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'I opened my account', callback_data: 'opened' }]]
        }
      });
      return res.status(200).end();
    }

    // a screenshot arrives
    if (m.photo || m.document) {
      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Got it. I will look at this myself and come back to you, usually the same day.'
      });

      await tg('forwardMessage', {
        chat_id: ADMIN,
        from_chat_id: from.id,
        message_id: m.message_id
      });

      await tg('sendMessage', {
        chat_id: ADMIN,
        parse_mode: 'HTML',
        text:
          `📸 <b>Confirmation from ${who(from)}</b>\n` +
          (from.username ? `@${esc(from.username)}\n` : '') +
          `id ${esc(from.id)}\n\n` +
          `Approve and I will send them a single use invite.`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: 'ok:' + from.id },
            { text: '✕ Decline', callback_data: 'no:' + from.id }
          ]]
        }
      });
      return res.status(200).end();
    }

    // anything else
    await tg('sendMessage', {
      chat_id: from.id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        'To get into the signals chat:\n\n' +
        `1. Open your account here:\n${LINK || '(link coming shortly)'}\n` +
        '2. Send me a screenshot of the confirmation\n' +
        '3. I review it and send you a private invite\n\n' +
        'Send /start to see it again.'
    });
    return res.status(200).end();

  } catch (err) {
    console.error('Doorman error:', err);
    return res.status(200).end();
  }
}
