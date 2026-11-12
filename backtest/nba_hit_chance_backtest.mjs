// Hit chance (src/hit_chance.js): fit and walk-forward test, plus the points-spread check.
//
//   node backtest/nba_hit_chance_backtest.mjs <box file> [--check] [--spread]
//
// <box file>: hoopR player box JSON for three or more seasons (backtest/hoopr_box.mjs;
// include the season before the first one you grade so early games have history).
//
// For every regular-season player-game with 10+ earlier games and a game in the last 21
// days, and every Kalshi-style rung (points 5..45, rebounds 2..16, assists 2..14,
// 3-pointers 1..6) where an estimate is between 3% and 97%:
//   - the starting probability is what the Board shows: Proj where it exists (points,
//     3-pointers, with the 14-day scoring correction), otherwise the Model; both with
//     the app's matchup factor, built from team context as of that date
//   - hitFeatures() (the app's own function) adds the long-run share, the long-run rate
//     and last-game minutes, from games strictly before the target
//   - a logistic fit per stat, trained on earlier seasons and scored on the next one
// Prints log loss before and after per stat and test season, calibration of the result,
// and the coefficients fit on all seasons in the form src/hit_chance.js pins.
// --check exits 1 if those differ from HIT_COEF by more than 0.02.
// --spread prints log loss by spread multiplier per stat and season (the SPREAD_ADJ check).
import fs from "node:fs";
import { nbaProjection, probAtLeast, teamContext, matchupFactor, SPREAD_ADJ } from "../src/nba_model.js";
import { opportunityProjection, opportunityMean, CORRECTION } from "../src/nba_opportunity.js";
import { hitFeatures, HIT_COEF, HIT_WINDOWS } from "../src/hit_chance.js";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const BOX = args.find((a) => !a.startsWith("--"));
if (!BOX) { console.error("usage: node backtest/nba_hit_chance_backtest.mjs <box file> [--check] [--spread]"); process.exit(1); }
const NBA = new Set("ATL BOS BKN CHA CHI CLE DAL DEN DET GS GSW HOU IND LAC LAL MEM MIA MIL MIN NO NOP NY NYK OKC ORL PHI PHX POR SAC SA SAS TOR UTAH UTA WSH WAS".split(" "));
const games = [];
for (const r of JSON.parse(fs.readFileSync(BOX, "utf8"))) {
  if (r.did_not_play || r.season_type === 1 || !NBA.has(String(r.team_abbreviation || "")) || !NBA.has(String(r.opponent_team_abbreviation || ""))) continue;
  const g = { name: r.athlete_display_name, norm: normalizeName(r.athlete_display_name), date: r.date, season: r.season, type: r.season_type, team: r.team_abbreviation,
    opp: r.opponent_team_abbreviation, starter: !!r.starter, pos: r.athlete_position_abbreviation, gameId: r.game_id,
    minutes: +r.minutes, points: +r.points, rebounds: +r.rebounds, assists: +r.assists, threes: +r.three_point_field_goals_made,
    orb: +r.offensive_rebounds || 0, tov: +r.turnovers || 0, fga: +r.field_goals_attempted, fta: +r.free_throws_attempted, fg3a: +r.three_point_field_goals_attempted };
  if (![g.minutes, g.points, g.rebounds, g.assists, g.threes, g.fga, g.fta, g.fg3a].every(Number.isFinite) || g.minutes <= 0) continue;
  games.push(g);
}
const byPlayer = new Map();
for (const g of games) (byPlayer.get(g.norm) || byPlayer.set(g.norm, []).get(g.norm)).push(g);
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));   // newest first
const seasons = [...new Set(games.map((g) => g.season))].sort();
const dayN = (d) => Date.parse(d + "T00:00:00Z") / 864e5;

// the app's 14-day scoring correction (points), walk-forward
const daily = new Map();
for (const arr of byPlayer.values()) for (let i = 0; i + CORRECTION.minPrior < arr.length; i++) {
  const m = opportunityMean(arr.slice(i + 1, i + 21), "points"); if (m === null) continue;
  const d = dayN(arr[i].date), c = daily.get(d) || daily.set(d, { y: 0, m: 0 }).get(d);
  c.y += arr[i].points; c.m += m;
}
const corr = new Map();
const correction = (date) => {
  const D = dayN(date);
  if (!corr.has(D)) { let y = 0, m = 0; for (let d = D - CORRECTION.windowDays; d < D; d++) { const c = daily.get(d); if (c) { y += c.y; m += c.m; } }
    const K = CORRECTION.priorGames * CORRECTION.typicalMean.points; corr.set(D, (y + K) / (m + K)); }
  return corr.get(D);
};

// the app's team context as of each date (pace, defense, defense vs position)
const tg = new Map();
for (const g of games) { if (g.type !== 2) continue; const k = g.gameId + "|" + g.team;
  const t = tg.get(k) || tg.set(k, { g: String(g.gameId), d: g.date, s: g.season - 1, t: g.team, o: g.opp, pts: 0, fga: 0, fta: 0, orb: 0, tov: 0, min: 0 }).get(k);
  t.pts += g.points; t.fga += g.fga; t.fta += g.fta; t.orb += g.orb; t.tov += g.tov; t.min += g.minutes; }
const teamGames = [];
for (const t of tg.values()) { const o = tg.get(t.g + "|" + t.o); if (!o) continue; const poss = (x) => x.fga - x.orb + x.tov + 0.44 * x.fta;
  teamGames.push({ g: t.g, d: t.d, s: t.s, t: t.t, o: t.o, pts: t.pts, opp: o.pts, poss: Math.round((poss(t) + poss(o)) / 2 * 10) / 10, min: Math.max(240, Math.round(t.min / 5) * 5) }); }
const doc = { teamGames, players: games.filter((g) => g.type === 2).map((g) => ({ name: g.name, norm: g.norm, date: g.date, season: g.season - 1, seasonType: "Regular Season",
  team: g.team, opponent: g.opp, position: g.pos, starter: g.starter, stats: { points: g.points, rebounds: g.rebounds, assists: g.assists, threes: g.threes } })) };
const ctxCache = new Map();
const ctxOn = (date) => { if (!ctxCache.has(date)) ctxCache.set(date, teamContext(doc, date)); return ctxCache.get(date); };

const RUNGS = { points: [5, 10, 15, 20, 25, 30, 35, 40, 45], rebounds: [2, 4, 6, 8, 10, 12, 14, 16], assists: [2, 4, 6, 8, 10, 12, 14], threes: [1, 2, 3, 4, 5, 6] };
const STATS = Object.keys(RUNGS);
// rows[stat][window] = [{ season, y, p (starting), x }]; spreadRows for --spread
const rows = Object.fromEntries(STATS.map((s) => [s, { 20: [], 40: [] }]));
const spreadRows = Object.fromEntries(STATS.map((s) => [s, []]));
let nGames = 0;
for (const arr of byPlayer.values()) {
  for (let i = 0; i + 10 < arr.length; i++) {
    const t = arr[i];
    if (t.type !== 2 || t.season === seasons[0]) continue;       // first season in the file is history only
    const prior = arr.slice(i + 1);
    if (prior[0].date >= t.date) throw new Error(`prior game on/after target: ${t.name} ${t.date}`);
    if (dayN(t.date) - dayN(prior[0].date) > 21) continue;        // the Board skips players with no game in 21 days
    nGames++;
    for (const stat of STATS) {
      const F = matchupFactor(stat, ctxOn(t.date), t.team, t.opp, prior[0].pos).factor;
      const base = nbaProjection(prior.slice(0, 20).map((x) => ({ value: x[stat], minutes: x.minutes })), F, stat);
      if (!base) continue;
      const opp = stat === "points" || stat === "threes" ? opportunityProjection(prior.slice(0, 82), stat, F, { scoringAdj: stat === "points" ? correction(t.date) : 1 }) : null;
      const hist = prior.slice(0, 40).map((x) => ({ value: x[stat], minutes: x.minutes }));
      for (const k of RUNGS[stat]) {
        const pM = probAtLeast(k, base.mean, base.dispersion, { clamp: false });
        const pP = opp ? probAtLeast(k, opp.mean, opp.dispersion, { clamp: false }) : null;
        if ((pM < 0.03 || pM > 0.97) && (pP === null || pP < 0.03 || pP > 0.97)) continue;
        const p = pP === null ? pM : pP, y = t[stat] >= k ? 1 : 0;
        const inp = { pOver: p, strike: k, modelMean: base.mean, projMinutes: base.minutes, factor: F };
        const f20 = hitFeatures({ ...inp, games: hist.slice(0, 20) });
        if (f20) rows[stat][20].push({ season: t.season, y, p, x: f20.x });
        if (hist.length >= HIT_WINDOWS.longMin) { const f40 = hitFeatures({ ...inp, games: hist }); rows[stat][40].push({ season: t.season, y, p, x: f40.x }); }
        spreadRows[stat].push({ season: t.season, y, k, mean: base.mean, disp: base.dispersion / (SPREAD_ADJ[stat] ?? 1) });
      }
    }
  }
}
console.log(`${nGames} player-games graded, seasons ${seasons.slice(1).join(", ")} (hoopR names a season by the year it ends)\n`);

// ---- logistic regression by Newton's method ----
function fit(R) {
  const d = R[0].x.length; let b = new Array(d).fill(0); b[1] = 1;
  for (let it = 0; it < 30; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (const r of R) {
      let z = 0; for (let j = 0; j < d; j++) z += b[j] * r.x[j];
      const p = 1 / (1 + Math.exp(-z)), w = p * (1 - p);
      for (let j = 0; j < d; j++) { g[j] += (r.y - p) * r.x[j]; for (let k = 0; k <= j; k++) H[j][k] += w * r.x[j] * r.x[k]; }
    }
    for (let j = 0; j < d; j++) for (let k = j + 1; k < d; k++) H[j][k] = H[k][j];
    const step = solve(H, g); let mx = 0;
    for (let j = 0; j < d; j++) { b[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-7) break;
  }
  return b;
}
function solve(A, y) {
  const n = y.length, M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}
const predict = (b, x) => { let z = 0; for (let j = 0; j < b.length; j++) z += b[j] * x[j]; return 1 / (1 + Math.exp(-z)); };
const ll = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const graded = seasons.slice(1);
console.log("Log loss, walk-forward (train on earlier seasons, score the next). 'before' = the Board's starting probability.");
const tot = { n: 0, before: 0, after: 0 }, cal = new Map();
for (const w of [20, 40]) for (const stat of STATS) {
  for (let i = 1; i < graded.length; i++) {
    const train = rows[stat][w].filter((r) => r.season < graded[i]), test = rows[stat][w].filter((r) => r.season === graded[i]);
    if (!train.length || !test.length) continue;
    const b = fit(train);
    const before = mean(test.map((r) => ll(r.p, r.y))), after = mean(test.map((r) => ll(predict(b, r.x), r.y)));
    console.log(`  ${w}-game table  ${stat.padEnd(9)} test ${graded[i]}  n ${String(test.length).padStart(6)}  before ${before.toFixed(4)}  after ${after.toFixed(4)}  (${(after - before).toFixed(4)})`);
    if (w === 40) { tot.n += test.length; tot.before += before * test.length; tot.after += after * test.length; }
    for (const r of test) for (const [side, p, y] of [["Over", predict(b, r.x), r.y], ["Under", 1 - predict(b, r.x), 1 - r.y]]) {
      if (p < 0.66) continue;
      const bk = p < 0.75 ? "66-75" : p < 0.85 ? "75-85" : p < 0.95 ? "85-95" : "95+", key = `${w}|${side}|${bk}`;
      const c = cal.get(key) || cal.set(key, { n: 0, p: 0, y: 0 }).get(key); c.n++; c.p += p; c.y += y;
    }
  }
}
console.log(`  40-game table, all stats: before ${(tot.before / tot.n).toFixed(4)}  after ${(tot.after / tot.n).toFixed(4)}\n`);
console.log("Calibration of the hit chance on the test seasons (stated -> actual):");
for (const [k, c] of [...cal].sort()) console.log(`  ${k.padEnd(16)} n ${String(c.n).padStart(7)}  ${(100 * c.p / c.n).toFixed(1)}% -> ${(100 * c.y / c.n).toFixed(1)}%`);

console.log("\nCoefficients fit on all graded seasons (paste into HIT_COEF):");
const r3 = (v) => Math.round(v * 1000) / 1000;
const all = { 20: {}, 40: {} }; let worst = 0;
for (const w of [20, 40]) {
  for (const stat of STATS) { all[w][stat] = fit(rows[stat][w]).map(r3); const pin = HIT_COEF[w][stat]; all[w][stat].forEach((v, j) => { worst = Math.max(worst, Math.abs(v - pin[j])); }); }
  console.log(`  ${w}: { ${STATS.map((s) => `${s}: [${all[w][s].join(", ")}]`).join(", ")} },`);
}
console.log(`Largest difference from the pinned HIT_COEF: ${worst.toFixed(3)}`);

if (args.includes("--spread")) {
  console.log("\nLog loss of the Model by spread multiplier (1.0 = no adjustment):");
  const mults = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5];
  for (const stat of STATS) for (const s of graded) {
    const R = spreadRows[stat].filter((r) => r.season === s);
    const v = mults.map((m) => mean(R.map((r) => ll(probAtLeast(r.k, r.mean, Math.max(1.02, r.disp * m), { clamp: false }), r.y))));
    console.log(`  ${stat.padEnd(9)} ${s}  ${mults.map((m, i) => `x${m}: ${v[i].toFixed(4)}`).join("  ")}  best x${mults[v.indexOf(Math.min(...v))]}`);
  }
}
if (args.includes("--check") && worst > 0.02) { console.error("HIT_COEF is out of date"); process.exit(1); }
