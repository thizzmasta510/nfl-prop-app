# Security setup

This is what the app now does by itself, and what you set up once in Cloudflare and GitHub.

## Built into the code
- **Fails closed.** If neither `APP_SECRET` nor Cloudflare Access is configured, every
  `/api/*` call returns 503 instead of running open. (`ALLOW_OPEN=true` in `.dev.vars` is
  for local development only.)
- **Password lockout.** 10 wrong passwords from one IP within 10 minutes locks that IP out
  for the rest of the window. The page's own empty "am I logged in?" check doesn't count.
  This is per Worker instance, so it slows guessing rather than guaranteeing a hard cap;
  Cloudflare Access is the real fix.
- **Cloudflare Access verification.** When `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, every
  request (page and API) must carry a valid Access token. The Worker checks the signature
  against your team's public keys, plus audience, issuer and expiry. This means the
  workers.dev address can't be used to skip the login.
- **Strict headers on every response:** HSTS, no-referrer, frame blocking, permissions
  policy, and cross-origin isolation. The page's content security policy now pins its one
  script by SHA-256 hash, so no injected script can run (`unsafe-inline` is gone for scripts).
- **Bounded inputs.** The 20 KB body limit is enforced even without a content-length header
  on the NBA lines endpoint, the line cap is 300, and stored text is length-capped and escaped.

## One-time steps (about 20 minutes)
1. **Rotate the odds key.** The SportsGameOdds key pasted into chat on Oct 8 should be
   treated as exposed. Regenerate it in their dashboard. Keep the new one only in your
   terminal environment (`set SGO_KEY=...`) or as a GitHub Actions secret, never in a file.
2. **Check the repo history for the old key.** The repo is public, because the stat feeds are
   served from it. In your project folder, run
   `git log -p -S "<first 6 characters of the old key>"`. If it prints anything, the key was
   committed. It is dead after step 1, but also delete any committed backup or odds files.
3. **Make the password strong.** `npx wrangler secret put APP_SECRET` with 20+ random
   characters (a password manager's generator is ideal).
4. **Turn on Cloudflare Access (recommended).** It's free for up to 50 users.
   - In the Cloudflare dashboard, go to **Workers & Pages → nfl-prop-model → Settings →
     Domains & Routes**. Next to the workers.dev route, enable **Cloudflare Access**. This
     creates an Access application. (If you use a custom domain instead, create a
     self-hosted application in **Zero Trust → Access → Applications**.)
   - In **Zero Trust → Access → Applications → (your app) → Policies**, allow only your own
     email. Use the "One-time PIN" or Google login method.
   - Copy the application's **AUD tag** and your team domain
     (`yourteam.cloudflareaccess.com`) into `wrangler.toml` as `ACCESS_AUD` and
     `ACCESS_TEAM_DOMAIN`, then run `npx wrangler deploy`.
   - Keep `APP_SECRET` as well if you want both: Access plus the password.
5. **Rate limiting.** If you move to a custom domain, add a WAF rate-limiting rule (for
   example, 60 requests per minute per IP on `/api/*`). On a workers.dev address there's no
   WAF, so the built-in lockout and Access cover this.
6. **GitHub.** In **Settings → Code security**, turn on **Dependabot alerts**, **secret
   scanning** and **push protection**; they're free for public repos. Add branch protection
   on `main`, so changes go through pull requests.
7. **R2.** Keep the `nfl-prop-data` bucket private: no public bucket URL, no r2.dev
   access. The Worker is the only thing that reads it.
