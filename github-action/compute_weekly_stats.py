"""
Computes weekly pressure-rate-allowed (by team/O-line) and red-zone usage
share (by player) from the free, public nflverse play-by-play dataset, and
writes a small summarized JSON file. Meant to run on a schedule via GitHub
Actions (free tier), NOT inside the Cloudflare Worker, to stay within the
Worker's free CPU-time limit.

Requires: pip install nfl_data_py pandas
"""
import json
import sys
from datetime import datetime, timezone

import pandas as pd

try:
    import nfl_data_py as nfl
except ImportError:
    print("Run: pip install nfl_data_py pandas", file=sys.stderr)
    raise


def current_season():
    now = datetime.now(timezone.utc)
    # NFL season year rolls over around March; a September game belongs to
    # the season that started that same calendar year.
    return now.year if now.month >= 3 else now.year - 1


def compute_pressure_rate(pbp: pd.DataFrame) -> pd.DataFrame:
    """Team-level pressure rate allowed on dropbacks (sacks + hits + hurries)."""
    dropbacks = pbp[pbp["qb_dropback"] == 1].copy()
    if dropbacks.empty:
        return pd.DataFrame(columns=["team", "week", "pressure_rate_allowed"])
    pressured_cols = [c for c in ["qb_hit", "sack"] if c in dropbacks.columns]
    dropbacks["pressured"] = dropbacks[pressured_cols].fillna(0).max(axis=1) if pressured_cols else 0
    grouped = (
        dropbacks.groupby(["posteam", "week"])
        .agg(dropbacks=("qb_dropback", "sum"), pressured=("pressured", "sum"))
        .reset_index()
    )
    grouped["pressure_rate_allowed"] = (grouped["pressured"] / grouped["dropbacks"]).round(3)
    return grouped.rename(columns={"posteam": "team"})[["team", "week", "pressure_rate_allowed"]]


def compute_red_zone_share(pbp: pd.DataFrame) -> pd.DataFrame:
    """Player-level share of team red-zone touches (rush attempts + targets)."""
    rz = pbp[(pbp["yardline_100"] <= 20) & (pbp["play_type"].isin(["run", "pass"]))].copy()
    if rz.empty:
        return pd.DataFrame(columns=["player", "team", "week", "red_zone_share"])

    rz["toucher"] = rz["rusher_player_name"].fillna(rz["receiver_player_name"])
    rz = rz.dropna(subset=["toucher"])

    team_totals = rz.groupby(["posteam", "week"]).size().rename("team_rz_plays")
    player_totals = (
        rz.groupby(["toucher", "posteam", "week"]).size().rename("player_rz_touches").reset_index()
    )
    merged = player_totals.merge(team_totals, on=["posteam", "week"])
    merged["red_zone_share"] = (merged["player_rz_touches"] / merged["team_rz_plays"]).round(3)
    return merged.rename(columns={"toucher": "player", "posteam": "team"})[
        ["player", "team", "week", "red_zone_share"]
    ]


def load_pbp(season: int):
    """Load play-by-play, falling back through earlier seasons on a 404.

    Same rationale as compute_player_stats.py: the current season's file may
    not be published yet, or nfl_data_py's URL path may be stale. Reporting
    which seasons resolve is more useful than crashing.
    """
    import urllib.error
    for yr in [season, season - 1, season - 2]:
        try:
            print(f"Trying pbp data for {yr}...")
            pbp = nfl.import_pbp_data([yr], downcast=True)
            if pbp.empty:
                print(f"  {yr}: 0 rows")
                continue
            print(f"  {yr}: OK, {len(pbp)} rows")
            return pbp, yr
        except urllib.error.HTTPError as e:
            print(f"  {yr}: HTTP {e.code} (not published, or stale URL path)")
        except Exception as e:
            print(f"  {yr}: {type(e).__name__}: {e}")
    return None, None


def main():
    requested = current_season()
    pbp, season = load_pbp(requested)
    if pbp is None:
        payload = {"generatedAt": datetime.now(timezone.utc).isoformat(),
                   "season": requested, "players": [], "teams": [],
                   "note": "no season data resolved; see workflow logs"}
        with open("weekly-stats.json", "w") as f:
            json.dump(payload, f)
        print("Wrote empty weekly-stats.json", file=sys.stderr)
        sys.exit(1)
    print(f"Using season {season}")

    pressure_df = compute_pressure_rate(pbp)
    rz_df = compute_red_zone_share(pbp)

    # Collapse to each team/player's most recent available week.
    latest_pressure = pressure_df.sort_values("week").groupby("team").tail(1)
    latest_rz = rz_df.sort_values("week").groupby("player").tail(1)

    players = []
    for _, row in latest_rz.iterrows():
        players.append({
            "player": row["player"],
            "team": row["team"],
            "week": int(row["week"]),
            "redZoneShare": float(row["red_zone_share"]),
        })

    teams = []
    for _, row in latest_pressure.iterrows():
        teams.append({
            "team": row["team"],
            "week": int(row["week"]),
            "pressureRateAllowed": float(row["pressure_rate_allowed"]),
        })

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "season": season,
        "players": players,   # red zone share, keyed by player
        "teams": teams,       # pressure rate allowed, keyed by team (applies to that team's QB)
    }

    with open("weekly-stats.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote weekly-stats.json: {len(players)} players, {len(teams)} teams.")


if __name__ == "__main__":
    main()
