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

const API = (m) => `https://api.telegram.org/bot${String(process.env.TELEGRAM_BOT_TOKEN || '').trim()}/${m}`;

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
  if (admin && String(userId).trim() === String(admin).trim()) return true;
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
  // .trim() everywhere: a stray space pasted into a dashboard is invisible
  // and would otherwise silently break every comparison below.
  const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const ADMIN = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const ROOM = String(process.env.SIGNALS_CHAT_ID || '').trim();
  const LINK = String(process.env.BROKER_LINK || '').trim();
  const SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const FREE = String(process.env.FREE_CHANNEL_LINK || 'https://t.me/+ukr-PkZbU1lmMmIx').trim();
  const VIDEO = String(process.env.WELCOME_VIDEO || '').trim();

  // ---- one time webhook registration, no token ever in the URL ----
  if (req.method === 'GET') {
    if (!SECRET || req.query.setup !== SECRET) {
      return res.status(200).send('Doorman is running.');
    }
    const url = `https://${req.headers.host}/api/telegram`;
    const out = await tg('setWebhook', {
      url,
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query', 'channel_post', 'my_chat_member'],
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
            '\ud83d\udcf8 <b>Step 2. Send me the screenshot.</b>\n\n' +
            'The confirmation screen or your welcome email, either works.\n\n' +
            '\ud83d\udeab No passwords. No card details. Nothing with a balance on it.\n\n' +
            'Drop it right here \ud83d\udc47'
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
              'Appreciate you applying. I cannot let you into THE VAULT right now.\n\n' +
              'The free channel is still wide open though, and there is real value in there \ud83d\udc47\n\n' +
              FREE
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
            "🔓 <b>YOU'RE IN.</b>\n\n" +
            'Here is your invite to THE VAULT 👇\n\n' +
            inv.result.invite_link +
            '\n\n⚡ It works <b>once</b>, it has your name on it, and it dies in 24 hours. ' +
            'Forwarding it does nothing, so use it now.\n\nWelcome to the room. 🤝'
        });
        await tg('sendMessage', { chat_id: from.id, text: 'Approved. Single use invite sent.' });
        return res.status(200).end();
      }
      return res.status(200).end();
    }

    // ========= the bot was added to, or promoted in, a chat =========
    if (u.my_chat_member) {
      const c = u.my_chat_member.chat || {};
      const st = (u.my_chat_member.new_chat_member || {}).status;
      if (c.type !== 'private' && (st === 'administrator' || st === 'member')) {
        await tg('sendMessage', {
          chat_id: ADMIN,
          parse_mode: 'HTML',
          text:
            `I was just added to <b>${esc(c.title || 'a chat')}</b> as <b>${esc(st)}</b>.\n\n` +
            `Its ID is:\n<code>${esc(c.id)}</code>\n\n` +
            `Put that into <b>SIGNALS_CHAT_ID</b> in Vercel, then redeploy.` +
            (st === 'administrator' ? '' : '\n\n⚠️ I need to be an <b>admin</b> with <b>Invite Users via Link</b> to make invites.')
        });
      }
      return res.status(200).end();
    }

    // ========= channel posts (a channel is not a group) =========
    if (u.channel_post) {
      const c = u.channel_post.chat || {};
      const t = (u.channel_post.text || '').trim();
      if (/^\/id/i.test(t)) {
        await tg('sendMessage', {
          chat_id: ADMIN,
          parse_mode: 'HTML',
          text: `That channel is:\n\n<code>${esc(c.id)}</code>\n\nName: ${esc(c.title || '')}\n\n` +
                `Put it into <b>SIGNALS_CHAT_ID</b> in Vercel, then redeploy.`
        });
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

    // Paste a file id back and I will test it on the spot.
    if (String(from.id) === ADMIN && /^(BAAC|CgAC|DQAC|BQAC)[A-Za-z0-9_-]{20,}$/.test(text)) {
      const t = await tg('sendVideo', {
        chat_id: from.id,
        video: text,
        supports_streaming: true,
        caption: '\u2705 <b>That id works.</b> Safe to put in Vercel.',
        parse_mode: 'HTML'
      });
      if (!(t && t.ok)) {
        await tg('sendMessage', {
          chat_id: from.id,
          parse_mode: 'HTML',
          text: '\u274c <b>That id is no good.</b>  <i>(' + text.length + ' characters)</i>\n\n' +
                'Telegram said:\n<code>' + esc((t && t.description) || 'no reason given') + '</code>\n\n' +
                'Send the clip again and tap the grey box to copy it.'
        });
      }
      return res.status(200).end();
    }

    if (/^\/start/i.test(text)) {
      // The welcome clip. If Telegram refuses it for any reason we carry on
      // without it, and the text below puts its own heading back.
      let videoSent = false;
      if (VIDEO) {
        try {
          const vr = await tg('sendVideo', {
            chat_id: from.id,
            video: VIDEO,
            supports_streaming: true,
            caption: '\ud83d\udd11 <b>Welcome to THE VAULT.</b>\n\nWatch this, then read below \ud83d\udc47',
            parse_mode: 'HTML'
          });
          videoSent = !!(vr && vr.ok);
          if (!videoSent && ADMIN) {
            await tg('sendMessage', {
              chat_id: ADMIN,
              parse_mode: 'HTML',
              text: '\u26a0\ufe0f <b>The welcome video did not send.</b>\n\nTelegram said:\n<code>' +
                    esc((vr && vr.description) || 'no reason given') + '</code>\n\n' +
                    'The applicant still got everything else. Send that line to Claude.'
            });
          }
        } catch (e) { videoSent = false; }
      }
      await tg('sendMessage', {
        chat_id: from.id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          (videoSent ? '' : `\ud83d\udd11 <b>Welcome to THE VAULT.</b>\n\n`) +
          `This is the room. Live calls, my levels, my reasoning, while it is happening.\n\n` +
          `Getting in costs you nothing. You just open your trading account through my link. `+
          `That is what keeps the room free for everybody in it. \ud83d\udcaf\n\n` +
          `<b>Three steps. Let's go.</b>\n\n` +
          `1\ufe0f\u20e3 <b>Open your account</b>\n` +
          `\ud83d\udc49 ${LINK || '(link coming shortly)'}\n\n` +
          `2\ufe0f\u20e3 <b>Screenshot it</b>\n` +
          `Once you are logged in, send the confirmation right here in this chat.\n\n` +
          `3\ufe0f\u20e3 <b>I let you in</b>\n` +
          `I check every single one myself. Approved and you get a private invite. `+
          `One use, your name on it, nobody else's. \ud83d\udd12\n\n` +
          `\u26a0\ufe0f Trading carries real risk. Read this before you fund anything:\n` +
          `https://themarketbully.com/legal\n\n` +
          `Tap below once step 1 is done \ud83d\udc47`,
        reply_markup: {
          inline_keyboard: [[{ text: '\u2705 I opened my account', callback_data: 'opened' }]]
        }
      });
      return res.status(200).end();
    }

    // Richard sends a clip: hand back the file id so it can be saved as WELCOME_VIDEO.
    // Telegram files the same clip as video, animation, video_note or document
    // depending on length, sound and how it was sent, so accept all of them.
    const clip = m.video || m.animation || m.video_note || m.document || null;

    if (clip && String(from.id) === ADMIN) {
      const kind = m.video ? 'video' : m.animation ? 'animation'
                 : m.video_note ? 'video note' : 'document';
      const fid = String(clip.file_id || '');
      await tg('sendMessage', {
        chat_id: from.id,
        parse_mode: 'HTML',
        text:
          '\ud83c\udfac <b>Got your welcome clip.</b>  <i>(' + kind + ')</i>\n\n' +
          '<b>' + fid.length + ' characters.</b> Send me back the same number or it got cut.\n\n' +
          '<code>' + esc(fid) + '</code>\n\n' +
          '\ud83d\udc46 <b>Tap the grey box once.</b> That copies the whole thing. ' +
          'Do not drag over it by hand, that is what clipped it last time.'
      });
      return res.status(200).end();
    }

    // a screenshot arrives
    if (m.photo || m.document || m.video || m.animation || m.video_note) {
      await tg('sendMessage', {
        chat_id: from.id,
        text: '\ud83d\udd25 Got it. I am looking at this myself, usually same day.\n\nSit tight, I will come straight back to you.'
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

    // Admin sent something we did not recognise: show exactly what arrived.
    if (String(from.id) === ADMIN && !text) {
      const keys = Object.keys(m).filter(function (k) {
        return ['message_id', 'from', 'chat', 'date'].indexOf(k) === -1;
      });
      await tg('sendMessage', {
        chat_id: from.id,
        parse_mode: 'HTML',
        text:
          '\ud83d\udd0e <b>I did not recognise that.</b>\n\n' +
          'Telegram sent me these fields:\n<code>' + esc(keys.join(', ') || 'none') + '</code>\n\n' +
          'Send that line to Claude and it will handle the rest.'
      });
      return res.status(200).end();
    }

    // anything else
    await tg('sendMessage', {
      chat_id: from.id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        `\ud83d\udd11 <b>How you get into THE VAULT</b>\n\n` +
        `1\ufe0f\u20e3 Open your account\n\ud83d\udc49 ${LINK || '(link coming shortly)'}\n\n` +
        `2\ufe0f\u20e3 Send me the screenshot\n\n` +
        `3\ufe0f\u20e3 I approve you and send your invite\n\n` +
        `Send /start to see it again.`
    });
    return res.status(200).end();

  } catch (err) {
    console.error('Doorman error:', err);
    return res.status(200).end();
  }
}
