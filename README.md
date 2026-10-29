# Oslo Haggadone Portfolio Website

[oslohaggadone.com](https://oslohaggadone.com)

Also holds Synopsist:
[Synopsist](https://oslohaggadone.com/Synopsist/)

plain HTML and CSS with a few lines of JavaScript

## Seeing it on your computer

```bash
cd ~/OsloHaggadone
python3 serve.py
```
@http://localhost:8080

## The contact form

The contact page's messages go through a small Cloudflare Worker (`contact-worker/`), which emails
them to the inbox business@oslohaggadone.com forwards to, with the sender's address to reply to.

```bash
cd ~/OsloHaggadone/contact-worker
npm install                          # once: wrangler, Cloudflare's tool (already done on this computer)
npx wrangler deploy                  # sends it live (again after changing src/index.js or wrangler.toml)
npx wrangler secret put CONTACT_TO   # once: the inbox to email, verified in Cloudflare's Email Routing
npm test                             # its tests
```
