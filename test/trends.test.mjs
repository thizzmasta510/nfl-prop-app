// node test/trends.test.mjs  -> exits non-zero on failure
import assert from "node:assert/strict";
import { buildTrendGrid, gameLogs, linesFromProps } from "../src/trends.js";
import { propTypeToStatKey } from "../src/model.js";

const mk = (name, season, week, rec, pos = "WR", team = "AAA") => ({ name, team, season, week, position: pos, stats: { receptions: rec } });
const rows = [
  ...[1, 2, 3, 4, 5, 6].map((w, i) => mk("Alpha One", 2026, w, [3, 4, 5, 6, 7, 8][i])),
  ...[1, 2, 3, 4, 5, 6].map((w) => mk("Beta Two", 2026, w, 2)),
  mk("Gamma Three", 2025, 17, 9), mk("Gamma Three", 2025, 18, 9),          // no 2026 game: dropped
  mk("Delta Four", 2026, 6, 5, "RB"),                                     // RB: filtered by default positions
  mk("Alpha One", 2026, 19, 99),                                          // playoff week: ignored
];

// 1) No lookahead: as of week 6, week 6 is excluded.
const g = buildTrendGrid(rows, { stat: "receptions", season: 2026, beforeWeek: 6, games: 5 });
const a = g.rows.find((r) => r.player === "Alpha One");
assert.deepEqual(a.values, [7, 6, 5, 4, 3], "newest first, week 6 excluded");
assert.equal(a.hits[5], 0.6);
assert.equal(a.hits[3], 1);
assert.equal(a.hits[7], 0.2);

// 2) Stale players (no current-season game) and wrong positions are dropped.
assert.ok(!g.rows.some((r) => r.player === "Gamma Three"));
assert.ok(!g.rows.some((r) => r.player === "Delta Four"));

// 3) Sorting by the chosen cutoff, buckets rank within column.
assert.equal(g.rows[0].player, "Alpha One");
assert.equal(g.rows[0].bucket[5], 4);
assert.equal(g.rows[1].bucket[5], 0);

// 4) Cross-season window fills from last season.
const rows2 = [mk("Eps Five", 2025, 17, 4), mk("Eps Five", 2025, 18, 4), mk("Eps Five", 2026, 1, 6), mk("Eps Five", 2026, 2, 6), mk("Eps Five", 2026, 3, 6)];
const g2 = buildTrendGrid(rows2, { stat: "receptions", season: 2026, games: 5 });
assert.deepEqual(g2.rows[0].weeks, ["2026-W3", "2026-W2", "2026-W1", "2025-W18", "2025-W17"]);

// 5) Lines from entered props, over-line rate uses strict >.
const lines = linesFromProps([{ player: "Alpha One", propType: "Receptions", line: 4.5 }, { player: "Alpha One", propType: "Rec Yds", line: 60.5 }], "receptions", propTypeToStatKey);
assert.deepEqual(lines, { "alpha one": 4.5 });
const g3 = buildTrendGrid(rows, { stat: "receptions", season: 2026, beforeWeek: 6, lines });
assert.equal(g3.rows.find((r) => r.player === "Alpha One").overLineRate, 0.6);

// 6) Min games: a player with fewer games than required is excluded.
const g4 = buildTrendGrid(rows, { stat: "receptions", season: 2026, beforeWeek: 3, games: 5 });
assert.equal(g4.rows.length, 0);
const g5 = buildTrendGrid(rows, { stat: "receptions", season: 2026, beforeWeek: 3, games: 5, minGames: 2 });
assert.equal(g5.rows.length, 2);

// 7) Review A1: unsorted input gives the same window, team and staleness result.
const shuffled = [mk("Zed", 2026, 3, 9, "WR", "NEW"), mk("Zed", 2025, 18, 1, "WR", "OLD"), mk("Zed", 2026, 1, 7, "WR", "NEW"), mk("Zed", 2026, 2, 8, "WR", "NEW")];
const gz = buildTrendGrid(shuffled, { stat: "receptions", season: 2026, games: 4 });
assert.deepEqual(gz.rows[0].values, [9, 8, 7, 1]);
assert.equal(gz.rows[0].team, "NEW");

// 8) Review A2: rows without a season field (player-stats.json) count as the current season.
const noSeason = [1, 2, 3].map((w) => ({ name: "Cur Player", team: "AAA", week: w, position: "WR", stats: { receptions: 5 } }));
const gn = buildTrendGrid([...noSeason, mk("Gone Guy", 2025, 17, 9), mk("Gone Guy", 2025, 18, 9)], { stat: "receptions", season: 2026, games: 2 });
assert.deepEqual(gn.rows.map((r) => r.player), ["Cur Player"]);

// 9) Review A3: one row -> neutral bucket; equal values -> same bucket.
const one = buildTrendGrid(noSeason, { stat: "receptions", season: 2026, games: 3 });
assert.equal(one.rows[0].bucket[5], 2);
const eq = buildTrendGrid(["A", "B", "C"].flatMap((n) => [1, 2].map((w) => ({ name: n, team: "T", week: w, position: "WR", stats: { receptions: 5 } }))), { stat: "receptions", season: 2026, games: 2 });
assert.equal(new Set(eq.rows.map((r) => r.bucket[5])).size, 1);

// 10) Review C15: empty-string and non-numeric stats are skipped, not counted as 0 / NaN.
const dirty = [1, 2, 3, 4].map((w) => ({ name: "Dirty Data", team: "T", week: w, position: "WR", stats: { receptions: [5, "", "abc", 6][w - 1] } }));
dirty.push({ name: "Dirty Data", team: "T", week: 5, position: "WR", stats: { receptions: null } }); // review F2: null must not become 0
const gd = buildTrendGrid(dirty, { stat: "receptions", season: 2026, games: 3, minGames: 1 });
assert.deepEqual(gd.rows[0].values, [6, 5]);

// 11) Trend grades: describe the record vs the entered line; caps keep thin or mixed records modest.
{
  const { buildTrendGrid: G } = await import("../src/trends.js");
  const mkv = (n, vals) => vals.map((v, i) => ({ name: n, team: "T", week: i + 1, position: "WR", stats: { receptions: v } }));
  const rows11 = [...mkv("Five Above", [7, 8, 6, 9, 7]), ...mkv("Barely", [6, 6, 6, 6, 6]), ...mkv("Below", [2, 3, 1, 2, 3]),
    ...mkv("Mixed", [4, 6, 5, 6, 4]), ...mkv("No Line", [9, 9, 9, 9, 9]), ...mkv("Thin", [9, 9, 9])];
  const lines11 = { "five above": 5.5, "barely": 5.5, "below": 5.5, "mixed": 5.5, "thin": 5.5 };
  const g11 = G(rows11, { stat: "receptions", season: 2026, games: 5, minGames: 3, lines: lines11, sortBy: "grade" });
  const by = Object.fromEntries(g11.rows.map((r) => [r.player, r.grade]));
  assert.equal(by["No Line"], null, "no line, no grade");
  assert.equal(by["Below"].direction, "below");
  assert.equal(by["Mixed"].letter <= "B" || ["B", "B-", "C+", "C"].includes(by["Mixed"].letter), true);
  assert.ok(["B", "B-", "C+", "C"].includes(by["Mixed"].letter), "3 of 5 is capped at B");
  assert.ok(!["A+", "A", "A-"].includes(by["Thin"].letter), "fewer than 5 games capped at B+");
  assert.equal(g11.sortBy, "grade");
  assert.ok(g11.gradeNote.includes("not a probability, a prediction or a pick"));
}

console.log("trends tests passed");
