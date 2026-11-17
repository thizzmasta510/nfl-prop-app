// NFL defense vs position (src/nfl_defense.js): walk-forward test.
//
//   node backtest/nfl_defense_backtest.mjs --history backtest/player-stats-history.json --games <games.csv> [--logs trend-logs.json]
//
// --games: nflverse schedule file (github.com/nflverse/nfldata, data/games.csv); it supplies each team's opponent by week.
// --logs:  the app's weekly logs; adds the current season and each player's listed position
//          (WR / TE). Receivers with no listed position are grouped together as "REC".
//
// For every player-week (weeks 1-18, 2+ earlier games that season): Proj from games before
// that week, then the same projection with the defense factor from nflDefenseTable(), which
// only sees player-games from earlier weeks (and last season at reduced weight). Scored at
// receptions 1..10, yards 10..120, pass yards 150..350, rush attempts 5..25 where Proj is
// 3-97%. Prints log loss before and after per market and season, for all players and for
// players with a regular role (4+ targets, 8+ carries or 20+ pass attempts a game).
// The first season in the file is history only; the second supplies last-season factors.
import fs from "node:fs";
import { nflOpportunityProjection, nflProbAtLeast } from "../src/nfl_opportunity.js";
import { nflDefenseTable, nflDefGroup, nflDefenseOpts, NFL_DEF_STATS, NFL_DEF_CFG } from "../src/nfl_defense.js";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2), arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!arg("history") || !arg("games")) { console.error("usage: --history <player-stats-history.json> --games <games.csv> [--logs trend-logs.json]"); process.exit(1); }
let hist = JSON.parse(fs.readFileSync(arg("history"), "utf8")).players; const posOf = new Map();
if (arg("logs")) { const lg = JSON.parse(fs.readFileSync(arg("logs"), "utf8")), cur = Number(lg.season);
  hist = hist.filter((r) => Number(r.season) !== cur).concat(lg.players.filter((r) => Number(r.season) === cur));
  for (const r of lg.players) if (r.position) posOf.set(r.norm || normalizeName(r.name), r.position); }
const oppOf = new Map();
for (const l of fs.readFileSync(arg("games"), "utf8").split("\n").slice(1)) { const c = l.split(","); if (c[2] !== "REG") continue; oppOf.set(`${c[1]}|${+c[3]}|${c[7]}`, c[9]); oppOf.set(`${c[1]}|${+c[3]}|${c[9]}`, c[7]); }
const bySeason = new Map();
for (const r of hist) { if (Number(r.week) > 18 || !r.stats) continue; const k = `${r.norm || normalizeName(r.name)}|${r.season}`; (bySeason.get(k) || bySeason.set(k, []).get(k)).push(r); }
for (const l of bySeason.values()) l.sort((a, b) => a.week - b.week);
const seasons = [...new Set(hist.map((r) => Number(r.season)))].sort();
const VOLK = ["targets", "receptions", "receiving_yards", "carries", "rushing_yards", "attempts", "completions", "passing_yards"];
const prevTotals = (norm, season) => { const l = bySeason.get(`${norm}|${season - 1}`) || []; if (!l.length) return null; const t = { games: l.length }; for (const k of VOLK) t[k] = l.reduce((a, r) => a + (Number(r.stats[k]) || 0), 0); return t; };
const RUNGS = { receptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], receiving_yards: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120], rushing_yards: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120], carries: [5, 8, 10, 12, 15, 18, 20, 25], passing_yards: [150, 175, 200, 225, 250, 275, 300, 325, 350] };
const VOL = { receptions: "targets", receiving_yards: "targets", rushing_yards: "carries", carries: "carries", passing_yards: "attempts" }, REGULAR = { targets: 4, carries: 8, attempts: 20 };
const rows = [];
for (const [key, list] of bySeason) {
  const [norm, se] = key.split("|"), season = Number(se); if (season === seasons[0]) continue;
  for (const t of list) {
    const prior = list.filter((r) => r.week < t.week); if (prior.length < NFL_DEF_CFG.minPriorGames) continue;
    const opp = oppOf.get(`${season}|${t.week}|${t.team}`); if (!opp) continue;
    const games = prior.slice().reverse().map((r) => r.stats), prev = prevTotals(norm, season);
    for (const stat of NFL_DEF_STATS) { const o = nflOpportunityProjection(games, stat, prev, { meanOnly: true }); if (!o) continue;
      const avg = games.reduce((a, g) => a + (Number(g[VOL[stat]]) || 0), 0) / games.length;
      rows.push({ season, week: t.week, opp, stat, group: nflDefGroup(o.role, posOf.get(norm)), mean: o.mean, actual: Number(t.stats[stat]) || 0, games, prev, regular: avg >= REGULAR[VOL[stat]] }); }
  }
}
const table = nflDefenseTable(rows);
const ll = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
const acc = {}, fs_ = [];
for (const r of rows) {
  if (r.season < seasons[2]) continue;
  const f = table.factor(r.season, r.week, r.opp, r.group, r.stat); fs_.push(f);
  const base = nflOpportunityProjection(r.games, r.stat, r.prev), adj = nflOpportunityProjection(r.games, r.stat, r.prev, nflDefenseOpts(r.stat, f));
  for (const k of RUNGS[r.stat]) { const p = nflProbAtLeast(k, base); if (!(p > 0.03 && p < 0.97)) continue; const y = r.actual >= k ? 1 : 0;
    for (const sub of r.regular ? ["all", "regular"] : ["all"]) { const a = (acc[`${r.stat}|${sub}|${r.season}`] ||= { n: 0, b: 0, a: 0 }); a.n++; a.b += ll(p, y); a.a += ll(nflProbAtLeast(k, adj), y); } }
}
fs_.sort((a, b) => a - b);
console.log(`${rows.length} player-game rows; factor applied: 5th pct ${fs_[Math.floor(0.05 * fs_.length)].toFixed(3)}, median ${fs_[fs_.length >> 1].toFixed(3)}, 95th pct ${fs_[Math.floor(0.95 * fs_.length)].toFixed(3)}\n`);
console.log("Log loss, Proj -> Proj with the defense factor (walk-forward):");
const tot = {};
for (const [k, a] of Object.entries(acc).sort()) { const [stat, sub, season] = k.split("|");
  console.log(`  ${stat.padEnd(15)} ${sub.padEnd(7)} ${season}  n ${String(a.n).padStart(6)}  ${(a.b / a.n).toFixed(4)} -> ${(a.a / a.n).toFixed(4)}  (${((a.a - a.b) / a.n >= 0 ? "+" : "") + ((a.a - a.b) / a.n).toFixed(4)})`);
  const t = (tot[`${stat}|${sub}`] ||= { n: 0, b: 0, a: 0, better: 0, cells: 0 }); t.n += a.n; t.b += a.b; t.a += a.a; t.cells++; if (a.a < a.b) t.better++; }
console.log("\nAll test seasons together:");
for (const [k, t] of Object.entries(tot).sort()) console.log(`  ${k.padEnd(24)} ${(t.b / t.n).toFixed(4)} -> ${(t.a / t.n).toFixed(4)}  (${((t.a - t.b) / t.n >= 0 ? "+" : "") + ((t.a - t.b) / t.n).toFixed(4)}; better in ${t.better} of ${t.cells} seasons)`);
