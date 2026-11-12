// Hit chance (NBA): a second pass over the model's probability that a player clears a rung.
//
// The Model and Proj build a mean from the last 20 games, weighted toward the newest.
// Checked on every player-game of 2024-25, 2025-26 and the start of 2026-27 (walk-forward,
// backtest/nba_hit_chance_backtest.mjs), three things they leave out predict the result:
//   1. how often he has actually cleared this number over a longer run (up to 40 games)
//   2. his longer-run per-minute rate against the recent-weighted one (rebounds and
//      assists most: the recent weighting chases noise there)
//   3. his minutes in the last game against his 10-game average (a role change shows up
//      there first)
// The hit chance is a logistic combination of the starting probability and those three,
// fit per stat. It lowered log loss on every stat in both test seasons (all four stats
// together, 40-game table: 0.4445 -> 0.4407), about as much as Proj improved on the Model for points.
//
// It is an estimate of how often the side hits, not of value: the market price is
// still the more accurate number, and nothing here is shown to beat it.
//
// Pure functions. Coefficients are pinned in test/hit_chance.test.mjs; refit them with
// the backtest, do not edit by hand.

const logit = (p) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export const HIT_WINDOWS = { short: 20, long: 40, longMin: 30 };   // 30+ games on file -> the 40-game table

// [intercept, logit(starting probability), share of games at or over the rung,
//  ln(long-run mean / model mean), last game minutes / 10-game average]
export const HIT_COEF = {
  20: { points: [-0.817, 0.848, 0.88, -0.108, 0.428], rebounds: [-0.737, 0.843, 0.81, 1.556, 0.341], assists: [-0.468, 0.943, 0.375, 0.979, 0.316], threes: [-0.451, 0.944, 0.43, -0.03, 0.267] },
  40: { points: [-0.966, 0.809, 1.161, 0.221, 0.448], rebounds: [-0.953, 0.791, 1.2, 1.485, 0.366], assists: [-0.581, 0.924, 0.6, 1.178, 0.341], threes: [-0.732, 0.851, 0.957, 0.093, 0.29] },
};
export const HIT_STATS = Object.keys(HIT_COEF[20]);

/**
 * The inputs, for an Over at "strike or more".
 * games: newest first [{ value, minutes }], as many as are on file (40 are used at most).
 * pOver: the starting probability (Proj where it exists, otherwise the Model), if he plays.
 * modelMean, projMinutes: from nbaProjection (the mean already includes the matchup factor).
 * factor: the matchup factor, so the long-run mean is on the same footing.
 * Returns { window, x: [1, logit, share, longr, lastMin] } or null without usable games.
 */
export function hitFeatures({ pOver, strike, games, modelMean, projMinutes, factor = 1 }) {
  const all = (games || []).filter((g) => Number.isFinite(g.value) && Number.isFinite(g.minutes) && g.minutes > 0);
  if (all.length < 5 || !(pOver >= 0 && pOver <= 1) || !(modelMean > 0) || !(projMinutes > 0)) return null;
  const window = all.length >= HIT_WINDOWS.longMin ? HIT_WINDOWS.long : HIT_WINDOWS.short;
  const g = all.slice(0, window);
  const share = g.filter((x) => x.value >= strike).length / g.length;
  let sv = 0, sm = 0;
  for (const x of g) { sv += x.value; sm += x.minutes; }
  const long = (sv / sm) * projMinutes * factor;
  const longr = Math.log(Math.max(0.05, long) / Math.max(0.05, modelMean));
  const ten = all.slice(0, 10);
  const lastMin = all[0].minutes / (ten.reduce((a, x) => a + x.minutes, 0) / ten.length);
  return { window, games: g.length, share, longr, lastMin, x: [1, logit(pOver), share, longr, lastMin] };
}

/** P(Over) after the second pass, or null when the stat or the games are not covered. */
export function nbaHitChance(stat, input, coef = HIT_COEF) {
  const f = hitFeatures(input);
  const c = f && coef[f.window] && coef[f.window][stat];
  if (!c) return null;
  let z = 0;
  for (let i = 0; i < c.length; i++) z += c[i] * f.x[i];
  return { pOver: Math.min(0.999, Math.max(0.001, sigmoid(z))), window: f.window, games: f.games, share: f.share, longr: f.longr, lastMin: f.lastMin };
}

/** Older games (21-40) from the data job's `history` block, by normalized name: newest first [{ minutes, points, ... }]. */
export function historyIndex(doc, normalize) {
  const out = new Map();
  const h = doc && doc.history;
  if (!h || typeof h !== "object") return out;
  for (const [name, v] of Object.entries(h)) {
    if (!v || !Array.isArray(v.minutes)) continue;
    const games = v.minutes.map((m, i) => ({ minutes: Number(m), points: Number(v.points?.[i]), rebounds: Number(v.rebounds?.[i]),
      assists: Number(v.assists?.[i]), threes: Number(v.threes?.[i]), date: v.dates ? v.dates[i] : null }));
    out.set(normalize(name), games);
  }
  return out;
}

// ---------------------------------------------------------------------------
// NFL hit chance: the same idea on Proj (src/nfl_opportunity.js).
//   1. how often he cleared this number over his last 10 games (this season and last)
//   2. his volume in the last game against his season average (targets for catches and
//      receiving yards, carries for rushing, pass attempts for passing yards)
// Checked walk-forward on 2023-2026 (backtest/nfl_hit_chance_backtest.mjs). It is used
// only where it helped players with a regular role:
//   passing yards   lower log loss in all 4 seasons (2026: 0.5189 -> 0.5098)
//   rush attempts   lower in all 4 (2026: 0.4869 -> 0.4773)
//   rushing yards   lower in 3 of 4, by a little
//   receptions      lower for all players in all 4 seasons; about even for regular players
//                   overall, but it corrects the case that matters for picking: when Proj
//                   sits 15+ points above how often he has actually cleared the number,
//                   Proj said 48.4% and 44.5% hit; the hit chance says 45.0% (2,634 rungs)
// Receiving yards showed no gain for regular players and over-corrects that same case
// (44.3% against 46.5% actual), so it stays on Proj.
export const NFL_HIT_GAMES = 10;
export const NFL_HIT_VOLUME = { receptions: "targets", receiving_yards: "targets", rushing_yards: "carries", carries: "carries", passing_yards: "attempts" };
// [intercept, logit(Proj), share of the last 10 at or over the rung, last-game volume / season average]
export const NFL_HIT_COEF = {
  receptions: [-0.423, 0.855, 0.515, 0.116],
  rushing_yards: [-0.427, 0.875, 0.439, 0.172], carries: [-0.492, 0.948, 0.49, 0.321], passing_yards: [-1.311, 0.648, 1.774, 0.469],
};

/**
 * games: this season's games, newest first (stat objects, as Proj takes them); needs 2+.
 * recent: his last games across seasons, newest first (10 are used).
 * Returns { share, lastVol, games, x } or null.
 */
export function nflHitFeatures({ pOver, strike, stat, games, recent }) {
  const vk = NFL_HIT_VOLUME[stat];
  if (!vk || !(pOver >= 0 && pOver <= 1) || !Array.isArray(games) || games.length < 2) return null;
  const r = (recent && recent.length ? recent : games).slice(0, NFL_HIT_GAMES);
  const share = r.filter((g) => (Number(g[stat]) || 0) >= strike).length / r.length;
  const vols = games.map((g) => Number(g[vk]) || 0), avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const lastVol = avg > 0 ? vols[0] / avg : 1;
  return { share, lastVol, games: r.length, x: [1, logit(pOver), share, lastVol] };
}

export function nflHitChance(input, coef = NFL_HIT_COEF) {
  const f = nflHitFeatures(input), c = f && coef[input.stat];
  if (!c) return null;
  let z = 0;
  for (let i = 0; i < c.length; i++) z += c[i] * f.x[i];
  return { pOver: Math.min(0.999, Math.max(0.001, sigmoid(z))), share: f.share, lastVol: f.lastVol, games: f.games };
}

/** Each player's last games across both seasons in the weekly logs, newest first (stat objects). */
export function nflRecentIndex(trend, normalize) {
  const idx = new Map();
  for (const r of (trend && trend.players) || []) {
    if (!r.stats || Number(r.week) > 18) continue;
    const k = r.norm || normalize(r.name);
    (idx.get(k) || idx.set(k, []).get(k)).push({ season: Number(r.season), week: Number(r.week), ...r.stats });
  }
  for (const v of idx.values()) v.sort((a, b) => (b.season - a.season) || (b.week - a.week));
  return idx;
}
