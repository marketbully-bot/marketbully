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

// The private alerts group: Richard, Yen and the door, nobody else.
// Leave empty and every alert goes to Richard alone (TELEGRAM_CHAT_ID).
// Keep this line the same in lead.js, stuck.js, member.js and telegram.js.
const ALERTS_ROOM = '-5310077180';

import { hasStore, r, rp, normEmail, isEmail, newDoorFor, getPerson, onList, onHouse, onHouseUser, normUser, letIn, upsellMessage, viato, isBlocked } from './_door.js';

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

// Signs the 10 minute pass that opens the member area on the site.
// api/member.js checks it with the same key. Keep the two in step.
async function memberPass(user, botToken) {
  const c = await import('node:crypto');
  const key = c.createHash('sha256').update('mb-member:' + botToken).digest();
  // Only the Telegram id and an expiry go in the link. No name, no username.
  const body = Buffer.from(JSON.stringify({
    t: 'l',
    u: user.id,
    e: Math.floor(Date.now() / 1000) + 600
  })).toString('base64url');
  return body + '.' + c.createHmac('sha256', key).update(body).digest('base64url');
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
  // Where alerts go: the alerts group if there is one, otherwise Richard.
  const ALERTS = String(process.env.ALERTS_CHAT_ID || ALERTS_ROOM || ADMIN).trim();
  const SHARED = !!ALERTS && ALERTS !== ADMIN;
  // If the alerts group cannot be reached, Richard still gets the alert.
  async function alert(method, payload) {
    let out = null;
    try { out = await tg(method, Object.assign({}, payload, { chat_id: ALERTS })); } catch (e) { out = null; }
    if (SHARED && ADMIN && !(out && out.ok)) {
      try { out = await tg(method, Object.assign({}, payload, { chat_id: ADMIN })); } catch (e) { /* nothing more to try */ }
    }
    return out;
  }
  const LINK = String(process.env.BROKER_LINK || '').trim();
  const SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const FREE = String(process.env.FREE_CHANNEL_LINK || 'https://t.me/+ukr-PkZbU1lmMmIx').trim();
  const VIDEO = String(process.env.WELCOME_VIDEO || '').trim();

  // New door (test mode until DOOR_MODE=live): ask for the sign-up email.
  async function askEmail(id, short) {
    await tg('sendMessage', {
      chat_id: id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        (short ? '' :
          '\ud83d\udd11 <b>Welcome to the door.</b> THE VAULT is my private room, and every seat is earned.\n\n' +
          '1\ufe0f\u20e3 <b>OPEN YOUR TRADING ACCOUNT</b> through my link\n\ud83d\udc49 ' + (LINK || 'https://themarketbully.com/steps') + '\n\n' +
          '2\ufe0f\u20e3 <b>TYPE THE EMAIL</b> you signed up with, right here.\n\n' +
          '\u26a0\ufe0f Trading carries real risk. Read this before you fund anything: https://themarketbully.com/legal\n\n') +
        '\u2709\ufe0f <b>Type the email you used to open your trading account</b> \ud83d\udc47\n\n' +
        '\ud83d\udcfa <b>Paid 1House member on the Market Bully team?</b> Type your 1House username with an @ in front, like <b>@yourname</b>.\n\n<i>No screenshot needed.</i>',
      reply_markup: { force_reply: true, input_field_placeholder: 'you@email.com' }
    });
  }

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
      if (data === 'opened' && newDoorFor(from.id) && hasStore()) {
        await askEmail(from.id, true);
        return res.status(200).end();
      }
      if ((data === 'optin:y' || data === 'optin:n') && hasStore()) {
        const pp = await getPerson(from.id);
        if (data === 'optin:y' && pp.email) {
          await r('SADD', 'v:optin', normEmail(pp.email));
          await viato(pp.email, pp.name || [from.first_name, from.last_name].filter(Boolean).join(' '), ['vault-member', 'broker-optin'], { oneHouse: true });
          await tg('sendMessage', { chat_id: from.id, text: '\u2705 You\u2019re on the list. Watch your inbox, and check spam the first time.' });
        } else {
          await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udc4d No problem. You\u2019re all set in THE VAULT either way.' });
        }
        return res.status(200).end();
      }
      if (data === 'ask') {
        await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udcac Type your question right here. It comes straight to me.' });
        return res.status(200).end();
      }
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

      // Approving or declining. Richard can, an admin of THE VAULT can, and so
      // can anyone tapping the button inside the private alerts group.
      if (data.startsWith('ok:') || data.startsWith('no:')) {
        const tappedIn = cq.message && cq.message.chat ? String(cq.message.chat.id) : '';
        const inAlerts = SHARED && tappedIn === ALERTS;
        const allowed = inAlerts || await canApprove(from.id, ADMIN, ROOM);
        // In the alerts group the answer is posted there, under the screenshot
        // message, with the name of who tapped, so nobody handles it twice.
        const back = inAlerts
          ? { chat_id: ALERTS, reply_to_message_id: cq.message.message_id, allow_sending_without_reply: true }
          : { chat_id: from.id };
        const by = inAlerts ? ' by ' + who(from) : '';
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
              'The Market Bully channel is still open to you, and there is real value in there \ud83d\udc47\n\n' +
              FREE
          });
          await tg('sendMessage', Object.assign({ parse_mode: 'HTML', text: '✕ Declined' + by + '. They have been told.' }, back));
          return res.status(200).end();
        }

        if (!ROOM) {
          await tg('sendMessage', Object.assign({ text: 'SIGNALS_CHAT_ID is not set, so I cannot make an invite.' }, back));
          return res.status(200).end();
        }

        {
          const pb = hasStore() ? await getPerson(target) : {};
          if (await isBlocked(target, pb.name, pb.email, pb.house)) {
            await tg('sendMessage', Object.assign({ text: '\u26d4 Not sent. ' + (pb.name || 'This person') + ' is on your do-not-admit list for THE VAULT.' }, back));
            return res.status(200).end();
          }
        }
        // single use link, expires in 24h, one member only
        const inv = await tg('createChatInviteLink', {
          chat_id: ROOM,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400,
          name: 'approved ' + target
        });

        if (!inv.ok) {
          await tg('sendMessage', Object.assign({
            text: 'Could not create the invite: ' + esc(inv.description) +
                  '\n\nUsually this means I am not an admin in the signals chat, or I do not have the invite users permission.'
          }, back));
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
        if (hasStore() && newDoorFor(target)) {
          try {
            const p = await getPerson(target);
            const cmds = [['HSET', 'd:p:' + target, 'state', 'in', 'inAt', Math.floor(Date.now() / 1000), 'manual', '1'], ['SREM', 'd:waiting', target], ['SREM', 'd:paused', target], ['SADD', 'd:in', target]];
            if (p.email) cmds.push(['SET', 'd:claim:' + p.email, target]);
            await rp(cmds);
          } catch (e) { /* approval already sent; memory is best effort */ }
        }
        await tg('sendMessage', Object.assign({ parse_mode: 'HTML', text: '✅ Approved' + by + '. Single use invite sent.' }, back));
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
            `If this is your private <b>alerts group</b>, send that number to Claude. Nothing else to do.\n\n` +
            `If this is <b>THE VAULT</b>, it goes into SIGNALS_CHAT_ID in Vercel, and I need to be an <b>admin</b> with <b>Invite Users via Link</b>.`
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

    // In a group: only answer /id, and only for Richard. Everything else is ignored,
    // except one thing: in MB Alerts, REPLYING to one of the door's messages sends
    // that reply to the person at the door (so Richard or Yen can answer them).
    if (m.chat && m.chat.type !== 'private') {
      const t = (m.text || '').trim();
      const rt = m.reply_to_message;
      if (String(m.chat.id) === ALERTS && rt && rt.from && rt.from.is_bot && t && !/^\//.test(t)) {
        let to = '';
        if (hasStore()) { try { to = String((await r('GET', 'd:relay:' + rt.message_id)) || ''); } catch (e) {} }
        if (!to) {
          const kb = rt.reply_markup && rt.reply_markup.inline_keyboard ? JSON.stringify(rt.reply_markup.inline_keyboard) : '';
          to = ((/"(?:ok|no):(\d{4,})"/.exec(kb) || [])[1]) || ((/\bid (\d{5,})\b/.exec(String(rt.text || '')) || [])[1]) || '';
        }
        if (to) {
          const sent = await tg('sendMessage', { chat_id: to, text: '\ud83d\udcac ' + t });
          await tg('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, allow_sending_without_reply: true,
            text: sent && sent.ok ? '\u2705 Sent to them at the door.' : '\u26a0\ufe0f Could not send. They may have blocked the door.' });
        }
        return res.status(200).end();
      }
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

    // Arriving from the website's "Send my screenshot" button. The site sends
    // people to t.me/<door>?start=shot or ?start=shot_<application ref>, which
    // lands here as "/start shot_7K2Q9X". They have already been walked
    // through opening the account on the site, so skip the long welcome and
    // ask for the screenshot straight away.
    const startArg = (/^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || [])[1] || '';
    // Arriving from the site's "Sign in with Telegram" button on /members.
    // Members of THE VAULT get a private button that opens their member area.
    if (/^members$/i.test(startArg)) {
      let member = false;
      if (ROOM) {
        try {
          const r = await tg('getChatMember', { chat_id: ROOM, user_id: from.id });
          const st = r && r.ok && r.result ? r.result.status : '';
          member = st === 'creator' || st === 'administrator' || st === 'member' ||
                   (st === 'restricted' && !!r.result.is_member);
        } catch (e) { member = false; }
      }
      if (member) {
        const pass = await memberPass(from, TOKEN);
        await tg('sendMessage', {
          chat_id: from.id,
          parse_mode: 'HTML',
          text:
            '\ud83d\udd13 <b>Member access.</b>\n\n' +
            'You are in THE VAULT, so your member area is open.\n\n' +
            'Tap the button below \ud83d\udc47\n\n' +
            '<i>This button is yours only and works for 10 minutes.</i>',
          reply_markup: {
            inline_keyboard: [[{ text: '\ud83d\udd11 Open my member area', url: 'https://themarketbully.com/members#k=' + pass }]]
          }
        });
      } else {
        await tg('sendMessage', {
          chat_id: from.id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text:
            '\ud83d\udd12 <b>The member area is for THE VAULT.</b>\n\n' +
            'You are not in the room yet. Here is how you earn your seat \ud83d\udc47\n\n' +
            'https://themarketbully.com/steps'
        });
      }
      return res.status(200).end();
    }

    // ===== new door (test mode until DOOR_MODE=live) =====
    if (newDoorFor(from.id) && hasStore()) {
      if (String(from.id) === ADMIN && /^\/doorstatus/i.test(text)) {
        const meta = await r('HGETALL', 'p:meta');
        const w = await r('SCARD', 'd:waiting');
        const i = await r('SCARD', 'd:in');
        await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML',
          text: '\ud83d\udee0 <b>Door status</b>\n\nPartner list: ' + esc(JSON.stringify(meta)) + '\nWaiting: ' + w + '\nLet in by the new door: ' + i });
        return res.status(200).end();
      }
      if (String(from.id) === ADMIN && /^\/postverify/i.test(text)) {
        const pm = await tg('sendMessage', { chat_id: ROOM, parse_mode: 'HTML',
          text: '\ud83d\udd11 <b>CONFIRM YOUR SEAT IN THE VAULT</b>\n\nThirty seconds. Tap the button, press Start, and type the email you opened your trading account with, or your 1House username like <b>@yourname</b>.\n\nEvery seat in here is earned. Please confirm yours within <b>14 days</b>. \ud83e\udd1d',
          reply_markup: { inline_keyboard: [[{ text: '\u2705 Confirm my seat', url: 'https://t.me/thevaultkey_bot?start=verify' }]] } });
        if (pm && pm.ok) await tg('pinChatMessage', { chat_id: ROOM, message_id: pm.result.message_id, disable_notification: false });
        await tg('sendMessage', { chat_id: from.id, text: pm && pm.ok ? '\ud83d\udccc Posted and pinned in THE VAULT.' : 'Could not post: ' + esc(pm && pm.description) });
        return res.status(200).end();
      }
      if (/^\/doorreset/i.test(text)) {
        const p0 = await getPerson(from.id);
        const cmds = [['DEL', 'd:p:' + from.id], ['SREM', 'd:in', from.id], ['SREM', 'd:waiting', from.id]];
        if (p0.email) cmds.push(['DEL', 'd:claim:' + p0.email]);
        if (p0.house) cmds.push(['DEL', 'd:uclaim:' + p0.house]);
        await rp(cmds);
        await tg('sendMessage', { chat_id: from.id, text: '\ud83e\uddf9 Test reset. The door has forgotten you, so you can test again from the start. Your real seat in THE VAULT is not touched.' });
        return res.status(200).end();
      }
      if (String(from.id) === ADMIN && /^\/upselltest/i.test(text)) {
        await tg('sendMessage', upsellMessage(from.id));
        return res.status(200).end();
      }
      if (/^\/start/i.test(text)) {
        const ref = (/^shot_([A-Z0-9]{4,12})$/.exec(startArg) || [])[1] || '';
        if (ref) await r('HSET', 'd:p:' + from.id, 'ref', ref);
        // Your welcome clip for new people (not for members just confirming their seat).
        if (VIDEO && !/^verify/i.test(startArg)) {
          try { await tg('sendVideo', { chat_id: from.id, video: VIDEO, supports_streaming: true, caption: 'Watch this first \ud83d\udc47' }); } catch (e) {}
        }
        await askEmail(from.id, /^(shot|verify)/i.test(startArg));
        return res.status(200).end();
      }
      if (/^@[A-Za-z0-9._-]{2,40}$/.test(text)) {
        const uname = normUser(text);
        const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
        const already = await getPerson(from.id);
        if (already.state === 'in') {
          await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udd13 You are already in THE VAULT. Lost your invite? Reply here and I will send a fresh one.' });
          return res.status(200).end();
        }
        const claimed = await r('GET', 'd:uclaim:' + uname);
        if (claimed && String(claimed) !== String(from.id)) {
          await tg('sendMessage', { chat_id: from.id, text: 'That 1House username is already linked to another Telegram account. If that is you, reply here and I will sort it out.' });
          await alert('sendMessage', { parse_mode: 'HTML', text: `\u26a0\ufe0f <b>${who(from)}</b> typed a 1House username that is already linked to someone else in THE VAULT: @${esc(uname)}\n\nNobody was let in.` });
          return res.status(200).end();
        }
        const hu = await onHouseUser(uname);
        await r('HSET', 'd:p:' + from.id, 'house', uname, 'name', name, 'at', Math.floor(Date.now() / 1000));
        if (hu === 'paid') {
          const res3 = await letIn(from.id, name, '', 'now', '1house');
          if (res3.ok) {
            await r('SET', 'd:uclaim:' + uname, from.id);
            await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udcec One last thing: what email should I send your Vault updates to? Just type it here.', reply_markup: { force_reply: true, input_field_placeholder: 'you@email.com' } });
          }
          await alert('sendMessage', { parse_mode: 'HTML',
            text: res3.ok ? `\u2705 <b>${who(from)}</b> ` + (res3.confirmed ? 'confirmed their seat in THE VAULT.' : 'was let into THE VAULT automatically.') + `\n1House @${esc(uname)} shows a paid subscription in your community.`
                          : `\u26a0\ufe0f Could not invite <b>${who(from)}</b>: ${esc(res3.why)}` });
          return res.status(200).end();
        }
        if (hu === 'free') {
          await rp([['SADD', 'd:waiting', from.id], ['HSET', 'd:p:' + from.id, 'state', 'waiting', 'nudged', '1']]);
          await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML', disable_web_page_preview: true,
            text: '\ud83d\udc4b I see <b>@' + esc(uname) + '</b> in my 1House community, on the <b>free</b> account.\n\n' +
                  'Go paid on 1House and your seat in THE VAULT comes with it, plus every live session I teach and the MB Strategy in modules. ' +
                  'Or open your trading account and type that email here.\n\nAlready paid? It can take a day to show. I check every morning and will let you in by myself.\n\n' +
                  '\ud83d\udcec Type your email here and I\u2019ll send you my free lessons and the next steps.',
            reply_markup: { inline_keyboard: [
              [{ text: '\ud83d\udcfa Get Digital Stream', url: 'https://subscribe.1house.tv/MARKETBULLY' }],
              [{ text: 'Open my trading account', url: LINK || 'https://themarketbully.com/steps' }]
            ] } });
          return res.status(200).end();
        }
        await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML', disable_web_page_preview: true,
          text: '\ud83d\udd0e I don\u2019t see <b>@' + esc(uname) + '</b> on the Market Bully team.\n\n' +
                'Typo? Check the spelling on your 1House profile and type it again.\n\n' +
                '\ud83d\udd11 <b>On 1House with another leader?</b> Your username won\u2019t open this door, but you can still get in. ' +
                'Open your trading account through my link, then type that email right here. About five minutes.\n\n' +
                '\ud83d\udcfa <b>Not on 1House yet?</b> Join through me and your seat in THE VAULT comes with any paid plan.',
          reply_markup: { inline_keyboard: [
            [{ text: '\ud83d\udd11 Open my trading account', url: LINK || 'https://themarketbully.com/steps' }],
            [{ text: '\ud83d\udcfa Join my team on 1House', url: 'https://subscribe.1house.tv/MARKETBULLY' }]
          ] } });
        await alert('sendMessage', { parse_mode: 'HTML',
          text: `\u2139\ufe0f <b>${who(from)}</b> came to the door with a 1House username that is not on your team: @${esc(uname)}\n\nThey were sent the trading account and join-my-team options. Nothing to do.` });
        return res.status(200).end();
      }
      if (isEmail(text)) {
        const email = normEmail(text);
        const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
        const claimed = await r('GET', 'd:claim:' + email);
        if (claimed && String(claimed) !== String(from.id)) {
          await tg('sendMessage', { chat_id: from.id, text: 'That email is already linked to another Telegram account. If that is you, reply here and I will sort it out.' });
          await alert('sendMessage', { parse_mode: 'HTML', text: `\u26a0\ufe0f <b>${who(from)}</b> typed an email that is already linked to someone else in THE VAULT:\n${esc(email)}\n\nNobody was let in. Check it if you know them.` });
          return res.status(200).end();
        }
        const already = await getPerson(from.id);
        if (already.state === 'in') {
          if (!already.email) {
            await rp([['HSET', 'd:p:' + from.id, 'email', email], ['SET', 'd:claim:' + email, from.id]]);
            await viato(email, name, already.via === '1house' ? ['vault-member', '1house-paid'] : ['vault-member'], { oneHouse: !!already.house || already.via === '1house' });
            await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udcec Got it, thank you. Your Vault updates go to ' + email + '.' });
            return res.status(200).end();
          }
          await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udd13 You are already in THE VAULT. Lost your invite? Reply here and I will send a fresh one.' });
          return res.status(200).end();
        }
        await r('HSET', 'd:p:' + from.id, 'email', email, 'name', name, 'at', Math.floor(Date.now() / 1000));
        const broker = await onList(email);
        const house = broker ? '' : await onHouse(email);
        if (broker || house === 'paid') {
          const res2 = await letIn(from.id, name, email, 'now', broker ? 'broker' : '1house');
          if (res2.ok) {
            const oneH = !!already.house || house === 'paid';
            const mine = oneH || (await rp([['SISMEMBER', 'p:l1', email], ['SISMEMBER', 'h:all', email], ['SISMEMBER', 'v:optin', email]])).some((x) => Number(x) === 1);
            if (mine) await viato(email, name, broker ? ['vault-member'] : ['vault-member', '1house-paid'], { oneHouse: oneH });
            else {
              // Broker level 2 and below: other leaders' people. Ask before emailing.
              await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML',
                text: '📬 <b>Want my emails too?</b>\n\nVault updates, my weekly recap and free lessons, straight to ' + esc(email) + '. Totally optional, and you can stop any time.',
                reply_markup: { inline_keyboard: [[{ text: '✅ Yes, send me emails', callback_data: 'optin:y' }, { text: 'No thanks', callback_data: 'optin:n' }]] } });
            }
          }
          await alert('sendMessage', { parse_mode: 'HTML',
            text: res2.ok
              ? `\u2705 <b>${who(from)}</b> ` + (res2.confirmed ? 'confirmed their seat in THE VAULT.' : 'was let into THE VAULT automatically.') + `\n${esc(email)} ` + (broker ? 'is on the partner list.' : 'is a paid 1House member under you.')
              : `\u26a0\ufe0f Could not invite <b>${who(from)}</b>: ${esc(res2.why)}` });
          return res.status(200).end();
        }
        if (house === 'free' || (already.house && (await onHouseUser(already.house)) === 'free')) {
          await viato(email, name, ['1house-nobroker-free'], { oneHouse: true });
          await rp([['HSET', 'd:p:' + from.id, 'state', 'free1house'], ['SREM', 'd:waiting', from.id]]);
          await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML', disable_web_page_preview: true,
            text: '\ud83d\udc4b I see you on 1House with me, on the <b>free</b> account. Two ways to earn your seat in THE VAULT:\n\n' +
                  '1\ufe0f\u20e3 <b>Go paid on 1House.</b> Digital Stream comes with your seat, plus every live session I teach and the MB Strategy in modules.\n\n' +
                  '2\ufe0f\u20e3 <b>Open your trading account</b> through my link, then type that email here.\n\n' +
                  'Already paid? It can take a day to show on my side. I check every morning.',
            reply_markup: { inline_keyboard: [
              [{ text: '\ud83d\udcfa Get Digital Stream', url: 'https://subscribe.1house.tv/MARKETBULLY' }],
              [{ text: 'Open my trading account', url: LINK || 'https://themarketbully.com/steps' }]
            ] } });
          await rp([['SADD', 'd:waiting', from.id], ['HSET', 'd:p:' + from.id, 'state', 'waiting', 'nudged', '1']]);
          await alert('sendMessage', { parse_mode: 'HTML', text: `\u2139\ufe0f <b>${who(from)}</b> came to the door. They are a <b>free</b> 1House member under you:\n${esc(email)}\n\nThey were sent the Digital Stream and trading account options. Nothing to do.` });
          return res.status(200).end();
        }
        await rp([['HSET', 'd:p:' + from.id, 'state', 'waiting', 'nudged', '0'], ['SADD', 'd:waiting', from.id]]);
        await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML', disable_web_page_preview: true,
          text: '\u23f3 I don\u2019t see <b>' + esc(email) + '</b> on my side yet. Brand-new accounts can take up to a day to show up.\n\n' +
                'I\u2019ll check again and message you right here. Signed up with a different email? Just type it.\n\n' +
                '\ud83d\udcfa <b>Paid 1House member on the Market Bully team?</b> Type your 1House username with an @ in front, like <b>@yourname</b>.\n\n' +
                'Haven\u2019t opened your account yet? Start here \ud83d\udc49 ' + (LINK || 'https://themarketbully.com/steps') });
        const p = await getPerson(from.id);
        await alert('sendMessage', { parse_mode: 'HTML',
          text: `\ud83d\udd0e <b>${who(from)}</b> is at the door with an email that is not on the partner list yet:\n${esc(email)}\n` +
                (p.ref ? `Application ref: <code>${esc(p.ref)}</code>\n` : '') +
                '\nThe door will re-check every day and let them in by itself. If you already know they are good, tap Approve.',
          reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'ok:' + from.id }, { text: '✕ Decline', callback_data: 'no:' + from.id }]] } });
        return res.status(200).end();
      }
      if (text && !/^\//.test(text)) {
        await tg('sendMessage', { chat_id: from.id, text: '\ud83d\udcac Got it. That is with me now and I will come back to you here.\n\nIf you are trying to get into THE VAULT, just type the email you opened your trading account with.' });
        const am = await alert('sendMessage', { parse_mode: 'HTML', text: `\ud83d\udcac <b>Message at the door from ${who(from)}</b>` + (from.username ? ` @${esc(from.username)}` : '') + `\n\n${esc(text)}\n\n<i>To answer: swipe left on this message (or long-press \u2192 Reply) and type. Your reply goes straight to them.</i>` });
        if (am && am.ok && am.result && hasStore()) { try { await r('SET', 'd:relay:' + am.result.message_id, String(from.id), 'EX', String(60 * 86400)); } catch (e) {} }
        return res.status(200).end();
      }
    }

    if (/^shot(?:_|$)/i.test(startArg)) {
      const ref = (/^shot_([A-Z0-9]{4,12})$/.exec(startArg) || [])[1] || '';
      const ask = {
        chat_id: from.id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          '\ud83d\udcf8 <b>Send me your screenshot.</b>\n\n' +
          'The confirmation screen or your welcome email, either works.\n\n' +
          '\ud83d\udeab No passwords. No card details. Nothing with a balance on it.\n\n' +
          'Drop it right here \ud83d\udc47\n\n' +
          'Not opened your trading account yet? Do that first \ud83d\udc49 ' + (LINK || 'https://themarketbully.com/steps') +
          (ref ? '\n\n<i>Application ref ' + ref + '</i>' : '')
      };
      // Replying to this message keeps the ref attached to the screenshot.
      if (ref) ask.reply_markup = { force_reply: true, input_field_placeholder: 'Attach your screenshot' };
      await tg('sendMessage', ask);
      if (ref && ALERTS) {
        await alert('sendMessage', {
          parse_mode: 'HTML',
          text:
            `\ud83d\udd17 <b>${who(from)}</b> just came to the door from the website.\n` +
            (from.username ? `@${esc(from.username)}\n` : '') +
            `Application ref: <code>${ref}</code>\n\n` +
            'Search this chat for that ref to see their application.'
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
            caption: 'Watch this first \ud83d\udc47',
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
          `\ud83d\udd11 <b>Welcome to THE VAULT.</b>\n\n` +
          `This is my signals room. My live trades, my levels and my reasoning, ` +
          `posted while it is happening. \ud83d\udcaf\n\n` +
          `Seats in here are earned. Three steps and you are in \ud83d\udc47\n\n` +
          `1\ufe0f\u20e3 <b>OPEN YOUR TRADING ACCOUNT</b>\n` +
          `This is the account you will trade from. Open it with my link.\n` +
          `\ud83d\udc49 ${LINK || '(link coming shortly)'}\n\n` +
          `2\ufe0f\u20e3 <b>SEND ME A SCREENSHOT</b>\n` +
          `Once you are signed up, take a picture of your account page and send it ` +
          `right here in this chat. No passwords, no card details.\n\n` +
          `3\ufe0f\u20e3 <b>I LET YOU IN</b> \ud83d\udd13\n` +
          `I check every single one myself. Once you are approved I send you a private ` +
          `invite. It works once and it is yours only.\n\n` +
          `\ud83e\udded <b>Never done this before?</b> I walk you through the whole setup here:\n` +
          `https://themarketbully.com/onboard\n\n` +
          `\u26a0\ufe0f Trading carries real risk. Read this before you fund anything:\n` +
          `https://themarketbully.com/legal\n\n` +
          `\u2b07\ufe0f Tap the button below once step 1 is done.`,
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

      await alert('forwardMessage', {
        from_chat_id: from.id,
        message_id: m.message_id
      });

      // If they replied to the door's "send me your screenshot" message, the
      // application ref from the website is in the message they replied to.
      const repliedTo = m.reply_to_message || {};
      const shotRef = (/Application ref ([A-Z0-9]{4,12})/.exec(String(repliedTo.text || repliedTo.caption || '')) || [])[1] || '';

      await alert('sendMessage', {
        parse_mode: 'HTML',
        text:
          `📸 <b>Confirmation from ${who(from)}</b>\n` +
          (from.username ? `@${esc(from.username)}\n` : '') +
          `id ${esc(from.id)}\n` +
          (shotRef ? `Application ref: <code>${shotRef}</code> (search this chat for it to see their answers)\n` : '') +
          `\n` +
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
        `\ud83e\udded New to this? Full walkthrough:\nhttps://themarketbully.com/onboard\n\n` +
        `Send /start to see it again.`
    });
    return res.status(200).end();

  } catch (err) {
    console.error('Doorman error:', err);
    return res.status(200).end();
  }
}
