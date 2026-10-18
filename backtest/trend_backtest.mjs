#!/usr/bin/env node
/**
 * Does a last-N hit rate (the Tendency Matrix) tell you anything the closing line doesn't?
 *
 *   node backtest/trend_backtest.mjs --props sgo_backfill.json [--history player-stats-history.json] [--games 5]
 *   node backtest/trend_backtest.mjs --league nba --props sgo_backfill_nba.json --games 10
 *       (NBA: logs come from the backfill's actuals, ordered by game date; statIDs per sgo_backfill.mjs --discover)
 *
 * For every graded prop in the SportsGameOdds backfill (closing line, closing
 * over/under prices, actual result), it computes the player's hit rate over that
 * same line in his previous N regular-season games, using only games before
 * kickoff (no lookahead), and compares it to the market's no-vig probability.
 *
 * Game logs come from --history when given (full box scores). Without it they are
 * built from the backfill's own `actual` values, which only include games where a
 * prop was posted, so a player's "last 5" can skip games. The output says which.
 *
 * Reports:
 *   1. Brier score: market vs raw hit rate vs shrunk hit rate (coin flip = 0.25).
 *   2. Calibration by hit-rate bucket: actual over rate vs what the market said.
 *   3. Does the hit rate add anything to the market? Logistic fit of
 *      outcome ~ logit(market) + (hitRate - 0.5), game-clustered bootstrap CI.
 *   4. Simple selection rules (e.g. bet Over when 5/5 cleared the line) at the
 *      real closing price: hit rate, ROI, 95% CI.
 */
import fs from "node:fs";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const arg = (n, f = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : f; };
const PROPS = arg("props"), HIST = arg("history");
const N = Number(arg("games", 5)), MIN = Number(arg("minGames", N));
const SEED = Number(arg("seed", 7)), B = Number(arg("boot", 1000));
// Zero results. In the SportsGameOdds backfill ~18-19% of receiving rows have actual = 0.
// Checked Oct 18 2026: the zeros sit almost entirely on fringe lines (60% of 0.5-reception
// lines, ~1% of 5.5+), so most are real zero games, not DNPs. Dropping them all
// (--dropZeros) removes real Unders from low lines and produced a spurious positive
// hit-rate coefficient (0.34, CI 0.12-0.58); restricting to starter-level lines
// (--starters) with or without zeros gives about -0.08 to -0.10 (CI spans 0).
// Default keeps zeros. Use --starters for the cleanest check.
const KEEP_ZEROS = !args.includes("--dropZeros");
const ZERO_OK = new Set(["passing_tds", "rushing_tds", "receiving_tds", "interceptions", "steals", "blocks", "threes", "turnovers"]);
// --starters: grade only lines set for real roles, where a 0 is rare unless the player sat.
// This is the cleanest check, because it doesn't depend on the zero rule.
const STARTERS = args.includes("--starters");
const STARTER_MIN = { receptions: 2.5, receiving_yards: 25.5, rushing_yards: 25.5, carries: 8.5, passing_yards: 150.5, attempts: 20.5, completions: 12.5, passing_tds: 0.5,
  points: 9.5, rebounds: 3.5, assists: 2.5, pra: 15.5, pr: 12.5, pa: 12.5, ra: 5.5 };
const dnpSuspect = (stat, v) => !KEEP_ZEROS && !HIST && Number(v) === 0 && !ZERO_OK.has(stat);
const OUT = arg("out", null);
const LEAGUE = String(arg("league", "nfl")).toLowerCase();
if (!PROPS) { console.error("Usage: node trend_backtest.mjs --props sgo_backfill.json [--history player-stats-history.json] [--games 5]"); process.exit(1); }

const SGO = LEAGUE === "nba" ? {
  // UNVERIFIED SGO NBA statIDs: confirm with `node backtest/sgo_backfill.mjs --league NBA --discover`.
  points: "points", rebounds: "rebounds", assists: "assists", threePointersMade: "threes",
  "points+rebounds+assists": "pra", "points+rebounds": "pr", "points+assists": "pa", "rebounds+assists": "ra",
  steals: "steals", blocks: "blocks", turnovers: "turnovers",
} : {
  receiving_receptions: "receptions", receiving_yards: "receiving_yards", rushing_yards: "rushing_yards",
  passing_yards: "passing_yards", rushing_attempts: "carries", passing_attempts: "attempts",
  passing_completions: "completions", passing_touchdowns: "passing_tds",
};
const props = JSON.parse(fs.readFileSync(PROPS, "utf8")).rows;

// ---- week mapping (same convention as market_vs_model.mjs)
// NFL seasons roll over in March; NBA seasons in October (review C21). NBA ordering uses the date, so this only affects labels.
const seasonOf = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return LEAGUE === "nba" ? (m >= 10 ? y : y - 1) : (m >= 3 ? y : y - 1); };
const anchor = {};
for (const p of props) { const s = seasonOf(p.startsAt), t = Date.parse(p.startsAt); if (!(s in anchor) || t < anchor[s]) anchor[s] = t; }
const weekOfNfl = (iso) => Math.floor((Date.parse(iso) - (anchor[seasonOf(iso)] - 1.5 * 86400000)) / (7 * 86400000)) + 1;
const ord = (season, week) => (LEAGUE === "nba" ? week : season * 100 + week);
// NBA: no weeks. "week" becomes the ET calendar date (YYYYMMDD), so ord() still sorts correctly and the
// week > 18 regular-season filter is skipped. Playoff games are NOT separated for the NBA (SGO has no flag here).
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDate = (iso) => Number(etFmt.format(new Date(iso)).replace(/-/g, ""));
const weekOf = LEAGUE === "nba" ? etDate : weekOfNfl;
const isReg = (w) => LEAGUE === "nba" || w <= 18;

// ---- game logs: norm|stat -> [{k, v}] ascending
const logs = new Map();
const push = (norm, stat, k, v) => { const key = `${norm}|${stat}`; if (!logs.has(key)) logs.set(key, new Map()); logs.get(key).set(k, v); };
let source;
if (HIST) {
  source = "history (full box scores)";
  for (const r of JSON.parse(fs.readFileSync(HIST, "utf8")).players) {
    // NBA history rows (nba-trend-logs.json) have `date`, not `week` (review S6).
    let k;
    if (LEAGUE === "nba") {
      if (r.seasonType && !String(r.seasonType).toLowerCase().startsWith("regular")) continue;
      k = Number(String(r.date || "").replace(/-/g, ""));
    } else {
      if (!(Number(r.week) >= 1 && Number(r.week) <= 18)) continue;
      k = ord(Number(r.season), Number(r.week));
    }
    if (!Number.isFinite(k)) continue;
    const norm = r.norm || normalizeName(r.name);
    for (const stat of Object.values(SGO)) {
      const v = r.stats ? Number(r.stats[stat]) : NaN;
      if (r.stats && r.stats[stat] !== undefined && r.stats[stat] !== null && r.stats[stat] !== "" && Number.isFinite(v)) push(norm, stat, k, v);
    }
  }
} else {
  source = "backfill actuals (only games where a prop was posted)";
  for (const p of props) {
    const stat = SGO[p.stat]; if (!stat || p.actual === null || p.actual === undefined) continue;
    const w = weekOf(p.startsAt); if (!isReg(w)) continue;
    if (dnpSuspect(stat, p.actual)) continue;
    push(normalizeName(p.name || ""), stat, ord(seasonOf(p.startsAt), w), Number(p.actual));
  }
}
const sortedLogs = new Map([...logs].map(([k, m]) => [k, [...m].map(([kk, v]) => ({ k: kk, v })).sort((a, b) => a.k - b.k)]));

// ---- build graded rows
const imp = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
const payout = (o) => (o > 0 ? o / 100 : 100 / -o);
const skip = { stat: 0, intLine: 0, odds: 0, fewGames: 0, playoff: 0 };
const R = [];
for (const p of props) {
  const stat = SGO[p.stat]; if (!stat) { skip.stat++; continue; }
  if (Number.isInteger(p.close)) { skip.intLine++; continue; }
  if (p.overCloseOdds == null || p.underCloseOdds == null || p.actual == null) { skip.odds++; continue; }
  if (STARTERS && STARTER_MIN[stat] !== undefined && p.close < STARTER_MIN[stat]) { skip.belowStarter = (skip.belowStarter || 0) + 1; continue; }
  if (dnpSuspect(stat, p.actual)) { skip.zeroDnp = (skip.zeroDnp || 0) + 1; continue; }
  const season = seasonOf(p.startsAt), week = weekOf(p.startsAt);
  if (!isReg(week)) { skip.playoff++; continue; }
  const k = ord(season, week);
  const L = sortedLogs.get(`${normalizeName(p.name || "")}|${stat}`) || [];
  const prev = L.filter((g) => g.k < k).slice(-N);
  if (prev.length < MIN) { skip.fewGames++; continue; }
  const h = prev.filter((g) => g.v > p.close).length / prev.length;
  const io = imp(p.overCloseOdds), iu = imp(p.underCloseOdds);
  R.push({ game: p.eventID, stat, season, week, player: p.name, line: p.close, h, n: prev.length,
    pM: io / (io + iu), y: p.actual > p.close ? 1 : 0, oOver: p.overCloseOdds, oUnder: p.underCloseOdds });
}

// ---- helpers
let s = SEED >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const brier = (rows, f) => rows.reduce((a, r) => a + (f(r) - r.y) ** 2, 0) / rows.length;
const logit = (p) => Math.log(p / (1 - p)), sig = (z) => 1 / (1 + Math.exp(-z));
const clip = (p) => Math.min(0.99, Math.max(0.01, p));
const shrink = (r) => (r.h * r.n + 0.5 * 5) / (r.n + 5); // shrink toward 50% with 5 pseudo-games

// logistic y ~ a + b*logit(pM) + c*(h-0.5), Newton's method
function fit(rows) {
  let w = [0, 1, 0];
  for (let it = 0; it < 25; it++) {
    const g = [0, 0, 0], H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const r of rows) {
      const x = [1, logit(clip(r.pM)), r.h - 0.5];
      const p = sig(x[0] * w[0] + x[1] * w[1] + x[2] * w[2]);
      for (let i = 0; i < 3; i++) { g[i] += (r.y - p) * x[i]; for (let j = 0; j < 3; j++) H[i][j] += p * (1 - p) * x[i] * x[j]; }
    }
    for (let i = 0; i < 3; i++) H[i][i] += 1e-6; // tiny ridge: keeps the solve stable on separated resamples (review C8)
    const d = solve3(H, g); w = w.map((v, i) => v + d[i]);
    if (!w.every(Number.isFinite)) return [NaN, NaN, NaN];
    if (Math.max(...d.map(Math.abs)) < 1e-8) break;
  }
  return w;
}
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let mx = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[mx][i])) mx = r;
    [M[i], M[mx]] = [M[mx], M[i]];
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[3] / r[i]);
}
const byGame = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.game)) m.set(r.game, []); m.get(r.game).push(r); } return [...m.values()]; };
function boot(rows, stat) {
  const G = byGame(rows), vals = [];
  for (let b = 0; b < B; b++) { const sample = []; for (let i = 0; i < G.length; i++) sample.push(...G[Math.floor(rnd() * G.length)]); vals.push(stat(sample)); }
  const ok = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (ok.length < vals.length) console.log(`   (bootstrap: ${vals.length - ok.length} of ${vals.length} resamples did not converge and were dropped)`);
  return [ok[Math.floor(0.025 * ok.length)], ok[Math.floor(0.975 * ok.length)]];
}
const roi = (rows, side) => rows.reduce((a, r) => a + ((side === "over" ? r.y : 1 - r.y) ? payout(side === "over" ? r.oOver : r.oUnder) : -1), 0) / rows.length;
const pct = (x) => (100 * x).toFixed(1) + "%";
const f4 = (x) => x.toFixed(4);

// ---- report
console.log(`Tendency Matrix backtest · last ${N} games (min ${MIN}) · logs from ${source}` + (!HIST && !KEEP_ZEROS ? " · zero results on volume stats dropped as likely DNP" : "") + (STARTERS ? " · starter-level lines only" : ""));
console.log(`Graded props: ${R.length} · skipped`, skip);
const report = { source, N, MIN, graded: R.length, skip, byStat: {}, buckets: [], fit: null, rules: [] };

console.log("\n1) Brier score (lower is better; coin flip 0.2500)");
console.log("stat".padEnd(16), "n".padStart(6), "market".padStart(8), "hitRate".padStart(8), "shrunk".padStart(8), "base".padStart(8));
const stats = [...new Set(R.map((r) => r.stat))];
for (const st of [...stats, "ALL"]) {
  const rows = st === "ALL" ? R : R.filter((r) => r.stat === st);
  if (rows.length < 50) continue;
  const base = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  const row = { n: rows.length, market: brier(rows, (r) => r.pM), hitRate: brier(rows, (r) => r.h), shrunk: brier(rows, shrink), base: brier(rows, () => base) };
  report.byStat[st] = row;
  console.log(st.padEnd(16), String(rows.length).padStart(6), f4(row.market).padStart(8), f4(row.hitRate).padStart(8), f4(row.shrunk).padStart(8), f4(row.base).padStart(8));
}

console.log(`\n2) Calibration by hit rate over the line in the last ${N}`);
console.log("hit rate".padEnd(10), "n".padStart(6), "actual over".padStart(12), "market said".padStart(12), "gap".padStart(8));
const levels = [...new Set(R.map((r) => r.h))].sort((a, b) => a - b);
for (const lv of levels) {
  const rows = R.filter((r) => r.h === lv); if (rows.length < 30) continue;
  const act = rows.reduce((a, r) => a + r.y, 0) / rows.length, mk = rows.reduce((a, r) => a + r.pM, 0) / rows.length;
  report.buckets.push({ hitRate: lv, n: rows.length, actualOver: act, marketSaid: mk });
  console.log(pct(lv).padEnd(10), String(rows.length).padStart(6), pct(act).padStart(12), pct(mk).padStart(12), ((act - mk) * 100 >= 0 ? "+" : "") + ((act - mk) * 100).toFixed(1).padStart(6));
}

console.log("\n3) Does the hit rate add anything to the market price?");
const w = fit(R);
const ci = boot(R, (rows) => fit(rows)[2]);
report.fit = { intercept: w[0], marketSlope: w[1], hitRateCoef: w[2], hitRateCI95: ci };
console.log(`   outcome ~ logit(market) + (hitRate-0.5): market slope ${w[1].toFixed(3)}, hit-rate coef ${w[2].toFixed(3)} (95% CI ${ci[0].toFixed(3)} to ${ci[1].toFixed(3)})`);
console.log(`   A CI that spans 0 means no detectable information beyond the closing line.`);

console.log("\n4) Selection rules at the real closing price (flat 1 unit)");
const rules = [
  ["Baseline: Over on every prop", () => true, "over"],
  ["Baseline: Under on every prop", () => true, "under"],
  ["Over when hit rate = 100%", (r) => r.h === 1, "over"],
  ["Over when hit rate >= 80%", (r) => r.h >= 0.8, "over"],
  ["Under when hit rate = 0%", (r) => r.h === 0, "under"],
  ["Under when hit rate <= 20%", (r) => r.h <= 0.2, "under"],
  ["Over when hit rate >= 80% AND market < 55%", (r) => r.h >= 0.8 && r.pM < 0.55, "over"],
  ["Under when hit rate <= 20% AND market > 45%", (r) => r.h <= 0.2 && r.pM > 0.45, "under"],
];
console.log("rule".padEnd(46), "n".padStart(6), "win".padStart(7), "ROI".padStart(8), "95% CI".padStart(18));
for (const [name, f, side] of rules) {
  const rows = R.filter(f); if (rows.length < 30) { console.log(name.padEnd(46), String(rows.length).padStart(6), "  too few"); continue; }
  const win = rows.reduce((a, r) => a + (side === "over" ? r.y : 1 - r.y), 0) / rows.length;
  const r0 = roi(rows, side), c = boot(rows, (x) => roi(x, side));
  report.rules.push({ rule: name, n: rows.length, win, roi: r0, ci95: c });
  console.log(name.padEnd(46), String(rows.length).padStart(6), pct(win).padStart(7), ((r0 >= 0 ? "+" : "") + pct(r0)).padStart(8), `${pct(c[0])} to ${pct(c[1])}`.padStart(18));
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`\nSaved ${OUT}`); }
