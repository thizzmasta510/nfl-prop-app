# NFL Player Prop Model, live app on Cloudflare Workers + R2

This is the same v3 probability model from the spreadsheet, running as a real web app.
It uses Cloudflare R2 as its entire "database" (two small JSON files), and Cloudflare
Workers to serve both the API and the page. On Cloudflare's free tier this costs
$0/month for personal-scale use: Workers free tier is 100,000 requests/day, and R2's
free tier is 10GB storage with no egress fees at all (that's the main cost R2 avoids
versus S3-style storage).

## What you get

- A form to enter each week's player props (same fields as the spreadsheet's
  Weekly_Inputs tab)
- An "All Scored Props" view showing every prop with its computed projection,
  edge %, probability, and confidence tier
- A "Top Picks" view ranked by probability
- A Validation Tracker to log your actual picks and see your real hit rate and
  closing-line-value (CLV) rate over time

The math (`src/model.js`) is a direct port of the spreadsheet's Scoring_Engine
formulas, tested against the spreadsheet's own example and confirmed to produce
identical numbers.

## One-time setup (about 10 minutes)

You'll need a free Cloudflare account (cloudflare.com, sign up if you don't have one)
and Node.js installed on your computer.

1. **Install dependencies and log in:**
   ```
   cd nfl-prop-app
   npm install
   npx wrangler login
   ```
   This opens a browser tab to authorize Wrangler (Cloudflare's CLI) against your
   account. No credit card is required for the free tier.

2. **Create the R2 bucket** (this is your database):
   ```
   npx wrangler r2 bucket create nfl-prop-data
   ```

3. **Deploy:**
   ```
   npx wrangler deploy
   ```
   Wrangler will print a URL like `https://nfl-prop-model.<your-subdomain>.workers.dev`.
   That's your live app. Open it in a browser.

That's it, no servers to manage, no separate hosting bill, no database to provision
beyond the R2 bucket you just created.

## Optional: protect it with a password

Anyone with the URL can currently add or delete data. If you want a basic lock:

1. Open `wrangler.toml` and uncomment the `[vars]` block, replacing `change-me`
   with a real secret string.
2. Redeploy: `npx wrangler deploy`
3. The app's write endpoints will now require that secret. For personal use, the
   simplest way to use it is to open your browser's dev tools console on the
   deployed page and run:
   ```js
   localStorage.setItem("appSecret", "your-secret-here")
   ```
   (Note: the current frontend doesn't wire this up automatically. If you want the
   password prompt built into the UI itself rather than the console, tell me and
   I'll add a small login screen.)

## Optional: use your own domain

In the Cloudflare dashboard, under Workers & Pages, your worker, you can attach a
custom domain or route for free if you already own one and have it on Cloudflare's
DNS.

## Two additional factors (added after launch)

- **Pressure Rate Allowed** (0 to 1, e.g. 0.28): only affects passing props. League
  average is roughly 0.25; entering a number above that pulls the projection down
  (worse pass protection), below it nudges the projection up. Leave blank to skip.
- **Red Zone Usage Share** (0 to 1, e.g. 0.22): only affects touchdown props (any
  prop type containing "TD"). 0.20 is a reasonable baseline for a clear lead role;
  entering a higher share raises the projection, a lower share reduces it. Leave
  blank to skip.

Both are gated to the prop types they actually apply to, so entering a red zone
share on a receiving-yards prop does nothing, this is intentional, it avoids the
double-counting problem where too many correlated inputs get stacked onto a single
number.

## Security guardrails built in

- **Shared-secret auth on every endpoint**, not just writes. Set it with
  `wrangler secret put APP_SECRET` (never put real secrets in `wrangler.toml`,
  that file is meant to be safe to commit). The frontend will prompt you for
  the password once and remember it in your browser.
- **Timing-safe secret comparison**, prevents an attacker from guessing the
  secret one character at a time via response-time differences.
- **Input whitelisting**: every POST is filtered down to a fixed list of known
  fields before it's stored. Unexpected fields, nested objects, or huge blobs
  are silently dropped rather than trusted.
- **Length and size limits**: request bodies over 20KB are rejected outright,
  individual string fields are capped at 200 characters, and the total number
  of stored props/tracker entries is capped at 2,000, all to block someone
  from filling up your R2 bucket or sending oversized payloads.
- **Output escaping (anti-XSS)**: every value that gets rendered into the page
  is HTML-escaped first. Without this, someone could enter a "player name"
  containing a script tag and have it execute in your browser when the table
  renders, this is exactly the kind of stored-XSS bug that's easy to miss.
- **Locked-down CORS**: the API only allows requests from the app's own
  origin by default (or a single origin you set via `ALLOWED_ORIGIN`), not
  from any website that feels like calling it.
- **Security headers** on the main page: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` (blocks the page from being embedded in another
  site's iframe, a clickjacking defense), and a `Content-Security-Policy`
  that only allows scripts/styles from the page itself.
- **Fixed, non-user-controllable fetch target for the scheduled job**: the
  cron handler only ever fetches the URL you set in `STATS_FEED_URL`, never
  anything derived from a request, which rules out server-side request
  forgery (SSRF) through that code path.
- **Fetch timeout on the scheduled job** (8 seconds), so a hung external
  request can't leave the scheduled invocation stuck.
- **Basic response validation** on the external stats feed: the scheduled
  handler checks the fetched JSON has the expected shape before storing it,
  and silently no-ops on any error rather than corrupting your stored data.

### Worth doing yourself, on Cloudflare's dashboard (not code-level)

- **Cloudflare Access** (free for small use): puts a real login screen (email
  code, Google login, etc.) in front of the whole Worker, stronger than a
  single shared password if more than one person will use this.
- **Rate limiting rules**: Cloudflare's dashboard lets you cap requests per
  IP for free on most plans, worth adding if you ever share the URL.
- **Workers Analytics/Logs**: keep an eye on request volume so you'd notice
  if something unexpected started hammering the endpoint.

## Automated stats pipeline (pressure rate + red zone share)

`github-action/compute_weekly_stats.py` pulls the free, public nflverse
play-by-play dataset and computes:
- team-level **pressure rate allowed** (dropbacks where the QB was hit or
  sacked, divided by total dropbacks)
- player-level **red zone share** (a player's red-zone touches divided by
  their team's total red-zone plays)

It writes a small `weekly-stats.json` file. The included GitHub Actions
workflow (`.github/workflows/weekly-stats.yml`) runs this automatically twice
a week (Tuesday and Friday) on GitHub's free tier and commits the result back
to your repo.

**To wire it up:**
1. Push this project to a GitHub repo (public or private, both get free
   Actions minutes; public repos get unlimited free minutes).
2. The workflow needs no secrets, it only reads public data and writes back
   to your own repo.
3. Once it's run at least once, grab the raw file URL, it'll look like:
   `https://raw.githubusercontent.com/<you>/<repo>/main/weekly-stats.json`
4. Set that as `STATS_FEED_URL` on the Worker:
   ```
   npx wrangler secret put STATS_FEED_URL
   ```
   (paste the raw URL when prompted)
5. The Worker's own cron (Tuesday 10am UTC, Friday 6pm UTC, an hour after the
   GitHub Action runs) will fetch that file and store it in R2 automatically.
6. Read it back anytime at `/api/weekly-stats` to pre-fill the Pressure Rate
   and Red Zone Share fields instead of typing them in by hand.

This entire pipeline is free: nflverse data has no cost, GitHub Actions is
free for this volume of runs, and the Worker-side fetch is a tiny, infrequent
request well within Cloudflare's free tier.



If you want to change any of the weighting formulas (matchup adjustment strength,
the small-sample cutoff, confidence thresholds, etc.), everything lives in
`src/model.js` in one place. Edit it and run `npx wrangler deploy` again to push
the change live.

## Local testing before you deploy

```
npm run dev
```
This runs the app locally (Wrangler will simulate R2 locally too) so you can try
it before pushing it live.
