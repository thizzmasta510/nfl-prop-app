// NFL defense vs position: what each defense has allowed to quarterbacks, running backs,
// wide receivers and tight ends, measured against what Proj expected from the players it
// faced, and applied to Proj at half strength.
//
// For every earlier player-game the table adds up actual production and Proj's mean (built
// only from that player's games before it), by defense, position group and stat. A defense's
// ratio (actual / projected), divided by the league's ratio, says how much more or less it
// gives up than the players' own numbers predict, so it is not fooled by a schedule full of
// good or bad offenses. That ratio is pulled toward 1 by how many games it rests on, last
// season counts at 0.3, and Proj moves by the square root of it (half the effect), capped
// at 0.80-1.25.
//
// Checked walk-forward on 2023-2026 (backtest/nfl_defense_backtest.mjs), change in log loss
// for players with a regular role, all four seasons together:
//   passing yards   -0.0039  (better in 4 of 4 seasons)
//   rushing yards   -0.0030  (3 of 4; flat in 2025)
//   rush attempts   -0.0017  (3 of 4; slightly worse in 2025)
//   receiving yards -0.0010  (3 of 4, with WR and TE separate)
//   receptions      -0.0006  (4 of 4)
// Full strength was worse than half strength: the raw ratios are noisy (rushing yards runs
// from about 0.7 to 1.4 across defenses and weeks). No market prices in this test.
//
// Pure functions. Settings are pinned in test/nfl_defense.test.mjs.

import { nflOpportunityProjection, prevTotalsFromAverages } from "./nfl_opportunity.js";

export const NFL_DEF_CFG = { shrinkGames: 8, prevWeight: 0.3, strength: 0.5, min: 0.8, max: 1.25, minPriorGames: 2 };
export const NFL_DEF_STATS = ["receptions", "receiving_yards", "rushing_yards", "carries", "passing_yards"];
// which part of the projection the factor scales
export const NFL_DEF_APPLIES = { receptions: "volume", carries: "volume", receiving_yards: "rate", rushing_yards: "rate", passing_yards: "rate" };

/** Position group: QB, RB, WR, TE; a receiver with no listed position is "REC". */
export function nflDefGroup(role, position) {
  if (role === "QB" || role === "RB") return role;
  const p = String(position || "").toUpperCase();
  return p === "WR" || p === "TE" ? p : "REC";
}

/**
 * rows: [{ season, week, opp, group, stat, actual, mean }] (one per earlier player-game and stat).
 * Returns { factor(season, week, opp, group, stat) } using only rows before that week
 * (earlier weeks of `season`, plus all of season - 1 at cfg.prevWeight).
 */
export function nflDefenseTable(rows, cfg = NFL_DEF_CFG) {
  const cell = new Map(), league = new Map();
  for (const r of rows) {
    if (!(r.mean > 0) || !Number.isFinite(r.actual) || !r.opp) continue;
    for (const [m, k] of [[cell, `${r.season}|${r.opp}|${r.group}|${r.stat}`], [league, `${r.season}|${r.group}|${r.stat}`]]) {
      const c = m.get(k) || m.set(k, new Map()).get(k);
      const w = c.get(r.week) || c.set(r.week, { a: 0, m: 0 }).get(r.week);
      w.a += r.actual; w.m += r.mean;
    }
  }
  const sums = (c, before) => { let a = 0, m = 0, n = 0; if (c) for (const [w, v] of c) if (w < before) { a += v.a; m += v.m; n++; } return { a, m, n }; };
  const raw = (season, week, opp, group, stat) => {
    const c = sums(cell.get(`${season}|${opp}|${group}|${stat}`), week), p = sums(cell.get(`${season - 1}|${opp}|${group}|${stat}`), Infinity);
    const lc = sums(league.get(`${season}|${group}|${stat}`), week), lp = sums(league.get(`${season - 1}|${group}|${stat}`), Infinity);
    const A = c.a + cfg.prevWeight * p.a, M = c.m + cfg.prevWeight * p.m, LA = lc.a + cfg.prevWeight * lp.a, LM = lc.m + cfg.prevWeight * lp.m;
    const games = c.n + cfg.prevWeight * p.n;
    if (!(M > 0 && LM > 0 && LA > 0 && A >= 0)) return { ratio: 1, games: 0 };
    return { ratio: (A / M) / (LA / LM), games };
  };
  const factor = (season, week, opp, group, stat) => {
    const { ratio, games } = raw(Number(season), Number(week), opp, group, stat);
    const shrunk = 1 + (ratio - 1) * games / (games + cfg.shrinkGames);
    return Math.min(cfg.max, Math.max(cfg.min, Math.max(0.01, shrunk) ** cfg.strength));
  };
  return { factor, raw };
}

/** { volumeAdj, rateAdj } options for nflOpportunityProjection: the factor on volume or rate, with any game-script volume change kept. */
export function nflDefenseOpts(stat, factor, gameScriptAdj = 0) {
  const f = factor > 0 ? factor : 1, gs = Number(gameScriptAdj) || 0;
  return NFL_DEF_APPLIES[stat] === "volume" ? { volumeAdj: (1 + gs) * f - 1 } : { volumeAdj: gs, rateAdj: f };
}

const cache = new WeakMap();
/**
 * The table from the app's weekly logs (trend.players: this season and whatever of last
 * season is on file; rows need team, opponent, week, season, stats). Each row's projected
 * mean uses that player's earlier games in the file, so a player's first two games on file
 * are not counted. Built once per logs object.
 * Returns { factor(opp, norm, role, stat, week?) } as of `week` (default: after every game on file).
 */
export function nflDefenseIndex(trend, normalize, cfg = NFL_DEF_CFG) {
  if (trend && cache.has(trend)) return cache.get(trend);
  const season = Number(trend && trend.season), by = new Map(), positionOf = new Map(), prior = (trend && trend.priorSeason) || {};
  for (const r of (trend && trend.players) || []) {
    if (!r.stats || Number(r.week) > 18 || !r.opponent) continue;
    const norm = r.norm || normalize(r.name), k = `${norm}|${r.season}`;
    (by.get(k) || by.set(k, []).get(k)).push(r);
    if (r.position && Number(r.season) === season) positionOf.set(norm, r.position);
  }
  const rows = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.week - b.week);
    for (let i = cfg.minPriorGames; i < list.length; i++) {
      const t = list[i], games = list.slice(0, i).reverse().map((x) => x.stats);
      for (const stat of NFL_DEF_STATS) {
        // last season's totals only help project this season's games (the file has no season before last)
        const prev = Number(t.season) === season && prior[t.norm || normalize(t.name)] ? prevTotalsFromAverages(prior[t.norm || normalize(t.name)]) : null;
        const o = nflOpportunityProjection(games, stat, prev, { meanOnly: true });
        if (!o) continue;
        rows.push({ season: Number(t.season), week: Number(t.week), opp: t.opponent, group: nflDefGroup(o.role, t.position), stat, actual: Number(t.stats[stat]) || 0, mean: o.mean });
      }
    }
  }
  const table = nflDefenseTable(rows, cfg);
  const out = { rows: rows.length, positionOf,
    factor: (opp, norm, role, stat, week = 99) => (opp && NFL_DEF_STATS.includes(stat) ? table.factor(season, week, opp, nflDefGroup(role, positionOf.get(norm)), stat) : 1) };
  if (trend) cache.set(trend, out);
  return out;
}
