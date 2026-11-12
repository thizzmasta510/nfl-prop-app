"""Opportunity stats in compute_nba_logs.py. Run: cd github-action && python test_nba_logs.py

Both box score paths (NBA CDN and ESPN) must store shot attempts, 3-point attempts,
free throws and offensive / defensive rebounds next to the counting stats, because
src/nba_opportunity.js projects from them.
"""
from compute_nba_logs import box_rows, espn_box, is_nba_game

CDN = {"game": {
    "gameId": "0022600123", "gameStatus": 3, "gameEt": "2026-11-02T19:00:00",
    "homeTeam": {"teamTricode": "CLE", "players": [
        {"name": "Donovan Mitchell", "personId": 1, "played": "1", "position": "G", "statistics": {
            "minutes": "PT36M12.00S", "points": 31, "reboundsTotal": 5, "assists": 6, "threePointersMade": 4,
            "steals": 1, "blocks": 0, "turnovers": 3, "fieldGoalsAttempted": 22, "fieldGoalsMade": 11,
            "threePointersAttempted": 10, "freeThrowsAttempted": 6, "freeThrowsMade": 5,
            "reboundsOffensive": 1, "reboundsDefensive": 4}},
        {"name": "Bench Guy", "personId": 2, "played": "0", "statistics": {"minutes": "PT00M00.00S"}}]},
    "awayTeam": {"teamTricode": "OKC", "players": []}}}

ESPN_EVENT = {"id": "401909907", "date": "2026-11-03T00:00Z",
              "competitions": [{"competitors": [{"homeAway": "home", "team": {"abbreviation": "CLE"}},
                                                {"homeAway": "away", "team": {"abbreviation": "OKC"}}]}]}
KEYS = ["minutes", "points", "fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted",
        "freeThrowsMade-freeThrowsAttempted", "offensiveRebounds", "defensiveRebounds", "rebounds", "assists",
        "turnovers", "steals", "blocks"]
def team(abbr, athletes):
    return {"team": {"abbreviation": abbr}, "statistics": [{"keys": KEYS, "athletes": athletes}]}
ESPN_SUMMARY = {"boxscore": {"players": [
    team("OKC", [{"athlete": {"displayName": "Shai Gilgeous-Alexander", "id": "9"},
                  "stats": ["39", "43", "14-35", "4-8", "11-12", "1", "2", "3", "8", "2", "1", "0"]},
                 {"athlete": {"displayName": "Brooks Barnhizer", "id": "8"}, "didNotPlay": True, "stats": []}]),
    team("CLE", [{"athlete": {"displayName": "Jarrett Allen", "id": "7"},
                  "stats": ["30", "14", "6-9", "0-0", "2-4", "3", "3", "6", "1", "1", "0", "2"]}])]}}


def test_cdn():
    rows = box_rows(CDN, 2026)
    assert len(rows) == 1, rows
    s = rows[0]["stats"]
    assert (s["fga"], s["fgm"], s["fg3a"], s["fta"], s["ftm"], s["oreb"], s["dreb"]) == (22, 11, 10, 6, 5, 1, 4), s
    assert s["points"] == 31 and s["threes"] == 4 and abs(s["minutes"] - 36.2) < 0.01


def test_espn():
    rows, teams = espn_box(ESPN_SUMMARY, ESPN_EVENT, 2026)
    by = {r["name"]: r["stats"] for r in rows}
    assert set(by) == {"Shai Gilgeous-Alexander", "Jarrett Allen"}, by
    s = by["Shai Gilgeous-Alexander"]
    assert (s["fga"], s["fgm"], s["fg3a"], s["threes"], s["fta"], s["ftm"], s["oreb"], s["dreb"]) == (35, 14, 8, 4, 12, 11, 1, 2), s
    assert s["points"] == 43
    a = by["Jarrett Allen"]
    assert a["fg3a"] == 0 and a["dreb"] == 3


def test_all_star_skipped():
    assert is_nba_game(ESPN_EVENT)
    star = {"id": "401838140", "name": "Team Stars vs Team World",
            "competitions": [{"competitors": [{"team": {"abbreviation": "STARS"}}, {"team": {"abbreviation": "WORLD"}}]}]}
    assert not is_nba_game(star)
    shaq = {"competitions": [{"competitors": [{"team": {"abbreviation": "SHQ"}}, {"team": {"abbreviation": "CHK"}}]}]}
    assert not is_nba_game(shaq)
    espn = {"competitions": [{"competitors": [{"team": {"abbreviation": "GS"}}, {"team": {"abbreviation": "UTAH"}}]}]}
    assert is_nba_game(espn)


def test_efficiency_totals():
    from compute_nba_logs import efficiency_totals
    rows = [{"name": "A", "date": d, "stats": {"minutes": 30, "points": p, "fga": 10, "fta": 4, "threes": 2, "fg3a": 5}}
            for d, p in [("2026-11-02", 20), ("2026-11-01", 10), ("2026-10-30", 15)]]
    rows.append({"name": "A", "date": "2026-10-29", "stats": {"minutes": 0, "points": 0, "fga": 0, "fta": 0, "threes": 0, "fg3a": 0}})
    rows.append({"name": "B", "date": "2026-11-02", "stats": {"minutes": 30, "points": 9}})   # no shot data: left out
    e = efficiency_totals(rows, cap=2)
    assert e == {"A": {"games": 2, "pts": 30, "fga": 20, "fta": 8, "fg3m": 4, "fg3a": 10}}, e


def test_history_games():
    from compute_nba_logs import history_games
    mk = lambda pid, name, d, m, p: {"playerId": pid, "name": name, "date": d, "stats": {"minutes": m, "points": p, "rebounds": 1, "assists": 2, "threes": 0}}
    rows = [mk(1, "A", f"2026-11-{d:02d}", 30, d) for d in range(1, 7)] + [mk(2, "B", "2026-11-01", 20, 5)]
    rows[2]["stats"]["minutes"] = 0            # Nov 3: did not play, still counts toward the newest `keep` rows
    h = history_games(rows, keep=2, cap=5)     # newest first: Nov 6, 5 kept; then Nov 4, 3 (0 min, skipped), 2; Nov 1 is past the cap
    assert h == {"A": {"dates": ["2026-11-04", "2026-11-02"], "minutes": [30, 30], "points": [4, 2], "rebounds": [1, 1], "assists": [2, 2], "threes": [0, 0]}}, h


if __name__ == "__main__":
    test_cdn(); test_espn(); test_all_star_skipped(); test_efficiency_totals(); test_history_games()
    print("nba logs opportunity-stat tests passed")
