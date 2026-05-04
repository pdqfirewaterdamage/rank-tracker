# PDQ Rank Tracker — Cloudflare Worker backend

This Worker gives the GitHub Pages site a real backend so your projects sync
across devices instead of being stuck in one browser's localStorage.

It exposes:

| Method | Path     | What it does                                      |
| ------ | -------- | ------------------------------------------------- |
| GET    | /health  | Liveness probe (no auth)                          |
| GET    | /data    | Load the rank-tracker JSON blob (X-Auth required) |
| PUT    | /data    | Save the rank-tracker JSON blob (X-Auth required) |

Storage is a single key in Workers KV, scoped to your shared-secret hash. The
local Node server (`serve.ps1`) still runs unchanged — it's used for the
Puppeteer scrape on your laptop. The cloud Worker only handles persistence.

## One-time setup

You need a Cloudflare account (free is fine) and Node installed.

```powershell
# From the repo root
cd worker
npm install

# 1. Log in to Cloudflare (opens a browser tab)
npx wrangler login

# 2. Create the KV namespace and copy the id it prints
npx wrangler kv namespace create RANK_DATA
# It prints something like:
#   id = "1a2b3c4d5e6f7890abcdef1234567890"
# Open wrangler.toml and replace BOTH `id` and `preview_id` with that value.

# 3. Set your shared-secret auth (you'll be prompted for the value)
#    Pick a long random string — you'll paste this into the Cloud Backend
#    dialog in the web UI later.
npx wrangler secret put AUTH_SECRET

# 4. Deploy
npx wrangler deploy
# Note the URL it prints — something like
#   https://ranktracker-api.<your-account>.workers.dev
```

## Connect the web UI

Open the live site (https://pdqfirewaterdamage.github.io/rank-tracker/), then:

1. Click **Cloud Backend** under the API Settings card.
2. Paste the Worker URL from step 4 above.
3. Paste the same `AUTH_SECRET` you set in step 3.

The "Cloud backend: connected" pill turns green. Any local-only projects
already in your browser get pushed up automatically; from then on every save
syncs to KV.

If you load the site in a different browser or on another device, click
Cloud Backend, paste the same URL + secret, and your projects appear.

## Local development

```powershell
cd worker
copy .dev.vars.example .dev.vars   # then edit .dev.vars and set AUTH_SECRET
npm run dev                        # runs at http://localhost:8787
```

`wrangler dev` uses a separate local KV. You can hit it from the static page
the same way as the deployed Worker.

## Adding a custom domain (later)

If you want `api.pdqrestoration.com` instead of `*.workers.dev`:

1. Add the domain to your Cloudflare account if it isn't already.
2. In the Cloudflare dashboard → Workers & Pages → ranktracker-api → Settings →
   Triggers → Add Custom Domain.
3. Update `ALLOWED_ORIGINS` in `wrangler.toml` if your front-end origin
   changes; redeploy.

## Cost

Free tier covers:
- 100,000 Worker requests/day
- 100,000 KV reads + 1,000 KV writes/day
- 1 GB KV storage

You will not hit any of these doing rank tracking.

## Adding cloud-side scraping later (Browser Rendering)

This Worker intentionally does NOT include the Puppeteer scrape — that stays
on `serve.ps1` because Browser Rendering requires the Workers Paid plan
($5/mo). When/if you want to enable it, add a `/scrape` route here that uses
`@cloudflare/puppeteer` and bind the `browser` service in `wrangler.toml`.
