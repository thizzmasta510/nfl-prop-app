#!/usr/bin/env node
/**
 * NFL opportunity projection (src/nfl_opportunity.js) vs the current NFL model and
 * the sportsbooks' closing lines.
 *
 *   node backtest/nfl_opportunity_backtest.mjs --props sgo_backfill.json --history backtest/player-stats-history.json [--logs trend-logs.json]
 *
 * Same join and the same current-model call as market_vs_model.mjs (no matchup,
 * injury, weather or game-script inputs for either model; graded only when the player
 * has a row that week and at least one earlier game this season; integer lines and
 * pushes skipped). --logs adds the current season from trend-logs.json when the
 * history file stops early. Market = no-vig closing probability.
 *
 * Reports, per stat and season: log loss and Brier for market / current / opportunity,
 * calibration, a logistic fit y ~ logit(market) + logit(opportunity) (does the
 * projection add anything the closing line doesn't have?), and the hit rate and ROI
 * when the projection disagrees with the closing price.
 * The props file is licensed data: keep it and the output rows out of the repo.
 */
import fs from "node:fs";
import { scoreProp, normalizeName } from "../src/model.js";
import { nflOpportunityProjection, nflProbAtLeast } from "../src/nfl_opportunity.js";
import { warnIfInGame } from "./sgo_check.mjs";

const args = process.argv.slice(2);
const arg = (n, f = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : f; };
const PROPS = arg("props"), HIST = arg("history"), LOGS = arg("logs"), OUT = arg("out");
// --season 2026: grade one season only. The 2025 backfill's "closing" lines are often
// in-game lines (a third of receiving-yard closes sit within 3 yards of the final
// result, vs about 1 in 10 for pregame lines; 2026's are clean), so grade 2026 only
// unless you know the file has pregame closes.
const ONLY = arg("season") ? Number(arg("season")) : null;
if (!PROPS || !HIST) { console.error("usage: --props <sgo_backfill.json> --history <player-stats-history.json> [--logs trend-logs.json]"); process.exit(1); }

const MAP = {
  receiving_receptions: { h: "receptions", label: "Receptions" },
  receiving_yards: { h: "receiving_yards", label: "Rec Yds" },
  rushing_attempts: { h: "carries", label: "Carries" },
  rushing_yards: { h: "rushing_yards", label: "Rush Yds" },
  passing_yards: { h: "passing_yards", label: "Pass Yds" },
};
const props = JSON.parse(fs.readFileSync(PROPS, "utf8")).rows;
warnIfInGame(props);
let hist = JSON.parse(fs.readFileSync(HIST, "utf8")).players;
if (LOGS) {
  const lg = JSON.parse(fs.readFileSync(LOGS, "utf8"));
  const cur = Number(lg.season);
  hist = hist.filter((r) => Number(r.season) !== cur).concat(lg.players.filter((r) => Number(r.season) === cur));
}
const idx = new Map();
for (const r of hist) {
  if (Number(r.week) > 18) continue;
  const k = `${r.norm || normalizeName(r.name)}|${r.season}`;
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(r);
}
for (const l of idx.values()) l.sort((a, b) => a.week - b.week);
const VOLK = ["targets", "receptions", "receiving_yards", "carries", "rushing_yards", "attempts", "completions", "passing_yards"];
function prevTotals(norm, season) {
  const l = idx.get(`${norm}|${season - 1}`) || [];
  if (!l.length) return null;
  const t = { games: l.length }; for (const k of VOLK) t[k] = l.reduce((a, r) => a + (Number(r.stats[k]) || 0), 0);
  return t;
}
function baseline(norm, season, hkey) {   // same as market_vs_model.mjs
  const l = (idx.get(`${norm}|${season - 1}`) || []).filter((r) => r.stats[hkey] !== undefined);
  if (l.length < 8) return undefined;
  return l.reduce((s, r) => s + r.stats[hkey], 0) / l.length;
}
const seasonOf = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m >= 3 ? y : y - 1; };
const anchor = {};
for (const p of props) { const s = seasonOf(p.startsAt), t = Date.parse(p.startsAt); if (!(s in anchor) || t < anchor[s]) anchor[s] = t; }
const weekOf = (iso) => Math.floor((Date.parse(iso) - (anchor[seasonOf(iso)] - 1.5 * 86400000)) / (7 * 86400000)) + 1;
const imp = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
const payout = (o) => (o > 0 ? o / 100 : 100 / -o);

const out = [], skip = { noMap: 0, intLine: 0, noOdds: 0, noHist: 0, noRow: 0, noLog: 0, push: 0, noOpp: 0 };
for (const p of props) {
  const m = MAP[p.stat]; if (!m) { skip.noMap++; continue; }
  if (Number.isInteger(p.close)) { skip.intLine++; continue; }
  if (p.overCloseOdds == null || p.underCloseOdds == null) { skip.noOdds++; continue; }
  const season = seasonOf(p.startsAt), week = weekOf(p.startsAt), norm = normalizeName(p.name || "");
  if (ONLY && season !== ONLY) continue;
  const list = idx.get(`${norm}|${season}`); if (!list) { skip.noHist++; continue; }
  const target = list.filter((r) => r.week === week);
  if (target.length !== 1 || target[0].stats[m.h] === undefined) { skip.noRow++; continue; }
  const prior = list.filter((r) => r.week < week && r.stats[m.h] !== undefined);
  if (!prior.length) { skip.noLog++; continue; }
  if (p.actual === p.close) { skip.push++; continue; }
  const gameLog = prior.slice().reverse().map((r) => r.stats[m.h]);
  const sc = scoreProp({ week, team: p.team || target[0].team, player: p.name, propType: m.label, line: p.close,
    gameLog, injuryStatus: "Healthy", roleVolumeScore: 5, gamesPlayed: gameLog.length, lineIsEstimate: true, priorYrBaseline: baseline(norm, season, m.h) });
  if (sc.pOver == null || !isFinite(sc.pOver)) { skip.noHist++; continue; }
  const games = prior.slice().reverse().map((r) => r.stats);
  const op = nflOpportunityProjection(games, m.h, prevTotals(norm, season));
  if (!op) { skip.noOpp++; continue; }
  const pOpp = nflProbAtLeast(Math.floor(p.close) + 1, op);
  const po = imp(p.overCloseOdds), pu = imp(p.underCloseOdds);
  out.push({ stat: m.h, season, week, n: gameLog.length, line: p.close, y: p.actual > p.close ? 1 : 0, actual: p.actual,
    pMkt: po / (po + pu), pModel: sc.pOver, pOpp, oppMean: op.mean, modelProj: sc.finalProjection, flag: op.flag, role: op.role,
    overOdds: p.overCloseOdds, underOdds: p.underCloseOdds });
}
console.log(`props ${props.length} | graded ${out.length} | skipped ${JSON.stringify(skip)}`);
// Pregame check: share of yards props whose closing line is within 3 of the result (pregame lines: about 0.1)
for (const se of [...new Set(out.map((r) => r.season))].sort()) {
  const Y = out.filter((r) => r.season === se && /yards/.test(r.stat));
  if (Y.length) console.log(`  ${se}: closing line within 3 yards of the result on ${(100 * Y.filter((r) => Math.abs(r.actual - r.line) < 3).length / Y.length).toFixed(0)}% of yards props${Y.filter((r) => Math.abs(r.actual - r.line) < 3).length / Y.length > 0.2 ? "  <-- too many: these closes include in-game lines" : ""}`);
}
console.log("");

const clip = (q) => Math.min(0.999, Math.max(0.001, q));
const LL = (L, k) => L.reduce((s, r) => s - (r.y ? Math.log(clip(r[k])) : Math.log(1 - clip(r[k]))), 0) / L.length;
const BR = (L, k) => L.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / L.length;
const logit = (p) => Math.log(clip(p) / (1 - clip(p)));
function logistic(L, keys) {   // y ~ a + sum b_i logit(p_i), Newton's method
  const X = L.map((r) => [1, ...keys.map((k) => logit(r[k]))]), y = L.map((r) => r.y), d = keys.length + 1;
  let b = new Array(d).fill(0); b[1] = 1;
  for (let it = 0; it < 25; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    X.forEach((x, i) => { const z = x.reduce((s, v, j) => s + v * b[j], 0), p = 1 / (1 + Math.exp(-z));
      for (let j = 0; j < d; j++) { g[j] += (y[i] - p) * x[j]; for (let l = 0; l < d; l++) H[j][l] -= p * (1 - p) * x[j] * x[l]; } });
    // solve H delta = -g (small system, Gauss)
    const A = H.map((row, j) => [...row, -g[j]]);
    for (let c = 0; c < d; c++) { let piv = c; for (let rr = c + 1; rr < d; rr++) if (Math.abs(A[rr][c]) > Math.abs(A[piv][c])) piv = rr; [A[c], A[piv]] = [A[piv], A[c]];
      for (let rr = 0; rr < d; rr++) if (rr !== c) { const f = A[rr][c] / A[c][c]; for (let cc = c; cc <= d; cc++) A[rr][cc] -= f * A[c][cc]; } }
    const delta = A.map((row, j) => row[d] / row[j]);
    b = b.map((v, j) => v + delta[j]);
    if (Math.max(...delta.map(Math.abs)) < 1e-8) break;
  }
  // standard errors from the inverse Hessian at the solution
  const H = Array.from({ length: d }, () => new Array(d).fill(0));
  X.forEach((x) => { const z = x.reduce((s, v, j) => s + v * b[j], 0), p = 1 / (1 + Math.exp(-z)); for (let j = 0; j < d; j++) for (let l = 0; l < d; l++) H[j][l] += p * (1 - p) * x[j] * x[l]; });
  const inv = H.map((row, j) => [...row, ...row.map((_, l) => (l === j ? 1 : 0))]);
  for (let c = 0; c < d; c++) { let piv = c; for (let rr = c + 1; rr < d; rr++) if (Math.abs(inv[rr][c]) > Math.abs(inv[piv][c])) piv = rr; [inv[c], inv[piv]] = [inv[piv], inv[c]];
    const f0 = inv[c][c]; for (let cc = 0; cc < 2 * d; cc++) inv[c][cc] /= f0;
    for (let rr = 0; rr < d; rr++) if (rr !== c) { const f = inv[rr][c]; for (let cc = 0; cc < 2 * d; cc++) inv[rr][cc] -= f * inv[c][cc]; } }
  return { b, se: b.map((_, j) => Math.sqrt(inv[j][d + j])) };
}
const f4 = (x) => x.toFixed(4);
function block(label, L) {
  if (L.length < 40) return;
  console.log(`${label.padEnd(26)} n=${String(L.length).padStart(5)}  log loss  market ${f4(LL(L, "pMkt"))} | current ${f4(LL(L, "pModel"))} | opportunity ${f4(LL(L, "pOpp"))}    Brier  ${f4(BR(L, "pMkt"))} | ${f4(BR(L, "pModel"))} | ${f4(BR(L, "pOpp"))}`);
}
console.log("LOG LOSS / BRIER at the closing line (lower is better)");
block("ALL", out);
for (const s of Object.values(MAP)) block(s.h, out.filter((r) => r.stat === s.h));
for (const se of [...new Set(out.map((r) => r.season))].sort()) block(`season ${se}`, out.filter((r) => r.season === se));
for (const [lo, hi] of [[1, 2], [3, 5], [6, 99]]) block(`earlier games ${lo}-${hi}`, out.filter((r) => r.n >= lo && r.n <= hi));

console.log("\nCALIBRATION, opportunity (predicted -> actual Over rate)");
for (let b = 0; b < 10; b++) { const L = out.filter((r) => r.pOpp >= b / 10 && r.pOpp < (b + 1) / 10); if (L.length < 40) continue;
  console.log(`  ${String(b * 10).padStart(2)}-${String(b * 10 + 10).padEnd(3)}%  ${(100 * L.reduce((s, r) => s + r.pOpp, 0) / L.length).toFixed(1).padStart(5)}% -> ${(100 * L.reduce((s, r) => s + r.y, 0) / L.length).toFixed(1).padStart(5)}%  (${L.length})`); }

console.log("\nMEAN vs ACTUAL (bias; positive = projection too low)");
for (const s of Object.values(MAP)) { const L = out.filter((r) => r.stat === s.h); if (L.length < 40) continue;
  const mae = (k) => L.reduce((a, r) => a + Math.abs(r.actual - r[k]), 0) / L.length, bias = (k) => L.reduce((a, r) => a + r.actual - r[k], 0) / L.length;
  console.log(`  ${s.h.padEnd(16)} MAE current ${mae("modelProj").toFixed(2)} opportunity ${mae("oppMean").toFixed(2)} | bias current ${bias("modelProj").toFixed(2)} opportunity ${bias("oppMean").toFixed(2)} | closing line MAE ${(L.reduce((a, r) => a + Math.abs(r.actual - r.line), 0) / L.length).toFixed(2)}`); }

console.log("\nDOES IT ADD TO THE CLOSING LINE?  y ~ a + b1 logit(market) + b2 logit(model)   (b2 > 0 with |b2/se| > 2 = real information)");
for (const [label, L] of [["ALL", out], ...Object.values(MAP).map((s) => [s.h, out.filter((r) => r.stat === s.h)])]) {
  if (L.length < 150) continue;
  const a = logistic(L, ["pMkt", "pOpp"]), c = logistic(L, ["pMkt", "pModel"]);
  console.log(`  ${label.padEnd(16)} opportunity b2 ${a.b[2].toFixed(3)} (se ${a.se[2].toFixed(3)})   current b2 ${c.b[2].toFixed(3)} (se ${c.se[2].toFixed(3)})`);
}

console.log("\nBET THE OPPORTUNITY SIDE WHEN IT DISAGREES WITH THE CLOSING PRICE (book odds; Kalshi pricing differs)");
for (const th of [0.03, 0.05, 0.08, 0.12]) {
  const L = out.filter((r) => Math.abs(r.pOpp - r.pMkt) >= th); if (L.length < 30) continue;
  let w = 0, pr = 0; for (const r of L) { const over = r.pOpp > r.pMkt, win = over ? r.y === 1 : r.y === 0; if (win) { w++; pr += payout(over ? r.overOdds : r.underOdds); } else pr -= 1; }
  console.log(`  gap >= ${String(th * 100).padStart(2)} pts  n=${String(L.length).padStart(5)}  hit ${(100 * w / L.length).toFixed(1)}%  ROI ${(100 * pr / L.length).toFixed(1)}%`);
}
console.log("\nFLAGS (last 3 games vs what the volume is usually worth) -> next game, actual - projected mean");
for (const f of ["below", "above", null]) { const L = out.filter((r) => r.flag === f && r.stat !== "carries"); if (L.length < 20) continue;
  const e = (k) => (L.reduce((a, r) => a + r.actual - r[k], 0) / L.length).toFixed(2);
  console.log(`  ${String(f || "none").padEnd(6)} n=${String(L.length).padStart(5)}  current ${e("modelProj")}  opportunity ${e("oppMean")}  over rate ${(100 * L.reduce((a, r) => a + r.y, 0) / L.length).toFixed(1)}%  market says ${(100 * L.reduce((a, r) => a + r.pMkt, 0) / L.length).toFixed(1)}%  opportunity says ${(100 * L.reduce((a, r) => a + r.pOpp, 0) / L.length).toFixed(1)}%`); }
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out));
