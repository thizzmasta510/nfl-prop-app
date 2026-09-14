# NFL Player Prop Model, Full Documentation

This document describes everything in the project: the statistical model, the
live app's architecture, every API endpoint, the security measures, and the
automated stats pipeline. See `README.md` for the quick-start deployment
steps, this file is the reference for how everything actually works.

---

## 1. Overview

A weighted projection model for NFL player prop bets (over/under lines),
delivered as a live web app running on Cloudflare Workers with Cloudflare R2
as its storage layer. It also includes a Validation Tracker to measure the
model's real-world accuracy over time, and an optional pipeline that
auto-populates two advanced stats (pressure rate allowed, red zone usage
share) from free public data.

**Core philosophy:** every adjustment in the model is grounded in a specific,
named mechanism (a real matchup fact, a documented statistical method, a
verified trend) rather than a vague "feels right" factor, and adjustments
that could double-count the same underlying signal are deliberately left
out. See Section 3 for the reasoning behind each one.

---

## 2. Architecture

```
Browser (frontend)
   |
   |  HTTPS
   v
Cloudflare Worker (src/index.js)
   |  - Serves the HTML/CSS/JS frontend
   |  - Exposes the REST API (Section 4)
   |  - Runs the model math (src/model.js) on every request
   |  - Runs a scheduled job twice a week (Section 6)
   v
Cloudflare R2 (object storage, the app's entire "database")
   - props.json          (this week's prop inputs)
   - tracker.json         (your logged picks + results)
   - weekly-stats.json    (pre-computed pressure rate / red zone share)
```

There is no separate backend server, database, or hosting bill beyond
Cloudflare's free tier at this scale (see README for exact free-tier limits).

### Files in this project

| File | Purpose |
|---|---|
| `src/model.js` | The scoring formulas. Pure functions, no I/O, easy to unit test. |
| `src/index.js` | The Worker: routes, storage, security, and the embedded frontend. |
| `dashboard-bundle.js` | `model.js` and `index.js` merged into one file, for pasting into Cloudflare's dashboard editor instead of using the CLI. |
| `wrangler.toml` | Cloudflare configuration: R2 binding, cron schedule. |
| `github-action/compute_weekly_stats.py` | Computes pressure rate and red zone share from public play-by-play data. |
| `.github/workflows/weekly-stats.yml` | Runs the above script automatically, twice a week, for free. |
| `package.json` | Project dependencies (just Wrangler). |
| `README.md` | Quick-start deployment steps. |
| `DOCUMENTATION.md` | This file. |
| `CHANGELOG.md` | History of what was built and fixed, in order. |

---

---

## 3. The Model (src/model.js), v9

`scoreProp()` takes one prop record and returns a scored version. The pipeline:

### Central projection

1. **Baseline.** Preferred input is a **game log** of that exact stat, most
   recent game first. It is reduced with exponentially weighted moments
   (decay 0.85, so the latest game carries roughly 3x the weight of one five
   outings back). This replaces v8's hard 60/40 split between "last 3 games"
   and "season average", which was an arbitrary cut point. If no log is
   supplied the old blend is used, so props saved under v8 still score. With
   neither, the market line is used as a neutral prior and confidence is
   forced to Low, because a projection derived from the line carries no
   independent information.

2. **Prior-year scheme-role blend.** Weight `MAX(0, 0.35 - (week-1) x 0.09)`,
   fading from 35% in Week 1 to 0% by Week 5, covering the stretch where
   current-season samples are too thin to trust.

3. **Schedule normalization.** Optional. If the average opponent defensive
   EPA the player has already faced is supplied, that embedded effect is
   removed from the baseline before this week's matchup adjustment is applied,
   so the two do not compound. v8 silently double-counted here.

### Multiplicative adjustments (summed, capped at +/-50%)

4. **Matchup.** Prefers opponent defensive EPA per play, scaled so +/-0.15 EPA
   maps to the +/-15% cap. Falls back to a 1-32 rank, which is worse because a
   rank discards magnitude.
5. **Weather.** Wind above 15mph or precipitation: -8% for passing and
   receiving, +3% for rushing. Domes neutralize it.
6. **Role/scheme.** One subjective 1-10 score, capped at +/-10%, discounted
   when the play caller changed (scaled by the size of the scheme shift when a
   numeric value is given). v8 used two separate 1-10 fields that moved
   together in practice, which made one signal look like two.
7. **Usage trend.** Capped at +/-7%, down from +/-15%. Intended only for
   information not yet in the game log, such as a teammate placed on IR this
   week. Anything already visible in recent production is double-counted here.
8. **Pressure rate allowed** (passing props only), league average 25%,
   capped +/-10%.
9. **Red zone share** (touchdown props only), 20% baseline, capped +/-15%.

### Distribution and probability

10. **Distribution by prop type.** v8 used a normal distribution for
    everything, which is fine for 208.5 passing yards and wrong for 4.5
    receptions or 0.5 touchdowns, where outcomes are non-negative integers
    with real skew and the normal assigns probability mass to impossible
    values.

    | Prop type | Distribution | Reason |
    |---|---|---|
    | Yardage | Normal | Continuous enough at volume |
    | Receptions, carries, completions, targets | Negative binomial | Overdispersed counts (variance > mean) |
    | Touchdowns | Poisson | Low-count, determined by its mean |

    Negative binomial uses the mean/variance parameterization
    `r = mean^2/(var-mean)`, `p = mean/var`, falling back to Poisson when the
    data are not overdispersed, since it is undefined there.

11. **Variance.** Computed, not typed. From a game log: exponentially weighted
    variance, rescaled to the adjusted mean to preserve the coefficient of
    variation, then shrunk toward a prior by empirical Bayes
    (`(n x observed + 5 x prior) / (n + 5)`). Variance estimates are noisier
    than mean estimates, hence the fairly heavy shrinkage. Without a log, a
    **stat-specific** coefficient of variation is used rather than v8's single
    "35-45% of the mean" rule for every stat:

    | Stat | Prior CV |
    |---|---|
    | Passing yards | 0.25 |
    | Rushing yards | 0.45 |
    | Receiving yards | 0.50 |
    | Receptions / targets | 0.35 |
    | Carries / attempts | 0.30 |
    | Completions | 0.20 |

    A manual override remains available but is no longer the primary path. In
    v8 this hand-typed number determined every probability and confidence
    tier, which made it the single weakest link in the model.

12. **Integer lines.** Push probability is computed explicitly for count props
    on whole-number lines, instead of treating every line as a half-line.

13. **Injury as a mixture, not a haircut.** v8 multiplied the projection by
    0.95 for Questionable and 0.75 for Doubtful. No player produces 95% of
    normal; he plays close to full or does not play. v9 instead models:

    ```
    P(over) = P(plays) x P(over | plays)
    ```

    with P(plays) of 1.0 / 0.75 / 0.25 / 0 for Healthy / Questionable /
    Doubtful / Out. These are coarse base rates, deliberately not given false
    precision. The central projection barely moves; the probability moves a
    great deal, and the probability is the output that matters. The reported
    `finalProjection` is conditional on playing, with `expectedValue` and
    `playProbability` shown separately.

14. **Confidence.** High at >=62% probability of the leaned side, Medium at
    >=56%, else Low. Capped at Medium when fewer than 3 games of data exist,
    and forced to Low when there is no player data at all.

15. **Ranking.** Both the per-team rank and the Top Picks list now sort by
    probability. In v8 the two views used different metrics (absolute edge %
    versus probability) and could disagree whenever variance differed between
    players.

### Removed in v9

The **scheme direction nudge**, a +/-5% push on rush versus pass props based on
under-center rate. The magnitude-based confidence discount from the same input
is retained because it is well-motivated, but the directional piece was close
to noise at the individual player level and added movement it could not
justify. Removing it lowers apparent sophistication in exchange for fewer
unjustified adjustments.

### Deliberately excluded

A team's Vegas implied point total: published analysis found close to zero
standalone predictive power for receiving yards once season averages already
reflect team pace and scheme, so including it risks double-counting. The same
test applies to any candidate factor. If it correlates strongly with something
already in the model, it is more likely to add noise than accuracy.

### The honest caveat

Every constant above is a judgment call, not a fitted parameter: the 0.85
decay, the shrinkage constant of 5, every +/-cap, the 0.09 weekly fade, the
62%/56% thresholds, the play probabilities, the prior CVs. They are defensible
and internally consistent. None of them were estimated from data.

That makes v9 more **principled** than v8, not provably more accurate. The
only thing that establishes accuracy is the calibration tracking in Section 5a,
and that needs roughly 50 to 100 graded picks before it says anything.

---

## 4. API Reference

All endpoints are served from the Worker's own domain (e.g.
`https://nfl-prop-model.<you>.workers.dev`). Every endpoint requires the
`x-app-secret` header if `APP_SECRET` is configured (see Section 5); if it
isn't configured, all endpoints are open.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serves the frontend (HTML/CSS/JS). |
| GET | `/api/props` | Returns all stored prop records, raw (unscored). |
| POST | `/api/props` | Creates or updates a prop record. Body is validated and whitelisted (Section 5). |
| DELETE | `/api/props/:id` | Deletes one prop record. |
| GET | `/api/scored` | Returns all props run through `scoreProp()`, ranked within their team. |
| GET | `/api/top?n=15` | Returns the top N props league-wide, ranked by probability (or edge % if no std dev was given). Max 50. |
| GET | `/api/tracker` | Returns all logged validation-tracker entries. |
| POST | `/api/tracker` | Creates or updates a tracker entry. |
| DELETE | `/api/tracker/:id` | Deletes one tracker entry. |
| GET | `/api/weekly-stats` | Returns the latest pre-computed pressure rate / red zone share data (Section 6), or null if none has been fetched yet. |

All responses are JSON except `/`.

---

---

## 5a. Calibration, the measure that actually validates the model

Hit rate tells you whether you won. It cannot tell you whether the
probabilities mean anything. A model can win 58% of its picks while claiming
75% confidence, and that model is useless for sizing even though its record
looks fine.

**Calibration** compares claimed probability to observed frequency, in bands.
If the model says 62% and those picks hit near 62%, the numbers are honest and
can be acted on. The tracker computes this automatically once picks are logged
with a `claimedProb`, which the Log button on the scored-props view carries
across for you.

**Brier score** summarizes it in one number: the mean squared difference
between claimed probability and outcome. Lower is better. **0.25 is the score
you would get by always saying 50%**, so anything above 0.25 means the
probabilities are actively misleading and worse than admitting ignorance.

A **negative gap** in a band means overconfidence in that band, the most common
failure mode for a model whose constants were chosen by judgment rather than
fitted. Treat fewer than roughly 50 to 100 graded picks as too small to act on.

Keep tracking closing line value alongside it. CLV and calibration answer
different questions: CLV asks whether you are beating the market to
information, calibration asks whether your stated confidence is trustworthy.

---

## 5. Security Guardrails

| Guardrail | What it does | Why |
|---|---|---|
| Shared-secret auth (`APP_SECRET`) on every endpoint | Every API call must include the correct `x-app-secret` header | Without this, anyone with the URL can read/write your data |
| Timing-safe secret comparison | Compares the provided secret byte-by-byte in constant time | Prevents guessing the secret via response-time differences |
| In-page login screen (not `window.prompt()`) | A real HTML form for entering the password | Many mobile browsers silently block auto-firing `prompt()` dialogs on page load, this is more reliable and better UX |
| Input whitelisting | Every POST body is filtered to a fixed list of known fields before being stored | Blocks arbitrary/unexpected data from being written to storage |
| Length and size limits | 20KB max request body, 200-char max per string field, 2,000-record max per store | Prevents storage-fill abuse and oversized payloads |
| Output escaping (`esc()` client-side, `escapeHtml()` server-side) | Every value is HTML-escaped before being inserted into the page | Prevents stored XSS, e.g. a "player name" containing a script tag |
| Locked-down CORS | API only allows requests from the app's own origin (or one you explicitly configure) | Stops arbitrary third-party websites from calling your API from a visitor's browser |
| Security headers on the main page | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive `Content-Security-Policy` | Blocks MIME-sniffing attacks and clickjacking (embedding your app in another site's invisible iframe) |
| Fixed fetch target for the scheduled job | The cron handler only ever fetches the exact URL in `STATS_FEED_URL`, never anything derived from a request | Rules out server-side request forgery (SSRF) through that code path |
| Fetch timeout (8s) on the scheduled job | Aborts a hung external request | Prevents a stuck scheduled invocation |
| Response shape validation on the external stats feed | Checks the fetched JSON has the expected structure before storing it | Prevents malformed or unexpected data from corrupting stored state |

**Not built into the code, worth doing on Cloudflare's dashboard:**
Cloudflare Access (a real multi-factor login screen, free for small use),
dashboard-level rate limiting rules, and Workers Analytics/Logs for
monitoring unusual traffic.

---

## 6. Automated Stats Pipeline

`github-action/compute_weekly_stats.py` computes two things from the free,
public nflverse play-by-play dataset:

- **Pressure rate allowed** (team-level): pressured dropbacks divided by
  total dropbacks.
- **Red zone usage share** (player-level): a player's red-zone touches
  divided by their team's total red-zone plays.

This deliberately runs in **GitHub Actions**, not inside the Cloudflare
Worker: parsing raw play-by-play data needs more CPU time than the Worker's
free tier allows (10ms per invocation). GitHub Actions gives 2,000 free
minutes/month (unlimited for public repos), comfortably enough for a
twice-weekly run.

The workflow (`.github/workflows/weekly-stats.yml`) runs automatically on
Tuesdays and Fridays, computes the stats, and commits `weekly-stats.json`
back to the repo. The Worker's own cron trigger (see `wrangler.toml`,
scheduled an hour later) fetches that file and stores it in R2, from which
`/api/weekly-stats` serves it. See the README for the one-time setup steps
(pushing to GitHub, setting `STATS_FEED_URL`).

---

---

## 6a. Automatic result grading

Filling in actual results by hand is the step most likely to be skipped, and
skipping it means calibration never gets computed. This pipeline automates it.

### How it flows

```
GitHub Action (free, twice weekly)
  compute_player_stats.py
  -> reads free public nflverse weekly player data
  -> writes player-stats.json, commits it to your repo
        |
        v
Cloudflare Worker cron (Tue 10:00 / Fri 18:00 UTC)
  -> fetches player-stats.json from the raw GitHub URL
  -> stores it in R2
        |
        v
You, on the Validation Tracker tab
  -> Preview: dry run, reports what it would fill, changes nothing
  -> Apply:   writes the matched results
```

GitHub never receives your app password. The Action only writes a public JSON
file; the Worker pulls it on its own schedule. Grading runs entirely inside the
Worker.

### Setup

1. Push this project to a GitHub repo (public repos get unlimited free Actions
   minutes).
2. Run the workflow once from the Actions tab, or wait for the schedule.
3. Set the raw URL as a Worker secret:
   ```
   npx wrangler secret put PLAYER_STATS_URL
   ```
   Paste: `https://raw.githubusercontent.com/<you>/<repo>/main/player-stats.json`
4. Redeploy. Use **Refresh stat feed** on the tracker tab to pull it
   immediately instead of waiting for the next cron.

### Matching rules

Names are normalized identically on both sides (lowercased, accents and
punctuation stripped, generational suffixes dropped) so that "D.J. Moore" and
"DJ Moore", or "Ja'Marr" and "JaMarr", resolve to the same key. Matching then
proceeds in tiers:

| Tier | Key | Purpose |
|---|---|---|
| 1 | normalized name + team + week | Primary. Team guards against same-surname collisions. |
| 2 | normalized name + week | Catches a stale team code after a mid-season trade. |
| 3 | first initial + surname + team + week | Last resort, team required. |

**Nothing is ever guessed.** Every case that does not resolve to exactly one
row is returned for manual entry with a specific reason:

| Status | Meaning |
|---|---|
| `matched` | Exactly one row, value filled |
| `ambiguous` | More than one player matched; the candidates are listed |
| `no_match` | No row for that player-week, or the stat is not recorded |
| `no_stat_key` | Prop type has no single stat column (e.g. "Anytime TD", which can be satisfied by either a rushing or receiving score) |
| `missing_week` | No published stats for that week yet |

This strictness is deliberate. A silently mismatched name produces a
plausible-looking result that corrupts both the hit rate and the calibration
numbers with no visible symptom, which is worse than an empty field.

### Safety properties

- **Preview is a true dry run.** It performs no writes.
- **Existing values are never overwritten.** Only entries whose `actual` is
  blank are touched, so a value you entered or corrected by hand is safe.
- **Idempotent.** Running Apply twice matches zero the second time.
- **Fails closed.** With no stats feed configured it returns a 503 explaining
  what to set, rather than silently doing nothing.

### What is not automated, and why

**Opening and closing lines remain manual.** Sportsbook odds are not in any
free public dataset, and scraping books violates their terms of service. The
legitimate route is a paid odds API (roughly $30 to $50 a month for historical
line data). Until then, lines are typed in, which is also the moment you are
already looking at them.

This means hit rate and calibration are fully automatable, while CLV is not.
Of the three, CLV is the one that depends on data you have to buy.

---

## 7. Known Limitations

- **No multi-user support.** One shared password protects the whole app;
  there's no per-user login or permissions system.
- **Opening and closing lines require manual entry.** Actual results are
  now auto-graded (Section 6a), but sportsbook lines are not available in any
  free dataset and scraping books violates their terms, so CLV still depends
  on hand-entered lines or a paid odds API.
- **Pressure rate and red zone share require the optional GitHub Action.**
  Without it, those two fields must be filled in manually from whatever
  source you use (e.g. PFF, Sports Info Solutions, FTN Fantasy).
- **The model is a decision-support tool, not a prediction guarantee.**
  Every projection, probability, and confidence tier is a structured
  best-estimate from the inputs provided, not a certainty. See the
  "Reality Check" language throughout the README and this doc.

---

## 8. Changelog

See `CHANGELOG.md` for the full build history, including the bug fixes
made during initial deployment troubleshooting.
