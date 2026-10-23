// NBA matchup context and a simple count model for player props.
//
// Pure functions, no I/O. Used by the NBA Tendency Matrix (Opp / Pace / DRtg /
// DvP columns, Model % for an entered line) and the NBA Board (Kalshi ladders
// ranked by model probability), and by backtest/nba_model_calibration.mjs.
//
// The NBA's closest thing to DVOA is an opponent-adjusted defensive rating
// (points allowed per 100 possessions). For player props, pace (possessions per
// 48 minutes) matters about as much, and "defense vs position" (what a team
// allows to opposing guards / forwards / centers) adds a little more. All three
// are computed here from nba-trend-logs.json as of a date, so a backtest never
// sees games after the one it is predicting.
//
// The model: per-minute rate (recent games weighted more) x projected minutes x
// a capped matchup factor, then a negative binomial distribution whose spread
// comes from the player's own game-to-game variation. It is an estimate, not a
// pick. Before trusting it, run the calibration backtest; the NFL model did not
// beat the market's own prices in testing.

import { gameLogs } from "./trends.js";
import { injuryFor, teammatesOut, PLAY_PROBABILITY } from "./nba_injuries.js";

export const DVP_STATS = ["points", "rebounds", "assists", "threes", "pra", "pr", "pa", "ra"];
const SCORING = new Set(["points", "pra", "pr", "pa", "threes"]);
const PRIOR_TEAM_GAMES = 10;     // last season counts as 10 games of evidence, fading as this season builds up
const PRIOR_DVP_APPS = 30;       // same idea for defense-vs-position (starter appearances)
const MIN_DVP_APPS = 8;
// Typical variance-to-mean ratio of each stat for one player, used to steady the
// estimate from a short log (points and combos vary far more than a Poisson count).
export const PRIOR_DISPERSION = { points: 2.5, pra: 3.0, pr: 2.8, pa: 2.8, rebounds: 1.5, assists: 1.5, ra: 1.6,
  threes: 1.4, steals: 1.15, blocks: 1.3, stocks: 1.25, turnovers: 1.2 };

export function posGroup(pos) {
  const c = String(pos || "").trim().toUpperCase().charAt(0);
  return c === "G" || c === "F" || c === "C" ? c : null;
}

const ymd = (d) => String(d || "").slice(0, 10);

function rankMap(entries, higherIsFirst) {
  const sorted = entries.filter(([, v]) => Number.isFinite(v)).sort((a, b) => (higherIsFirst ? b[1] - a[1] : a[1] - b[1]));
  const out = {};
  sorted.forEach(([k], i) => { out[k] = i + 1; });
  return { ranks: out, size: sorted.length };
}

// Blend this season with last season: n games this season count fully, last
// season counts as up to PRIOR games, so early in the year the numbers lean on
// last season and by mid-season they are this season's.
function blend(cur, nCur, prev, nPrev, prior) {
  const k = Number.isFinite(prev) && nPrev > 0 ? Math.min(prior, nPrev) : 0;
  if (!nCur && !k) return null;
  if (!nCur) return prev;
  if (!k) return cur;
  return (nCur * cur + k * prev) / (nCur + k);
}

/**
 * Team pace, offensive/defensive rating and defense-vs-position, as of a date.
 * doc: nba-trend-logs.json. asOf: "YYYY-MM-DD" (games strictly before it count).
 * Returns null fields when the data has no teamGames (stats.nba.com fallback).
 */
export function teamContext(doc, asOf) {
  const cut = asOf ? ymd(asOf) : "9999-99-99";
  const tgs = (doc && Array.isArray(doc.teamGames) ? doc.teamGames : []).filter((g) => ymd(g.d) < cut);
  const rows = (doc && Array.isArray(doc.players) ? doc.players : []).filter((r) => ymd(r.date) < cut &&
    (!r.seasonType || String(r.seasonType).toLowerCase().startsWith("regular")));
  const curSeason = Math.max(...tgs.map((g) => Number(g.s)).filter(Number.isFinite),
    ...rows.map((r) => Number(r.season)).filter(Number.isFinite), -Infinity);

  // Pace and ratings from possession estimates.
  const acc = {};
  for (const g of tgs) {
    if (![g.pts, g.opp, g.poss, g.min].every((x) => Number.isFinite(Number(x))) || !g.t) continue;
    const which = Number(g.s) === curSeason ? "cur" : Number(g.s) === curSeason - 1 ? "prev" : null;
    if (!which) continue;
    const a = (acc[g.t] ||= { cur: { n: 0, pts: 0, opp: 0, poss: 0, min: 0 }, prev: { n: 0, pts: 0, opp: 0, poss: 0, min: 0 } })[which];
    a.n++; a.pts += +g.pts; a.opp += +g.opp; a.poss += +g.poss; a.min += +g.min;
  }
  const rate = (a) => a.n ? { pace: 48 * a.poss / (a.min / 5), ortg: 100 * a.pts / a.poss, drtg: 100 * a.opp / a.poss } : {};
  const teams = {};
  for (const [t, a] of Object.entries(acc)) {
    const c = rate(a.cur), p = rate(a.prev);
    teams[t] = {
      games: a.cur.n, priorGames: a.prev.n,
      pace: blend(c.pace, a.cur.n, p.pace, a.prev.n, PRIOR_TEAM_GAMES),
      ortg: blend(c.ortg, a.cur.n, p.ortg, a.prev.n, PRIOR_TEAM_GAMES),
      drtg: blend(c.drtg, a.cur.n, p.drtg, a.prev.n, PRIOR_TEAM_GAMES),
    };
  }
  const vals = (k) => Object.values(teams).map((t) => t[k]).filter(Number.isFinite);
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const league = { pace: mean(vals("pace")), ortg: mean(vals("ortg")), drtg: mean(vals("drtg")), teams: Object.keys(teams).length };
  const pr = rankMap(Object.entries(teams).map(([t, v]) => [t, v.pace]), true);    // 1 = fastest
  const dr = rankMap(Object.entries(teams).map(([t, v]) => [t, v.drtg]), false);   // 1 = best defense
  for (const t of Object.keys(teams)) { teams[t].paceRank = pr.ranks[t] ?? null; teams[t].drtgRank = dr.ranks[t] ?? null; }

  // Defense vs position: average allowed per opposing player of that position
  // (with cdn.nba.com data, positions are only listed for starters, so this is
  // "per opposing starter").
  const dv = {};
  for (const r of rows) {
    const grp = posGroup(r.position), opp = r.opponent;
    if (!grp || !opp || !r.stats) continue;
    const which = Number(r.season) === curSeason ? "cur" : Number(r.season) === curSeason - 1 ? "prev" : null;
    if (!which) continue;
    const cell = ((dv[opp] ||= {})[grp] ||= { cur: { n: 0 }, prev: { n: 0 } })[which];
    cell.n++;
    for (const s of DVP_STATS) { const v = Number(r.stats[s]); if (Number.isFinite(v)) cell[s] = (cell[s] || 0) + v; }
  }
  const dvp = {}, dvpLeague = {};
  for (const [t, groups] of Object.entries(dv)) {
    for (const [grp, c] of Object.entries(groups)) {
      for (const s of DVP_STATS) {
        const cur = c.cur.n ? (c.cur[s] || 0) / c.cur.n : null, prev = c.prev.n ? (c.prev[s] || 0) / c.prev.n : null;
        const v = blend(cur, c.cur.n, prev, c.prev.n, PRIOR_DVP_APPS);
        if (v === null || c.cur.n + Math.min(PRIOR_DVP_APPS, c.prev.n) < MIN_DVP_APPS) continue;
        ((dvp[t] ||= {})[grp] ||= {})[s] = { avg: v, n: c.cur.n, priorN: c.prev.n };
      }
    }
  }
  for (const grp of ["G", "F", "C"]) {
    for (const s of DVP_STATS) {
      const entries = Object.entries(dvp).filter(([, g]) => g[grp] && g[grp][s]).map(([t, g]) => [t, g[grp][s].avg]);
      if (!entries.length) continue;
      (dvpLeague[grp] ||= {})[s] = mean(entries.map((e) => e[1]));
      const rk = rankMap(entries, false); // 1 = allows the least (toughest), N = allows the most (softest)
      for (const [t] of entries) { dvp[t][grp][s].rank = rk.ranks[t]; dvp[t][grp][s].of = rk.size; }
    }
  }
  return { asOf: asOf || null, season: Number.isFinite(curSeason) ? curSeason : null, teams, league, dvp, dvpLeague,
    hasPace: Object.keys(teams).length > 0 };
}

/** The team's next game that has not tipped off yet (from doc.upcoming). */
export function nextGame(doc, team, nowMs = Date.now()) {
  if (!team) return null;
  for (const g of (doc && doc.upcoming) || []) {
    if (g.home !== team && g.away !== team) continue;
    const tip = Date.parse(g.tip);
    if (!Number.isFinite(tip) || tip <= nowMs) continue;
    return { gameId: g.g, date: g.date, tip: g.tip, home: g.home === team, opp: g.home === team ? g.away : g.home };
  }
  return null;
}

/**
 * Matchup multiplier for one stat, capped at +/-15%.
 *  pace:     expected game pace relative to the team's OWN pace (its baseline games
 *            were played at about its own pace, against a mix of opponents). With
 *            additive team effects, expected pace = team + opponent - league, so the
 *            change is (T + O - L) / T. opts.paceMode = "league" uses the alternative
 *            ((T + O) / 2) / L instead, for comparison in the calibration backtest.
 *  defense:  opponent DRtg vs league (scoring stats only), half weight
 *  position: what the opponent allows to this position vs league, quarter weight.
 *            For scoring stats it is divided by the opponent's overall DRtg ratio
 *            first, so a team that is bad at all defense isn't counted twice.
 * Weights are judgment calls, not fitted. `capped` says the +/-15% cap was hit.
 */
export function matchupFactor(stat, ctx, team, opp, pos, opts = {}) {
  const parts = { pace: 1, defense: 1, position: 1 };
  if (!ctx || !opp) return { factor: 1, parts, capped: false };
  const T = ctx.teams[team], O = ctx.teams[opp], L = ctx.league;
  if (T && O && Number.isFinite(T.pace) && Number.isFinite(O.pace) && Number.isFinite(L.pace)) {
    parts.pace = opts.paceMode === "league" ? ((T.pace + O.pace) / 2) / L.pace : (T.pace + O.pace - L.pace) / T.pace;
  }
  let drtgRatio = null;
  if (SCORING.has(stat) && O && Number.isFinite(O.drtg) && Number.isFinite(L.drtg)) {
    drtgRatio = O.drtg / L.drtg;
    parts.defense = 1 + 0.5 * (drtgRatio - 1);
  }
  const grp = posGroup(pos);
  const d = grp && ctx.dvp[opp] && ctx.dvp[opp][grp] && ctx.dvp[opp][grp][stat];
  const lg = grp && ctx.dvpLeague[grp] && ctx.dvpLeague[grp][stat];
  if (d && lg) {
    const pr = (d.avg / lg) / (drtgRatio || 1);     // positional part beyond overall defense
    parts.position = 1 + 0.25 * (pr - 1);
  }
  const raw = parts.pace * parts.defense * parts.position;
  const factor = Math.min(1.15, Math.max(0.85, raw));
  return { factor, parts, raw, capped: factor !== raw };
}

// Per-minute (rate) dispersion priors: how much a stat varies beyond Poisson for a
// FIXED number of minutes. Minutes uncertainty is added separately below.
export const PRIOR_RATE_DISPERSION = { points: 2.2, pra: 2.6, pr: 2.4, pa: 2.4, rebounds: 1.4, assists: 1.4, ra: 1.5,
  threes: 1.3, steals: 1.1, blocks: 1.25, stocks: 1.2, turnovers: 1.15 };
// Low-count stats: 20 games say little about their dispersion, so the prior counts for more.
const DISP_PSEUDO = { threes: 15, steals: 15, blocks: 15, stocks: 15, turnovers: 15 };
const PRIOR_MIN_SD = 4.5, MIN_PSEUDO = 5;   // typical game-to-game minutes spread (minutes), prior worth 5 games

/**
 * Projection from a player's games (newest first: [{ value, minutes }]).
 * Mean = per-minute rate (0.9^i weights) x projected minutes (0.8^i weights, last 10) x factor.
 * Variance by the law of total variance, so the spread matches how the mean is built:
 *   Var = E[minutes] * rate * d_rate * (1 + 1/n_eff)   count noise at a fixed minutes load,
 *                                                       widened for uncertainty in the rate
 *       + (rate * factor)^2 * Var(minutes)              uncertainty in tonight's minutes
 * d_rate comes from residuals of value against rate x actual minutes, shrunk toward
 * PRIOR_RATE_DISPERSION; Var(minutes) from recent minutes around the projection,
 * shrunk toward a 4.5-minute spread. Without minutes data it falls back to the
 * dispersion of the raw values.
 * Returns { mean, dispersion, n, minutes, minutesSd, rateDispersion } or null with < 3 games.
 */
export function nbaProjection(games, factor = 1, stat = null) {
  const g = (games || []).filter((x) => Number.isFinite(x.value)).slice(0, 20);
  const n = g.length;
  if (n < 3) return null;
  const priorD = PRIOR_RATE_DISPERSION[stat] ?? 1.4, pseudo = DISP_PSEUDO[stat] ?? 8;
  const effN = (len, decay) => { let sw = 0, sw2 = 0; for (let i = 0; i < len; i++) { const w = decay ** i; sw += w; sw2 += w * w; } return (sw * sw) / sw2; };
  const withMin = g.map((x, i) => ({ ...x, i })).filter((x) => Number.isFinite(x.minutes) && x.minutes > 0);

  if (withMin.length >= 3) {
    let sv = 0, sm = 0;
    for (const x of withMin) { const w = 0.9 ** x.i; sv += w * x.value; sm += w * x.minutes; }
    const rate = sv / sm;
    const recent = withMin.slice(0, 10);
    let wm = 0, ws = 0;
    for (const x of recent) { const w = 0.8 ** x.i; wm += w * x.minutes; ws += w; }
    const minutes = wm / ws;
    // Rate dispersion from residuals at each game's actual minutes.
    const k = withMin.length;
    let rss = 0, expSum = 0;
    for (const x of withMin) { const e = rate * x.minutes; rss += (x.value - e) ** 2; expSum += e; }
    let dRate = expSum > 0 ? (rss / expSum) * (k / Math.max(1, k - 1)) : priorD;
    dRate = (k * dRate + pseudo * priorD) / (k + pseudo);
    dRate = Math.max(1.0, dRate);
    // Minutes spread around the projection, recent games.
    let mss = 0;
    for (const x of recent) mss += (x.minutes - minutes) ** 2;
    const mVar = recent.length > 1 ? mss / (recent.length - 1) : PRIOR_MIN_SD ** 2;
    const minVar = (recent.length * mVar + MIN_PSEUDO * PRIOR_MIN_SD ** 2) / (recent.length + MIN_PSEUDO);
    const mean = Math.max(0.05, rate * minutes * factor);
    const variance = mean * dRate * (1 + 1 / effN(k, 0.9)) + (rate * factor) ** 2 * minVar;
    const disp = Math.min(10, Math.max(1.02, variance / mean));
    return { mean, dispersion: disp, n, minutes, minutesSd: Math.sqrt(minVar), rateDispersion: dRate };
  }
  // No minutes: weighted mean of values, dispersion of the raw values.
  let sv = 0, sw = 0;
  g.forEach((x, i) => { const w = 0.9 ** i; sv += w * x.value; sw += w; });
  const vals = g.map((x) => x.value);
  const avg = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((a, v) => a + (v - avg) ** 2, 0) / Math.max(1, n - 1);
  const priorTotal = (PRIOR_DISPERSION[stat] ?? 1.5);
  let disp = avg > 0 ? variance / avg : priorTotal;
  disp = (n * disp + pseudo * priorTotal) / (n + pseudo) * (1 + 1 / effN(n, 0.9));
  disp = Math.min(10, Math.max(1.02, disp));
  return { mean: Math.max(0.05, (sv / sw) * factor), dispersion: disp, n, minutes: null, minutesSd: null, rateDispersion: null };
}

/** P(X >= k) under a negative binomial with the given mean and variance/mean ratio. */
export function probAtLeast(k, mean, dispersion, { clamp = true } = {}) {
  if (!Number.isFinite(k) || !Number.isFinite(mean)) return null;
  if (k <= 0) return 1;
  let logPmf, step;
  if (dispersion <= 1.0001) {               // Poisson
    logPmf = -mean;
    step = (x) => Math.log(mean) - Math.log(x + 1);
  } else {
    const r = mean / (dispersion - 1), q = 1 / dispersion;
    logPmf = r * Math.log(q);
    step = (x) => Math.log(x + r) - Math.log(x + 1) + Math.log(1 - q);
  }
  let cdf = 0;
  for (let x = 0; x < k; x++) { cdf += Math.exp(logPmf); logPmf += step(x); }
  const p = Math.min(1, Math.max(0, 1 - cdf));
  return clamp ? Math.min(0.999, Math.max(0.001, p)) : p;   // the display floor; backtests score unclamped
}

/** P(over a line): an "X+" rung is line X - 0.5; a whole-number line pushes at X. */
export const probOver = (line, proj) => (proj ? probAtLeast(Math.floor(line) + 1, proj.mean, proj.dispersion) : null);
export const probUnder = (line, proj) => (proj ? 1 - probAtLeast(Math.ceil(line), proj.mean, proj.dispersion) : null);

// ---------------------------------------------------------------------------
// NBA Tendency Matrix: add Opp / Pace / DRtg / DvP and Model % to grid rows.
// ---------------------------------------------------------------------------
export function decorateNbaGrid(grid, doc, { stat, season, nowMs = Date.now(), ctx = null, injuries = null } = {}) {
  ctx ||= teamContext(doc, null);
  const logs = gameLogs(doc.players || [], { sport: "nba", stat, season });
  for (const r of grid.rows) {
    const p = logs.get(r.norm);
    const ng = nextGame(doc, r.team, nowMs);
    const mf = matchupFactor(stat, ctx, r.team, ng && ng.opp, r.position);
    const proj = p ? nbaProjection(p.games, ng ? mf.factor : 1, stat) : null;
    const O = ng && ctx.teams[ng.opp];
    const grp = posGroup(r.position);
    const d = ng && grp && ctx.dvp[ng.opp] && ctx.dvp[ng.opp][grp] && ctx.dvp[ng.opp][grp][stat];
    const ir = injuryFor(injuries, r.norm, r.team);
    r.injury = ir ? { status: ir.status, reason: ir.reason } : null;
    r.teammatesOut = teammatesOut(injuries, r.team, r.norm).slice(0, 4).map((t) => t.name);
    r.matchup = ng ? {
      opp: ng.opp, home: ng.home, tip: ng.tip, date: ng.date,
      pace: O ? O.pace : null, paceRank: O ? O.paceRank : null,
      drtg: O ? O.drtg : null, drtgRank: O ? O.drtgRank : null,
      dvp: d ? { group: grp, avg: d.avg, rank: d.rank, of: d.of } : null,
      factor: mf.factor,
    } : null;
    r.model = proj ? {
      mean: proj.mean, minutes: proj.minutes,
      pOver: r.line === null ? null : probOver(r.line, proj),
      pUnder: r.line === null ? null : probUnder(r.line, proj),
      // Matrix lines may be sportsbook lines (usually void if he sits), so these stay
      // "if he plays"; pPlays is shown next to them.
      pPlays: ir ? (PLAY_PROBABILITY[ir.status] ?? 1) : 1,
    } : null;
  }
  grid.injuries = injuries ? injuries.meta : null;
  grid.context = { teams: ctx.league.teams, hasPace: ctx.hasPace, league: ctx.league,
    note: "Opp = next game. Pace rank 1 = fastest. DRtg rank 1 = best defense (points allowed per 100 possessions, this season blended with last season early on). DvP rank 1 = allows the least to that position, 30 = the most. Model % is an estimate from recent per-minute production, projected minutes and this matchup; it is not a pick." };
  return grid;
}
