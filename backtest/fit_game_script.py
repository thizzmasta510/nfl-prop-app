"""Usage: python3 backtest/fit_game_script.py backtest/player-stats-history.json games.csv
(games.csv from github.com/nflverse/nfldata, data/games.csv)

Fit the game-script effect: how a player's output moves with his team's
point spread and implied team total, relative to the games already in his log.

Live-like setup: for each player-game, baseline = mean of his previous games
that season (>= 3), and the spread / implied total are measured relative to
the average over those same previous games (that is what the model's game log
already reflects). Model: actual = base * (1 + c + a*dSpread + b*dImplied).
Fit 2021-2024, test 2025.
"""
import json, sys
import numpy as np, pandas as pd

hist = json.load(open(sys.argv[1]))["players"]
g = pd.read_csv(sys.argv[2])
g = g[g.game_type == "REG"][["season", "week", "home_team", "away_team", "spread_line", "total_line"]].dropna()

lines = {}
for r in g.itertuples():
    lines[(r.season, r.week, r.home_team)] = (r.spread_line, r.total_line)
    lines[(r.season, r.week, r.away_team)] = (-r.spread_line, r.total_line)

rows = []
for p in hist:
    k = (p["season"], p["week"], p["team"])
    if k not in lines:
        continue
    s, t = lines[k]
    rows.append({"norm": p["norm"], "season": p["season"], "week": p["week"], "spread": s,
                 "implied": (t + s) / 2, "total": t, **p["stats"]})
df = pd.DataFrame(rows).sort_values(["norm", "season", "week"])
print("rows with lines:", len(df), file=sys.stderr)

STATS = {  # stat: (min baseline, gate column, min gate baseline)
    "passing_yards": (120, "attempts", 20),
    "rushing_yards": (15, "carries", 5),
    "carries": (5, "carries", 5),
    "receptions": (1.5, "targets", 2.5),
    "receiving_yards": (15, "targets", 2.5),
}

def build(stat):
    minb, gate, ming = STATS[stat]
    out = []
    for (norm, season), grp in df.groupby(["norm", "season"], sort=False):
        v = grp[stat].to_numpy(float); gv = grp[gate].to_numpy(float)
        s = grp["spread"].to_numpy(float); im = grp["implied"].to_numpy(float)
        for i in range(3, len(grp)):
            base = v[:i].mean(); gbase = gv[:i].mean()
            if base < minb or gbase < ming:
                continue
            out.append((season, v[i], base, s[i] - s[:i].mean(), im[i] - im[:i].mean(), s[i], im[i]))
    return np.array(out)

result = {}
for stat in STATS:
    A = build(stat)
    tr, te = A[A[:, 0] <= 2024], A[A[:, 0] == 2025]
    def fit(D):
        y = (D[:, 1] - D[:, 2]) / D[:, 2]
        X = np.column_stack([np.ones(len(D)), D[:, 3], D[:, 4]])
        w = D[:, 2]  # weight by baseline size
        W = np.sqrt(w)
        coef, *_ = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)
        # standard errors (weighted OLS)
        resid = (y - X @ coef) * W
        s2 = resid @ resid / (len(D) - 3)
        cov = s2 * np.linalg.inv((X * W[:, None]).T @ (X * W[:, None]))
        return coef, np.sqrt(np.diag(cov))
    coef, se = fit(tr)
    c, a, b = coef
    # Out-of-sample: squared error of baseline vs adjusted (game-script only, intercept excluded
    # so the comparison isolates the spread/total effect).
    base_err = ((te[:, 1] - te[:, 2]) ** 2).mean()
    adj = te[:, 2] * (1 + np.clip(a * te[:, 3] + (b if stat != "carries" else 0) * te[:, 4], -0.15, 0.15))
    adj_err = ((te[:, 1] - adj) ** 2).mean()
    # refit on everything for the shipped coefficients
    coef_all, se_all = fit(A[A[:, 0] <= 2025])
    result[stat] = {
        "n_train": int(len(tr)), "n_test": int(len(te)),
        "train": {"spread": round(a, 5), "spread_se": round(se[1], 5), "implied": round(b, 5), "implied_se": round(se[2], 5)},
        "all": {"spread": round(coef_all[1], 5), "spread_se": round(se_all[1], 5), "implied": round(coef_all[2], 5), "implied_se": round(se_all[2], 5)},
        "test_mse_base": round(base_err, 3), "test_mse_adj": round(adj_err, 3),
        "test_improve_pct": round(100 * (base_err - adj_err) / base_err, 3),
        "dSpread_sd": round(float(A[:, 3].std()), 2), "dImplied_sd": round(float(A[:, 4].std()), 2),
    }
print(json.dumps(result, indent=1))
