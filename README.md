# The Market Bully

Website for Richard "Pops" Hall Jr. — The Market Bully.

## What is in here

- `index.html` — the entire site. One file. All CSS, JavaScript and images are inside it,
  so there is nothing else to upload and nothing that can fail to load.
- `vercel.json` — tells Vercel that /start, /about, /community, /faq, /contact and /legal
  are real addresses. Without this file those URLs return a 404 when typed directly.

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
| `/start` | The five question application |
| `/contact` | Contact and call request |
| `/legal` | Risk and disclosure |

`/start` is the link to use in an Instagram bio, DMs and stories.

## Connecting the lead form to a backend

Open `index.html`, search for `var ENDPOINT = "";` near the start of the script block at the
bottom of the file. Paste the Google Apps Script `/exec` URL between the quotes and commit.
Until that is filled in, the application collects and tags answers but does not transmit them.

## Domain notes

The domain has email on it. Connect it with **A / CNAME records only** — never by switching
nameservers to Vercel, which would move every DNS record and break mail delivery silently.

- A record, name `@` → the IP shown on the Vercel Domains screen
- CNAME, name `www` → the value shown on the Vercel Domains screen

Do not modify MX records, any TXT record containing `v=spf1`, `_dmarc`, `_domainkey`, or
`autodiscover`.
