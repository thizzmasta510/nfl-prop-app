"""
Publishes nba-trend-logs.json: each NBA player's last 20 regular-season games
across the current and previous season, for the NBA Tendency Matrix tab.

Source: stats.nba.com through the nba_api package (free, no key). One request
per season returns every player's game log (PlayerGameLogs), plus one request
for positions (PlayerIndex). stats.nba.com sometimes throttles or blocks cloud
IPs; requests are retried with backoff and the script exits non-zero with a
printed reason if it still fails, so a bad run never overwrites good data.

Runs in GitHub Actions (see .github/workflows/nba-stats.yml), not the Worker.
Output: nba-trend-logs.json
Requires: pip install nba_api pandas
"""
import json
import math
import sys
import time
from datetime import datetime, timezone

from compute_player_stats import normalize_name, short_key

KEEP_GAMES = 20
TIMEOUT = 60


def season_strings(now=None):
    """NBA seasons start in October: Oct 2026 -> '2026-27' (start year 2026)."""
    now = now or datetime.now(timezone.utc)
    start = now.year if now.month >= 10 else now.year - 1
    fmt = lambda y: f"{y}-{str(y + 1)[-2:]}"
    return [(start, fmt(start)), (start - 1, fmt(start - 1))]


def with_retries(fn, label, tries=4):
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            wait = 10 * (i + 1)
            print(f"  {label}: {type(e).__name__}: {e} (retry in {wait}s)")
            time.sleep(wait)
    return None


def minutes(v):
    if v is None:
        return None
    s = str(v)
    if ":" in s:
        m, sec = s.split(":")[:2]
        return round(int(m) + int(sec) / 60, 1)
    f = num(v)
    return None if f is None else round(f, 1)


def num(v):
    """float or None. pandas turns missing values into NaN, which is not valid JSON."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def main():
    from nba_api.stats.endpoints import playergamelogs, playerindex

    positions = {}
    for start, label in season_strings():
        df = with_retries(lambda: playerindex.PlayerIndex(season=label, timeout=TIMEOUT).get_data_frames()[0],
                          f"PlayerIndex {label}")
        if df is not None and len(df):
            for _, r in df.iterrows():
                positions.setdefault(int(r["PERSON_ID"]), str(r.get("POSITION") or "") or None)
        time.sleep(2)

    rows = []
    for start, label in season_strings():
        df = with_retries(lambda: playergamelogs.PlayerGameLogs(
            season_nullable=label, season_type_nullable="Regular Season", timeout=TIMEOUT).get_data_frames()[0],
            f"PlayerGameLogs {label}")
        if df is None:
            print(f"season {label}: request failed")
            continue
        print(f"season {label}: {len(df)} player-games")
        for _, r in df.iterrows():
            matchup = str(r.get("MATCHUP") or "")
            home = " vs. " in matchup
            opp = matchup.split(" vs. " if home else " @ ")[-1].strip() if matchup else None
            pts, reb, ast = num(r.get("PTS")), num(r.get("REB")), num(r.get("AST"))
            stl, blk = num(r.get("STL")), num(r.get("BLK"))
            stats = {"points": pts, "rebounds": reb, "assists": ast, "threes": num(r.get("FG3M")),
                     "steals": stl, "blocks": blk, "turnovers": num(r.get("TOV")), "minutes": minutes(r.get("MIN"))}
            if None not in (pts, reb, ast):
                stats.update(pra=pts + reb + ast, pr=pts + reb, pa=pts + ast, ra=reb + ast)
            if None not in (stl, blk):
                stats["stocks"] = stl + blk
            stats = {k: v for k, v in stats.items() if v is not None}
            name = str(r["PLAYER_NAME"])
            rows.append({
                "name": name, "norm": normalize_name(name), "short": short_key(name),
                "team": str(r.get("TEAM_ABBREVIATION") or "").upper(),
                "season": start, "date": str(r["GAME_DATE"])[:10], "seasonType": "Regular Season",
                "position": positions.get(int(r["PLAYER_ID"])), "opponent": opp, "home": home,
                "gameId": str(r.get("GAME_ID")), "playerId": int(r["PLAYER_ID"]),
                "stats": stats,
            })
        time.sleep(2)

    if not rows:
        print("No NBA data retrieved; leaving any existing nba-trend-logs.json untouched.", file=sys.stderr)
        sys.exit(1)

    rows.sort(key=lambda x: x["date"], reverse=True)
    kept, count = [], {}
    for r in rows:
        n = count.get(r["playerId"], 0)
        if n < KEEP_GAMES:
            kept.append(r)
            count[r["playerId"]] = n + 1

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sport": "nba",
        "season": season_strings()[0][0],
        "gamesPerPlayer": KEEP_GAMES,
        "latestGameDate": rows[0]["date"],
        "players": kept,
    }
    with open("nba-trend-logs.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"), allow_nan=False)
    print(f"Wrote nba-trend-logs.json: {len(kept)} player-games, latest {rows[0]['date']}")


if __name__ == "__main__":
    main()
