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

## v16: First real, data-verified fix to the model's own math

Everything up to this point tuned inputs (WOPR, EPA, single-game handling)
or built infrastructure (bulk log, auto-grade, routes proxy, the historical
data pipeline). This is the first change to the model's actual probability
math justified by real evidence rather than judgment, made possible by
finally having 97,029 real player-weeks (6 seasons, 2021-2026) to check
against instead of guessing.

- **Receiving yards' variance prior corrected from 0.50 to 1.1** (as a
  coefficient of variation). The old value was a judgment call never
  checked against outcomes. A sweep against 19,787 real cases found
  central-50 coverage at the old value was 38.8% against a 50% target,
  meaning every receiving-yards prop's uncertainty band was badly too
  narrow. Swept 0.20 to 1.20; 1.1 was the best fit (50.9% coverage, KS
  statistic down from 0.1353 to 0.1085). This also fixed a by-week shape
  problem as a side effect: coverage under the old value climbed steadily
  across a season and never closed the gap (33% by week 4, still only 42%
  by week 18); under 1.1 it holds steady in the 48-55% range for nearly the
  whole season.
- **Confirmed rushing and passing yards' priors (0.45, 0.25) are already
  well-calibrated on average** (48.7% and 49.9% coverage respectively), no
  change made to either.
- **A separate, unresolved structural limitation found and documented, not
  fixed.** Swept the shrinkage constant (SHRINK_K, 1 through 50) against
  both rushing and passing. No single value corrected the calibration
  shape: coverage starts too low early in a season and drifts past the
  target late in it, in both stats, and the KS statistic barely moved
  across the entire swept range. A single constant can only shift the
  whole curve, not correct a curve that bends the wrong direction partway
  through a season. The real fix needs the shrinkage weight to change as
  games accumulate within a season, not a different fixed number, that is
  a genuine model change and has not been made. Documented in detail
  directly in the code at SHRINK_K's definition, with the exact commands
  to reproduce the finding.

### What made this possible

Built the tooling for this across three prior steps: the historical data
puller (`compute_historical_stats.py`, pulled all 6 seasons nflreadpy
actually has), and a real parameter sweep added to `backtest.mjs` (the
`--sweep cv` and `--sweep shrinkK` flags), replacing what had been a stub
that only explained why sweeping wasn't possible yet. Both were validated
against synthetic data with a known correct answer before being pointed at
real data: the sweep mechanism correctly recovered a value close to an
injected true CV of 0.70 (found 0.8) before it was ever trusted with the
real 97,029-record file.

### Verified

The exact backtest run that motivated this change is reproducible: `node
backtest/backtest.mjs --data <historical> --stat receiving_yards --sweep
cv`. Confirmed the fix does not affect scoring when a manual stdDev
override is present (the standing Kelce regression case, unaffected).
Confirmed the new CV is used only for receiving-yardage props and rushing
and passing props remain at their original values (checked via
varianceSource on live scoreProp() calls). Rebuilt dashboard-bundle.js and
reconfirmed both it and src/index.js produce byte-identical runtime-served
client scripts.

## v15: Fixed single-game data being silently discarded

Discovered while trying to run real Week 2 players through the model: with
the season only one week old, every player has exactly one game played, and
the model's primary method (the weighted game log) requires at least two
entries to compute anything. A single game typed into Game Log fell straight
through to the zero-data fallback, silently discarding it entirely, unless
Last 3 / Season Avg were also filled in by hand as a workaround. This was not
a rare edge case, it was the actual situation every prop was in this week.

- **Single-game log entries are now used.** A lone real game blends toward a
  stabilizing prior (the prior-year baseline if given, otherwise the market
  line, itself an efficient estimate) rather than being discarded or taken
  at full face value, so one monster or disaster game nudges the projection
  without defining it outright.
- **Variance widens correctly for the n=1 case.** Predicting a new outcome
  from an estimated mean carries two stacked sources of uncertainty: the
  underlying spread of outcomes, and how uncertain the mean estimate itself
  is from a single observation. The standard result is prior variance times
  (1 + 1/n), which doubles the width at n=1 and relaxes toward the plain
  prior as more games accumulate. This was the missing piece that let one
  outlier game produce an overconfident-looking probability: the projection
  moved to reflect the single game, but the uncertainty band around it
  previously did not widen to match.
- **A downstream confidence-tier check was also wrong.** It forced Low
  confidence whenever the game log had fewer than 2 entries, which correctly
  caught genuinely zero player data but also caught the newly-legitimate
  single-game case, double-penalizing the same small sample that the
  widened variance had already accounted for. Narrowed to fire only on
  actually zero data.

### Verified

Confirmed the exact discard bug directly: a real 182-yard game previously
produced a projection of 59.1 (pure market-line fallback, the real number
completely ignored); after the fix, 86, correctly incorporating it with
appropriate shrinkage. Re-ran the same 10 real Week 1 players that had
exposed the issue: extreme single-game outputs came back to sane ranges
(Chris Olave's P(Over) dropped from an overconfident 89.9% to 66.2%; Terry
McLaurin's went from an impossible-looking 0.0% to a reasonable 38.6%).
11 new edge-case tests: priorYrBaseline correctly used as the stabilizing
anchor over the market line when both are available, a single game with
neither anchor available falls back to the game itself rather than
crashing, a real zero-yardage game handled without producing NaN, count and
TD prop types unaffected by the new branch, each variance source string
correctly identifies which path was used, and the manual standard-deviation
override still takes priority over all of this untouched. Reran the
standing Kelce regression case (2+ game log, unrelated to this fix) and the
zero-data fallback case, both unchanged. Confirmed the runtime-served
client script still parses cleanly.

## v14.1: Confirmed against live data, fixed a real signature bug, added season fallback

The discovery step ran against real nflverse data for the first time and answered the
open questions directly.

- **Confirmed:** `load_participation()` explicitly rejects the current season
  ("Season must be between 2016 and 2025"), a real, documented limit on
  nflverse's side, not a bug. Participation data lags behind play-by-play in
  nflverse's publishing pipeline.
- **Confirmed:** FTN charting works fine for 2026, but has no route-specific
  column (verified against the real 2,675-row output: blitz counts,
  personnel backfield counts, play-action/screen flags, nothing about
  routes). Participation remains the only free path to this proxy.
- **Real bug fixed:** `load_players()` doesn't accept a `seasons` keyword at
  all, calling it that way raised a `TypeError` on every attempt. It's a
  global roster/ID table, not a season-scoped one. Fixed by adding a
  no-argument call as a third attempt, confirmed working against the
  real function's actual signature.
- **Added season fallback for participation specifically**, since it's now
  confirmed capped at 2025: tries the requested season, then two years back,
  and once it finds a year that works, fetches play-by-play for that SAME
  year (not the originally requested one) so the join stays internally
  consistent. A mismatched-season join would have silently matched nothing.
- **Output now includes `season`, `requestedSeason`, and `isStale`**, so a
  consumer of `route-stats.json` can tell at a glance whether the data is
  current or falling back to a prior season, rather than silently treating
  stale data as current.

### Verified

Re-ran all five prior scenarios, all still pass. Added a sixth test built
directly from the real log output pasted after the live run, reproducing the
exact behavior confirmed live: participation rejecting 2026, FTN charting
succeeding with no route column, `load_players()` rejecting the seasons
kwarg, and the corrected script falling back to 2025 participation data,
matching it to 2025 play-by-play, and correctly flagging the result as
`isStale: true`.

### What this means practically

The routes-run proxy will not populate for the current season until nflverse
publishes participation data for it, likely sometime after the season
concludes based on the pattern of prior seasons. Until then, every run
produces real 2025 data, useful for the backtest harness, correctly labeled
as not representing the current season, rather than an empty file every
single week.

## v14: Routes-run proxy (yards per route run)

Requested build for a real metric that has no free exact source, so this is
explicitly a proxy, documented as such everywhere it appears.

- **New script** (`compute_route_stats.py`) approximates routes run as "pass
  plays a receiver was on the field for," using nflverse participation data
  joined against play-by-play (filtered to real dropbacks) and a player
  ID-to-name crosswalk. This is an upper bound on true routes run, not an
  exact figure, since participation data cannot distinguish a receiver who
  ran a route from one who stayed in to pass-block on a given play. The
  output file is explicitly labeled `isProxy: true` with a note explaining
  the limitation, so it's never mistaken for the real PFF-style metric,
  which has no free public source and would require licensed charting data.
- **Discovery-first design**, same pattern as the original nflreadpy
  migration: the exact column names in participation data, and whether FTN
  charting exposes anything more direct, were unverified against live data.
  The script tries multiple candidate column names, prints what it actually
  finds at every step, and degrades to a clearly-labeled empty file with a
  printed reason rather than crashing if an assumption is wrong. Wired into
  the workflow with `continue-on-error`, so a shortfall here can never block
  the two scripts that are already working.
- **`weekly-stats.yml`** updated to run the new script and include
  `route-stats.json` in both the "show what was produced" and commit steps.

### Bug found and fixed during testing

A column selection unnecessarily required `posteam` even though nothing
downstream reads it, so a valid pbp schema missing that exact column name
crashed the entire script with a `KeyError`. Caught by a test using a
deliberately minimal pbp fixture (only the columns actually needed), which a
test built around the "expected" schema would not have exercised. Fixed by
selecting only the columns genuinely used, with an explicit check for missing
required columns beforehand instead of relying on pandas to raise if one
happens to be absent.

### Verified

Five scenarios: correct join and dropback-filtering logic against a
realistic fixture (confirmed a player who only appeared on a non-dropback
play would have been correctly excluded, and a player on the borderline case
was correctly included after checking the fixture rather than trusting a
mistaken assumption about it), an unrecognized column schema degrading
gracefully with an explanatory note, the participation/pbp functions being
entirely absent from the installed nflreadpy version, nflreadpy not being
installed at all, and both semicolon- and comma-delimited player-ID lists
being auto-detected correctly. The posteam bug was caught during this pass
and reverified after the fix.

### Honest scope note

Whether this actually improves projections is unverified and will stay that
way until there is real graded-pick volume to check it against, consistent
with the standing decision to hold off on personnel/formation data and a
full opponent-adjusted DVOA build for the same reason. This was built now at
explicit request, overriding that general default, not because the
calibration case for it changed.

## v13: WOPR-driven usage trend and EPA efficiency check

Two additions, both designed to replace subjective inputs with real data
rather than stack on top of them, following the request to remove personal
bias from the model where possible.

- **Data-driven usage trend from WOPR** (receiving props only). When a
  recent and baseline WOPR are supplied, the trend between them replaces the
  subjective Usage Trend slider entirely, capped at the same +/-7%. WOPR is
  used specifically because it already combines target share and air yards
  share into one published composite metric, using it alongside either
  component individually would double-count the same signal. Falls back to
  the manual slider when WOPR is not supplied, so existing saved props still
  score.
- **Efficiency check from EPA per opportunity**, layered onto (not
  replacing) the existing Role Adjustment. Uses receiving, rushing, or
  passing EPA depending on the prop's family. Capped at a modest +/-6%,
  smaller than other caps, because a single week of EPA is noisier than a
  full game log or a real matchup fact and should temper a role score
  rather than override it.
- **Pipeline extraction** (`compute_player_stats.py`): now pulls
  `target_share`, `air_yards_share`, `receiving_epa`/`rushing_epa`/
  `passing_epa`, `racr`, `wopr`, `pacr`, plus real `position` and
  `opponent_team`, into a separate `efficiency` object per player-week. Kept
  deliberately apart from the `stats` dict the auto-grader searches, mixing
  them in would risk a prop type accidentally matching an efficiency column
  instead of the intended box-score stat.
- **Pipeline extraction** (`compute_weekly_stats.py`): now also computes
  defensive EPA allowed per play for every team, the real-data counterpart
  to the `oppDefEpaPerPlay` field that previously had to be typed in by
  hand. Verified against a hand-calculated case (two plays, EPA 2.0 and
  -0.5, correctly averaged to 0.75).

### Verified

13 tests covering: WOPR overriding the manual slider and being correctly
capped, the manual slider correctly used as fallback when WOPR is absent,
WOPR correctly ignored on non-receiving props, negative WOPR trends handled
correctly, each EPA field mapping to the correct prop family (with cross-
contamination checked, a rushing prop with a very high receivingEpa value
supplied was confirmed to ignore it entirely), a missing EPA value
defaulting cleanly to zero, and both new adjustments confirmed to combine
correctly in the total. Also reran the standing Kelce regression case to
confirm no existing behavior changed, and ran the new fields through the
full Worker API path (not just the model in isolation) to confirm the
`usageAdjSource` flag and efficiency adjustment survive the whitelist and
JSON round-trip.

### Known gap

Extracted into the data pipeline but not yet wired into the app: the app's
form does not auto-fill these values from the published feed, they still
have to be read out of `player-stats.json` and typed in manually. Auto-fill
would need a name-matching layer similar to the auto-grader's.

## v12: Bulk log to tracker

Requested to automate "getting my top N picks into the tracker" specifically,
as distinct from picking them (needs sportsbook lines, not automatable) or
grading them (already automated in v10).

- **Checkboxes on the scored-props table**, ranked by the same probability
  ordering used everywhere else in the app (Top Picks, team rank), so "select
  top 15" here means the same thing it means when picks are requested.
- **"Select top N"** (N configurable), **"select all"**, and **"clear"**
  helpers, plus a week field so week doesn't have to be set on every prop
  individually.
- **New `POST /api/tracker/bulk` endpoint**, capped at 100 items per request.
- **Duplicate protection keyed on week + player + prop type** (normalized:
  lowercased, trimmed), not on id, since bulk items are new client-side
  records with none yet. A duplicate is skipped, not overwritten, since an
  existing tracker entry may already carry a result or a corrected line that
  a re-log should not clobber. Verified this holds under re-clicking the
  button, and under whitespace/case variation in the player name; verified a
  same player logged for a different week is correctly treated as distinct.

### Bug fixed during this build

Renamed the per-row log payload's `line` field to `openingLine` for
consistency with the new bulk payload, but left the old single-Log button's
conversion code in place (`payload.openingLine = payload.line`), which would
have overwritten the now-correct value with `undefined`. Caught before
shipping by re-reading the handler after the rename rather than assuming it
still applied; the redundant conversion was removed.

### Verified

Nine scenarios: basic bulk log, duplicate rejection on re-click, distinct
weeks not treated as duplicates, case/whitespace-insensitive duplicate
matching, a missing-player item flagged rather than silently dropped, the
100-item cap enforced, auth enforced on the new endpoint, a malformed request
body rejected cleanly, and bulk-logged entries confirmed to flow correctly
into calibration once graded.

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
