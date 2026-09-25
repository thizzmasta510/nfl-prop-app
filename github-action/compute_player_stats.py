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

# ============================================================
# Inlined nflverse loader
#
# Kept inline rather than imported from a shared module so this script has no
# local file dependency: one fewer file to place correctly, and no chance of a
# ModuleNotFoundError from a missing sibling.
#
# nflreadpy is tried first. nfl_data_py builds its own download URLs which now
# 404 for the current season, and it pins numpy<2.0; both indicate it is
# unmaintained, so it is only a fallback.
# ============================================================
import sys
import urllib.error


def _to_pandas(df):
    """Normalize a polars or pandas frame to pandas.

    nflreadpy returns polars frames; the existing scripts are written against
    pandas. Rather than rewrite them, convert at the boundary.
    """
    if df is None:
        return None
    # Already pandas
    if hasattr(df, "iterrows") and hasattr(df, "columns"):
        return df
    # Polars exposes to_pandas()
    if hasattr(df, "to_pandas"):
        try:
            return df.to_pandas()
        except Exception as e:
            print(f"  to_pandas() failed: {type(e).__name__}: {e}")
            return None
    print(f"  unrecognized frame type: {type(df)}")
    return None


def _describe_api(mod, modname):
    """Print the callables a module exposes, so a failed guess is informative."""
    names = [n for n in dir(mod) if not n.startswith("_") and callable(getattr(mod, n, None))]
    print(f"  {modname} exposes: {sorted(names)}")


def _try_nflreadpy(kind, season):
    """kind is 'weekly' or 'pbp'."""
    try:
        import nflreadpy as nfl
    except ImportError:
        print("  nflreadpy not installed")
        return None

    # Candidate function names, most likely first. Probed rather than assumed.
    # Confirmed against the live package: nflreadpy exposes load_player_stats
    # and load_pbp. The alternates are retained only as version insurance.
    candidates = {
        "weekly": ["load_player_stats", "load_weekly_data", "load_player_stats_weekly"],
        "pbp": ["load_pbp", "load_pbp_data"],
    }[kind]

    fn = None
    fname = None
    for name in candidates:
        if hasattr(nfl, name):
            fn = getattr(nfl, name)
            fname = name
            break

    if fn is None:
        print(f"  nflreadpy has none of {candidates}")
        _describe_api(nfl, "nflreadpy")
        return None

    # Argument name also varies across versions; try the likely forms.
    for kwargs in ({"seasons": [season]}, {"seasons": season}, {"years": [season]}):
        try:
            print(f"  nflreadpy.{fname}({kwargs})")
            df = _to_pandas(fn(**kwargs))
            if df is not None and len(df):
                print(f"  OK via nflreadpy.{fname}: {len(df)} rows")
                return df
            if df is not None:
                print("  returned 0 rows")
        except TypeError as e:
            print(f"  signature mismatch: {e}")
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}")
            return None
        except Exception as e:
            print(f"  {type(e).__name__}: {e}")
    return None


def _try_nfl_data_py(kind, season):
    try:
        import nfl_data_py as nfl
    except ImportError:
        print("  nfl_data_py not installed")
        return None
    fn = nfl.import_weekly_data if kind == "weekly" else nfl.import_pbp_data
    try:
        df = fn([season], downcast=True)
        if df is not None and len(df):
            print(f"  OK via nfl_data_py: {len(df)} rows")
            return df
        print("  returned 0 rows")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} (nfl_data_py's URL path is likely stale)")
    except Exception as e:
        print(f"  {type(e).__name__}: {e}")
    return None


def load(kind, season, fallback_seasons=2):
    """Load 'weekly' or 'pbp' data for a season, trying nflreadpy then
    nfl_data_py, then walking back earlier seasons.

    Returns (DataFrame, season_used) or (None, None).
    """
    assert kind in ("weekly", "pbp")
    for yr in range(season, season - fallback_seasons - 1, -1):
        print(f"\n=== {kind} data, season {yr} ===")
        print(" trying nflreadpy:")
        df = _try_nflreadpy(kind, yr)
        if df is not None and len(df):
            return df, yr
        print(" trying nfl_data_py:")
        df = _try_nfl_data_py(kind, yr)
        if df is not None and len(df):
            return df, yr
    print(
        "\nNo season resolved through either package. Check the workflow log above\n"
        "for the API surface each package exposes.",
        file=sys.stderr,
    )
    return None, None


def resolve_season():
    """Current season, preferring nflreadpy's own helper over date arithmetic.

    nflreadpy exposes get_current_season(), which tracks the league calendar
    properly. Guessing from the month is a worse approximation, so it is only
    the fallback.
    """
    try:
        import nflreadpy as nfl
        if hasattr(nfl, "get_current_season"):
            return int(nfl.get_current_season())
    except Exception as e:
        print(f"  get_current_season() unavailable ({type(e).__name__}), falling back to date")
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    return now.year if now.month >= 3 else now.year - 1
# ============================================================
# End inlined loader
# ============================================================



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




# Column mapping from the nflverse weekly dataset to the stat names the app
# uses for auto-grading. Only stats that correspond to real prop markets are
# included here, since these are matched directly against prop types (see
# propTypeToStatKey in src/model.js) and an unrelated column with a similar
# name could produce a wrong match.
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

# Efficiency and usage metrics, kept in a SEPARATE dict from STAT_COLUMNS
# rather than merged in. These are not prop-gradeable stats, and mixing them
# into the same dict the grader searches would risk a prop type accidentally
# matching an efficiency column instead of the intended box-score stat. They
# exist to inform model inputs (usage trend, matchup normalization) that
# currently have to be typed in by hand.
EFFICIENCY_COLUMNS = {
    "target_share": "target_share",
    "air_yards_share": "air_yards_share",
    "receiving_epa": "receiving_epa",
    "rushing_epa": "rushing_epa",
    "passing_epa": "passing_epa",
    "racr": "racr",   # receiver air conversion ratio
    "wopr": "wopr",   # weighted opportunity rating
    "pacr": "pacr",   # passer air conversion ratio
}


def load_weekly(season: int):
    """Thin wrapper over the shared loader, which tries nflreadpy first."""
    return load("weekly", season)


def main():
    requested = resolve_season()
    print(f"Season to request: {requested}")
    wk, season = load_weekly(requested)

    if wk is None:
        # Write a valid empty payload rather than leaving no file at all, so the
        # Worker's shape check rejects it cleanly instead of erroring on a
        # missing fetch target.
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "season": requested,
            "players": [],
            "note": "no season data resolved; see workflow logs",
        }
        with open("player-stats.json", "w") as f:
            json.dump(payload, f)
        print("Wrote empty player-stats.json")
        sys.exit(1)

    print(f"\nUsing season {season}")
    print(f"Available columns: {sorted(wk.columns.tolist())}")

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

        efficiency = {}
        for out_name, col in EFFICIENCY_COLUMNS.items():
            if col in wk.columns:
                val = row.get(col)
                if pd.notna(val):
                    efficiency[out_name] = float(val)

        opp_col = "opponent_team" if "opponent_team" in wk.columns else None
        pos_col = "position" if "position" in wk.columns else None

        records.append({
            "name": display,
            "norm": normalize_name(display),
            "short": short_key(display),
            "team": str(row.get(team_col) or "").upper(),
            "week": int(row.get("week")),
            "stats": stats,
            "efficiency": efficiency,
            "position": str(row.get(pos_col)).upper() if pos_col and pd.notna(row.get(pos_col)) else None,
            "opponent": str(row.get(opp_col)).upper() if opp_col and pd.notna(row.get(opp_col)) else None,
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
