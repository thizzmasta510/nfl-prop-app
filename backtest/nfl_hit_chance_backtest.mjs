// NFL hit chance (src/hit_chance.js): fit and walk-forward test.
//
//   node backtest/nfl_hit_chance_backtest.mjs --history backtest/player-stats-history.json [--logs trend-logs.json] [--check]
//
// For every player-week (weeks 1-18) with 2+ earlier games that season, and every rung
// (receptions 1..10, receiving / rushing yards 10..120, passing yards 150..350, rush
// attempts 5..25) where Proj is between 3% and 97%: Proj from games before that week
// (no game-script, matchup or injury inputs), then nflHitFeatures() (the app's own
// function) from his last 10 games across seasons. A logistic fit per stat, trained on
// earlier seasons and scored on the next. "Regular role" = season average of 4+ targets,
// 8+ carries or 20+ pass attempts (closer to the players Kalshi lists).
// Prints log loss before / after, calibration, and the coefficients fit on all seasons.
// The app uses it only for the markets where regular players improved (see NFL_HIT_COEF).
// --check exits 1 if those differ from NFL_HIT_COEF by more than 0.02. No prices in it.
import fs from "node:fs";
import { nflOpportunityProjection, nflProbAtLeast } from "../src/nfl_opportunity.js";
import { nflHitFeatures, NFL_HIT_COEF, NFL_HIT_VOLUME } from "../src/hit_chance.js";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!arg("history")) { console.error("usage: --history <player-stats-history.json> [--logs trend-logs.json] [--check]"); process.exit(1); }
let hist = JSON.parse(fs.readFileSync(arg("history"), "utf8")).players;
if (arg("logs")) { const lg = JSON.parse(fs.readFileSync(arg("logs"), "utf8")), cur = Number(lg.season);
  hist = hist.filter((r) => Number(r.season) !== cur).concat(lg.players.filter((r) => Number(r.season) === cur)); }
const bySeason = new Map(), all = new Map();
for (const r of hist) { if (Number(r.week) > 18 || !r.stats) continue; const n = r.norm || normalizeName(r.name), k = `${n}|${r.season}`;
  (bySeason.get(k) || bySeason.set(k, []).get(k)).push(r); (all.get(n) || all.set(n, []).get(n)).push(r); }
for (const l of bySeason.values()) l.sort((a, b) => a.week - b.week);
for (const l of all.values()) l.sort((a, b) => (b.season - a.season) || (b.week - a.week));
const VOLK = ["targets", "receptions", "receiving_yards", "carries", "rushing_yards", "attempts", "completions", "passing_yards"];
const prevTotals = (norm, season) => { const l = bySeason.get(`${norm}|${season - 1}`) || []; if (!l.length) return null;
  const t = { games: l.length }; for (const k of VOLK) t[k] = l.reduce((a, r) => a + (Number(r.stats[k]) || 0), 0); return t; };
const RUNGS = { receptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], receiving_yards: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120], rushing_yards: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120],
  carries: [5, 8, 10, 12, 15, 18, 20, 25], passing_yards: [150, 175, 200, 225, 250, 275, 300, 325, 350] };
const REGULAR = { targets: 4, carries: 8, attempts: 20 };
const STATS = Object.keys(RUNGS), seasons = [...new Set(hist.map((r) => Number(r.season)))].sort();
const rows = Object.fromEntries(STATS.map((s) => [s, []]));
for (const [key, list] of bySeason) {
  const [norm, se] = key.split("|"), season = Number(se);
  if (season === seasons[0]) continue;                         // first season is history only
  for (const t of list) {
    const prior = list.filter((r) => r.week < t.week); if (prior.length < 2) continue;
    const games = prior.slice().reverse().map((r) => r.stats);
    const recent = all.get(norm).filter((r) => r.season < season || (r.season === season && r.week < t.week)).map((r) => r.stats);
    for (const stat of STATS) {
      const op = nflOpportunityProjection(games, stat, prevTotals(norm, season)); if (!op) continue;
      const vk = NFL_HIT_VOLUME[stat], avg = games.reduce((a, g) => a + (Number(g[vk]) || 0), 0) / games.length;
      for (const k of RUNGS[stat]) {
        const p = nflProbAtLeast(k, op); if (!(p > 0.03 && p < 0.97)) continue;
        const f = nflHitFeatures({ pOver: p, strike: k, stat, games, recent });
        rows[stat].push({ season, y: (Number(t.stats[stat]) || 0) >= k ? 1 : 0, p, x: f.x, regular: avg >= REGULAR[vk] });
      }
    }
  }
}
function fit(R) {
  const d = R[0].x.length; let b = new Array(d).fill(0); b[1] = 1;
  for (let it = 0; it < 30; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (const r of R) { let z = 0; for (let j = 0; j < d; j++) z += b[j] * r.x[j]; const p = 1 / (1 + Math.exp(-z)), w = p * (1 - p);
      for (let j = 0; j < d; j++) { g[j] += (r.y - p) * r.x[j]; for (let k = 0; k < d; k++) H[j][k] += w * r.x[j] * r.x[k]; } }
    const M = H.map((r, i) => [...r, g[i]]);
    for (let c = 0; c < d; c++) { let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < d; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= d; k++) M[r][k] -= f * M[c][k]; } }
    let mx = 0; for (let j = 0; j < d; j++) { const s = M[j][d] / M[j][j]; b[j] += s; mx = Math.max(mx, Math.abs(s)); }
    if (mx < 1e-7) break;
  }
  return b;
}
const predict = (b, x) => { let z = 0; for (let j = 0; j < b.length; j++) z += b[j] * x[j]; return 1 / (1 + Math.exp(-z)); };
const ll = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log("Log loss, walk-forward (train on earlier seasons, score the next): all players, then players with a regular role");
const tot = { n: 0, b: 0, a: 0, rn: 0, rb: 0, ra: 0 }, cal = new Map(); let better = 0, cells = 0;
for (const stat of STATS) for (const te of seasons.slice(2)) {
  const train = rows[stat].filter((r) => r.season < te), test = rows[stat].filter((r) => r.season === te); if (!train.length || !test.length) continue;
  const b = fit(train), reg = test.filter((r) => r.regular);
  const B = mean(test.map((r) => ll(r.p, r.y))), A = mean(test.map((r) => ll(predict(b, r.x), r.y))), RB = mean(reg.map((r) => ll(r.p, r.y))), RA = mean(reg.map((r) => ll(predict(b, r.x), r.y)));
  console.log(`  ${stat.padEnd(15)} ${te}  n ${String(test.length).padStart(6)}  Proj ${B.toFixed(4)} -> ${A.toFixed(4)}   regular n ${String(reg.length).padStart(6)}  ${RB.toFixed(4)} -> ${RA.toFixed(4)}`);
  cells++; if (A < B) better++;
  tot.n += test.length; tot.b += B * test.length; tot.a += A * test.length; tot.rn += reg.length; tot.rb += RB * reg.length; tot.ra += RA * reg.length;
  for (const r of test) for (const [side, p, y] of [["Over", predict(b, r.x), r.y], ["Under", 1 - predict(b, r.x), 1 - r.y]]) {
    if (p < 0.66) continue; const key = `${side}|${p < 0.75 ? "66-75" : p < 0.85 ? "75-85" : "85+"}`;
    const c = cal.get(key) || cal.set(key, { n: 0, p: 0, y: 0 }).get(key); c.n++; c.p += p; c.y += y; }
}
console.log(`  all five markets: ${(tot.b / tot.n).toFixed(4)} -> ${(tot.a / tot.n).toFixed(4)}; regular role ${(tot.rb / tot.rn).toFixed(4)} -> ${(tot.ra / tot.rn).toFixed(4)}; better in ${better} of ${cells} stat-seasons\n`);
console.log("Calibration on the test seasons (stated -> actual):");
for (const [k, c] of [...cal].sort()) console.log(`  ${k.padEnd(12)} n ${String(c.n).padStart(7)}  ${(100 * c.p / c.n).toFixed(1)}% -> ${(100 * c.y / c.n).toFixed(1)}%`);
console.log("\nCoefficients fit on all graded seasons (paste into NFL_HIT_COEF):"); let worst = 0;
for (const stat of STATS) { const b = fit(rows[stat]).map((v) => Math.round(v * 1000) / 1000); const pin = NFL_HIT_COEF[stat]; if (pin) b.forEach((v, j) => { worst = Math.max(worst, Math.abs(v - pin[j])); });
  console.log(`  ${stat}: [${b.join(", ")}],${pin ? "" : "   (not used)"}`); }
console.log(`Largest difference from the pinned NFL_HIT_COEF: ${worst.toFixed(3)}`);
if (args.includes("--check") && worst > 0.02) { console.error("NFL_HIT_COEF is out of date"); process.exit(1); }
