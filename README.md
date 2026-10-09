# The Market Bully

Website for Richard "Pops" Hall Jr. — The Market Bully.

## What is in here

- `index.html` — the entire site. One file. All CSS, JavaScript and images are inside it,
  so there is nothing else to upload and nothing that can fail to load.
- `vercel.json` — tells Vercel that /start, /about, /community, /faq, /contact and /legal
  are real addresses. Without this file those URLs return a 404 when typed directly.

- `lessons/` — the Lesson 1 video and its cover picture, shown on the home page, the welcome screen of `/start`, and `/steps`.
- `api/lead.js` — receives an application and sends it to Telegram and Viato.
- `api/stuck.js` — receives a tap on "Tell me what's holding you up" and sends it to Telegram.
- `api/telegram.js` — the door.

## Deploying

1. Push both files to the root of this repository.
2. In Vercel: Add New → Project → import this repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
4. Deploy.

## Pages

| URL | Page |
|---|---|
| `/` | Home |
| `/about` | About |
| `/community` | Community and financial literacy work |
| `/faq` | FAQ |
| `/start` | The six question application |
| `/steps` | The finish screen of the application: the four steps into The Vault, with tick boxes. Use this link in follow-up emails. It remembers the person's name and ticks on the device they applied from. |
| `/contact` | Contact and call request |
| `/legal` | Risk and disclosure |

`/start` is the link to use in an Instagram bio, DMs and stories.

## Connecting the lead form to a backend

Open `index.html`, search for `var ENDPOINT = "";` near the start of the script block at the
bottom of the file. Paste the Google Apps Script `/exec` URL between the quotes and commit.
Until that is filled in, the application collects and tags answers but does not transmit them.

## Analytics

Google Analytics is built in but switched off until a Measurement ID is pasted in. Open
`index.html`, search for `window.MB_GA_ID = "";` near the top, and put the ID (it looks like
`G-AB12CD34EF`) between the quotes.

It counts page views and these taps: starting the application, each question answered, the free
1House.TV screen and button, reaching the contact step, sending the application, the two tick
boxes on `/steps`, the "what's holding you up" buttons, Lesson 1 plays, and taps on the door, the
free channel and the 1House links. No name, email or phone number is ever sent. Visitors in Europe
and the UK see a small cookie notice first.

## Domain notes

The domain has email on it. Connect it with **A / CNAME records only** — never by switching
nameservers to Vercel, which would move every DNS record and break mail delivery silently.

- A record, name `@` → the IP shown on the Vercel Domains screen
- CNAME, name `www` → the value shown on the Vercel Domains screen

Do not modify MX records, any TXT record containing `v=spf1`, `_dmarc`, `_domainkey`, or
`autodiscover`.
