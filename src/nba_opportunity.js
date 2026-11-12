// Opportunity projection for NBA points and threes.
//
// Pure functions, no I/O. The idea: a player's VOLUME (shots, free throws, minutes)
// is steady from game to game, while his EFFICIENCY (how many of those go in) is
// mostly noise over a few games. So instead of averaging recent points, this builds
//
//   points = projected minutes x shooting plays per minute x points per shooting play
//   threes = projected minutes x 3-point attempts per minute x 3-point %
//
// where shooting plays = FGA + 0.44 x FTA (the usual possession estimate for free
// throws), volume comes from recent games (weighted toward the newest), and
// efficiency comes from his whole available history, pulled toward the league
// average until he has a large sample (150 shooting plays / 200 three-point
// attempts count as much as the league prior).
//
// Output: a mean, a floor / median / ceiling (10th / 50th / 90th percentile),
// P(stat >= k) for any rung, and a "volume vs results" note that says when recent
// results are running ahead of, or behind, the shots he is getting.
//
// The spread comes from nbaProjection (src/nba_model.js) on the same games, so the
// two models differ only in the mean. Run backtest/nba_opportunity_backtest.mjs
// before trusting it; it is a research estimate, not a pick.

import { nbaProjection, probAtLeast, matchupFactor, nextGame } from "./nba_model.js";
import { normalizeName } from "./model.js";

export const OPP_STATS = ["points", "threes"];
export const FT_WEIGHT = 0.44;
// League priors (2025-26 regular season, from hoopR box scores). Points per shooting
// play is 2 x true-shooting %.
export const LEAGUE = { pps: 1.163, fg3pct: 0.360 };
export const PRIOR_K = { pps: 150, fg3pct: 200 };   // sample size at which his own number counts half
const HISTORY_GAMES = 82;   // efficiency window (he keeps about a season of games)
const VOLUME_GAMES = 20;    // volume window, 0.9^i weights
const MINUTES_GAMES = 10;
export const EFF_DECAY = 1;
// Share of last-5 efficiency kept for flagged players (0 = full regression). Tested at
// 0.15-0.5 over three seasons: cold players were under-projected in 2024-25 (+0.40 pts)
// and over-projected in 2025-26 (-0.55), and every blend made both seasons worse, so 0.
export const FLAG_BLEND = { below: 0, above: 0 };  // efficiency weights per game back (1 = all games equal)   // minutes window, 0.8^i weights (same as nbaProjection)

const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
const fin = (x) => Number.isFinite(x);

/**
 * Per-player logs with the opportunity fields, newest first, from nba-trend-logs.json
 * rows ({ name, team, date, seasonType?, stats: { minutes, points, threes, fga, fta, fg3a, ... } }).
 * Only regular-season and play-in/playoff games strictly before `beforeDate` count.
 * Games without fga (older logs written before the data job stored it) are skipped.
 */
export function opportunityLogs(rows, { beforeDate = "9999-99-99" } = {}) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || !r.stats || !r.date || String(r.date).slice(0, 10) >= beforeDate) continue;
    if (r.seasonType && /pre/i.test(String(r.seasonType))) continue;
    const s = r.stats;
    const g = { date: String(r.date).slice(0, 10), team: r.team, opponent: r.opponent || null,
      minutes: num(s.minutes), points: num(s.points), threes: num(s.threes),
      fga: num(s.fga), fta: num(s.fta), fg3a: num(s.fg3a) };
    if (![g.minutes, g.points, g.threes, g.fga, g.fta, g.fg3a].every(fin) || g.minutes <= 0) continue;
    const norm = r.norm || normalizeName(r.name);
    if (!by.has(norm)) by.set(norm, { norm, name: r.name, team: r.team, games: [] });
    by.get(norm).games.push(g);
  }
  for (const p of by.values()) {
    p.games.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    p.team = p.games[0].team;
  }
  return by;
}

/** doc.efficiency (keyed by player name) -> Map(norm -> totals). */
export function efficiencyIndex(doc) {
  const m = new Map();
  for (const [name, t] of Object.entries((doc && doc.efficiency) || {})) {
    if (t && [t.pts, t.fga, t.fta, t.fg3m, t.fg3a].every((x) => Number.isFinite(Number(x)))) {
      m.set(normalizeName(name), { pts: +t.pts, fga: +t.fga, fta: +t.fta, fg3m: +t.fg3m, fg3a: +t.fg3a, games: +t.games || null });
    }
  }
  return m;
}

/** Smallest k with P(X <= k) >= q under the negative binomial (mean, variance/mean). */
export function nbQuantile(q, mean, dispersion) {
  if (!fin(mean) || mean <= 0) return 0;
  let k = 0;
  while (k < 400) {
    const pLe = 1 - probAtLeast(k + 1, mean, dispersion, { clamp: false });
    if (pLe >= q) return k;
    k++;
  }
  return k;
}

const shootingPlays = (g) => g.fga + FT_WEIGHT * g.fta;

/**
 * Efficiency, regressed toward the league. stat "points" -> points per shooting play;
 * "threes" -> 3-point %. Returns { raw, value, sample }.
 */
export function regressedEfficiency(games, stat, league = LEAGUE, { decay = EFF_DECAY, k = null, totals = null } = {}) {
  const h = games.slice(0, HISTORY_GAMES);
  let made = 0, att = 0;
  // totals: the data job's season-long sums (doc.efficiency), used when they cover
  // more shots than the 20 games kept in the log.
  const tAtt = totals ? (stat === "points" ? totals.fga + FT_WEIGHT * totals.fta : totals.fg3a) : 0;
  const gAtt = h.reduce((a, g) => a + (stat === "points" ? shootingPlays(g) : g.fg3a), 0);
  if (totals && decay === 1 && tAtt > gAtt) { made = stat === "points" ? totals.pts : totals.fg3m; att = tAtt; }
  else h.forEach((g, i) => {
    const w = decay ** i;
    if (stat === "points") { made += w * g.points; att += w * shootingPlays(g); }
    else { made += w * g.threes; att += w * g.fg3a; }
  });
  const prior = stat === "points" ? league.pps : league.fg3pct;
  k ??= stat === "points" ? PRIOR_K.pps : PRIOR_K.fg3pct;
  return { raw: att > 0 ? made / att : null, value: (made + k * prior) / (att + k), sample: att };
}

function volumePerMinute(games, stat, from = 0, to = VOLUME_GAMES) {
  let v = 0, m = 0;
  games.slice(from, to).forEach((g, j) => {
    const w = 0.9 ** j;
    v += w * (stat === "points" ? shootingPlays(g) : g.fg3a); m += w * g.minutes;
  });
  return m > 0 ? v / m : null;
}

/**
 * Volume vs results over the last `n` games: what he scored against what his shots
 * were worth at his regressed efficiency, and whether his volume is rising or falling.
 * Returns { ratio, volumeTrend, flag, note } (flag: "below" | "above" | "role-up" | "role-down" | null).
 * These describe the last 5 games; they are not predictions. In the backtest, players
 * flagged "above" were over-projected by the current model and roughly right in this one;
 * "below" players bounced back only part of the way (this model over-projects them a little).
 */
export const FLAG_RULES = {
  below: 0.85,         // results under 85% of shots x regressed efficiency ...
  above: 1.15,         // ... or over 115%,
  minGap: { points: 12, threes: 3 },   // with at least this many points / threes of difference
  steadyVolume: 0.95,  // "below" also needs last-5 shots per minute >= 0.95 x games 6-20 (shots still there)
  roleUp: 1.25, roleDown: 0.8,         // last-5 vs games 6-20 shots per minute
};
export function volumeVsResults(games, stat, eff, n = 5) {
  const last = games.slice(0, n);
  if (last.length < n || games.length < n + 5) return { ratio: null, volumeTrend: null, flag: null, note: null };
  let actual = 0, expected = 0;
  for (const g of last) {
    actual += stat === "points" ? g.points : g.threes;
    expected += (stat === "points" ? shootingPlays(g) : g.fg3a) * eff;
  }
  const ratio = expected > 0 ? actual / expected : null;
  const recentVol = volumePerMinute(games, stat, 0, n), earlierVol = volumePerMinute(games, stat, n, n + 15);
  const volumeTrend = recentVol && earlierVol ? recentVol / earlierVol : null;
  const pct = (x) => `${Math.round(Math.abs(x - 1) * 100)}%`;
  const what = stat === "points" ? "shots" : "3-point attempts";
  let flag = null, note = null;
  // Results flags need a real gap in expected output, not one missed three.
  const R = FLAG_RULES, minGap = R.minGap[stat];
  if (ratio !== null && ratio < R.below && expected - actual >= minGap && (volumeTrend === null || volumeTrend >= R.steadyVolume)) {
    flag = "below"; note = `Last ${n}: ${stat === "points" ? "scored" : "made"} ${pct(ratio)} below what his ${what} are usually worth`;
  } else if (ratio !== null && ratio > R.above && actual - expected >= minGap) {
    flag = "above"; note = `Last ${n}: ${stat === "points" ? "scored" : "made"} ${pct(ratio)} above what his ${what} are usually worth`;
  } else if (volumeTrend !== null && volumeTrend >= R.roleUp) {
    flag = "role-up"; note = `Last ${n}: ${what} per minute up ${pct(volumeTrend)}`;
  } else if (volumeTrend !== null && volumeTrend <= R.roleDown) {
    flag = "role-down"; note = `Last ${n}: ${what} per minute down ${pct(volumeTrend)}`;
  }
  return { ratio, volumeTrend, flag, note };
}

/**
 * Opportunity projection for one player and stat ("points" | "threes").
 * games: newest first, from opportunityLogs. factor: matchup multiplier (1 = none).
 * opts.totals: { pts, fga, fta, fg3m, fg3a } season-long sums for efficiency (doc.efficiency[norm]).
 * Returns null with fewer than 5 games, else
 *   { mean, dispersion, minutes, volumePerMin, efficiency, efficiencyRaw, sample,
 *     floor, median, ceiling, baseMean, volume: {ratio, volumeTrend, flag, note} }
 * baseMean is the current model's mean (recent points per minute) for comparison.
 */
export function opportunityProjection(games, stat, factor = 1, opts = {}) {
  const { league = LEAGUE, effDecay = EFF_DECAY, k = null, totals = null, flagBlend = FLAG_BLEND, scoringAdj = 1 } = opts;
  if (!OPP_STATS.includes(stat)) return null;
  const g = (games || []).filter((x) => fin(x.minutes) && x.minutes > 0);
  if (g.length < 5) return null;
  const recent = g.slice(0, MINUTES_GAMES);
  let wm = 0, ws = 0;
  recent.forEach((x, i) => { const w = 0.8 ** i; wm += w * x.minutes; ws += w; });
  const minutes = wm / ws;
  const vpm = volumePerMinute(g, stat);
  const eff = regressedEfficiency(g, stat, league, { decay: effDecay, k, totals });
  const volume = volumeVsResults(g, stat, eff.value);
  // Hot / cold: players bounce back (or cool off) only part of the way, so part of
  // the last-5 efficiency is kept (flagBlend[flag], tested in the backtest).
  let effUsed = eff.value;
  const w = volume.flag && flagBlend ? (flagBlend[volume.flag] || 0) : 0;
  if (w > 0) {
    const last = g.slice(0, 5);
    const made = last.reduce((a, x) => a + (stat === "points" ? x.points : x.threes), 0);
    const att = last.reduce((a, x) => a + (stat === "points" ? shootingPlays(x) : x.fg3a), 0);
    if (att > 0) effUsed = w * (made / att) + (1 - w) * eff.value;
  }
  // scoringAdj: league-wide correction from how the projection has done over the last
  // two weeks (scoringCorrection below); 1 = none.
  const mean = Math.max(0.05, minutes * vpm * effUsed * factor * scoringAdj);
  const base = nbaProjection(g.map((x) => ({ value: stat === "points" ? x.points : x.threes, minutes: x.minutes })), factor, stat);
  const dispersion = base ? base.dispersion : (stat === "points" ? 2.5 : 1.4);
  return {
    mean, dispersion, minutes, volumePerMin: vpm, efficiency: effUsed, efficiencyRaw: eff.raw, efficiencyRegressed: eff.value,
    sample: eff.sample, scoringAdj,
    floor: nbQuantile(0.1, mean, dispersion), median: nbQuantile(0.5, mean, dispersion), ceiling: nbQuantile(0.9, mean, dispersion),
    baseMean: base ? base.mean : null,
    volume,
  };
}

/** Mean only (no spread, quantiles or flags), for the scoring correction below. */
export function opportunityMean(games, stat) {
  const g = (games || []).filter((x) => fin(x.minutes) && x.minutes > 0);
  if (g.length < 5) return null;
  let wm = 0, ws = 0;
  g.slice(0, MINUTES_GAMES).forEach((x, i) => { const w = 0.8 ** i; wm += w * x.minutes; ws += w; });
  return Math.max(0.05, (wm / ws) * volumePerMinute(g, stat) * regressedEfficiency(g, stat).value);
}

// League-wide scoring correction (points). Early in 2026-27 every projection ran about
// 1 point (9%) high: scoring is down and players' roles from last season didn't carry
// over, while the same check on the 2024-25 -> 2025-26 changeover showed no bias. A
// fixed adjustment would be wrong one season and right the next, so the projection
// corrects itself instead: over the last 14 days of completed games, actual points vs
// what it projected (walk-forward, 10+ earlier games), pulled toward "no correction"
// as if 600 more player-games had come in exactly as projected. Backtest (2024-25 to
// 2026-27, 20-game history): 2026-27 points log loss 0.4814 -> 0.4779, calibration at
// 70-80% from 63% actual to 71%; 2024-25 0.5026 -> 0.5027 (no bias there to fix).
// Not applied to 3-pointers (no bias there; no gain).
export const CORRECTION = { stats: ["points"], windowDays: 14, minPrior: 10, priorGames: 600, typicalMean: { points: 11, threes: 1.2 } };

/**
 * Correction factor as of `asOf` ("YYYY-MM-DD"; games strictly before it count) from
 * opportunityLogs output. Returns { factor, games, actual, projected }.
 */
export function scoringCorrection(logs, stat, asOf, cfg = CORRECTION) {
  if (!cfg.stats.includes(stat)) return { factor: 1, games: 0, actual: 0, projected: 0 };
  const end = Date.parse(asOf + "T00:00:00Z"), start = end - cfg.windowDays * 864e5;
  let y = 0, m = 0, n = 0;
  for (const p of logs.values()) {
    const g = p.games;
    for (let i = 0; i < g.length; i++) {
      const t = Date.parse(g[i].date + "T00:00:00Z");
      if (t >= end) continue;
      if (t < start) break;                              // newest first: the rest are older
      const prior = g.slice(i + 1, i + 21);
      if (prior.length < cfg.minPrior) continue;
      const mean = opportunityMean(prior, stat);
      if (mean === null) continue;
      y += stat === "points" ? g[i].points : g[i].threes; m += mean; n++;
    }
  }
  const K = cfg.priorGames * cfg.typicalMean[stat];
  return { factor: (y + K) / (m + K), games: n, actual: y, projected: m };
}

export function correctionNote(c) {
  if (!c || c.factor === 1 || !c.games) return "";
  const pct = Math.round((c.factor - 1) * 1000) / 10;
  return ` Scoring correction ${pct > 0 ? "+" : ""}${pct}%: over the last two weeks players scored ${Math.round(c.actual)} points against ${Math.round(c.projected)} projected (${c.games} games).`;
}

/** The correction for the next game day: games before the day after the newest logged game. */
export function currentCorrection(logs, stat) {
  let newest = "";
  for (const p of logs.values()) if (p.games.length && p.games[0].date > newest) newest = p.games[0].date;
  if (!newest) return { factor: 1, games: 0, actual: 0, projected: 0, asOf: null };
  const asOf = new Date(Date.parse(newest + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
  return { ...scoringCorrection(logs, stat, asOf), asOf };
}

/** P(stat >= k) from an opportunity projection. */
export const oppProbAtLeast = (k, proj, opts) => (proj ? probAtLeast(k, proj.mean, proj.dispersion, opts) : null);

/**
 * NBA Tendency Matrix: add r.opportunity to each grid row (points and threes only),
 * with the same matchup factor the Model % column uses. P(over/under) only when the
 * row has a line. Rows keep r.opportunity = null when the logs have no shot data yet.
 */
export function decorateOpportunity(grid, doc, { stat, ctx = null, nowMs = Date.now() } = {}) {
  if (!OPP_STATS.includes(stat)) return grid;
  const logs = opportunityLogs((doc && doc.players) || []), eff = efficiencyIndex(doc);
  const corr = currentCorrection(logs, stat);
  let n = 0;
  for (const r of grid.rows) {
    const p = logs.get(r.norm);
    const ng = nextGame(doc, r.team, nowMs);
    const mf = ctx && ng ? matchupFactor(stat, ctx, r.team, ng.opp, r.position) : { factor: 1 };
    const o = p ? opportunityProjection(p.games, stat, mf.factor, { totals: eff.get(r.norm) || null, scoringAdj: corr.factor }) : null;
    r.opportunity = o ? {
      mean: o.mean, floor: o.floor, median: o.median, ceiling: o.ceiling,
      pOver: r.line === null || r.line === undefined ? null : probAtLeast(Math.floor(r.line) + 1, o.mean, o.dispersion),
      pUnder: r.line === null || r.line === undefined ? null : 1 - probAtLeast(Math.ceil(r.line), o.mean, o.dispersion),
      volumePerMin: o.volumePerMin, efficiency: o.efficiency, efficiencyRaw: o.efficiencyRaw,
      flag: o.volume.flag, note: o.volume.note, scoringAdj: o.scoringAdj,
    } : null;
    if (o) n++;
  }
  grid.opportunity = { stat, rows: n, correction: corr, note: n ? "Proj = opportunity projection: projected minutes x shots per minute x shooting efficiency pulled toward the league average. Range = 10th to 90th percentile." + correctionNote(corr) : "No shot data in the logs yet (the data job adds it on its next run)." };
  return grid;
}
