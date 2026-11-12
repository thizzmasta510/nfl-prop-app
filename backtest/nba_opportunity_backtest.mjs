// Backtest: opportunity projection (src/nba_opportunity.js) vs the current NBA model
// (src/nba_model.js nbaProjection), walk-forward, no lookahead.
//
//   node backtest/nba_opportunity_backtest.mjs <box file> [--kalshi rows.txt --kalshi-date 2026-11-02] [--min 10] [--history 82] [--no-correction]
//
// <box file>: either nba-history.json from the data job (rows with stats.fga etc.,
// written by compute_nba_logs.py after this update) or a hoopR player-box JSON
// (rows with field_goals_attempted etc.; see backtest/README.md for how to build it).
//
// For every player-game he actually played, with at least --min earlier games:
//   - both models predict P(stat >= k) using ONLY earlier games, no matchup factor
//     (so the test isolates how the mean is built; minutes and spread are shared)
//   - scored at the standard rungs (points 10..40, threes 1..5) where the current
//     model is between 5% and 95%, and at a synthetic line = median of his last 10
// Both models share the minutes projection and the spread, so this answers "given
// the current minutes model, does building the mean from shots and regressed
// efficiency help?", not whether the opportunity model is better end to end.
// Volume uses recent games; efficiency uses all --history games, shrunk.
// Reports log loss and Brier for current / opportunity / 50-50 blend, the paired
// difference with a standard error clustered by player-game, calibration, mean
// error, and the volume-vs-results flags (did "cold" shooters bounce back?).
//
// --kalshi: also score a saved list of real Kalshi rungs ("GAME|stat|Player|N|bid|ask",
// the format the slate tools write) for one date against that night's results,
// with the market's own mid as the benchmark.

import fs from "node:fs";
import { nbaProjection, probAtLeast } from "../src/nba_model.js";
import { opportunityProjection, opportunityMean, LEAGUE, CORRECTION } from "../src/nba_opportunity.js";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MIN = Number(opt("--min", 10));
const OUT = opt("--out", null);
// The live app keeps about 20-30 games per player (20 in the log plus the data job's
// shooting totals); --history 20 scores what the app will actually show.
const HIST = Number(opt("--history", 82));
// The 30 teams in ESPN's codes (hoopR) and the NBA's.
const NBA_TEAMS = new Set("ATL BOS BKN CHA CHI CLE DAL DEN DET GS GSW HOU IND LAC LAL MEM MIA MIL MIN NO NOP NY NYK OKC ORL PHI PHX POR SAC SA SAS TOR UTAH UTA WSH WAS".split(" "));
const CORRECT = !args.includes("--no-correction");   // the app's 14-day scoring correction (points)
if (!file) { console.error("usage: node backtest/nba_opportunity_backtest.mjs <box file> [--kalshi rows.txt --kalshi-date YYYY-MM-DD]"); process.exit(1); }

// ---- load either format into { norm, name, date, minutes, points, threes, fga, fta, fg3a } ----
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = Array.isArray(raw) ? raw : raw.players || [];
const games = [];
for (const r of rows) {
  let g;
  if (r.stats) {
    if (r.seasonType && /pre/i.test(r.seasonType)) continue;
    const s = r.stats;
    g = { name: r.name, date: String(r.date).slice(0, 10), minutes: +s.minutes, points: +s.points, threes: +s.threes,
      fga: s.fga === undefined ? NaN : +s.fga, fta: s.fta === undefined ? NaN : +s.fta, fg3a: s.fg3a === undefined ? NaN : +s.fg3a };
  } else {
    if (r.did_not_play || r.season_type === 1) continue;
    if (!NBA_TEAMS.has(String(r.team_abbreviation || ""))) continue;   // All-Star weekend teams (CHK, SHQ, STARS, WORLD...) are tagged regular season
    g = { name: r.athlete_display_name, date: r.date, minutes: +r.minutes, points: +r.points, threes: +r.three_point_field_goals_made,
      fga: +r.field_goals_attempted, fta: +r.free_throws_attempted, fg3a: +r.three_point_field_goals_attempted };
  }
  if (![g.minutes, g.points, g.threes, g.fga, g.fta, g.fg3a].every(Number.isFinite) || g.minutes <= 0) continue;
  g.norm = normalizeName(g.name);
  games.push(g);
}
const byPlayer = new Map();
for (const g of games) { if (!byPlayer.has(g.norm)) byPlayer.set(g.norm, []); byPlayer.get(g.norm).push(g); }
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));   // newest first
const dates = games.map((g) => g.date).sort();
console.log(`${games.length} player-games with shot data, ${byPlayer.size} players, ${dates[0]} to ${dates[dates.length - 1]}`);
console.log(`Scoring correction (points): ${CORRECT ? "on" : "off"}. Efficiency history: last ${HIST} games. League priors used: points per shooting play ${LEAGUE.pps}, 3P% ${LEAGUE.fg3pct} (from 2025-26; a mild lookahead for 2025-26 targets only)\n`);

const CUTS = { points: [10, 15, 20, 25, 30, 35, 40], threes: [1, 2, 3, 4, 5] };
const EPS = 1e-6;
const ll = (p, y) => -(y ? Math.log(Math.max(EPS, p)) : Math.log(Math.max(EPS, 1 - p)));
const valueOf = (g, stat) => (stat === "points" ? g.points : g.threes);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Scoring correction by date, the same rule as scoringCorrection() in the app: actual vs
// projected over the previous 14 days of games with 10+ earlier games, shrunk.
const dayN = (d) => Date.parse(d + "T00:00:00Z") / 864e5;
const corrCache = {};
function correctionOn(stat, date) {
  if (!CORRECT || !CORRECTION.stats.includes(stat)) return 1;
  if (!corrCache[stat]) {
    const daily = new Map();
    for (const arr of byPlayer.values()) for (let i = 0; i + CORRECTION.minPrior < arr.length; i++) {
      const m = opportunityMean(arr.slice(i + 1, i + 21), stat); if (m === null) continue;
      const d = dayN(arr[i].date), c = daily.get(d) || daily.set(d, { y: 0, m: 0 }).get(d);
      c.y += valueOf(arr[i], stat); c.m += m;
    }
    corrCache[stat] = { daily, byDate: new Map() };
  }
  const C = corrCache[stat], D = dayN(date);
  if (!C.byDate.has(D)) {
    let y = 0, m = 0;
    for (let d = D - CORRECTION.windowDays; d < D; d++) { const c = C.daily.get(d); if (c) { y += c.y; m += c.m; } }
    const K = CORRECTION.priorGames * CORRECTION.typicalMean[stat];
    C.byDate.set(D, (y + K) / (m + K));
  }
  return C.byDate.get(D);
}

function project(prior, stat, date) {
  const base = nbaProjection(prior.slice(0, 20).map((x) => ({ value: valueOf(x, stat), minutes: x.minutes })), 1, stat);
  const opp = opportunityProjection(prior.slice(0, HIST), stat, 1, { scoringAdj: correctionOn(stat, date) });
  return base && opp ? { base, opp } : null;
}

function score(stat, filter = () => true) {
  const recs = [], perGame = [], line = [], flags = {};
  for (const arr of byPlayer.values()) {
    for (let i = 0; i + MIN < arr.length; i++) {
      const target = arr[i];
      if (!filter(target)) continue;
      const prior = arr.slice(i + 1);
      if (prior[0].date >= target.date) throw new Error(`prior game on/after target: ${target.name} ${target.date}`);
      const pr = project(prior, stat, target.date);
      if (!pr) continue;
      const y = valueOf(target, stat);
      let dLL = 0, n = 0;
      for (const k of CUTS[stat]) {
        const pb = probAtLeast(k, pr.base.mean, pr.base.dispersion, { clamp: false });
        if (pb <= 0.05 || pb >= 0.95) continue;
        const po = probAtLeast(k, pr.opp.mean, pr.opp.dispersion, { clamp: false });
        const pm = (pb + po) / 2, hit = y >= k ? 1 : 0;
        recs.push({ y: hit, pb, po, pm });
        dLL += ll(po, hit) - ll(pb, hit); n++;
      }
      if (n) perGame.push(dLL);
      // synthetic line: median of last 10, Over = at least floor(median) + 1
      const k = Math.floor(median(prior.slice(0, 10).map((x) => valueOf(x, stat)))) + 1;
      const pb = probAtLeast(k, pr.base.mean, pr.base.dispersion, { clamp: false });
      const po = probAtLeast(k, pr.opp.mean, pr.opp.dispersion, { clamp: false });
      line.push({ y: y >= k ? 1 : 0, pb, po, pm: (pb + po) / 2 });
      const f = pr.opp.volume.flag || "none";
      const c = (flags[f] ||= { n: 0, actual: 0, base: 0, opp: 0 });
      c.n++; c.actual += y; c.base += pr.base.mean; c.opp += pr.opp.mean;
    }
  }
  return { recs, perGame, line, flags };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const report = {};
function printBlock(title, r) {
  const L = (k) => mean(r.recs.map((x) => ll(x[k], x.y))), B = (k) => mean(r.recs.map((x) => (x[k] - x.y) ** 2));
  const LL = (k) => mean(r.line.map((x) => ll(x[k], x.y)));
  const d = r.perGame, se = sd(d) / Math.sqrt(d.length);
  console.log(`${title}: ${r.recs.length} rung predictions from ${d.length} player-games`);
  console.log(`  log loss  current ${L("pb").toFixed(4)} | opportunity ${L("po").toFixed(4)} | blend ${L("pm").toFixed(4)}`);
  console.log(`  Brier     current ${B("pb").toFixed(4)} | opportunity ${B("po").toFixed(4)} | blend ${B("pm").toFixed(4)}`);
  console.log(`  opportunity - current, log loss summed per player-game: ${mean(d).toFixed(4)} (SE ${se.toFixed(4)}, t ${(mean(d) / se).toFixed(1)}; negative = opportunity better)`);
  console.log(`  synthetic line (median of last 10), ${r.line.length} games: log loss current ${LL("pb").toFixed(4)} | opportunity ${LL("po").toFixed(4)} | blend ${LL("pm").toFixed(4)}`);
  console.log("  Calibration (opportunity): predicted -> actual (n)");
  for (let b = 0; b < 10; b++) {
    const bin = r.recs.filter((x) => x.po >= b / 10 && x.po < (b + 1) / 10);
    if (bin.length < 100) continue;
    console.log(`    ${String(b * 10).padStart(2)}-${String(b * 10 + 10).padEnd(3)}%  ${(mean(bin.map((x) => x.po)) * 100).toFixed(1).padStart(5)}% -> ${(mean(bin.map((x) => x.y)) * 100).toFixed(1).padStart(5)}%  (${bin.length})`);
  }
  console.log("  Volume vs results flag (last 5 games) -> next game: actual avg vs each model's mean");
  for (const [f, c] of Object.entries(r.flags).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${f.padEnd(9)} n=${String(c.n).padStart(5)}  actual ${(c.actual / c.n).toFixed(2).padStart(6)} | current ${(c.base / c.n).toFixed(2).padStart(6)} (err ${((c.actual - c.base) / c.n).toFixed(2).padStart(5)}) | opportunity ${(c.opp / c.n).toFixed(2).padStart(6)} (err ${((c.actual - c.opp) / c.n).toFixed(2).padStart(5)})`);
  }
  console.log("");
  report[title] = { n: r.recs.length, games: d.length, logloss: { current: L("pb"), opportunity: L("po"), blend: L("pm") },
    brier: { current: B("pb"), opportunity: B("po"), blend: B("pm") }, diff: mean(d), se,
    line: { n: r.line.length, current: LL("pb"), opportunity: LL("po"), blend: LL("pm") }, flags: r.flags };
}

for (const stat of ["points", "threes"]) {
  printBlock(`${stat}, all seasons`, score(stat));
  printBlock(`${stat}, 2024-25 only`, score(stat, (g) => g.date < "2025-08-01"));
  printBlock(`${stat}, 2026-27 only (out of sample for the league priors)`, score(stat, (g) => g.date >= "2026-10-01"));
}

// ---- real Kalshi rungs for one night ----
const kfile = opt("--kalshi", null), kdate = opt("--kalshi-date", null);
if (kfile && kdate) {
  const lines = fs.readFileSync(kfile, "utf8").split(/\r?\n/).filter(Boolean);
  const out = { points: [], threes: [] }; let unmatched = 0;
  const seen = new Set();
  for (const ln of lines) {
    const [, stat, player, N, bid, ask] = ln.split("|");
    if (!out[stat]) continue;
    const key = `${stat}|${player}|${N}`; if (seen.has(key)) continue; seen.add(key);
    const arr = byPlayer.get(normalizeName(player)); if (!arr) { unmatched++; continue; }
    const target = arr.find((g) => g.date === kdate); const prior = arr.filter((g) => g.date < kdate);
    if (!target || prior.length < MIN) { unmatched++; continue; }
    const pr = project(prior, stat, kdate); if (!pr) { unmatched++; continue; }
    const k = Number(N), y = valueOf(target, stat) >= k ? 1 : 0, mid = (Number(bid) + Number(ask)) / 2;
    out[stat].push({ y, mid, pb: probAtLeast(k, pr.base.mean, pr.base.dispersion, { clamp: false }),
      po: probAtLeast(k, pr.opp.mean, pr.opp.dispersion, { clamp: false }) });
  }
  console.log(`Kalshi rungs on ${kdate} (${unmatched} rungs had no result or too little history; DNPs drop out):`);
  report.kalshi = {};
  for (const [stat, rs] of Object.entries(out)) {
    if (!rs.length) continue;
    const L = (k) => mean(rs.map((x) => ll(x[k], x.y)));
    rs.forEach((x) => { x.pm = (x.pb + x.po) / 2; x.mk = 0.5 * x.mid + 0.5 * x.po; });
    console.log(`  ${stat}: ${rs.length} rungs  log loss  market mid ${L("mid").toFixed(4)} | current ${L("pb").toFixed(4)} | opportunity ${L("po").toFixed(4)} | 50/50 market+opportunity ${L("mk").toFixed(4)}`);
    report.kalshi[stat] = { n: rs.length, market: L("mid"), current: L("pb"), opportunity: L("po"), marketPlusOpp: L("mk") };
  }
  console.log("  One night, correlated rungs (several per player): a sanity check, not evidence.");
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
