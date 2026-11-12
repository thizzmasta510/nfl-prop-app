# Backtest harness

Runs the model over historical player data to measure how good its projections
and its uncertainty actually are. It imports `../src/model.js` directly, so
results apply to the live model rather than to a reimplementation.

## Why

Every constant in the model was chosen by judgment, not fitted: the 0.85
recency decay, the variance shrinkage constant, the prior coefficients of
variation. Waiting on live picks means months before there is enough data to
say anything. Historical player data is free and already exists.

## Getting data

Extend the existing Action script to cover past seasons:

```python
# in github-action/compute_player_stats.py, change:
wk = nfl.import_weekly_data([season], downcast=True)
# to:
wk = nfl.import_weekly_data([2021, 2022, 2023, 2024, 2025], downcast=True)
```

Add `season` to each emitted record, save as `player-stats-history.json`.

## Running

```
node backtest/backtest.mjs --data player-stats-history.json --stat receiving_yards
node backtest/backtest.mjs --data player-stats-history.json --stat rushing_yards --minGames 4
```

Stat keys: `receiving_yards`, `rushing_yards`, `passing_yards`, `receptions`,
`carries`, `completions`, `attempts`, `targets`, `rushing_tds`,
`receiving_tds`, `passing_tds`, `rush_rec_yards`.

## What it measures

**Point accuracy.** Mean absolute error, RMSE, and bias, compared against a
naive benchmark that just averages the player's prior games. If the model
cannot beat that benchmark, its extra machinery is not earning its place.

**Distribution calibration**, via the probability integral transform. For each
prediction it computes `F(actual)` under the model's own predictive CDF. If the
uncertainty is honest those values are uniform on [0,1]. Clumping in the middle
means intervals are too wide (underconfident); clumping at the tails means too
narrow (overconfident). This needs no sportsbook lines, which is why it is the
right tool here.

It reports a decile histogram, a KS statistic against uniform, and coverage of
the central 50% and 80% intervals, then states plainly which way the model is
miscalibrated.

## No lookahead

For a target week W, only games strictly before W build the inputs. Leaking the
target game into its own projection produces excellent numbers that mean
nothing, which is the most common way a backtest lies.

## What it cannot measure

There are no free historical sportsbook lines, so this cannot compute CLV or
ROI, and it cannot tell you whether the model beats a market price. It measures
whether the projections and their stated uncertainty are any good, which is
upstream of both.

Matchup, weather, and role adjustments are also held neutral during backtesting.
Reconstructing them faithfully for past games is not feasible, and feeding in
guessed values would measure the guesses rather than the model core.

## Validation of the harness itself

Tested against synthetic data with known variance structure:

| True volatility | Model assumes | Detected |
|---|---|---|
| CV 0.50 | CV 0.50 | Well calibrated: 47.8% central-50 coverage, target 50% |
| CV 0.80 | CV 0.50 | Overconfident: 40.0% coverage, tails clumped at 17% each |
| CV 0.25 | CV 0.50 | Underconfident: 63.9% coverage, middle deciles clumped |

It correctly identifies both failure modes.

**One finding worth knowing before you read real results:** on that synthetic
data the exponentially weighted mean did *not* beat a simple average of prior
games. That is the correct result there, because the generator holds each
player's true level constant, so recency weighting adds variance without adding
signal. Recency weighting only earns its place if player form and role actually
drift within a season. Whether they drift enough to justify it is exactly the
question real data will answer, and it is a real possibility that the honest
answer is no.

## NBA opportunity projection (`nba_opportunity_backtest.mjs`)

Tests `src/nba_opportunity.js` (points and 3-pointers built from shot volume and
regressed efficiency) against the current NBA model, walk-forward with no
lookahead, on public hoopR box scores:

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/sportsdataverse/hoopR-nba-data
cd hoopR-nba-data && git sparse-checkout set nba/player_box/parquet && cd ..
node backtest/hoopr_box.mjs hoopR-nba-data/nba/player_box/parquet/player_box_2025.parquet hoopR-nba-data/nba/player_box/parquet/player_box_2026.parquet hoopR-nba-data/nba/player_box/parquet/player_box_2027.parquet --out backtest/nba_box.json
node backtest/nba_opportunity_backtest.mjs backtest/nba_box.json --history 20
```

`--history 20` matches what the app keeps per player; leave it off to use up to 82
games. `--kalshi rows.txt --kalshi-date YYYY-MM-DD` also scores a saved night of
Kalshi rungs against the market's own mid. `nba-history.json` from the data job
works too once it carries shot data (runs after this update).

## NFL opportunity projection (`nfl_opportunity_backtest.mjs`)

Grades `src/nfl_opportunity.js` against the current NFL model and the books' closing
lines (same join as `market_vs_model.mjs`):

```
node backtest/nfl_opportunity_backtest.mjs --props ..\sgo_backfill.json --history backtest/player-stats-history.json --logs trend-logs.json --season 2026
```

**Warning about the 2025 backfill:** about a third of 2025 receiving-yard "closing" lines
sit within 3 yards of the final result (pregame lines: about 1 in 10, which is what the
2026 rows show), and some carry odds like +900 / -1700. Those are in-game lines, so the
2025 "market" looks far better than it was. The script prints this check; grade 2026
only (`--season 2026`) until the 2025 closes are re-pulled as pregame lines. Earlier
results built on the 2025 closes (model vs market, band ROI) need the same re-check.

## NBA hit chance (`nba_hit_chance_backtest.mjs`)

Fits and tests `src/hit_chance.js` and the points-spread multiplier, walk-forward by season,
through the app's own projection, matchup and feature code.

```
node backtest/hoopr_box.mjs <parquet 2024> <parquet 2025> <parquet 2026> <parquet 2027> --out backtest/nba_box.json
node backtest/nba_hit_chance_backtest.mjs backtest/nba_box.json --spread          # report
node backtest/nba_hit_chance_backtest.mjs backtest/nba_box.json --check           # fails if HIT_COEF is stale
```

The first season in the file is history only. Prints log loss before and after per stat and test
season for the 20-game and 40-game tables, calibration of the result by side, the coefficients fit
on all graded seasons (paste into `HIT_COEF`, then update `test/hit_chance.test.mjs`), and with
`--spread` the log loss by spread multiplier (the `SPREAD_ADJ` check). It cannot say anything about
prices: there are no market lines in it.

## NFL hit chance (`nfl_hit_chance_backtest.mjs`)

```
node backtest/nfl_hit_chance_backtest.mjs --history backtest/player-stats-history.json --logs trend-logs.json
```

Walk-forward by season through the app's own Proj and `nflHitFeatures()`. Prints log loss before
and after for all players and for players with a regular role, calibration, and the coefficients
for all five markets; the app pins only the markets where regular players improved
(`NFL_HIT_COEF`: receptions, passing yards, rush attempts, rushing yards; see the notes in `src/hit_chance.js`). `--check` fails if those are stale.
