"""
Pulls multiple seasons of real weekly player stats for the backtest harness.

WHY THIS EXISTS
Every constant in the scoring model (the 0.85 recency decay, the variance
shrinkage constant, the stat-specific CV priors) was chosen by judgment, never
fitted. The backtest harness (backtest/backtest.mjs) can check those
constants against real outcomes, but it has so far only been tested against
synthetic data because no real historical file existed yet. This script is
the missing piece: a genuine multi-season pull, in the exact format
backtest.mjs expects.

This is a ONE-TIME or occasional pull, not a weekly job, so it runs only on
manual dispatch (see the separate workflow), not on the Tuesday/Friday
schedule the live-season scripts use.

SAME DISCOVERY-FIRST DISCIPLINE AS THE REST OF THIS PIPELINE
The nflreadpy season range for load_player_stats() was confirmed live in an
earlier run (current season worked fine), but exactly how far back it goes has
NOT been confirmed. Guessing a start year and having the whole run fail on the
first unavailable season would waste the run. Instead this tries each season
independently, keeps whatever succeeds, and reports plainly which seasons
were actually pulled, so a partial result is still useful and clearly labeled
rather than treated as a failure.

Reuses the exact normalize_name/short_key/STAT_COLUMNS logic from
compute_player_stats.py so historical and live records key identically, this
was copied rather than imported to keep each GitHub Action step
self-contained and independently runnable.
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone

import pandas as pd

try:
    import nflreadpy as nfl
except ImportError:
    print("nflreadpy not installed", file=sys.stderr)
    sys.exit(1)


SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalize_name(name: str) -> str:
    if not isinstance(name, str):
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[.'\u2019`]", "", s)
    s = re.sub(r"[-_]", " ", s)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    parts = [p for p in s.split() if p and p not in SUFFIXES]
    return " ".join(parts)


def short_key(name: str) -> str:
    n = normalize_name(name)
    parts = n.split()
    if len(parts) < 2:
        return n
    return f"{parts[0][0]} {parts[-1]}"


STAT_COLUMNS = {
    "passing_yards": "passing_yards",
    "passing_tds": "passing_tds",
    "completions": "completions",
    "attempts": "attempts",
    "interceptions": "interceptions",
    "carries": "carries",
    "rushing_yards": "rushing_yards",
    "rushing_tds": "rushing_tds",
    "receptions": "receptions",
    "targets": "targets",
    "receiving_yards": "receiving_yards",
    "receiving_tds": "receiving_tds",
}


def _to_pandas(df):
    if df is None:
        return None
    if hasattr(df, "iterrows"):
        return df
    if hasattr(df, "to_pandas"):
        try:
            return df.to_pandas()
        except Exception as e:
            print(f"  to_pandas() failed: {type(e).__name__}: {e}")
            return None
    return None


def current_season() -> int:
    now = datetime.now(timezone.utc)
    return now.year if now.month >= 3 else now.year - 1


def try_season(season: int):
    """One season, tried independently so one bad year can't sink the run."""
    for kwargs in ({"seasons": [season]}, {"seasons": season}):
        try:
            print(f"  season {season}: nflreadpy.load_player_stats({kwargs})")
            df = _to_pandas(nfl.load_player_stats(**kwargs))
            if df is not None and len(df):
                print(f"  season {season}: OK, {len(df)} rows")
                return df
            print(f"  season {season}: 0 rows")
            return None
        except TypeError as e:
            print(f"  season {season}: signature mismatch, {e}")
        except ValueError as e:
            if "season" in str(e).lower():
                print(f"  season {season}: NOT AVAILABLE ({e})")
                return None
            print(f"  season {season}: {type(e).__name__}: {e}")
        except Exception as e:
            print(f"  season {season}: {type(e).__name__}: {e}")
    return None


def main():
    latest = current_season()
    # Tries the last 6 seasons. Not a claim that nflreadpy actually has all of
    # these, each is attempted independently and the log states plainly which
    # ones actually resolved.
    candidate_seasons = list(range(latest, latest - 6, -1))
    print(f"Attempting seasons: {candidate_seasons}\n")

    frames = []
    resolved_seasons = []
    for season in candidate_seasons:
        df = try_season(season)
        if df is not None:
            df = df.copy()
            if "season" not in df.columns:
                df["season"] = season
            frames.append(df)
            resolved_seasons.append(season)

    if not frames:
        print("\nNo seasons resolved at all. Writing an empty, clearly-labeled file.",
              file=sys.stderr)
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "seasonsAttempted": candidate_seasons,
            "seasonsResolved": [],
            "players": [],
            "note": "no seasons resolved; see workflow log for per-season reasons",
        }
        with open("player-stats-history.json", "w") as f:
            json.dump(payload, f)
        sys.exit(1)

    print(f"\nResolved seasons: {resolved_seasons}")
    combined = pd.concat(frames, ignore_index=True)
    print(f"Combined rows: {len(combined)}")
    print(f"Columns: {sorted(combined.columns.tolist())}")

    name_col = "player_display_name" if "player_display_name" in combined.columns else "player_name"
    team_col = "recent_team" if "recent_team" in combined.columns else "team"

    if name_col not in combined.columns or team_col not in combined.columns:
        print(f"Missing expected column(s): name_col={name_col in combined.columns}, "
              f"team_col={team_col in combined.columns}. Available columns printed above.",
              file=sys.stderr)
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "seasonsAttempted": candidate_seasons,
            "seasonsResolved": resolved_seasons,
            "players": [],
            "note": f"expected columns not found; name_col candidate={name_col}, team_col candidate={team_col}",
        }
        with open("player-stats-history.json", "w") as f:
            json.dump(payload, f)
        sys.exit(1)

    records = []
    skipped_no_name = 0
    for _, row in combined.iterrows():
        display = row.get(name_col)
        if not isinstance(display, str) or not display.strip():
            skipped_no_name += 1
            continue

        stats = {}
        for out_name, col in STAT_COLUMNS.items():
            if col in combined.columns:
                val = row.get(col)
                if pd.notna(val):
                    stats[out_name] = float(val)

        if "rushing_yards" in stats or "receiving_yards" in stats:
            stats["rush_rec_yards"] = (
                stats.get("rushing_yards", 0.0) + stats.get("receiving_yards", 0.0)
            )

        if not stats:
            continue

        week_val = row.get("week")
        season_val = row.get("season")
        if pd.isna(week_val) or pd.isna(season_val):
            continue

        records.append({
            "name": display,
            "norm": normalize_name(display),
            "short": short_key(display),
            "team": str(row.get(team_col) or "").upper(),
            "week": int(week_val),
            "season": int(season_val),
            "stats": stats,
        })

    print(f"Records built: {len(records)} (skipped {skipped_no_name} rows with no player name)")

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "seasonsAttempted": candidate_seasons,
        "seasonsResolved": resolved_seasons,
        "players": records,
    }
    with open("player-stats-history.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"\nWrote player-stats-history.json: {len(records)} player-weeks "
          f"across seasons {resolved_seasons}.")


if __name__ == "__main__":
    main()
