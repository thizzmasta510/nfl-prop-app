"""
Publishes nba-trend-logs.json: each NBA player's last 20 regular-season games
across the current and previous season, for the NBA Tendency Matrix tab.

Sources, tried in order:
  1. cdn.nba.com (the NBA's public CDN: the season schedule plus one box score per
     game). This is what the NBA's own site loads, and unlike stats.nba.com it is
     not known to block cloud servers such as GitHub's runners.
  2. stats.nba.com via the nba_api package (one request per season). It works
     from a home connection but often times out from GitHub Actions.
If both fail, the script exits non-zero and writes nothing, so a bad run never
overwrites good data. Run it at home with `python compute_nba_logs.py` if needed.

Runs in GitHub Actions (see .github/workflows/nba-stats.yml), not the Worker.
Output: nba-trend-logs.json
Requires: pip install requests (cdn path); nba_api pandas (fallback path)
"""
import json
import math
import re
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


# ---------------------------------------------------------------------------
# Source 1: cdn.nba.com
# ---------------------------------------------------------------------------
CDN = "https://cdn.nba.com/static/json"
CDN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Referer": "https://www.nba.com/", "Origin": "https://www.nba.com", "Accept": "application/json",
}
MAX_BOX_PER_SEASON = 450   # enough for every team's last 20+ games; keeps a run to a few minutes


def iso_minutes(v):
    """'PT34M12.00S' -> 34.2"""
    s = str(v or "")
    if not s.startswith("PT"):
        return minutes(v)
    m = re.match(r"PT(?:(\d+)M)?(?:([\d.]+)S)?", s)
    if not m:
        return None
    return round(int(m.group(1) or 0) + float(m.group(2) or 0) / 60, 1)


def box_rows(box, season_start):
    """One CDN box score -> player rows in the same shape as the stats.nba.com path."""
    g = (box or {}).get("game") or {}
    gid = str(g.get("gameId") or "")
    if not gid.startswith("002") or int(g.get("gameStatus") or 0) != 3:
        return []  # regular season, final games only
    date = str(g.get("gameEt") or g.get("gameTimeUTC") or "")[:10]
    out = []
    for side, other in (("homeTeam", "awayTeam"), ("awayTeam", "homeTeam")):
        team, opp = g.get(side) or {}, g.get(other) or {}
        for p in team.get("players") or []:
            st = p.get("statistics") or {}
            mins = iso_minutes(st.get("minutes"))
            if str(p.get("played", "1")) != "1" or not mins:
                continue  # did not play
            pts, reb, ast = num(st.get("points")), num(st.get("reboundsTotal")), num(st.get("assists"))
            stl, blk = num(st.get("steals")), num(st.get("blocks"))
            stats = {"points": pts, "rebounds": reb, "assists": ast, "threes": num(st.get("threePointersMade")),
                     "steals": stl, "blocks": blk, "turnovers": num(st.get("turnovers")), "minutes": mins}
            if None not in (pts, reb, ast):
                stats.update(pra=pts + reb + ast, pr=pts + reb, pa=pts + ast, ra=reb + ast)
            if None not in (stl, blk):
                stats["stocks"] = stl + blk
            stats = {k: v for k, v in stats.items() if v is not None}
            name = str(p.get("name") or f"{p.get('firstName', '')} {p.get('familyName', '')}").strip()
            out.append({
                "name": name, "norm": normalize_name(name), "short": short_key(name),
                "team": str(team.get("teamTricode") or "").upper(),
                "season": season_start, "date": date, "seasonType": "Regular Season",
                "position": (p.get("position") or None),  # the CDN only lists positions for starters
                "opponent": str(opp.get("teamTricode") or "").upper() or None, "home": side == "homeTeam",
                "gameId": gid, "playerId": int(p.get("personId") or 0), "stats": stats,
            })
    return out


def from_cdn(session=None, sleep=0.3):
    import requests
    s = session or requests.Session()
    get = lambda url: s.get(url, headers=CDN_HEADERS, timeout=30)
    rows = []
    cur_start = season_strings()[0][0]
    # Current season: completed regular-season games from the schedule, newest first.
    ids = []
    try:
        r = get(f"{CDN}/staticData/scheduleLeagueV2.json")
        r.raise_for_status()
        sched = r.json().get("leagueSchedule") or {}
        for d in sched.get("gameDates") or []:
            for gm in d.get("games") or []:
                gid = str(gm.get("gameId") or "")
                if gid.startswith("002") and int(gm.get("gameStatus") or 0) == 3:
                    ids.append((str(gm.get("gameDateTimeUTC") or gm.get("gameDateEst") or ""), gid))
        sched_year = str(sched.get("seasonYear") or "")
        if sched_year[:4].isdigit():
            cur_start = int(sched_year[:4])
        print(f"cdn schedule {sched_year}: {len(ids)} completed regular-season games")
    except Exception as e:
        print(f"  cdn schedule: {type(e).__name__}: {e}")
    ids.sort(reverse=True)

    def collect(id_list, season_start, label):
        per_team, got, fails = {}, 0, 0
        for gid in id_list[:MAX_BOX_PER_SEASON]:
            if per_team and len(per_team) >= 30 and min(per_team.values()) >= KEEP_GAMES + 2:
                break
            try:
                r = get(f"{CDN}/liveData/boxscore/boxscore_{gid}.json")
                if r.status_code == 404:
                    continue
                r.raise_for_status()
                br = box_rows(r.json(), season_start)
            except Exception as e:
                fails += 1
                print(f"  cdn box {gid}: {type(e).__name__}: {e}")
                if fails >= 10 and got == 0:
                    print(f"  cdn {label}: giving up after 10 failures")
                    break
                continue
            if br:
                got += 1
                for t in {x["team"] for x in br}:
                    per_team[t] = per_team.get(t, 0) + 1
                rows.extend(br)
            time.sleep(sleep)
        print(f"cdn {label}: {got} box scores")
        return per_team

    cur_teams = collect([g for _, g in ids], cur_start, f"{cur_start}-{str(cur_start + 1)[-2:]}")
    if len(cur_teams) >= 30 and min(cur_teams.values()) >= KEEP_GAMES:
        return rows  # every team already has a full window this season
    # Previous season, newest game first (regular-season ids are 002YY00001..002YY01230).
    prev = cur_start - 1
    prev_ids = [f"002{str(prev)[-2:]}{n:05d}" for n in range(1230, 0, -1)]
    collect(prev_ids, prev, f"{prev}-{str(prev + 1)[-2:]}")
    return rows


# ---------------------------------------------------------------------------
# Source 2: stats.nba.com (nba_api)
# ---------------------------------------------------------------------------
def from_stats_api():
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
    return rows


def main():
    rows = []
    try:
        rows = from_cdn()
    except Exception as e:
        print(f"cdn source failed: {type(e).__name__}: {e}")
    if not rows:
        print("cdn.nba.com gave no data; trying stats.nba.com")
        try:
            rows = from_stats_api()
        except Exception as e:
            print(f"stats.nba.com source failed: {type(e).__name__}: {e}")
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
