// Opportunity projection for NFL player props.
//
// Pure functions, no I/O. Same idea as src/nba_opportunity.js: volume (targets,
// carries, pass attempts) repeats from week to week, efficiency (catch rate, yards
// per target / carry / attempt) mostly does not over a handful of games. So
//
//   receptions      = targets x catch rate
//   receiving yards = targets x yards per target
//   rush attempts   = carries
//   rushing yards   = carries x yards per carry
//   passing yards   = pass attempts x yards per attempt
//
// Volume: this season's games, newest weighted most (0.85 per game back), with last
// season's per-game volume counting as 2 extra games (4+ games last season).
// Efficiency: this season's totals plus last season's at 70% weight, pulled toward
// the league average for his role (QB / RB / receiver) by k "touches" of league data.
// League values and k were measured on 2021-2024 (empirical Bayes: k = per-touch
// noise / real between-player spread), so 2025-26 tests are out of sample.
//
// Distribution: volume is negative binomial; receptions are binomial on targets;
// yards are a gamma per number of touches (mean t x yards per touch, variance
// t x per-touch variance + t^2 x uncertainty in his yards per touch), mixed over
// the volume distribution. Gives P(stat >= k) for any rung and floor / median / ceiling.

export const NFL_OPP_STATS = ["receptions", "receiving_yards", "carries", "rushing_yards", "passing_yards"];
const SPEC = {
  receptions: { vol: "targets", made: "receptions", kind: "binomial" },
  receiving_yards: { vol: "targets", made: "receiving_yards", kind: "yards" },
  carries: { vol: "carries", made: null, kind: "count" },
  rushing_yards: { vol: "carries", made: "rushing_yards", kind: "yards" },
  passing_yards: { vol: "attempts", made: "passing_yards", kind: "yards" },
};
// From 2021-2024 regular seasons (backtest/nfl_opportunity_fit.mjs): league rate, k, per-touch variance.
export const NFL_PRIORS = {
  QB: { carries: { rushing_yards: { rate: 4.56, k: 26, var: 38.6 } }, attempts: { passing_yards: { rate: 7.10, k: 200, var: 78.8 } } },
  RB: { carries: { rushing_yards: { rate: 4.31, k: 115, var: 31.1 } },
        targets: { receptions: { rate: 0.780, k: 121 }, receiving_yards: { rate: 5.76, k: 78, var: 51.6 } } },
  REC: { carries: { rushing_yards: { rate: 4.89, k: 27, var: 37.8 } },
         targets: { receptions: { rate: 0.656, k: 55 }, receiving_yards: { rate: 7.78, k: 87, var: 91.6 } },
         attempts: { passing_yards: { rate: 6.0, k: 16, var: 23.2 } } },
};
// Negative binomial size for volume by role (var = m + m^2 / r), 2021-2024 player-seasons.
export const VOL_SIZE = { QB: { attempts: 12, carries: 6 }, RB: { carries: 4, targets: 6 }, REC: { targets: 12, carries: 2, attempts: 1 } };
export const NFL_OPP_CFG = { decay: 0.85, prevVolGames: 2, prevMinGames: 4, prevEffWeight: 0.7, volPseudo: 8 };

const fin = (x) => Number.isFinite(x);
const num = (x) => (x === null || x === undefined || x === "" ? 0 : Number(x) || 0);

/** QB / RB / REC from per-game volume (pass attempts, carries vs targets). */
export function nflRole(games, prev = null) {
  const g = games.length ? games : [];
  const n = g.length + (prev && prev.games ? prev.games : 0) || 1;
  const s = (k) => (g.reduce((a, x) => a + num(x[k]), 0) + (prev ? num(prev[k]) : 0)) / n;
  if (s("attempts") >= 10) return "QB";
  if (s("carries") >= s("targets") && s("carries") >= 2) return "RB";
  return "REC";
}

// ---- distributions ----
function lgamma(x) {   // Lanczos
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015;
  for (const v of c) s += v / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
/** Regularized upper incomplete gamma Q(a, x) = P(Gamma(a,1) >= x). */
export function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  if (x < a + 1) {   // series for P
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a)));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;   // continued fraction for Q
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - lgamma(a)) * h);
}
/** Negative binomial pmf array for mean m, size r (Poisson when r is huge), up to where the tail is negligible. */
export function nbPmf(m, r) {
  const out = []; if (!(m > 0)) return [1];
  const q = r / (r + m);
  let lp = r * Math.log(q), cum = 0;
  for (let x = 0; x < 400; x++) {
    const p = Math.exp(lp); out.push(p); cum += p;
    if (x > m && cum > 1 - 1e-7) break;
    lp += Math.log(x + r) - Math.log(x + 1) + Math.log(1 - q);
  }
  return out;
}

/** P(stat >= k) for a projection (see nflOpportunityProjection). */
export function nflProbAtLeast(k, proj) {
  if (!proj) return null;
  if (k <= 0) return 1;
  const pmf = proj.volPmf;
  if (proj.kind === "count") { let c = 0; for (let x = 0; x < Math.min(k, pmf.length); x++) c += pmf[x]; return Math.max(0, 1 - c); }
  if (proj.kind === "binomial") {
    const p = proj.rate; let tot = 0;
    for (let t = Math.ceil(k); t < pmf.length; t++) {
      if (pmf[t] < 1e-9) continue;
      // P(Binomial(t, p) >= k)
      let lp = t * Math.log(1 - p), cdf = 0;
      for (let r = 0; r < k; r++) { cdf += Math.exp(lp); lp += Math.log(t - r) - Math.log(r + 1) + Math.log(p) - Math.log(1 - p); }
      tot += pmf[t] * Math.max(0, 1 - cdf);
    }
    return Math.min(1, tot);
  }
  // yards: gamma for each number of touches; continuous, so "at least k" on a whole-number
  // stat is Y > k - 0.5
  const x = k - 0.5, mu = proj.rate, v1 = proj.touchVar, vMu = proj.rateVar;
  let tot = 0;
  for (let t = 1; t < pmf.length; t++) {
    if (pmf[t] < 1e-9) continue;
    const m = t * mu, v = t * v1 + t * t * vMu;
    if (m <= 0) continue;
    tot += pmf[t] * gammaQ(m * m / v, x / (v / m));
  }
  return Math.min(1, tot);
}

function quantile(q, proj) {
  // smallest whole number k with P(stat <= k) >= q
  let lo = 0, hi = Math.max(5, Math.ceil(proj.mean * 4 + 20));
  const cdf = (k) => 1 - nflProbAtLeast(k + 1, proj);
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf(mid) >= q) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * games: this season, newest first: [{ targets, receptions, receiving_yards, carries,
 *        rushing_yards, attempts, completions, passing_yards }] (one per game played).
 * prev:  last season's TOTALS and games: { games, targets, receptions, ... } or null.
 * opts:  { volumeAdj = 0 (game script: +0.03 = 3% more volume), cfg, priors }
 * Returns null without a game this season (or no volume at all), else
 *   { stat, kind, role, mean, volume, rate, rateRaw, sample, floor, median, ceiling, flag, note, volPmf, ... }
 */
export function nflOpportunityProjection(games, stat, prev = null, opts = {}) {
  const sp = SPEC[stat]; if (!sp) return null;
  const cfg = { ...NFL_OPP_CFG, ...(opts.cfg || {}) }, priors = opts.priors || NFL_PRIORS;
  const g = (games || []).filter(Boolean);
  if (!g.length) return null;
  const role = nflRole(g, prev);
  const usePrev = prev && prev.games >= cfg.prevMinGames;
  // volume
  let sv = 0, sw = 0;
  g.forEach((x, i) => { const w = cfg.decay ** i; sv += w * num(x[sp.vol]); sw += w; });
  if (usePrev) { sv += cfg.prevVolGames * num(prev[sp.vol]) / prev.games; sw += cfg.prevVolGames; }
  let volume = sv / sw * (1 + (opts.volumeAdj || 0));
  if (!(volume > 0)) return null;
  // volume spread: NB size from his own games, shrunk toward the role prior
  const rPrior = (VOL_SIZE[role] && VOL_SIZE[role][sp.vol]) || 6;
  const vals = g.map((x) => num(x[sp.vol])), m0 = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v0 = vals.length > 1 ? vals.reduce((a, b) => a + (b - m0) ** 2, 0) / (vals.length - 1) : null;
  const rOwn = v0 !== null && v0 > m0 && m0 > 0 ? m0 * m0 / (v0 - m0) : 200;
  const r = 1 / ((vals.length - 1) / (vals.length - 1 + cfg.volPseudo) / Math.min(200, rOwn) + cfg.volPseudo / (vals.length - 1 + cfg.volPseudo) / rPrior);
  const volPmf = nbPmf(volume, r);
  let rate = 1, rateRaw = null, sample = 0, rateVar = 0, touchVar = 0;
  if (sp.made) {
    const pr = (priors[role] && priors[role][sp.vol] && priors[role][sp.vol][sp.made]) || priors.REC.targets.receiving_yards;
    let made = g.reduce((a, x) => a + num(x[sp.made]), 0), att = g.reduce((a, x) => a + num(x[sp.vol]), 0);
    if (usePrev) { made += cfg.prevEffWeight * num(prev[sp.made]); att += cfg.prevEffWeight * num(prev[sp.vol]); }
    rateRaw = att > 0 ? made / att : null; sample = att;
    rate = (made + pr.k * pr.rate) / (att + pr.k);
    touchVar = pr.var ?? rate * (1 - rate);
    rateVar = touchVar / (pr.k + att);      // posterior uncertainty in his rate
    if (sp.kind === "binomial") rate = Math.min(0.97, Math.max(0.2, rate));
  }
  const mean = volume * rate;
  const proj = { stat, kind: sp.kind, role, mean, volume, volumeSize: r, rate, rateRaw, sample, touchVar, rateVar, volPmf };
  proj.floor = quantile(0.1, proj); proj.median = quantile(0.5, proj); proj.ceiling = quantile(0.9, proj);
  Object.assign(proj, volumeVsResults(g, sp, rate));
  return proj;
}

/**
 * Hot / cold over the last 3 games (yards and receptions only): results vs what his
 * targets / carries / attempts are usually worth at his regressed rate. Thresholds in
 * NFL_FLAG_RULES. Descriptions, not predictions.
 */
export const NFL_FLAG_RULES = { games: 3, below: 0.75, above: 1.3, minGapYards: 40, minGapCatches: 3, steadyVolume: 0.9 };
function volumeVsResults(g, sp, rate) {
  const R = NFL_FLAG_RULES, none = { flag: null, note: null, ratio: null };
  if (!sp.made || g.length < R.games + 2) return none;
  const last = g.slice(0, R.games), earlier = g.slice(R.games);
  const actual = last.reduce((a, x) => a + num(x[sp.made]), 0);
  const expected = last.reduce((a, x) => a + num(x[sp.vol]), 0) * rate;
  if (!(expected > 0)) return none;
  const ratio = actual / expected, minGap = sp.kind === "binomial" ? R.minGapCatches : R.minGapYards;
  const volLast = last.reduce((a, x) => a + num(x[sp.vol]), 0) / last.length, volEarlier = earlier.reduce((a, x) => a + num(x[sp.vol]), 0) / earlier.length;
  const what = sp.vol === "targets" ? "targets" : sp.vol === "carries" ? "carries" : "pass attempts";
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  if (ratio < R.below && expected - actual >= minGap && volLast >= R.steadyVolume * volEarlier)
    return { flag: "below", ratio, note: `Last ${R.games}: ${pct}% below what his ${what} are usually worth` };
  if (ratio > R.above && actual - expected >= minGap)
    return { flag: "above", ratio, note: `Last ${R.games}: ${pct}% above what his ${what} are usually worth` };
  return { flag: null, note: null, ratio };
}

/** Last season's totals per player from trend.priorSeason (per-game averages x games). */
export function prevTotalsFromAverages(avg) {
  if (!avg || !(avg.games > 0)) return null;
  const out = { games: avg.games };
  for (const k of ["targets", "receptions", "receiving_yards", "carries", "rushing_yards", "attempts", "completions", "passing_yards"]) out[k] = num(avg[k]) * avg.games;
  return out;
}

/**
 * Index the app's NFL trend logs (trend-logs.json) for the projection: norm ->
 * { games: this season's stat rows, newest first; prev: last season's totals }.
 */
export function nflOppIndex(trend, normalize) {
  const season = Number(trend && trend.season);
  const idx = new Map();
  for (const r of (trend && trend.players) || []) {
    if (Number(r.season) !== season || !r.stats || Number(r.week) > 18) continue;
    const k = r.norm || normalize(r.name);
    if (!idx.has(k)) idx.set(k, { games: [], prev: prevTotalsFromAverages(((trend.priorSeason || {})[k]) || null) });
    idx.get(k).games.push({ week: Number(r.week), ...r.stats });
  }
  for (const v of idx.values()) v.games.sort((a, b) => b.week - a.week);
  return idx;
}

/** Shape a projection for the Board / Matrix JSON (no pmf). pSide: chance for the row's side, when given. */
export function nflOppSummary(o, extra = {}) {
  const LBL = { receptions: ["targets", "catch rate"], receiving_yards: ["targets", "yards per target"], carries: ["carries", null],
    rushing_yards: ["carries", "yards per carry"], passing_yards: ["pass attempts", "yards per attempt"] };
  return o ? { mean: o.mean, floor: o.floor, median: o.median, ceiling: o.ceiling, volume: o.volume, rate: o.rate, rateRaw: o.rateRaw,
    volLabel: LBL[o.stat][0], rateLabel: LBL[o.stat][1],
    role: o.role, flag: o.flag, note: o.note, ...extra } : null;
}

/** NFL Tendency Matrix: r.opportunity for the five projected markets (current week only). */
export function decorateNflOpportunity(grid, trend, { stat, normalize }) {
  if (!NFL_OPP_STATS.includes(stat)) return grid;
  const idx = nflOppIndex(trend, normalize);
  let n = 0;
  for (const r of grid.rows) {
    const p = idx.get(r.norm);
    const o = p && p.games.length ? nflOpportunityProjection(p.games, stat, p.prev) : null;
    const hasLine = r.line !== null && r.line !== undefined;
    const pOver = o && hasLine ? nflProbAtLeast(Math.floor(r.line) + 1, o) : null;
    const pUnder = o && hasLine ? 1 - nflProbAtLeast(Math.ceil(r.line), o) : null;
    r.opportunity = nflOppSummary(o, { pOver, pUnder });
    if (o) n++;
  }
  grid.opportunity = { stat, rows: n, note: "Proj = opportunity projection: targets / carries / pass attempts this season (last season counts as 2 games) x his catch rate or yards per touch, pulled toward the league average for his role. Range = 10th to 90th percentile. No game script or injuries in the Matrix version." };
  return grid;
}
