// node test/trends_nba.test.mjs
import assert from "node:assert/strict";
import { buildTrendGrid, parseLinesText, linesFromList } from "../src/trends.js";

const g = (name, season, date, pts, pos = "G", type = "Regular Season", min = 34) =>
  ({ name, team: "NYK", season, date, seasonType: type, position: pos, stats: { points: pts, minutes: min } });
const dates = ["2025-03-01", "2025-03-03", "2025-03-05", "2025-03-07", "2025-03-09", "2025-03-11"];
const rows = [
  ...dates.map((d, i) => g("Ace Guard", 2024, d, [10, 20, 30, 25, 15, 35][i])),
  ...dates.map((d) => g("Big Center", 2024, d, 12, "C")),
  g("Ace Guard", 2024, "2025-04-20", 50, "G", "Playoffs"),          // playoffs ignored
  g("Old Timer", 2024, "2025-01-05", 40, "F"),                       // stale (> 21 days before newest)
  ...dates.slice(0, 5).map((d) => g("Wing Two", 2024, d, 22, "G-F")),
];

// 1) Order by date, newest first; playoffs excluded; before-date cut is strict.
const a = buildTrendGrid(rows, { sport: "nba", stat: "points", season: 2025, games: 5, beforeDate: "2025-03-11" });
const ace = a.rows.find((r) => r.player === "Ace Guard");
assert.deepEqual(ace.values, [15, 25, 30, 20, 10]);
assert.equal(ace.hits[20], 0.6);
assert.equal(ace.avgMinutes, 34);

// 2) Season fallback: no 2025-26 games yet, so last season is used and flagged.
assert.equal(a.windowSeasonFallback, true);

// 3) Stale players dropped; position filter matches hyphenated positions.
assert.ok(!a.rows.some((r) => r.player === "Old Timer"));
const f = buildTrendGrid(rows, { sport: "nba", stat: "points", season: 2025, games: 5, positions: ["F"] });
assert.deepEqual(f.rows.map((r) => r.player), ["Wing Two"]);

// 4) Once the new season has games, players without one are dropped.
const rows2 = [...rows, g("Ace Guard", 2025, "2025-10-22", 28)];
const b = buildTrendGrid(rows2, { sport: "nba", stat: "points", season: 2025, games: 5, minGames: 1 });
assert.equal(b.windowSeasonFallback, false);
assert.deepEqual(b.rows.map((r) => r.player), ["Ace Guard"]);
assert.equal(b.rows[0].values[0], 28);

// 5) Pasted lines parse with aliases; bad rows are reported, not guessed.
const { ok, bad } = parseLinesText("Ace Guard, pts, 24.5\nBig Center, reb, 9.5\nNobody, dunks, 2.5\nBroken line");
assert.deepEqual(ok, [{ player: "Ace Guard", stat: "points", line: 24.5 }, { player: "Big Center", stat: "rebounds", line: 9.5 }]);
assert.equal(bad.length, 2);
assert.deepEqual(linesFromList(ok, "points"), { "ace guard": 24.5 });

console.log("nba trends tests passed");
