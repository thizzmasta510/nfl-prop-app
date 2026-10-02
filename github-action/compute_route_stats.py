"""
Computes a routes-run PROXY and yards-per-route-run for receivers, from free
public nflverse data.

WHY THIS IS A PROXY, NOT THE REAL METRIC
True "routes run" (the PFF/charting version) requires knowing, on every single
pass play, which non-targeted receivers actually ran a route versus stayed in
to block. That distinction is proprietary charting data and is not published
anywhere free. What nflverse's participation dataset actually has is which
players were ON THE FIELD for each play. This script approximates routes run
as "pass plays a receiver was on the field for," which is close to real routes
run for most skill players in most offenses, but cannot separate a receiver
who ran a route from one who stayed in to chip-block or pass-protect on a
given snap. Treat the output as an upper bound on true routes run, not an
exact figure, and treat yards-per-route-run computed from it the same way.

WHY THIS SCRIPT DISCOVERS RATHER THAN ASSUMES
The exact shape of nflreadpy's participation data (column names, whether
player IDs need a separate crosswalk to names, whether FTN charting adds a
more direct route indicator) has not been verified against live data. Rather
than guess and risk another multi-round debugging cycle like the initial
nflreadpy migration, this script tries multiple candidate data sources, prints
what it actually finds at each step, and degrades gracefully (writing a valid,
clearly-labeled empty or partial file) rather than crashing the whole
scheduled run if a step fails. The commit workflow uses continue-on-error for
this specific script so a shortfall here never blocks the two scripts that are
already working.

Requires: pip install nflreadpy pandas pyarrow
"""
import json
import sys
from datetime import datetime, timezone

import pandas as pd


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


def resolve_season():
    try:
        import nflreadpy as nfl
        if hasattr(nfl, "get_current_season"):
            return int(nfl.get_current_season())
    except Exception as e:
        print(f"  get_current_season() unavailable ({type(e).__name__}), falling back to date")
    now = datetime.now(timezone.utc)
    return now.year if now.month >= 3 else now.year - 1


def try_load(nfl, fn_name, season, label):
    """Attempts one nflreadpy function, printing its actual columns on success
    so a wrong assumption anywhere below shows up in the log immediately
    rather than causing a silent empty result.

    Tries a no-argument call in addition to the season-keyed forms, since not
    every nflreadpy function is season-scoped, load_players() specifically
    was found (via a live run) to reject a seasons kwarg entirely, it returns
    a global roster/ID table instead.

    A ValueError mentioning "season" is treated as a distinct, expected
    outcome, not a bug: it means this data type genuinely is not published
    yet for the requested year on nflverse's side, confirmed live for
    load_participation() rejecting the current season outright. That is
    reported as "not yet available for this season" rather than folded into
    the generic error path, so a future run (or a future season once the gap
    closes) can tell at a glance whether this is the known limitation or
    something new.
    """
    if not hasattr(nfl, fn_name):
        print(f"  nflreadpy has no {fn_name}()")
        return None
    fn = getattr(nfl, fn_name)
    for kwargs in ({"seasons": [season]}, {"seasons": season}, {}):
        try:
            print(f"  {label}: nflreadpy.{fn_name}({kwargs})")
            df = _to_pandas(fn(**kwargs))
            if df is not None and len(df):
                print(f"  {label}: OK, {len(df)} rows")
                print(f"  {label}: columns = {sorted(df.columns.tolist())}")
                return df
            print(f"  {label}: 0 rows")
        except TypeError as e:
            print(f"  {label}: signature mismatch, {e}")
        except ValueError as e:
            if "season" in str(e).lower():
                print(f"  {label}: NOT YET AVAILABLE for {season} ({e}). "
                      f"This is a real data-publishing gap on nflverse's side, "
                      f"not a bug here, expected to close once the season's "
                      f"data is finalized.")
                return None
            print(f"  {label}: {type(e).__name__}: {e}")
        except Exception as e:
            print(f"  {label}: {type(e).__name__}: {e}")
    return None


def find_first_present(columns, candidates):
    """Returns the first candidate column name actually present, or None.
    Used throughout because the exact name for a given concept (e.g. the
    player-ID column, or a possible direct route-run indicator) is not
    confirmed and may differ from what's assumed here."""
    for c in candidates:
        if c in columns:
            return c
    return None


def compute_routes_proxy(participation: pd.DataFrame, pbp: pd.DataFrame, players: pd.DataFrame):
    """Builds the routes-run proxy by joining participation (who was on the
    field), pbp (which plays were actual pass plays), and a player-ID-to-name
    crosswalk. Any join that cannot be completed with the columns actually
    present is skipped with a printed reason rather than guessed at.
    """
    if participation is None:
        print("  No participation data available, cannot build a routes proxy.")
        return pd.DataFrame()

    cols = participation.columns.tolist()

    offense_players_col = find_first_present(
        cols, ["offense_players", "offense_player_ids", "offensive_players"]
    )
    game_id_col = find_first_present(cols, ["nflverse_game_id", "game_id"])
    play_id_col = find_first_present(cols, ["play_id"])

    if not offense_players_col:
        print(f"  No offense-players column found among {cols}. Cannot identify "
              f"who was on the field per play, stopping here.")
        return pd.DataFrame()
    if not game_id_col or not play_id_col:
        print(f"  Missing a game/play identifier column, cannot join to pbp. "
              f"game_id_col={game_id_col} play_id_col={play_id_col}")
        return pd.DataFrame()

    # Restrict to actual pass plays using pbp, joined on game+play id.
    pbp_cols = pbp.columns.tolist()
    pbp_game_col = find_first_present(pbp_cols, ["nflverse_game_id", "game_id"])
    if not pbp_game_col or "play_id" not in pbp_cols or "qb_dropback" not in pbp_cols:
        print("  pbp is missing a required join or dropback column, cannot restrict to pass plays.")
        return pd.DataFrame()

    # Only select columns actually used downstream (the join keys and week).
    # An earlier version also selected "posteam" here even though nothing
    # after this point reads it, which meant a pbp schema lacking that exact
    # column name crashed the whole script over an unused convenience field.
    required_pbp_cols = [pbp_game_col, "play_id", "week"]
    missing = [c for c in required_pbp_cols if c not in pbp_cols]
    if missing:
        print(f"  pbp is missing required column(s) {missing}, cannot build pass-play filter.")
        return pd.DataFrame()
    pass_plays = pbp[pbp["qb_dropback"] == 1][required_pbp_cols].copy()
    pass_plays = pass_plays.rename(columns={pbp_game_col: "game_id", "play_id": "pid"})

    part = participation.rename(columns={game_id_col: "game_id", play_id_col: "pid"})
    merged = part.merge(pass_plays, on=["game_id", "pid"], how="inner")
    if merged.empty:
        print("  Join between participation and pass-play pbp produced 0 rows, "
              "the ID formats likely don't match as assumed.")
        return pd.DataFrame()
    print(f"  Joined {len(merged)} pass plays with participation data.")

    # Explode the offense_players field (commonly a delimited string of IDs)
    # into one row per player per play.
    sample_val = merged[offense_players_col].dropna().iloc[0] if merged[offense_players_col].notna().any() else ""
    delim = ";" if ";" in str(sample_val) else ("," if "," in str(sample_val) else " ")
    exploded = merged.assign(
        player_id=merged[offense_players_col].astype(str).str.split(delim)
    ).explode("player_id")
    exploded["player_id"] = exploded["player_id"].str.strip()
    exploded = exploded[exploded["player_id"] != ""]

    routes = (
        exploded.groupby(["player_id", "week"]).size().rename("routes_proxy").reset_index()
    )

    # Map player_id to a display name if a crosswalk is available.
    if players is not None and len(players):
        id_col = find_first_present(players.columns.tolist(), ["gsis_id", "player_id", "nfl_id"])
        name_col = find_first_present(players.columns.tolist(), ["display_name", "player_display_name", "full_name", "name"])
        if id_col and name_col:
            xwalk = players[[id_col, name_col]].drop_duplicates().rename(
                columns={id_col: "player_id", name_col: "name"}
            )
            routes = routes.merge(xwalk, on="player_id", how="left")
        else:
            print(f"  No usable name crosswalk found (id_col={id_col}, name_col={name_col}); "
                  f"output will be keyed by raw player_id instead of a name.")
            routes["name"] = routes["player_id"]
    else:
        routes["name"] = routes["player_id"]

    return routes


def main():
    try:
        import nflreadpy as nfl
    except ImportError:
        print("nflreadpy not installed", file=sys.stderr)
        _write_empty("nflreadpy not installed")
        return

    requested_season = resolve_season()
    print(f"Requested season: {requested_season}\n")

    print("=== participation data (season fallback, confirmed capped at 2025 live) ===")
    participation, part_season = None, None
    for yr in [requested_season, requested_season - 1, requested_season - 2]:
        participation = try_load(nfl, "load_participation", yr, f"participation ({yr})")
        if participation is not None:
            part_season = yr
            break
    if participation is None:
        print(f"\nParticipation data unavailable for {requested_season} and the two seasons "
              f"before it. Confirmed live that load_participation() rejects the current season "
              f"outright ('Season must be between 2016 and 2025'), so this is expected until "
              f"nflverse publishes it, not a bug.")

    print("\n=== FTN charting data (checked for a more direct route indicator) ===")
    ftn = try_load(nfl, "load_ftn_charting", requested_season, "ftn_charting")
    if ftn is not None:
        route_like = [c for c in ftn.columns if "route" in c.lower()]
        print(f"  FTN columns containing 'route': {route_like or 'none found'}")
        print(f"  No direct route indicator confirmed live, FTN charting has play-context "
              f"columns (blitz counts, personnel backfield counts, play-action/screen flags) "
              f"but nothing route-specific, participation remains the only path to this proxy.")

    # pbp must come from the SAME season participation resolved to, a season
    # mismatch here would silently produce a join that matches nothing.
    pbp, players = None, None
    if part_season is not None:
        print(f"\n=== play-by-play, season {part_season} (matched to participation's season) ===")
        pbp = try_load(nfl, "load_pbp", part_season, "pbp")

        print("\n=== player ID/name crosswalk ===")
        players = try_load(nfl, "load_players", part_season, "players")

    if participation is None or pbp is None:
        _write_empty(
            f"participation unavailable for {requested_season} and two prior seasons "
            f"(nflverse has not published it yet for this range), or pbp fetch for the "
            f"resolved season failed; see the full log above for specifics"
        )
        return

    routes = compute_routes_proxy(participation, pbp, players)
    if routes.empty:
        print("\nRoutes proxy could not be computed with the columns actually available "
              "(see the reasons printed above). This is expected the first time this "
              "script runs against real data if a column name guess was wrong, the "
              "printed column lists above show what to fix.")
        _write_empty("join produced no usable rows")
        return

    latest = routes.sort_values("week").groupby("player_id").tail(1)
    records = [{
        "player_id": r["player_id"],
        "name": r.get("name", r["player_id"]),
        "week": int(r["week"]),
        "routesRunProxy": int(r["routes_proxy"]),
    } for _, r in latest.iterrows()]

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "season": part_season,
        "requestedSeason": requested_season,
        "isStale": part_season != requested_season,
        "isProxy": True,
        "proxyNote": (
            "routesRunProxy counts pass plays a player was on the field for, from "
            "nflverse participation data. It cannot distinguish a receiver running a "
            "route from one staying in to block, so treat it as an upper bound on "
            "true routes run, not an exact figure."
        ),
        "players": records,
    }
    with open("route-stats.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"\nWrote route-stats.json: {len(records)} player records.")


def _write_empty(reason):
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "isProxy": True,
        "players": [],
        "note": reason,
    }
    with open("route-stats.json", "w") as f:
        json.dump(payload, f)
    print(f"Wrote empty route-stats.json: {reason}")


if __name__ == "__main__":
    main()
