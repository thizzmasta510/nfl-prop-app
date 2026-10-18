#!/usr/bin/env node
/**
 * Grade the model against the market's closing lines.
 *
 * Joins the SportsGameOdds backfill (closing line, closing prices, actual result)
 * with player-stats-history.json (game logs), runs the live model code on each
 * prop with no lookahead, and compares model vs market probabilities.
 *
 *   node market_vs_model.mjs --props ..\sgo_backfill.json --history player-stats-history.json
 *
 * LIMITS (read these before trusting a number)
 *  - The model runs with NO matchup, injury or weather inputs (history cannot
 *    reconstruct them). This grades the baseline + variance engine only.
 *  - Only props where the player has a row in the history for that week are graded
 *    (this drops players who did not play, whose props a book would void).
 *  - Integer lines (possible pushes) are skipped.
 *  - Market probability = no-vig from the closing over/under prices.
 */
import fs from "node:fs";
import { scoreProp, normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const arg = (n, f = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : f; };
const PROPS = arg("props"), HIST = arg("history");
if (!PROPS || !HIST) { console.error("Usage: node market_vs_model.mjs --props <sgo_backfill.json> --history <player-stats-history.json>"); process.exit(1); }

// SGO stat -> { history key, model prop label }
const MAP = {
  passing_yards: { h: "passing_yards", label: "Pass Yds" },
  rushing_yards: { h: "rushing_yards", label: "Rush Yds" },
  receiving_yards: { h: "receiving_yards", label: "Rec Yds" },
  receiving_receptions: { h: "receptions", label: "Receptions" },
  passing_touchdowns: { h: "passing_tds", label: "Pass TDs" },
  passing_attempts: { h: "attempts", label: "Pass Attempts" },
  passing_completions: { h: "completions", label: "Completions" },
  rushing_attempts: { h: "carries", label: "Carries" },
};

const props = JSON.parse(fs.readFileSync(PROPS, "utf8")).rows;
const hist = JSON.parse(fs.readFileSync(HIST, "utf8")).players;

// ---- index history: norm|season -> rows sorted by week
const idx = new Map();
for (const r of hist) {
  const k = `${r.norm || normalizeName(r.name)}|${r.season}`;
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(r);
}
for (const l of idx.values()) l.sort((a, b) => a.week - b.week);

// ---- prior-season per-game baseline (regular season, >= 8 games), same as backtest.mjs
function baseline(norm, season, hkey) {
  const l = (idx.get(`${norm}|${season - 1}`) || []).filter((r) => r.week <= 18 && r.stats[hkey] !== undefined);
  if (l.length < 8) return undefined;
  return l.reduce((s, r) => s + r.stats[hkey], 0) / l.length;
}

// ---- date -> NFL week (anchor = earliest kickoff of that season in the props file)
const seasonOf = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m >= 3 ? y : y - 1; };
const anchor = {};
for (const p of props) { const s = seasonOf(p.startsAt), t = Date.parse(p.startsAt); if (!(s in anchor) || t < anchor[s]) anchor[s] = t; }
const weekOf = (iso) => Math.floor((Date.parse(iso) - (anchor[seasonOf(iso)] - 1.5 * 86400000)) / (7 * 86400000)) + 1;

const imp = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
const payout = (o) => (o > 0 ? o / 100 : 100 / -o);

const out = [];
const skip = { noMap: 0, intLine: 0, noOdds: 0, noHist: 0, noRow: 0, push: 0 };
let agree = 0, agreeN = 0;
for (const p of props) {
  const m = MAP[p.stat]; if (!m) { skip.noMap++; continue; }
  if (Number.isInteger(p.close)) { skip.intLine++; continue; }
  if (p.overCloseOdds == null || p.underCloseOdds == null) { skip.noOdds++; continue; }
  const season = seasonOf(p.startsAt), week = weekOf(p.startsAt);
  const norm = normalizeName(p.name || "");
  const list = idx.get(`${norm}|${season}`);
  if (!list) { skip.noHist++; continue; }
  const target = list.filter((r) => r.week === week);
  if (target.length !== 1 || target[0].stats[m.h] === undefined) { skip.noRow++; continue; }
  const actual = p.actual;
  agreeN++; if (Math.abs(target[0].stats[m.h] - actual) < 0.5) agree++;
  const prior = list.filter((r) => r.week < week && r.stats[m.h] !== undefined);
  const gameLog = prior.slice().reverse().map((r) => r.stats[m.h]);
  const pb = baseline(norm, season, m.h);
  if (!gameLog.length && pb === undefined) { skip.noHist++; continue; }
  const sc = scoreProp({
    week, team: p.team || target[0].team, player: p.name, propType: m.label, line: p.close,
    gameLog, injuryStatus: "Healthy", roleVolumeScore: 5, gamesPlayed: gameLog.length,
    lineIsEstimate: true, priorYrBaseline: pb,
  });
  if (sc.pOver == null || !isFinite(sc.pOver)) { skip.noHist++; continue; }
  const po = imp(p.overCloseOdds), pu = imp(p.underCloseOdds), pm = po / (po + pu);
  if (actual === p.close) { skip.push++; continue; }
  out.push({ ...p, season, week, n: gameLog.length, pModel: sc.pOver, pMkt: pm, y: actual > p.close ? 1 : 0, proj: sc.finalProjection });
}

console.log(`props in file: ${props.length} | graded: ${out.length}`);
console.log("skipped:", JSON.stringify(skip));
console.log(`week-mapping check: history stat matches SGO result in ${agree}/${agreeN} (${(100 * agree / Math.max(1, agreeN)).toFixed(1)}%)` + (agree / Math.max(1, agreeN) < 0.9 ? "   <-- LOW, week mapping or name matching may be off" : ""));
if (!out.length) process.exit(0);

const brier = (L, f) => L.reduce((s, r) => s + (f(r) - r.y) ** 2, 0) / L.length;
const ll = (L, f) => L.reduce((s, r) => { const q = Math.min(0.999, Math.max(0.001, f(r))); return s - (r.y ? Math.log(q) : Math.log(1 - q)); }, 0) / L.length;
const f3 = (x) => x.toFixed(4);

function table(label, L) {
  console.log(`${label.padEnd(24)} n=${String(L.length).padStart(5)}  model ${f3(brier(L, (r) => r.pModel))}  market ${f3(brier(L, (r) => r.pMkt))}  coin 0.2500   logloss model ${f3(ll(L, (r) => r.pModel))} market ${f3(ll(L, (r) => r.pMkt))}`);
}
console.log("\nBRIER (lower is better) and LOG LOSS, same props for both");
table("ALL", out);
for (const s of Object.keys(MAP)) { const L = out.filter((r) => r.stat === s); if (L.length >= 30) table(s, L); }
console.log("\nBY GAMES OF HISTORY THIS SEASON");
for (const [lo, hi] of [[0, 0], [1, 2], [3, 5], [6, 99]]) { const L = out.filter((r) => r.n >= lo && r.n <= hi); if (L.length >= 30) table(`prior games ${lo}-${hi}`, L); }
console.log("\nBY SEASON");
for (const s of [...new Set(out.map((r) => r.season))]) table(String(s), out.filter((r) => r.season === s));

// Does a blend help? Weight w on the model, rest on the market.
console.log("\nBLEND (w = weight on model)");
for (const w of [0, 0.1, 0.25, 0.5, 1]) console.log(`  w=${w}  Brier ${f3(brier(out, (r) => w * r.pModel + (1 - w) * r.pMkt))}`);

// Disagreement: bet the side the model likes at the real closing price.
console.log("\nWHEN THE MODEL DISAGREES WITH THE MARKET (bet the model's side at closing price)");
for (const th of [0.03, 0.05, 0.08, 0.12, 0.2]) {
  const L = out.filter((r) => Math.abs(r.pModel - r.pMkt) >= th);
  if (L.length < 20) continue;
  let wins = 0, profit = 0;
  for (const r of L) {
    const over = r.pModel > r.pMkt, win = over ? r.y === 1 : r.y === 0, odds = over ? r.overCloseOdds : r.underCloseOdds;
    if (win) { wins++; profit += payout(odds); } else profit -= 1;
  }
  console.log(`  gap >= ${(th * 100).toFixed(0).padStart(2)} pts  n=${String(L.length).padStart(5)}  hit ${(100 * wins / L.length).toFixed(1)}%  ROI ${(100 * profit / L.length).toFixed(1)}%`);
}
fs.writeFileSync("market_vs_model_rows.json", JSON.stringify(out));
console.log("\nSaved market_vs_model_rows.json");
