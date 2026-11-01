"""Parser tests for compute_nba_injuries.py. Run: cd github-action && python test_nba_injuries.py

SQUASHED reproduces what pdfplumber returned for the Nov 1, 2026 12:30 AM report
(spaces dropped inside cells, wrapped reasons landing on neighboring lines, the
page footer mid-line). Before the fix every row came out with team None and names
like "Devin BostonCeltics Carter".
"""
from compute_nba_injuries import parse_report_text, report_quality, MIN_TEAM_SHARE

SQUASHED = """Injury Report: 11/01/26 12:30 AM
Game Date Game Time Matchup Team Player Name Current Status Reason
11/01/2026 03:30(ET) BOS@ORL BostonCeltics Carter,Devin Out Injury/Illness-Illness
Robinson,Mitchell Questionable Rest Injury/Illness-RightLowGradeHigh
OrlandoMagic Banchero,Paolo Out
AnkleSprain Injury/Illness-LeftKneeInjury
Isaac,Jonathan Out
Management
05:00(ET) BKN@IND BrooklynNets Bilodeau,Tyler Out GLeague-Two-Way
BrownJr.,Mikel Out Injury/Illness-Back,InjuryManagement
IndianaPacers Furphy,Johnny Out Injury/Illness-RightACLRepair/ Page1of5
Surgery
Haliburton,Tyrese Out Injury/Illness-LeftHamstringStrain
Nesmith,Aaron Probable Injury/Illness-LeftHamstringStrain
Toppin,Obi Questionable Injury/Illness-LowBackSoreness
08:30(ET) LAC@GSW LAClippers Beal,Bradley Out Injury/Illness-RightKneeInjuryManagement
Niederhauser,YanicKonan Out Injury/Illness-RightLisfrancSurgery
GoldenStateWarriors ButlerIII,Jimmy Out Injury/Illness-RightACLRepair/Surgery
Curry,Stephen Out Injury/Illness-RightKneeInjuryManagement
10:00(ET) TOR@LAL TorontoRaptors NOTYETSUBMITTED
"""

SPACED = """Injury Report: 11/01/26 12:30 AM
Game Date Game Time Matchup Team Player Name Current Status Reason
11/01/2026 03:30 (ET) BOS@ORL Boston Celtics Carter, Devin Out Injury/Illness - Illness
Robinson, Mitchell Questionable Rest
Orlando Magic Banchero, Paolo Out Injury/Illness - Right Low Grade High Ankle Sprain
05:00 (ET) BKN@IND Brooklyn Nets Brown Jr., Mikel Out Injury/Illness - Back, Injury Management
Indiana Pacers Haliburton, Tyrese Out Injury/Illness - Left Hamstring Strain
08:30 (ET) LAC@GSW Golden State Warriors Butler III, Jimmy Out Injury/Illness - Right ACL Repair / Surgery
Page 2 of 5
Curry, Stephen Out Injury/Illness - Right Knee Injury Management
"""


def by_name(players):
    return {p["name"]: p for p in players}


def test_squashed():
    players, ns = parse_report_text(SQUASHED)
    P = by_name(players)
    assert len(players) == 14, [p["name"] for p in players]
    assert report_quality(players) == 1.0, [(p["name"], p["team"]) for p in players if not p["team"]]
    assert P["Devin Carter"]["team"] == "BOS" and P["Devin Carter"]["status"] == "Out"
    assert P["Mitchell Robinson"]["team"] == "BOS" and P["Mitchell Robinson"]["status"] == "Questionable"
    assert P["Mitchell Robinson"]["reason"] == "Rest", P["Mitchell Robinson"]["reason"]
    assert P["Paolo Banchero"]["team"] == "ORL"
    assert P["Jonathan Isaac"]["team"] == "ORL"
    assert P["Mikel Brown Jr."]["norm"] == "mikel brown" and P["Mikel Brown Jr."]["team"] == "BKN"
    assert P["Johnny Furphy"]["team"] == "IND" and "Page" not in P["Johnny Furphy"]["reason"]
    assert P["Aaron Nesmith"]["status"] == "Probable" and P["Aaron Nesmith"]["team"] == "IND"
    assert P["Bradley Beal"]["team"] == "LAC" and P["Bradley Beal"]["game"]["matchup"] == "LAC@GSW"
    assert P["YanicKonan Niederhauser"]["team"] == "LAC"
    assert P["Jimmy Butler III"]["norm"] == "jimmy butler" and P["Jimmy Butler III"]["team"] == "GSW"
    assert P["Stephen Curry"]["team"] == "GSW"
    assert P["Tyrese Haliburton"]["game"]["date"] == "2026-11-01"
    assert ns == [{"team": "TOR", "matchup": "TOR@LAL", "date": "2026-11-01"}], ns


def test_spaced():
    players, _ = parse_report_text(SPACED)
    P = by_name(players)
    assert len(players) == 7
    assert report_quality(players) == 1.0
    assert P["Paolo Banchero"]["reason"] == "Right Low Grade High Ankle Sprain"
    assert P["Mikel Brown Jr."]["team"] == "BKN" and P["Jimmy Butler III"]["team"] == "GSW"
    assert P["Stephen Curry"]["team"] == "GSW", "team carries across the page footer"


def test_quality_gate():
    # A team outside the matchup is treated as a parsing slip, and a report where
    # most rows have no team is not published (the ESPN feed is used instead).
    players, _ = parse_report_text("11/01/2026 03:30(ET) BOS@ORL MiamiHeat Carter,Devin Out Illness\nIsaac,Jonathan Out Rest\n")
    assert all(p["team"] is None for p in players)
    assert report_quality(players) < MIN_TEAM_SHARE


if __name__ == "__main__":
    test_squashed(); test_spaced(); test_quality_gate()
    print("nba injury parser tests passed")
