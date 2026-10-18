"""
Publishes trend-logs.json: each player's last 10 regular-season games across the
current and previous season, for the Tendency Matrix ("hit rate by cutoff, last N").

Same row shape as player-stats.json plus a `season` field, so src/trends.js can
read either file. Kept small on purpose (last 10 games per player), because the
Worker parses it on request and the full history file is far too big for that.

Runs in GitHub Actions next to compute_player_stats.py and reuses its loader.
Output: trend-logs.json
"""
import json
import sys
from datetime import datetime, timezone

import pandas as pd

from compute_player_stats import (
    load, resolve_season, normalize_name, short_key, STAT_COLUMNS,
)

KEEP_GAMES = 10
REG_MAX_WEEK = 18


def regular_season(df):
    if "season_type" in df.columns:
        df = df[df["season_type"].astype(str).str.upper().isin(["REG", "REGULAR"])]
    return df[df["week"] <= REG_MAX_WEEK]


def main():
    season = resolve_season()
    frames = []
    for yr in (season, season - 1):
        df, used = load("weekly", yr, fallback_seasons=0)
        if df is None or not len(df):
            print(f"season {yr}: not available")
            continue
        if "season" not in df.columns:
            df["season"] = used
        frames.append(regular_season(df))
    if not frames:
        with open("trend-logs.json", "w") as f:
            json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(), "players": [],
                       "note": "no season data resolved"}, f)
        sys.exit(1)

    wk = pd.concat(frames, ignore_index=True)
    name_col = "player_display_name" if "player_display_name" in wk.columns else "player_name"
    team_col = "recent_team" if "recent_team" in wk.columns else "team"
    wk = wk[wk[name_col].notna()]
    wk["_order"] = wk["season"].astype(int) * 100 + wk["week"].astype(int)
    wk = wk.sort_values("_order", ascending=False)

    records = []
    # Stable per-row player key (review C25/F4). player_id when present; otherwise
    # name + position, with missing values spelled out. pandas groupby drops NaN keys
    # by default, and NaN + str is NaN, so every part is filled before joining.
    name_part = wk[name_col].fillna("UNKNOWN").astype(str)
    pos_part = wk["position"].fillna("UNK").astype(str) if "position" in wk.columns else "UNK"
    fallback_key = "name:" + name_part + "|" + pos_part
    if "player_id" in wk.columns:
        # Blank strings count as missing too (review round 4 #4), so two players with
        # player_id "" can't collapse into one "id:" group.
        pid = wk["player_id"].astype("object").where(wk["player_id"].astype(str).str.strip().ne("") & wk["player_id"].notna())
        wk["_pid"] = ("id:" + pid.fillna("").astype(str)).where(pid.notna(), fallback_key)
        n_missing = int(pid.isna().sum())
    else:
        wk["_pid"] = fallback_key
        n_missing = len(wk)
    if n_missing:
        print(f"WARNING: {n_missing} rows without player_id; grouped by name + position", file=sys.stderr)
    id_col = "_pid"
    for _, grp in wk.groupby(id_col, sort=False, dropna=False):
        for _, row in grp.head(KEEP_GAMES).iterrows():
            stats = {k: float(row[c]) for k, c in STAT_COLUMNS.items() if c in wk.columns and pd.notna(row.get(c))}
            if "rushing_yards" in stats or "receiving_yards" in stats:
                stats["rush_rec_yards"] = stats.get("rushing_yards", 0.0) + stats.get("receiving_yards", 0.0)
            if not stats:
                continue
            display = row[name_col]
            records.append({
                "name": display, "norm": normalize_name(display), "short": short_key(display),
                "team": str(row.get(team_col) or "").upper(),
                "season": int(row["season"]), "week": int(row["week"]),
                "position": str(row.get("position")).upper() if pd.notna(row.get("position")) else None,
                "opponent": str(row.get("opponent_team")).upper() if pd.notna(row.get("opponent_team")) else None,
                "stats": stats,
            })

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "season": season,
        "gamesPerPlayer": KEEP_GAMES,
        "players": records,
    }
    with open("trend-logs.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote trend-logs.json: {len(records)} player-games")


if __name__ == "__main__":
    main()
