"""
Publishes nba-injuries.json: the latest NBA injury report, for the NBA Board and
the NBA Tendency Matrix (Out / Doubtful players are skipped, Questionable ones
flagged, and each row lists teammates who are out).

Sources, tried in order:
  1. The NBA's official injury report (a PDF the league posts through the day,
     every 15 minutes on game days):
     https://ak-static.cms.nba.com/referee/injury/Injury-Report_YYYY-MM-DD_HH_MMAM.pdf
     The newest one from the last 36 hours is used.
  2. ESPN's public injuries feed (JSON), if no official PDF can be read.
If both fail, the script exits non-zero and writes nothing, so a failed run never
replaces a good file.

Runs in GitHub Actions (.github/workflows/nba-injuries.yml), hourly on game days.
Output: nba-injuries.json, plus nba-injury-history.json (the last status each
player had before tip-off, per game date, kept 240 days) so the chance of playing
by status can be fitted (backtest/nba_play_rates.mjs) instead of guessed.
Requires: pip install requests pdfplumber
"""
import io
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from compute_player_stats import normalize_name

ET = ZoneInfo("America/New_York")
REPORT_URL = "https://ak-static.cms.nba.com/referee/injury/Injury-Report_{date}_{time}.pdf"
ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
           "Referer": "https://www.nba.com/"}
STATUSES = ["Out", "Doubtful", "Questionable", "Probable", "Available"]

TEAMS = {
    "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN", "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET", "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
    "LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL", "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA", "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP",
    "New York Knicks": "NYK", "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC", "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR", "Utah Jazz": "UTA", "Washington Wizards": "WAS",
}
_TEAM_RE = "|".join(sorted((re.escape(t) for t in TEAMS), key=len, reverse=True))
_STATUS_RE = "|".join(STATUSES)
ROW_RE = re.compile(
    r"^(?:(?P<date>\d{2}/\d{2}/\d{4})\s+)?"
    r"(?:(?P<time>\d{1,2}:\d{2})\s*\(ET\)\s+)?"
    r"(?:(?P<matchup>[A-Z]{2,3}@[A-Z]{2,3})\s+)?"
    rf"(?:(?P<team>{_TEAM_RE})\s+)?"
    r"(?P<player>[A-Z][^,]{0,40},\s*[^,]{1,40}?)\s+"
    rf"(?P<status>{_STATUS_RE})\b\s*(?P<reason>.*)$")
NOT_SUBMITTED_RE = re.compile(
    r"^(?:(?P<date>\d{2}/\d{2}/\d{4})\s+)?(?:(?P<time>\d{1,2}:\d{2})\s*\(ET\)\s+)?(?:(?P<matchup>[A-Z]{2,3}@[A-Z]{2,3})\s+)?"
    rf"(?P<team>{_TEAM_RE})\s+NOT YET SUBMITTED", re.I)
SKIP_RE = re.compile(r"^(Injury Report:|Page \d+ of \d+|Game Date\s+Game Time)", re.I)


def flip_name(last_first):
    """'Harper Jr., Ron' -> 'Ron Harper Jr.'"""
    last, _, first = last_first.partition(",")
    return f"{first.strip()} {last.strip()}".strip()


def parse_report_text(text):
    """Text of the official PDF -> (players, notSubmitted). Date, time, matchup and
    team are printed only on the first row of each group, so they carry down."""
    players, not_submitted = [], []
    cur = {"date": None, "time": None, "matchup": None, "team": None}
    last = None
    for raw in (text or "").splitlines():
        line = " ".join(raw.split())
        if not line or SKIP_RE.match(line):
            continue
        ns = NOT_SUBMITTED_RE.match(line)
        if ns:
            for k in ("date", "time", "matchup"):
                if ns.group(k):
                    cur[k] = ns.group(k)
            cur["team"] = ns.group("team")
            not_submitted.append({"team": TEAMS[ns.group("team")], "matchup": cur["matchup"], "date": _iso(cur["date"])})
            last = None
            continue
        m = ROW_RE.match(line)
        if m:
            for k in ("date", "time", "matchup", "team"):
                if m.group(k):
                    cur[k] = m.group(k)
                    if k == "matchup":
                        cur["team"] = m.group("team") or None  # new game: team must be restated
            name = flip_name(m.group("player"))
            last = {
                "name": name, "norm": normalize_name(name),
                "team": TEAMS.get(cur["team"]) if cur["team"] else None,
                "status": m.group("status"), "reason": m.group("reason").strip(),
                "game": {"date": _iso(cur["date"]), "time": cur["time"], "matchup": cur["matchup"]},
            }
            players.append(last)
            continue
        if last is not None:  # wrapped reason text
            last["reason"] = (last["reason"] + " " + line).strip()
    for p in players:
        p["reason"] = re.sub(r"^Injury/Illness\s*-\s*", "", p["reason"]).strip()
        if p["team"] is None and p["game"]["matchup"]:
            p["team"] = None  # leave unknown rather than guess
    return players, not_submitted


def _iso(mdy):
    if not mdy:
        return None
    m, d, y = mdy.split("/")
    return f"{y}-{m}-{d}"


def report_urls(now_et, hours=36):
    """Candidate report URLs, newest first, in 15-minute steps."""
    t = now_et.replace(minute=(now_et.minute // 15) * 15, second=0, microsecond=0)
    end = t - timedelta(hours=hours)
    while t > end:
        h12 = t.strftime("%I")
        ap = t.strftime("%p")
        d = t.strftime("%Y-%m-%d")
        yield t, REPORT_URL.format(date=d, time=f"{h12}_{t.strftime('%M')}{ap}")
        if t.minute == 0:
            yield t, REPORT_URL.format(date=d, time=f"{h12}{ap}")  # older naming: 09PM
        t -= timedelta(minutes=15)


def from_official(session, now_et=None, pdf_text=None):
    now_et = now_et or datetime.now(ET)
    errors = 0
    for t, url in report_urls(now_et):
        try:
            r = session.get(url, headers=HEADERS, timeout=20)
        except Exception as e:
            errors += 1
            print(f"  {url}: {type(e).__name__}")
            if errors >= 5:
                print("  official report host unreachable; giving up on it")
                return None
            continue
        errors = 0
        if r.status_code != 200 or not r.content.startswith(b"%PDF"):
            continue
        text = (pdf_text or _pdf_text)(r.content)
        players, ns = parse_report_text(text)
        if not players and not ns:
            print(f"  {url}: no rows parsed")
            continue
        print(f"official report {t.strftime('%Y-%m-%d %I:%M %p')} ET: {len(players)} players")
        return {"source": "NBA official injury report", "reportUrl": url,
                "reportTime": t.isoformat(), "players": players, "notSubmitted": ns}
    return None


def _pdf_text(content):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return "\n".join((page.extract_text() or "") for page in pdf.pages)


ESPN_STATUS = {"out": "Out", "doubtful": "Doubtful", "questionable": "Questionable", "day-to-day": "Questionable",
               "probable": "Probable", "available": "Available", "suspension": "Out", "injured reserve": "Out"}


def from_espn(session):
    r = session.get(ESPN_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()
    data = r.json()
    players = []
    for team in data.get("injuries") or []:
        tname = team.get("displayName") or (team.get("team") or {}).get("displayName") or ""
        code = TEAMS.get(tname) or str((team.get("team") or {}).get("abbreviation") or "").upper() or None
        for inj in team.get("injuries") or []:
            ath = inj.get("athlete") or {}
            name = ath.get("displayName") or ""
            raw = str(inj.get("status") or (inj.get("type") or {}).get("description") or "").strip()
            status = ESPN_STATUS.get(raw.lower())
            if not name or not status:
                continue
            players.append({"name": name, "norm": normalize_name(name), "team": code, "status": status,
                            "reason": str(inj.get("shortComment") or inj.get("details", {}).get("type") or "")[:200],
                            "game": None})
    if not players:
        return None
    print(f"ESPN injuries: {len(players)} players")
    return {"source": "ESPN injuries feed", "reportUrl": ESPN_URL, "reportTime": datetime.now(ET).isoformat(),
            "players": players, "notSubmitted": []}


HISTORY_DAYS = 240


def _tip_et(game):
    """Game date + 'HH:MM' (ET, evening games) -> aware datetime, or None."""
    try:
        h, m = (int(x) for x in game["time"].split(":"))
        if h < 12:
            h += 12  # the report lists tip times like 07:30 (ET) for 7:30 PM
        y, mo, d = (int(x) for x in game["date"].split("-"))
        return datetime(y, mo, d, h, m, tzinfo=ET)
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def update_history(history, report, now_et=None):
    """Record each player's status for his game date, overwriting earlier statuses
    from the same day, but only while the game has not started."""
    now_et = now_et or datetime.now(ET)
    rt = report.get("reportTime")
    try:
        rtime = datetime.fromisoformat(rt) if rt else now_et
    except ValueError:
        rtime = now_et
    days = history.setdefault("days", {})
    for p in report.get("players") or []:
        g = p.get("game") or {}
        tip = _tip_et(g)
        if not g.get("date") or not p.get("team") or tip is None or rtime >= tip:
            continue
        days.setdefault(g["date"], {})[f"{p['norm']}|{p['team']}"] = {
            "name": p["name"], "team": p["team"], "status": p["status"], "asOf": rtime.isoformat()}
    cutoff = (now_et - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")
    for d in [d for d in days if d < cutoff]:
        del days[d]
    return history


def main():
    import requests
    s = requests.Session()
    out = None
    try:
        out = from_official(s)
    except Exception as e:
        print(f"official report failed: {type(e).__name__}: {e}")
    if not out:
        try:
            out = from_espn(s)
        except Exception as e:
            print(f"ESPN failed: {type(e).__name__}: {e}")
    if not out:
        print("No injury data retrieved; leaving any existing nba-injuries.json untouched.", file=sys.stderr)
        sys.exit(1)
    out = {"generatedAt": datetime.now(timezone.utc).isoformat(), "sport": "nba", **out}
    # Same report as the published file: keep its timestamp so the workflow has
    # nothing to commit (no hourly commits when nothing changed).
    try:
        with open(os.path.join("..", "nba-injuries.json")) as f:
            prev = json.load(f)
        if prev.get("reportUrl") == out["reportUrl"] and prev.get("players") == out["players"] \
                and prev.get("notSubmitted") == out["notSubmitted"]:
            out["generatedAt"] = prev.get("generatedAt", out["generatedAt"])
            out["reportTime"] = prev.get("reportTime", out["reportTime"])
            print("Report unchanged since the last run.")
    except (OSError, ValueError):
        pass
    with open("nba-injuries.json", "w") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)
    # Status history (official report only: the ESPN feed has no game times).
    if out["source"].startswith("NBA official"):
        try:
            with open(os.path.join("..", "nba-injury-history.json")) as f:
                history = json.load(f)
        except (OSError, ValueError):
            history = {}
        update_history(history, out)
        with open("nba-injury-history.json", "w") as f:
            json.dump(history, f, separators=(",", ":"), sort_keys=True)
    print(f"Wrote nba-injuries.json from {out['source']}: {len(out['players'])} players")


if __name__ == "__main__":
    main()
