"""
Publishes a compact per-player, per-week stat lookup from the free public
nflverse weekly dataset, for automatic grading of logged prop picks.

Runs in GitHub Actions (free tier), NOT inside the Cloudflare Worker. Parsing
season-long player data needs more CPU than the Worker's free tier allows, and
keeping it here means GitHub never needs your app password: it writes a public
JSON file, and the Worker pulls that file on its own schedule.

Output: player-stats.json

Requires: pip install nfl_data_py pandas
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone

import pandas as pd

try:
    import nfl_data_py as nfl
except ImportError:
    print("Run: pip install nfl_data_py pandas", file=sys.stderr)
    raise


# Suffixes are stripped during normalization because sources disagree on them
# ("Marvin Harrison Jr" vs "Marvin Harrison Jr."), and they are never needed to
# disambiguate within a single team-week.
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalize_name(name: str) -> str:
    """Lowercase, strip accents and punctuation, drop generational suffixes.

    Handles the cases that actually break these pipelines in practice:
    "D.J. Moore" vs "DJ Moore", "Ja'Marr" vs "JaMarr", "Amon-Ra" vs "Amon Ra".
    """
    if not isinstance(name, str):
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[.'\u2019`]", "", s)   # periods and apostrophes vanish
    s = re.sub(r"[-_]", " ", s)          # hyphens become spaces
    s = re.sub(r"[^a-z0-9 ]", "", s)
    parts = [p for p in s.split() if p and p not in SUFFIXES]
    return " ".join(parts)


def short_key(name: str) -> str:
    """First initial plus last name, e.g. 'j chase'. Fallback match key."""
    n = normalize_name(name)
    parts = n.split()
    if len(parts) < 2:
        return n
    return f"{parts[0][0]} {parts[-1]}"


def current_season() -> int:
    now = datetime.now(timezone.utc)
    return now.year if now.month >= 3 else now.year - 1


# Column mapping from the nflverse weekly dataset to the stat names the app
# uses. Only stats that correspond to real prop markets are included.
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


def main():
    season = current_season()
    print(f"Fetching weekly player data for {season}...")
    wk = nfl.import_weekly_data([season], downcast=True)

    if wk.empty:
        print("No weekly data available yet for this season.", file=sys.stderr)
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "season": season,
            "players": [],
        }
        with open("player-stats.json", "w") as f:
            json.dump(payload, f)
        return

    # Prefer the display name; fall back to the abbreviated name column.
    name_col = "player_display_name" if "player_display_name" in wk.columns else "player_name"
    team_col = "recent_team" if "recent_team" in wk.columns else "team"

    records = []
    for _, row in wk.iterrows():
        display = row.get(name_col)
        if not isinstance(display, str) or not display.strip():
            continue

        stats = {}
        for out_name, col in STAT_COLUMNS.items():
            if col in wk.columns:
                val = row.get(col)
                if pd.notna(val):
                    stats[out_name] = float(val)

        # Derived combo stat: several books post a combined rush+rec yardage
        # market, so it is precomputed here rather than reassembled client-side.
        if "rushing_yards" in stats or "receiving_yards" in stats:
            stats["rush_rec_yards"] = (
                stats.get("rushing_yards", 0.0) + stats.get("receiving_yards", 0.0)
            )

        if not stats:
            continue

        records.append({
            "name": display,
            "norm": normalize_name(display),
            "short": short_key(display),
            "team": str(row.get(team_col) or "").upper(),
            "week": int(row.get("week")),
            "stats": stats,
        })

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "season": season,
        "weeksIncluded": sorted({r["week"] for r in records}),
        "players": records,
    }

    with open("player-stats.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    print(f"Wrote player-stats.json: {len(records)} player-weeks, "
          f"weeks {payload['weeksIncluded']}")


if __name__ == "__main__":
    main()
