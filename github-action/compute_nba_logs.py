"""
Publishes nba-trend-logs.json: each NBA player's last 20 regular-season games
across the current and previous season, for the NBA Tendency Matrix tab, plus
  teamGames: one row per team per game (points, opponent points, possessions,
             minutes), so the Worker can compute pace and offensive/defensive
             rating as of any date (no lookahead in backtests)
  upcoming:  scheduled games for the next 8 days with tip-off times, so the
             Worker can show each player's next opponent and skip games that
             have already started

Sources, tried in order:
  0. (see below) cdn.nba.com first; if it refuses (it returns 403 to GitHub's
     servers), ESPN's public scoreboard + game summary JSON, then stats.nba.com.
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
from datetime import datetime, timedelta, timezone

from compute_player_stats import normalize_name, short_key

KEEP_GAMES = 20
# --all: every regular-season game of both seasons (no 20-game trim, no early stop),
# for point-in-time backtests. Written to --out (default nba-history.json); not
# meant to be published for the Worker.
FULL = "--all" in sys.argv
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


def _team_line(team):
    """Points, FGA, FTA, offensive rebounds, turnovers and minutes for one side of a box score.
    Uses the team totals when present, otherwise sums the players."""
    st = team.get("statistics") or {}
    players = team.get("players") or []
    def total(*keys):
        for k in keys:
            v = num(st.get(k))
            if v is not None:
                return v
        vals = [num((p.get("statistics") or {}).get(keys[-1])) for p in players]
        vals = [v for v in vals if v is not None]
        return sum(vals) if vals else None
    return {
        "pts": total("points"), "fga": total("fieldGoalsAttempted"), "fta": total("freeThrowsAttempted"),
        "orb": total("reboundsOffensive"), "tov": total("turnoversTotal", "turnovers"),
    }


def team_games(box, season_start):
    """One CDN box score -> two team-game rows with an estimated possession count.
    Possessions use the standard estimate FGA - ORB + TOV + 0.44 * FTA, averaged over
    both teams (they have nearly the same number of possessions in a game)."""
    g = (box or {}).get("game") or {}
    gid = str(g.get("gameId") or "")
    if not gid.startswith("002") or int(g.get("gameStatus") or 0) != 3:
        return []
    date = str(g.get("gameEt") or g.get("gameTimeUTC") or "")[:10]
    home, away = g.get("homeTeam") or {}, g.get("awayTeam") or {}
    h, a = _team_line(home), _team_line(away)
    if None in (h["pts"], h["fga"], h["fta"], h["orb"], h["tov"], a["pts"], a["fga"], a["fta"], a["orb"], a["tov"]):
        return []
    poss = lambda x: x["fga"] - x["orb"] + x["tov"] + 0.44 * x["fta"]
    p = round((poss(h) + poss(a)) / 2, 1)
    # Overtime: team minutes are 240 plus 25 per OT period (5 players x 5 minutes).
    periods = max(4, int(num(g.get("period")) or 4))
    mins = 240.0 + 25.0 * (periods - 4)
    out = []
    for me, them, x, y in ((home, away, h, a), (away, home, a, h)):
        out.append({"g": gid, "d": date, "s": season_start,
                    "t": str(me.get("teamTricode") or "").upper(), "o": str(them.get("teamTricode") or "").upper(),
                    "home": me is home, "pts": x["pts"], "opp": y["pts"], "poss": p, "min": mins})
    return out


def upcoming_games(sched, now=None, days=8):
    """Scheduled (not started) regular-season games in the next `days` days."""
    now = now or datetime.now(timezone.utc)
    out = []
    for d in (sched or {}).get("gameDates") or []:
        for gm in d.get("games") or []:
            gid = str(gm.get("gameId") or "")
            if not gid.startswith("002") or int(gm.get("gameStatus") or 0) != 1:
                continue
            tip = str(gm.get("gameDateTimeUTC") or "")
            try:
                t = datetime.fromisoformat(tip.replace("Z", "+00:00"))
            except ValueError:
                continue
            if t < now or (t - now).days > days:
                continue
            out.append({"g": gid, "tip": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "date": str(gm.get("gameDateEst") or tip)[:10],
                        "home": str((gm.get("homeTeam") or {}).get("teamTricode") or "").upper(),
                        "away": str((gm.get("awayTeam") or {}).get("teamTricode") or "").upper()})
    out.sort(key=lambda x: x["tip"])
    return out


def from_cdn(session=None, sleep=0.3, now=None):
    import requests
    s = session or requests.Session()
    get = lambda url: s.get(url, headers=CDN_HEADERS, timeout=30)
    rows, tgames, upcoming = [], [], []
    cur_start = season_strings()[0][0]
    # Current season: completed regular-season games from the schedule, newest first.
    ids = []
    try:
        r = get(f"{CDN}/staticData/scheduleLeagueV2.json")
        r.raise_for_status()
        sched = r.json().get("leagueSchedule") or {}
        upcoming = upcoming_games(sched, now)
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
        for gid in (id_list if FULL else id_list[:MAX_BOX_PER_SEASON]):
            if not FULL and per_team and len(per_team) >= 30 and min(per_team.values()) >= KEEP_GAMES + 2:
                break
            try:
                r = get(f"{CDN}/liveData/boxscore/boxscore_{gid}.json")
                if r.status_code == 404:
                    continue
                r.raise_for_status()
                box = r.json()
                br = box_rows(box, season_start)
                tg = team_games(box, season_start)
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
                tgames.extend(tg)
            time.sleep(sleep)
        print(f"cdn {label}: {got} box scores")
        return per_team

    cur_teams = collect([g for _, g in ids], cur_start, f"{cur_start}-{str(cur_start + 1)[-2:]}")
    if not FULL and len(cur_teams) >= 30 and min(cur_teams.values()) >= KEEP_GAMES:
        return rows, tgames, upcoming  # every team already has a full window this season
    # Previous season, newest game first (regular-season ids are 002YY00001..002YY01230).
    prev = cur_start - 1
    prev_ids = [f"002{str(prev)[-2:]}{n:05d}" for n in range(1230, 0, -1)]
    collect(prev_ids, prev, f"{prev}-{str(prev + 1)[-2:]}")
    return rows, tgames, upcoming


# ---------------------------------------------------------------------------
# Source 1b: ESPN public JSON (scoreboard by date + one summary per game)
# ---------------------------------------------------------------------------
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_HEADERS = {"User-Agent": CDN_HEADERS["User-Agent"], "Accept": "application/json"}
# ESPN abbreviations that differ from the NBA's (the injury report and Kalshi use NBA codes).
ESPN_TEAM = {"GS": "GSW", "NO": "NOP", "NY": "NYK", "SA": "SAS", "UTAH": "UTA", "WSH": "WAS", "PHO": "PHX", "BRK": "BKN"}
ESPN_POS = {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C", "GF": "G", "FC": "F"}


def espn_team(abbr):
    a = str(abbr or "").upper()
    return ESPN_TEAM.get(a, a)


def _et_date(iso):
    from zoneinfo import ZoneInfo
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None, None
    return t, t.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def _made_att(v):
    try:
        m, a = str(v).split("-")
        return float(m), float(a)
    except (ValueError, AttributeError):
        return None, None


def espn_box(summary, event, season_start):
    """ESPN game summary -> (player rows, team-game rows) in the same shape as the cdn path."""
    _, date = _et_date(event.get("date"))
    gid = str(event.get("id"))
    out, totals = [], {}
    teams = (summary or {}).get("boxscore", {}).get("players") or []
    if len(teams) != 2:
        return [], []
    codes = [espn_team((t.get("team") or {}).get("abbreviation")) for t in teams]
    home_code = None
    for c in ((event.get("competitions") or [{}])[0].get("competitors") or []):
        if c.get("homeAway") == "home":
            home_code = espn_team((c.get("team") or {}).get("abbreviation"))
    for ti, team in enumerate(teams):
        me, opp = codes[ti], codes[1 - ti]
        st = (team.get("statistics") or [{}])[0]
        keys = st.get("keys") or []
        idx = {k: i for i, k in enumerate(keys)}
        tot = {"pts": 0.0, "fga": 0.0, "fta": 0.0, "orb": 0.0, "tov": 0.0, "min": 0.0}
        for a in st.get("athletes") or []:
            vals = a.get("stats") or []
            if a.get("didNotPlay") or not vals:
                continue
            g = lambda k: vals[idx[k]] if k in idx and idx[k] < len(vals) else None
            mins = num(g("minutes"))
            if not mins:
                continue
            pts, reb, ast = num(g("points")), num(g("rebounds")), num(g("assists"))
            stl, blk, tov = num(g("steals")), num(g("blocks")), num(g("turnovers"))
            fgm, fga = _made_att(g("fieldGoalsMade-fieldGoalsAttempted"))
            tpm, _ = _made_att(g("threePointFieldGoalsMade-threePointFieldGoalsAttempted"))
            _, fta = _made_att(g("freeThrowsMade-freeThrowsAttempted"))
            orb = num(g("offensiveRebounds"))
            for k, v in (("pts", pts), ("fga", fga), ("fta", fta), ("orb", orb), ("tov", tov), ("min", mins)):
                if v is not None:
                    tot[k] += v
            stats = {"points": pts, "rebounds": reb, "assists": ast, "threes": tpm, "steals": stl, "blocks": blk,
                     "turnovers": tov, "minutes": mins}
            if None not in (pts, reb, ast):
                stats.update(pra=pts + reb + ast, pr=pts + reb, pa=pts + ast, ra=reb + ast)
            if None not in (stl, blk):
                stats["stocks"] = stl + blk
            stats = {k: v for k, v in stats.items() if v is not None}
            ath = a.get("athlete") or {}
            name = str(ath.get("displayName") or "").strip()
            pos = ESPN_POS.get(str((ath.get("position") or {}).get("abbreviation") or "").upper().replace("-", ""))
            out.append({
                "name": name, "norm": normalize_name(name), "short": short_key(name),
                "team": me, "season": season_start, "date": date, "seasonType": "Regular Season",
                "position": pos, "starter": bool(a.get("starter")),
                "opponent": opp, "home": me == home_code,
                "gameId": gid, "playerId": int(ath.get("id") or 0), "stats": stats,
            })
        totals[me] = tot
    tg = []
    if all(k in totals for k in codes):
        poss = lambda x: x["fga"] - x["orb"] + x["tov"] + 0.44 * x["fta"]
        p = round((poss(totals[codes[0]]) + poss(totals[codes[1]])) / 2, 1)
        for ti in (0, 1):
            me, opp = codes[ti], codes[1 - ti]
            team_min = totals[me]["min"]
            mins = 240.0 + 25.0 * max(0, round((team_min - 240) / 25))   # overtime adds 25 team minutes
            tg.append({"g": gid, "d": date, "s": season_start, "t": me, "o": opp, "home": me == home_code,
                       "pts": totals[me]["pts"], "opp": totals[opp]["pts"], "poss": p, "min": mins})
    return out, tg


def from_espn(session=None, sleep=0.15, now=None):
    import requests
    from zoneinfo import ZoneInfo
    s = session or requests.Session()
    get = lambda path, **params: s.get(f"{ESPN}/{path}", params=params, headers=ESPN_HEADERS, timeout=30)
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo("America/New_York")).date()
    cur_start = season_strings(now)[0][0]
    rows, tgames, upcoming = [], [], []
    fails = 0

    def scoreboard(day):
        nonlocal fails
        try:
            r = get("scoreboard", dates=day.strftime("%Y%m%d"))
            r.raise_for_status()
            fails = 0
            return r.json().get("events") or []
        except Exception as e:
            fails += 1
            print(f"  espn scoreboard {day}: {type(e).__name__}: {e}")
            return []

    # Upcoming: today and the next 7 days, games not yet started.
    for k in range(0, 8):
        for ev in scoreboard(today + timedelta(days=k)):
            st = (ev.get("status") or {}).get("type") or {}
            if (ev.get("season") or {}).get("type") != 2 or st.get("state") != "pre":
                continue
            t, d = _et_date(ev.get("date"))
            comp = (ev.get("competitions") or [{}])[0].get("competitors") or []
            side = {c.get("homeAway"): espn_team((c.get("team") or {}).get("abbreviation")) for c in comp}
            if t and side.get("home") and side.get("away") and t > now:
                upcoming.append({"g": str(ev.get("id")), "tip": t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                 "date": d, "home": side["home"], "away": side["away"]})
        if fails >= 5:
            print("  espn unreachable; giving up")
            return [], [], []
    upcoming.sort(key=lambda x: x["tip"])

    def walk(start_day, stop_day, season_start, label):
        per_team, got = {}, 0
        day = start_day
        nonlocal fails
        while day >= stop_day:
            if not FULL and len(per_team) >= 30 and min(per_team.values()) >= KEEP_GAMES + 2:
                break
            for ev in scoreboard(day):
                st = (ev.get("status") or {}).get("type") or {}
                if (ev.get("season") or {}).get("type") != 2 or not st.get("completed"):
                    continue
                try:
                    r = get("summary", event=str(ev.get("id")))
                    r.raise_for_status()
                    br, tg = espn_box(r.json(), ev, season_start)
                except Exception as e:
                    print(f"  espn summary {ev.get('id')}: {type(e).__name__}: {e}")
                    continue
                if br:
                    got += 1
                    for t in {x["team"] for x in br}:
                        per_team[t] = per_team.get(t, 0) + 1
                    rows.extend(br)
                    tgames.extend(tg)
                time.sleep(sleep)
            if fails >= 5:
                print("  espn unreachable; giving up")
                break
            day -= timedelta(days=1)
        print(f"espn {label}: {got} games")
        return per_team

    from datetime import date as _date
    # Current season: yesterday back to Oct 1; previous season: Apr 20 back to Oct 1.
    cur = walk(today - timedelta(days=0 if now.hour >= 12 else 1), _date(cur_start, 10, 1), cur_start,
               f"{cur_start}-{str(cur_start + 1)[-2:]}")
    if FULL or not (len(cur) >= 30 and min(cur.values()) >= KEEP_GAMES):
        prev = cur_start - 1
        walk(_date(cur_start, 4, 20), _date(prev, 10, 1), prev, f"{prev}-{str(prev + 1)[-2:]}")
    return rows, tgames, upcoming


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
    rows, tgames, upcoming = [], [], []
    try:
        rows, tgames, upcoming = from_cdn()
    except Exception as e:
        print(f"cdn source failed: {type(e).__name__}: {e}")
    if not rows:
        print("cdn.nba.com gave no data; trying ESPN")
        try:
            rows, tgames, upcoming = from_espn()
        except Exception as e:
            print(f"ESPN source failed: {type(e).__name__}: {e}")
    if not rows:
        print("ESPN gave no data; trying stats.nba.com")
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
        if FULL or n < KEEP_GAMES:
            kept.append(r)
            count[r["playerId"]] = n + 1
    out_path = "nba-trend-logs.json"
    if FULL:
        out_path = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "nba-history.json"

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sport": "nba",
        "season": season_strings()[0][0],
        "gamesPerPlayer": None if FULL else KEEP_GAMES,
        "latestGameDate": rows[0]["date"],
        "players": kept,
        # Empty when the stats.nba.com fallback was used (it has no possession data).
        "teamGames": sorted(tgames, key=lambda x: (x["d"], x["g"], x["t"])),
        "upcoming": upcoming,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, separators=(",", ":"), allow_nan=False)
    print(f"Wrote {out_path}: {len(kept)} player-games, {len(tgames)} team-games, "
          f"{len(upcoming)} upcoming games, latest {rows[0]['date']}")


if __name__ == "__main__":
    main()
