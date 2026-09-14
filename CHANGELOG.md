# Changelog

All notable changes to this project, in the order they were built.

## v1: Initial model and spreadsheet (pre-app)
- Weighted-average projection combining recent-form and season-average stats.
- Matchup, weather, coach/scheme, usage-trend, and injury adjustments.
- Built first as an Excel workbook (Weekly_Inputs, Scoring_Engine,
  Top_Picks_By_Team tabs) before being ported to a live app.

## v2: Scheme-role carryover
- Added OC/Play-Caller Continuity and Prior-Year Role Stat Baseline inputs.
- Added the fading Prior-Year Weight (35% in Week 1, 0% by Week 5), so
  early-season projections lean on last year's scheme role data before
  enough current-season data exists.
- Coach/Scheme Adjustment is halved when continuity is broken (new
  play-caller).

## v3: Probability-based confidence, spreadsheet validation tracker
- Added Games Played This Season and Est. Std Dev inputs.
- Added true P(Over)/P(Under) via the normal distribution, replacing the
  cruder "edge % vs. line" heuristic as the primary confidence driver.
- Small-sample rule: Confidence is capped at Medium if Games Played This
  Season is under 3, regardless of computed probability.
- Added a Model_Validation_Tracker tab to the spreadsheet: log picks,
  auto-grade Hit/Miss/Push, and compute Closing Line Value (CLV) direction.

## v4: Live app (Cloudflare Workers + R2)
- Ported the entire spreadsheet model to `src/model.js` as pure JavaScript
  functions. Verified to produce identical output to the spreadsheet on a
  known test case (Travis Kelce example: 7.1 final projection, 81.9%
  P(Over), High confidence, matched exactly).
- Built `src/index.js`: a Cloudflare Worker serving both the frontend and a
  REST API, with R2 as the storage layer (two JSON files: props and
  tracker entries).
- Added the Validation Tracker to the live app with hit-rate and CLV-rate
  breakdowns, including a breakdown by confidence tier and by lean
  (OVER/UNDER), and an explicit warning against drawing conclusions from
  samples under ~20 picks per tier.

## v5: Two new model factors
- Added Pressure Rate Allowed (passing props only) and Red Zone Usage
  Share (touchdown props only), each gated to the prop types they actually
  apply to, to avoid double-counting overlapping signals.
- Verified both against hand-computed test cases before shipping (a 0.32
  pressure rate correctly reduced a passing projection by 2.8%; a 0.35 red
  zone share correctly increased a TD projection by 11.2%).

## v6: Automated stats pipeline
- Built `github-action/compute_weekly_stats.py`, which computes team-level
  pressure rate and player-level red zone share from the free, public
  nflverse play-by-play dataset.
- Added `.github/workflows/weekly-stats.yml` to run that script twice a
  week (Tuesday and Friday) for free on GitHub Actions.
- Added a matching Worker cron trigger (`wrangler.toml`) that fetches the
  resulting `weekly-stats.json` and stores it in R2, exposed via
  `GET /api/weekly-stats`.
- Deliberately kept the heavy computation in GitHub Actions rather than the
  Worker itself, to stay within the Worker's free-tier CPU-time limit.

## v7: Security hardening
- Added shared-secret authentication (`APP_SECRET`) to every API endpoint,
  not just writes.
- Switched from `window.prompt()` to a real in-page login screen, since
  many mobile browsers silently block auto-firing prompt dialogs on page
  load.
- Added timing-safe secret comparison, input whitelisting, request body
  size limits, per-field length limits, and a hard cap on stored record
  counts.
- Added output escaping (`esc()` / `escapeHtml()`) everywhere user-supplied
  data is rendered into the page, to prevent stored XSS.
- Locked down CORS to the app's own origin by default.
- Added security headers to the main page response (`X-Content-Type-
  Options`, `X-Frame-Options`, `Content-Security-Policy`).
- Pinned the scheduled job's fetch target to a fixed config value (never
  derived from a request) and added a fetch timeout, to rule out SSRF and
  hung invocations.

## v7.1: Bug fix, nested template-literal escaping error
- **Symptom:** `Uncaught SyntaxError: Unexpected string` in the browser
  console, app failed to load or respond to input.
- **Root cause:** the entire frontend (including its `<script>` block) is
  embedded as a JavaScript template literal (`const HTML = \`...\`;`) inside
  the Worker's own source. That outer template literal processes its own
  escape sequences at runtime, so a single `\"` written in the source (meant
  to survive into the client-side script as an escaped quote) was being
  consumed and stripped down to a bare `"` before ever reaching the
  browser, corrupting the `esc()` helper's object literal syntax. This
  reproduced identically through clean CLI deploys and in fresh incognito
  windows, correctly ruling out both copy-paste corruption and browser
  caching as the cause.
- **Fix:** doubled the backslash (`\\"`) in the source so one level
  survives the outer template literal's own evaluation, leaving the
  correct `\"` in the actual served script. Verified this time by
  executing the real template literal in Node (simulating exactly what the
  Worker runtime produces), extracting the true resulting script, and
  confirming it passes a syntax check, rather than only inspecting the
  source text.

## v11: Correlation, bet economics, export, backtesting

- **Same-game correlation surfaced.** Picks sharing a game are grouped under an
  order-independent key (BAL vs IND and IND vs BAL collapse to one), and each
  pick is labelled with the likely correlation direction against the others:
  positive for a teammate in the same stat family, negative for an opponent,
  mixed for rush against pass within a team. The scored view warns when
  exposure is concentrated. This does not estimate a correlation matrix, which
  would need far more data; it makes the exposure visible instead of silently
  assuming independence. Matters because correlated misses cluster and make
  calibration look worse than the model deserves, and because multiplying
  same-game leg probabilities for a parlay is badly wrong.
- **Bet economics.** New `played`, `odds`, and `stake` fields. ROI, units
  profit, and the break-even rate implied by the prices paid are computed over
  actually-played picks only, which is what separates model skill from
  bet-selection judgment. Verified numerically that 55% at -130 loses (-2.7u
  over 100 bets) while 52% at +100 wins (+4.0u), the exact claim that motivated
  adding this.
- **Export endpoint and button.** Everything previously lived in one R2 bucket
  with no backup.
- **Backtest harness** (`backtest/`), importing the live model directly so
  results apply to it rather than to a copy. Measures point accuracy against a
  naive prior-mean benchmark, and distribution calibration via the probability
  integral transform, which needs no sportsbook lines. Enforces no lookahead:
  only games strictly before the target week build its inputs.

### Bug fixed during this build

A string edit corrupted the return statement in `renderScoredTable`, leaving
`return html + ,`. Caught by the check that executes the HTML template literal
and syntax-checks the actual served script, which is the third time that check
has caught a defect the source-level check missed.

### Harness validated against known-answer data

Synthetic histories with deliberately mismatched volatility confirmed the
harness detects both failure modes: data 60% more volatile than the model
assumes produced 40.0% central-50 coverage against a 50% target with tails
clumped at 17% per decile, and data half as volatile produced 63.9% coverage
with the middle deciles clumped. Matched data produced 47.8%.

**Finding worth flagging:** on that synthetic data the exponentially weighted
mean did not beat a simple average of prior games. That is correct there, since
the generator holds each player's true level constant and recency weighting
therefore adds variance without signal. Recency weighting only earns its place
if form and role genuinely drift in-season. Real data will settle it, and the
honest answer may be that the 0.85 decay should be closer to 1.0.

## v10.1: Bug fix, Log button omitted the week

- **Symptom:** every pick logged via the Log button failed auto-grading with
  "no week recorded on this pick", because the button payload did not include
  a week field while the matcher requires one to select a player-week row.
- **Impact:** auto-grading worked in testing (where picks were seeded directly
  with a week) but would have matched zero in real use through the UI, which is
  exactly the path a user would take. Found by auditing the Log payload against
  the grader requirements rather than by a test, since the test fixtures
  happened to supply the field the UI did not.
- **Fix:** week added to the Log payload, plus a full end-to-end audit of the
  logging chain: Log payload round-trip through the whitelist, auto-grade of a
  Log-button pick, propagation into hit rate and calibration, presence of every
  required field on the manual tracker form, CLV computation intact, and a
  check that no prop input field is silently dropped by the whitelist. All
  clean.

## v10: Automatic result grading

Filling in actual results by hand was the most-skipped step, and skipping it
meant calibration never got computed. This release automates it end to end
while refusing to guess.

- **New GitHub Action script** (`compute_player_stats.py`) publishes a compact
  per-player, per-week stat lookup from the free public nflverse weekly
  dataset, including a precomputed combined rush+rec yardage figure for the
  markets that post it.
- **New Worker endpoints:** `GET /api/autograde` (dry run, writes nothing),
  `POST /api/autograde` (applies matches), and `POST /api/refresh-stats` to
  pull the feeds on demand instead of waiting for the cron.
- **Tiered name matching** with normalization mirrored exactly between the
  Python and JavaScript sides: normalized name + team + week, falling back to
  name + week (for stale team codes after a trade), then first initial +
  surname + team as a last resort.
- **Refuses to guess.** Anything that does not resolve to exactly one row is
  surfaced for manual entry with a specific reason (`ambiguous`, `no_match`,
  `no_stat_key`, `missing_week`). A silently mismatched name produces a
  plausible-looking value that corrupts the hit rate and calibration with no
  visible symptom, which is strictly worse than an empty field.
- **Hand-entered values are never overwritten**, and Apply is idempotent.
- **Scheduled handler refactored** into shared `refreshExternalStats()` used by
  both the cron and the manual endpoint, so there is one code path. Both feed
  URLs come from configuration and are never derived from a request, keeping
  the SSRF guarantee from v7.

### Testing

- Name normalization verified on the pairs that actually break these pipelines
  ("D.J. Moore"/"DJ Moore", "Ja'Marr"/"JaMarr", "Amon-Ra St. Brown", suffix
  variants) and confirmed **not** to collide distinct players sharing a
  surname (Josh Allen vs Keenan Allen, Michael Thomas vs Brian Thomas).
- 25 matching tests covering all prop-type mappings plus every failure mode.
- Full grading simulation: dry run confirmed to write nothing, ambiguous
  same-name players correctly flagged rather than resolved, hand-entered
  results preserved, second Apply matching zero, and a missing feed returning
  a 503 with setup guidance.

### Still manual

Opening and closing lines. Sportsbook odds are not in any free public dataset
and scraping books violates their terms, so CLV continues to depend on
hand-entered lines or a paid odds API. Hit rate and calibration are now fully
automatable; CLV is the one that costs money.

## v9: Accuracy overhaul

The theme of this release is replacing assumptions with either computation or
an honest admission of uncertainty.

**Distribution branching.** v8 applied a normal distribution to every prop.
That is defensible for 208.5 passing yards and wrong for 4.5 receptions or 0.5
touchdowns, where outcomes are non-negative integers with real skew and the
normal assigns probability to impossible values. v9 uses a negative binomial
for count props, Poisson for touchdowns, and normal only for yardage. All
distribution code was validated against analytic values: log-gamma against
known factorials, Poisson and normal CDFs against hand-computed figures, and
the negative binomial verified to integrate to 1 and to recover its stated
mean and variance numerically.

**Injury as a mixture, not a haircut.** v8 multiplied the projection by 0.95
for Questionable and 0.75 for Doubtful, modelling an outcome that does not
occur; a questionable player plays close to full or does not play. v9 computes
`P(over) = P(plays) x P(over | plays)`. In testing, a Doubtful player on a 65
receiving-yard line moved from v8's 44.7% over to v9's 16.1%, which is the
honest figure given a 75% chance of producing zero.

**Variance computed rather than typed.** v8's probabilities and confidence
tiers rested entirely on a hand-entered standard deviation, making it the
weakest link in the model. v9 derives it from a game log using exponentially
weighted variance (decay 0.85), rescaled to the adjusted mean and shrunk
toward a prior by empirical Bayes. Without a log it falls back to
**stat-specific** coefficients of variation rather than one global
"35-45%" rule, which overstated variance for high-volume QB stats and
understated it for boom/bust receiving roles. Tested on two logs with similar
means but very different volatility: the steady log produced sd 26.2 and 68.3%
confidence, the volatile log sd 58.3 and 60.7%. v8 could not distinguish them.

**Bias reduction.** Coach Volume and Scheme Fit collapsed into a single
Role/Scheme Volume score, since in practice they moved together and made one
signal appear to be two. Usage Trend cut from +/-15% to +/-7% and redefined to
cover only information not already visible in the game log; at +/-15% a
subjective field carried the same authority as the data-driven matchup
adjustment while double-counting recent form.

**Schedule normalization.** Optionally removes the matchup effect already
embedded in a player's baseline before applying this week's matchup
adjustment, which v8 silently compounded.

**Integer-line push probability** computed explicitly for count props instead
of treating every line as a half-line.

**Ranking consistency.** Per-team rank and the Top Picks list both sort by
probability now. In v8 they used different metrics and could disagree whenever
variance differed between players.

**Calibration tracking added.** The tracker now records the probability the
model claimed at pick time and reports Brier score plus a claimed-versus-actual
breakdown by probability band. This is the only thing that can establish
whether the model is actually accurate rather than merely principled.

**Removed:** the v8 scheme *direction* nudge (+/-5% on rush versus pass from
under-center rate). The magnitude-based confidence discount is kept, but the
directional push was close to noise at the player level. This is a deliberate
reduction in apparent sophistication.

### Bugs found and fixed during this build

- **TD props were misclassified as counts.** The pattern `\btd\b` silently
  fails on "Rush TDs" because the trailing s is a word character, so touchdown
  props were routed to the negative binomial instead of Poisson. Caught by a
  classification test across 17 realistic prop-type strings.
- **Two template-literal quote collapses.** Escaped quotes written as `\"`
  inside the HTML template literal collapse to bare `"` in the served output,
  breaking the client script. Same root cause as the v7.1 bug. Caught before
  deployment by the check that executes the template literal and syntax-checks
  the actual served script, rather than only checking the source.
- **Displayed probabilities could sum to 1.001.** Three values rounded
  independently. Under is now taken as the residual of the rounded pair so the
  displayed set always sums to exactly 1.
- **Poisson props reported an unused standard deviation.** A Poisson
  distribution is determined by its mean, so the computed sd played no part in
  touchdown probabilities. Reporting one implied an input that was not being
  used; it now reports sqrt(mean) and labels itself as unused.

### Backward compatibility

Props saved under v8 still score. The old `last3`/`seasonAvg` blend is retained
as a fallback when no game log is supplied, and the two legacy role fields are
averaged when no v9 single score is present. Verified by simulation.

## v8: Continuous scheme shift and EPA-based matchup
- Replaced the binary OC-continuity flag with an optional **numeric
  Play-Caller Scheme Shift** (change in under-center rate, in percentage
  points). Its magnitude discounts the Coach/Scheme Adjustment on a sliding
  scale rather than a flat halving, and its direction applies a tight
  +/-5% nudge favoring rush props on a move toward under-center and
  pass/receiving props on a move toward shotgun. The original Y/N flag
  still works as a fallback when no numeric value is supplied, verified
  by test.
- Added optional **opponent defensive EPA allowed per play** as a more
  precise alternative to the 1-32 defensive rank for the Matchup
  Adjustment, since ranks discard magnitude. Falls back to rank when not
  supplied. Verified that EPA correctly overrides a conflicting rank.
- **Bug caught during testing:** receiving props were initially excluded
  from the directional scheme nudge, because the prop-type check only
  matched "rush" and "pass". Receiving yards depend on pass volume, so
  they should move with the passing side. Fixed by matching
  receiving/reception/target prop types onto the pass side, and verified
  across five prop types.

## v7.2: Full documentation
- Added `DOCUMENTATION.md`: complete architecture, model formula reference,
  API reference, security guardrail reference, and known limitations.
- Added this changelog.
