#!/usr/bin/env node
/**
 * Backtest harness for the NFL prop model.
 *
 * Runs the model over historical player-week data and measures how good its
 * projections and its uncertainty actually are. This reuses the exact model
 * code the app runs, so a result here applies to the live model rather than to
 * a reimplementation of it.
 *
 * WHY THIS EXISTS
 * Every constant in the model was chosen by judgment: the 0.85 recency decay,
 * the variance shrinkage constant, the prior coefficients of variation. None
 * were fitted. Waiting for live picks to accumulate means months before there
 * is enough data to say anything. Historical player data is free and already
 * exists, so the constants can be tuned against thousands of real outcomes
 * instead.
 *
 * WHAT IT CAN AND CANNOT MEASURE
 * There are no free historical sportsbook lines, so this cannot grade against
 * real closing numbers or compute CLV or ROI. What it CAN measure is more
 * fundamental:
 *
 *   1. Point accuracy: mean absolute error and bias of the projection.
 *   2. Distribution calibration, via the probability integral transform.
 *      For each prediction, compute F(actual) where F is the model's own
 *      predictive CDF. If the uncertainty is honest, those values are
 *      uniform on [0,1]. Clumping in the middle means the model is
 *      underconfident (intervals too wide); clumping at the tails means it is
 *      overconfident (intervals too narrow). This needs no lines at all,
 *      which is exactly why it is the right tool here.
 *
 * NO LOOKAHEAD
 * For a target week W, only games strictly before W are used to build inputs.
 * Leaking the target game into its own projection would produce excellent
 * numbers that mean nothing, which is the most common way a backtest lies.
 *
 * USAGE
 *   node backtest.mjs --data player-stats-history.json --stat receiving_yards
 *   node backtest.mjs --data ... --stat rushing_yards --sweep decay
 *
 * INPUT FORMAT
 * The same shape github-action/compute_player_stats.py emits, but covering
 * many weeks and ideally several seasons:
 *   { players: [ { name, norm, team, week, season, stats: {...} }, ... ] }
 */

import fs from "node:fs";
import { scoreProp, predictiveCdf, classifyProp } from "../src/model.js";

// ---------- argument parsing ----------
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const DATA_PATH = arg("data");
const STAT = arg("stat", "receiving_yards");
const MIN_PRIOR_GAMES = Number(arg("minGames", 3));
const SWEEP = arg("sweep");

if (!DATA_PATH) {
  console.error("Required: --data <path to history json>");
  console.error("Optional: --stat <stat key>  --minGames <n>  --sweep <decay|shrink>");
  process.exit(1);
}

// Map a stat key back to a prop-type label the model will classify correctly.
const STAT_TO_PROPTYPE = {
  receiving_yards: "Rec Yds",
  rushing_yards: "Rush Yds",
  passing_yards: "Pass Yds",
  receptions: "Receptions",
  carries: "Carries",
  completions: "Completions",
  attempts: "Pass Attempts",
  targets: "Targets",
  rushing_tds: "Rush TDs",
  receiving_tds: "Rec TDs",
  passing_tds: "Pass TDs",
  rush_rec_yards: "Rush+Rec Yds",
};

// ---------- load and index ----------
const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const rows = (raw.players || []).filter((r) => r.stats && r.stats[STAT] !== undefined);

if (!rows.length) {
  console.error(`No rows found with stat "${STAT}". Available in first row:`,
    Object.keys((raw.players || [])[0]?.stats || {}).join(", ") || "(none)");
  process.exit(1);
}

// Index by player identity, then order chronologically. Season is included so
// multi-season histories do not interleave weeks incorrectly.
const byPlayer = new Map();
for (const r of rows) {
  const id = `${r.norm || r.name}|${r.season ?? "x"}`;
  if (!byPlayer.has(id)) byPlayer.set(id, []);
  byPlayer.get(id).push(r);
}
for (const list of byPlayer.values()) {
  list.sort((a, b) => Number(a.week) - Number(b.week));
}

// ---------- prior-season baselines ----------
// For each player-season, the per-game average of the PREVIOUS season, used
// only as the regression target when testing how hard to regress a small
// sample toward last year's level (--sweep priorK). Regular season only
// (weeks 1-18) so a playoff game does not distort it, and requires a minimum
// number of games so a two-game cameo is not treated as a stable baseline.
const PRIOR_MIN_GAMES = Number(arg("priorMinGames", 8));
const prevBaseline = new Map();
{
  const bySeason = new Map();
  for (const r of rows) {
    if (Number(r.week) > 18) continue;
    const key = `${r.norm || r.name}|${r.season}`;
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key).push(Number(r.stats[STAT]));
  }
  for (const [key, vals] of bySeason.entries()) {
    if (vals.length < PRIOR_MIN_GAMES) continue;
    const [norm, season] = key.split("|");
    prevBaseline.set(`${norm}|${Number(season) + 1}`, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
}

// ---------- build no-lookahead cases ----------
const cases = [];
for (const [id, list] of byPlayer.entries()) {
  for (let i = 0; i < list.length; i++) {
    const target = list[i];
    const prior = list.slice(0, i);              // strictly earlier games only
    if (prior.length < MIN_PRIOR_GAMES) continue;
    const log = prior.slice().reverse().map((r) => r.stats[STAT]); // most recent first
    cases.push({
      player: target.name,
      team: target.team,
      week: Number(target.week),
      season: target.season,
      gameLog: log,
      actual: Number(target.stats[STAT]),
      // Previous season's per-game average, or undefined when the player had
      // too few games then (rookies, injured seasons). Never includes the
      // target season, so it cannot leak the outcome.
      prevMean: prevBaseline.get(`${target.norm || target.name}|${target.season}`),
    });
  }
}

if (!cases.length) {
  console.error(`No cases with at least ${MIN_PRIOR_GAMES} prior games. Try --minGames 2.`);
  process.exit(1);
}

// ---------- run ----------
// Inputs are deliberately kept neutral. The purpose is to test the baseline
// and the variance model, not to simulate matchup or weather adjustments that
// historical data cannot reconstruct faithfully. Feeding in guessed
// adjustments would measure the guesses rather than the model core.
function runCases(list, overrides = {}) {
  const out = [];
  for (const c of list) {
    const scored = scoreProp({
      week: c.week,
      team: c.team,
      player: c.player,
      propType: STAT_TO_PROPTYPE[STAT] || "Rec Yds",
      line: c.actual,            // placeholder; not used for point accuracy
      gameLog: c.gameLog,
      injuryStatus: "Healthy",
      roleVolumeScore: 5,        // neutral
      gamesPlayed: c.gameLog.length,
      // The line here is a placeholder equal to the outcome, so it must never
      // be used as a regression target or it would leak the answer.
      lineIsEstimate: true,
      priorYrBaseline: overrides.usePrior ? c.prevMean : undefined,
      __cvOverride: overrides.cv,
      __shrinkKOverride: overrides.shrinkK,
      __priorKOverride: overrides.priorK,
    });
    if (!isFinite(scored.finalProjection) || !isFinite(scored.sd) || scored.sd <= 0) continue;
    const pit = predictiveCdf(c.actual, scored.kind, scored.finalProjection, scored.sd);
    out.push({
      ...c,
      projection: scored.finalProjection,
      sd: scored.sd,
      kind: scored.kind,
      error: scored.finalProjection - c.actual,
      pit,
    });
  }
  return out;
}

// ---------- metrics ----------
function metrics(results) {
  const n = results.length;
  const abs = results.reduce((s, r) => s + Math.abs(r.error), 0) / n;
  const bias = results.reduce((s, r) => s + r.error, 0) / n;
  const rmse = Math.sqrt(results.reduce((s, r) => s + r.error * r.error, 0) / n);

  // A naive benchmark: predict the simple mean of prior games. If the model
  // cannot beat this, its extra machinery is not earning anything.
  const naiveAbs = results.reduce((s, r) => {
    const naive = r.gameLog.reduce((a, b) => a + b, 0) / r.gameLog.length;
    return s + Math.abs(naive - r.actual);
  }, 0) / n;

  // PIT uniformity. Ten equal bins; each should hold about 10% of cases.
  const bins = new Array(10).fill(0);
  for (const r of results) bins[Math.min(9, Math.floor(r.pit * 10))]++;
  const binPct = bins.map((b) => b / n);

  // Kolmogorov-Smirnov statistic of the PIT values against uniform(0,1).
  const sorted = results.map((r) => r.pit).sort((a, b) => a - b);
  let ks = 0;
  for (let i = 0; i < n; i++) {
    ks = Math.max(ks, Math.abs(sorted[i] - (i + 0.5) / n));
  }

  // Coverage of the central 50% and 80% intervals. Honest uncertainty puts
  // close to 50% and 80% of outcomes inside them.
  const cov50 = results.filter((r) => r.pit >= 0.25 && r.pit <= 0.75).length / n;
  const cov80 = results.filter((r) => r.pit >= 0.10 && r.pit <= 0.90).length / n;

  return { n, abs, bias, rmse, naiveAbs, binPct, ks, cov50, cov80 };
}

function report(m) {
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`\nCases: ${m.n}   stat: ${STAT}`);
  console.log(`\nPOINT ACCURACY`);
  console.log(`  Mean absolute error   ${m.abs.toFixed(2)}`);
  console.log(`  RMSE                  ${m.rmse.toFixed(2)}`);
  console.log(`  Bias (proj - actual)  ${m.bias >= 0 ? "+" : ""}${m.bias.toFixed(2)}`
    + (Math.abs(m.bias) > m.abs * 0.1 ? "   <-- systematic, worth investigating" : ""));
  console.log(`  Naive prior-mean MAE  ${m.naiveAbs.toFixed(2)}`);
  const lift = (m.naiveAbs - m.abs) / m.naiveAbs;
  console.log(`  Improvement vs naive  ${lift >= 0 ? "+" : ""}${pct(lift)}`
    + (lift <= 0 ? "   <-- the extra machinery is not earning its place" : ""));

  console.log(`\nDISTRIBUTION CALIBRATION (probability integral transform)`);
  console.log(`  Each decile should hold ~10% if the uncertainty is honest.`);
  m.binPct.forEach((p, i) => {
    const bar = "#".repeat(Math.round(p * 100));
    console.log(`   ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  ${pct(p).padStart(6)}  ${bar}`);
  });
  console.log(`  KS statistic vs uniform  ${m.ks.toFixed(4)}`);
  console.log(`    (roughly: below ${(1.36 / Math.sqrt(m.n)).toFixed(3)} is consistent with uniform at 5%)`);
  console.log(`  Central 50% coverage     ${pct(m.cov50)}  (target 50%)`);
  console.log(`  Central 80% coverage     ${pct(m.cov80)}  (target 80%)`);

  const c50 = m.cov50;
  if (c50 > 0.58) console.log(`  READ: intervals too WIDE, model is underconfident.`);
  else if (c50 < 0.42) console.log(`  READ: intervals too NARROW, model is overconfident.`);
  else console.log(`  READ: interval width is in a reasonable range.`);
}

// ---------- parameter sweep ----------
// Tests a range of candidate values for the CV prior or the shrinkage
// constant against the real historical cases, scoring each by how close its
// central-50 coverage lands to the 50% target (the direct, interpretable
// measure of over/underconfidence) and reporting the KS statistic alongside
// as a fuller calibration check. This replaces guessing at a fix with
// actually checking candidates against real outcomes.
function sweepParam(paramName, candidates) {
  console.log(`\n=== SWEEP: ${paramName} ===`);
  console.log(`${"value".padStart(8)}  ${"n".padStart(6)}  ${"MAE".padStart(7)}  ${"cov50".padStart(7)}  ${"cov80".padStart(7)}  ${"KS".padStart(7)}  ${"|cov50-50%|".padStart(12)}`);
  let best = null;
  for (const val of candidates) {
    const overrides = paramName === "cv" ? { cv: val } : { shrinkK: val };
    const results = runCases(cases, overrides);
    if (!results.length) continue;
    const m = metrics(results);
    const dist = Math.abs(m.cov50 - 0.5);
    console.log(
      `${String(val).padStart(8)}  ${String(m.n).padStart(6)}  ${m.abs.toFixed(2).padStart(7)}  ` +
      `${(m.cov50 * 100).toFixed(1).padStart(6)}%  ${(m.cov80 * 100).toFixed(1).padStart(6)}%  ` +
      `${m.ks.toFixed(4).padStart(7)}  ${(dist * 100).toFixed(2).padStart(11)}%`
    );
    if (!best || dist < best.dist) best = { val, dist, m };
  }
  if (best) {
    console.log(`\nBest ${paramName} by central-50 coverage: ${best.val} ` +
      `(cov50 ${(best.m.cov50 * 100).toFixed(1)}%, KS ${best.m.ks.toFixed(4)})`);
  }
  return best;
}

// Sweeps how hard to regress a small sample of current-season games toward
// the player's prior-season per-game average. Scored on point accuracy (mean
// absolute error against what actually happened), not interval coverage,
// because this parameter moves the projection itself. Only cases that HAVE a
// prior-season baseline are used, and the same cases are used for every
// candidate, so the comparison is like for like. K=0 is no regression at all,
// i.e. the current behavior with no prior supplied, and is the baseline every
// other value has to beat.
function sweepPriorK(candidates) {
  const eligible = cases.filter((c) => c.prevMean !== undefined && isFinite(c.prevMean));
  console.log(`\n=== SWEEP: priorK (regression toward prior-season average) ===`);
  console.log(`Eligible cases with a prior-season baseline: ${eligible.length} of ${cases.length}`);
  if (!eligible.length) {
    console.log("No eligible cases. The history needs at least two consecutive seasons per player.");
    return null;
  }
  const early = eligible.filter((c) => c.gameLog.length <= 4);
  console.log(`  of which early-season (4 or fewer games banked): ${early.length}\n`);
  console.log(`${"K".padStart(5)}  ${"MAE all".padStart(9)}  ${"MAE n<=4".padStart(9)}  ${"bias all".padStart(9)}  ${"vs K=0 all".padStart(11)}  ${"vs K=0 n<=4".padStart(12)}`);

  // One pass over the eligible cases per K, then the early-season subset is
  // just a filter of the same results, so both columns use identical cases.
  const summarize = (K) => {
    const out = runCases(eligible, { usePrior: true, priorK: K });
    const stat = (list) => {
      const n = list.length;
      return {
        mae: list.reduce((a, r) => a + Math.abs(r.error), 0) / n,
        bias: list.reduce((a, r) => a + r.error, 0) / n,
        n,
      };
    };
    return { all: stat(out), early: stat(out.filter((r) => r.gameLog.length <= 4)) };
  };
  const maeOf = (list, K) => {
    const r = summarize(K);
    return list === eligible ? r.all : r.early;
  };

  const base = { all: maeOf(eligible, 0), early: maeOf(early, 0) };
  let best = null;
  for (const K of candidates) {
    const a = maeOf(eligible, K);
    const e = maeOf(early, K);
    const dAll = (a.mae - base.all.mae) / base.all.mae;
    const dEarly = (e.mae - base.early.mae) / base.early.mae;
    console.log(
      `${String(K).padStart(5)}  ${a.mae.toFixed(3).padStart(9)}  ${e.mae.toFixed(3).padStart(9)}  ` +
      `${(a.bias >= 0 ? "+" : "") + a.bias.toFixed(2).padStart(8)}  ` +
      `${((dAll >= 0 ? "+" : "") + (dAll * 100).toFixed(2) + "%").padStart(11)}  ` +
      `${((dEarly >= 0 ? "+" : "") + (dEarly * 100).toFixed(2) + "%").padStart(12)}`
    );
    if (!best || a.mae < best.mae) best = { K, mae: a.mae, early: e.mae };
  }
  if (best) {
    console.log(`\nBest K by overall MAE: ${best.K} (MAE ${best.mae.toFixed(3)} vs ${base.all.mae.toFixed(3)} with no regression)`);
    console.log(`Live default in src/model.js is DEFAULT_PRIOR_K = 4. Change it to ${best.K} if this holds up.`);
  }
  return best;
}

let sweepBest = null;
if (SWEEP === "priorK") {
  sweepPriorK([0, 1, 2, 3, 4, 6, 8, 12, 20]);
  process.exit(0);
}
if (SWEEP === "cv") {
  sweepBest = sweepParam("cv", [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.20]);
} else if (SWEEP === "shrinkK" || SWEEP === "shrink") {
  sweepBest = sweepParam("shrinkK", [1, 2, 3, 5, 8, 12, 18, 25, 35, 50]);
} else if (SWEEP) {
  console.log(`\nUnknown --sweep value "${SWEEP}". Use "cv", "shrinkK", or "priorK".`);
}

const finalOverrides = sweepBest
  ? (SWEEP === "cv" ? { cv: sweepBest.val } : { shrinkK: sweepBest.val })
  : {};
if (sweepBest) {
  console.log(`\n=== Full report using the best found ${SWEEP} = ${sweepBest.val} ===`);
}

const results = runCases(cases, finalOverrides);
if (!results.length) {
  console.error("No scorable cases produced. Check the stat key and data shape.");
  process.exit(1);
}
report(metrics(results));

// Per-week breakdown, to catch the early-season weeks where thin samples make
// the model least reliable.
const byWeek = {};
for (const r of results) (byWeek[r.week] = byWeek[r.week] || []).push(r);
console.log(`\nBY WEEK`);
for (const w of Object.keys(byWeek).map(Number).sort((a, b) => a - b)) {
  const m = metrics(byWeek[w]);
  console.log(`  W${String(w).padStart(2)}  n=${String(m.n).padStart(5)}  MAE ${m.abs.toFixed(2).padStart(7)}  cov50 ${(m.cov50 * 100).toFixed(0).padStart(3)}%`);
}

console.log(`\nNOTE: no historical sportsbook lines are used here, so this measures`);
console.log(`projection accuracy and uncertainty honesty, not CLV or ROI.`);
