// Calibration check for the NBA model (src/nba_model.js), using only the game logs.
//
//   node backtest/nba_model_calibration.mjs nba-trend-logs.json [--min 8] [--stats points,rebounds,assists,threes]
//
// Walk-forward: for every player-game with at least --min earlier games in the
// file, predict P(stat >= cutoff) for each market cutoff using ONLY earlier games,
// with team context (pace, DRtg, DvP) computed as of that game's date. Then score:
//   model            per-minute rate x minutes x matchup factor, negative binomial
//   model, no matchup the same without the matchup factor (does context help?)
//   last-10 rate     (hits + 1) / (n + 2) over the previous 10 games
// Lower Brier is better. The reliability table shows, for each predicted range,
// how often it actually happened; a well-calibrated model's rows match.
//
// This does NOT compare against market prices (it has none). Beating a last-10
// hit rate is a low bar; the market is the real test (see trend_backtest.mjs).
// The file keeps 20 games per player, so early games in each log have short
// histories; treat small differences as noise.

import fs from "node:fs";
import { gameLogs, SPORTS } from "../src/trends.js";
import { teamContext, matchupFactor, nbaProjection, probAtLeast } from "../src/nba_model.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) || "nba-trend-logs.json";
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MIN = Number(opt("--min", 8));
const STATS = String(opt("--stats", "points,rebounds,assists,threes")).split(",");
const PACE = opt("--pace", "baseline");   // "league" tries ((T+O)/2)/L instead of (T+O-L)/T
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
if (doc.simulated) console.log("NOTE: simulated data file; results only check that the script runs.\n");
if (Number(doc.gamesPerPlayer) > 0) {
  console.log(`NOTE: this file keeps only each player's last ${doc.gamesPerPlayer} games, picked as of its latest date.`);
  console.log("      That favors players who stayed in the rotation (survivorship). For a point-in-time test, build");
  console.log("      the full history:  python compute_nba_logs.py --all --out nba-history.json\n");
}
let cappedN = 0, factorN = 0;
const season = Number(doc.season) || new Date().getUTCFullYear();

const ctxByDate = new Map();
const ctxOn = (d) => { if (!ctxByDate.has(d)) ctxByDate.set(d, teamContext(doc, d)); return ctxByDate.get(d); };
// Opponent of each player-game (gameLogs keeps it on each game).
const brier = (rows, k) => rows.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / rows.length;

for (const stat of STATS) {
  const cutoffs = SPORTS.nba.markets[stat].cutoffs;
  const logs = gameLogs(doc.players, { sport: "nba", stat, season });
  const out = [];
  for (const p of logs.values()) {
    const g = p.games; // newest first
    for (let i = 0; i + MIN < g.length; i++) {
      const target = g[i], prior = g.slice(i + 1);
      const ctx = ctxOn(target.tag);
      const mf = matchupFactor(stat, ctx, target.team, target.opponent, p.position, { paceMode: PACE });
      factorN++; if (mf.capped) cappedN++;
      const withCtx = nbaProjection(prior, mf.factor, stat), noCtx = nbaProjection(prior, 1, stat);
      if (!withCtx) continue;
      const last10 = prior.slice(0, 10).map((x) => x.value);
      for (const c of cutoffs) {
        const hits = last10.filter((v) => v >= c).length;
        out.push({
          y: target.value >= c ? 1 : 0,
          model: probAtLeast(c, withCtx.mean, withCtx.dispersion, { clamp: false }),   // unclamped for scoring
          plain: probAtLeast(c, noCtx.mean, noCtx.dispersion, { clamp: false }),
          hit: (hits + 1) / (last10.length + 2),
        });
      }
    }
  }
  if (!out.length) { console.log(`${stat}: not enough history (need ${MIN + 1}+ games per player)\n`); continue; }
  // Only "live" cutoffs (both outcomes plausible) matter for props; drop near-certain ones.
  const live = out.filter((r) => r.model > 0.05 && r.model < 0.95);
  console.log(`${stat}: ${out.length} predictions (${live.length} with model between 5% and 95%)`);
  console.log(`  Brier  model ${brier(live, "model").toFixed(4)} | model, no matchup ${brier(live, "plain").toFixed(4)} | last-10 rate ${brier(live, "hit").toFixed(4)} | coin flip 0.2500`);
  console.log("  Reliability (model):  predicted  ->  actual   (n)");
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    const bin = live.filter((r) => r.model >= lo && (r.model < hi || (b === 9 && r.model <= 1)));
    if (bin.length < 20) continue;
    const pm = bin.reduce((s, r) => s + r.model, 0) / bin.length, act = bin.reduce((s, r) => s + r.y, 0) / bin.length;
    console.log(`    ${(lo * 100).toFixed(0).padStart(3)}-${(hi * 100).toFixed(0).padEnd(3)}%   ${(pm * 100).toFixed(1).padStart(5)}%  ->  ${(act * 100).toFixed(1).padStart(5)}%   (${bin.length})`);
  }
  // The band the NBA Board uses.
  const band = live.filter((r) => (r.model >= 0.66 && r.model <= 0.75) || (1 - r.model >= 0.66 && 1 - r.model <= 0.75));
  if (band.length >= 20) {
    const pm = band.reduce((s, r) => s + Math.max(r.model, 1 - r.model), 0) / band.length;
    const act = band.reduce((s, r) => s + (r.model >= 0.5 ? r.y : 1 - r.y), 0) / band.length;
    console.log(`  66-75% sides: model said ${(pm * 100).toFixed(1)}%, happened ${(act * 100).toFixed(1)}% (${band.length})`);
  }
  console.log("");
}
console.log(`Matchup factor hit the +/-15% cap in ${factorN ? (100 * cappedN / factorN).toFixed(1) : 0}% of predictions (pace mode: ${PACE}).`);
