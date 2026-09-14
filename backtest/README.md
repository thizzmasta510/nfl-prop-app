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
