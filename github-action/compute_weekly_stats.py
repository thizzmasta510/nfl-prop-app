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





def compute_defensive_epa(pbp: pd.DataFrame) -> pd.DataFrame:
    """Team-level EPA allowed per play on defense (offense's EPA becomes the
    opponent's defensive number, since pbp is keyed by the team on offense).

    This is the real-data counterpart to the oppDefEpaPerPlay model input,
    which currently has to be typed in by hand. Positive = the defense allows
    more expected points than average (a worse defense, favorable for the
    offensive player facing it next).
    """
    plays = pbp[pbp["play_type"].isin(["run", "pass"])].copy()
    if plays.empty or "epa" not in plays.columns or "defteam" not in plays.columns:
        return pd.DataFrame(columns=["team", "week", "def_epa_per_play"])
    grouped = (
        plays.groupby(["defteam", "week"])
        .agg(def_epa_per_play=("epa", "mean"), plays=("epa", "count"))
        .reset_index()
    )
    return grouped.rename(columns={"defteam": "team"})[["team", "week", "def_epa_per_play"]]


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
    """Thin wrapper over the shared loader, which tries nflreadpy first."""
    return load("pbp", season)


def main():
    requested = resolve_season()
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
    def_epa_df = compute_defensive_epa(pbp)

    # Collapse to each team/player's most recent available week.
    latest_pressure = pressure_df.sort_values("week").groupby("team").tail(1)
    latest_rz = rz_df.sort_values("week").groupby("player").tail(1)
    latest_def_epa = def_epa_df.sort_values("week").groupby("team").tail(1)

    players = []
    for _, row in latest_rz.iterrows():
        players.append({
            "player": row["player"],
            "team": row["team"],
            "week": int(row["week"]),
            "redZoneShare": float(row["red_zone_share"]),
        })

    # Merge pressure rate and defensive EPA into one row per team rather than
    # two separate lists, so a single lookup gives both matchup inputs.
    teams_by_key = {}
    for _, row in latest_pressure.iterrows():
        key = (row["team"], int(row["week"]))
        teams_by_key.setdefault(key, {"team": row["team"], "week": int(row["week"])})
        teams_by_key[key]["pressureRateAllowed"] = float(row["pressure_rate_allowed"])
    for _, row in latest_def_epa.iterrows():
        key = (row["team"], int(row["week"]))
        teams_by_key.setdefault(key, {"team": row["team"], "week": int(row["week"])})
        teams_by_key[key]["oppDefEpaPerPlay"] = round(float(row["def_epa_per_play"]), 4)
    teams = list(teams_by_key.values())

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
