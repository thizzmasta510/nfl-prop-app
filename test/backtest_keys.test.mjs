// node test/backtest_keys.test.mjs : the backtest keys NFL and NBA games consistently between
// props (ISO kickoff timestamps) and history files (season/week or local game date). Review F3/F8.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-"));
const run = (args) => execFileSync(process.execPath, ["backtest/trend_backtest.mjs", ...args, "--boot", "50"], { encoding: "utf8" });
const graded = (out) => Number(/Graded props: (\d+)/.exec(out)[1]);

// NBA: a 7:30 PM ET tip on Jan 14 is "2026-01-15T00:30:00Z"; the history row says date "2026-01-14".
// 3 earlier games + the graded game; with --games 3 the graded prop must see exactly the 3 earlier games.
const days = ["2026-01-08", "2026-01-10", "2026-01-12", "2026-01-14"];
const props = days.map((d, i) => ({ eventID: "e" + i, startsAt: new Date(Date.parse(d + "T00:30:00Z") + 86400000).toISOString(),
  name: "Hand Built", stat: "points", close: 20.5, overCloseOdds: -110, underCloseOdds: -110, actual: [25, 25, 25, 10][i] }));
const hist = days.map((d, i) => ({ name: "Hand Built", season: 2025, date: d, seasonType: "Regular Season", stats: { points: [25, 25, 25, 10][i] } }));
fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify({ rows: props }));
fs.writeFileSync(path.join(dir, "h.json"), JSON.stringify({ players: hist }));
const nba = run(["--league", "nba", "--props", path.join(dir, "p.json"), "--history", path.join(dir, "h.json"), "--games", "3"]);
assert.equal(graded(nba), 1, "only the 4th game has 3 prior games; same-day history row must not leak in");

// NFL: September 2026 games must key into season 2026 (not 2025) so they sort after 2025 week 17.
const nflProps = [
  { eventID: "a", startsAt: "2025-09-05T00:20:00Z", name: "Nfl Guy", stat: "receiving_receptions", close: 4.5, overCloseOdds: -110, underCloseOdds: -110, actual: 5 },
  { eventID: "b", startsAt: "2025-12-28T18:00:00Z", name: "Nfl Guy", stat: "receiving_receptions", close: 4.5, overCloseOdds: -110, underCloseOdds: -110, actual: 6 },
  { eventID: "c", startsAt: "2026-09-10T00:20:00Z", name: "Nfl Guy", stat: "receiving_receptions", close: 4.5, overCloseOdds: -110, underCloseOdds: -110, actual: 3 },
  { eventID: "d", startsAt: "2026-09-20T17:00:00Z", name: "Nfl Guy", stat: "receiving_receptions", close: 4.5, overCloseOdds: -110, underCloseOdds: -110, actual: 7 },
];
fs.writeFileSync(path.join(dir, "n.json"), JSON.stringify({ rows: nflProps }));
const nfl = run(["--props", path.join(dir, "n.json"), "--games", "3"]);
assert.equal(graded(nfl), 1, "only the Sep 20 2026 game has 3 earlier games (2025 W1, 2025 W17, 2026 W1)");
console.log("backtest key tests passed");
