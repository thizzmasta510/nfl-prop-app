// Tendency Matrix: how often each player reached each cutoff in his last N games.
//
// Pure functions, no I/O, so the Worker endpoint, the dashboard and the
// backtests all share one implementation. Works for the NFL (games ordered by
// season + week) and the NBA (games ordered by date).
//
// IMPORTANT: a hit rate describes what happened. It is not a forecast. The
// backtest (backtest/trend_backtest.mjs) measures how much, if anything, a
// last-N hit rate adds over the market's own price before anyone relies on it.

import { normalizeName } from "./model.js";

// Market config per sport. `cutoffs` are "X or more" thresholds (X+ == over X-0.5).
// `positions` is the default position filter for the grid.
export const SPORTS = {
  nfl: {
    label: "NFL", defaultGames: 5,
    markets: {
      receptions:      { label: "Receptions",       cutoffs: [3, 4, 5, 6, 7],               positions: ["WR", "TE"] },
      receiving_yards: { label: "Receiving Yards",  cutoffs: [40, 50, 60, 70, 80, 100],      positions: ["WR", "TE"] },
      targets:         { label: "Targets",          cutoffs: [4, 5, 6, 7, 8, 10],            positions: ["WR", "TE", "RB"] },
      rushing_yards:   { label: "Rushing Yards",    cutoffs: [40, 50, 60, 70, 80, 100],      positions: ["RB"] },
      carries:         { label: "Carries",          cutoffs: [10, 12, 15, 18, 20],           positions: ["RB"] },
      rush_rec_yards:  { label: "Rush + Rec Yards", cutoffs: [50, 60, 75, 90, 100, 125],     positions: ["RB", "WR", "TE"] },
      passing_yards:   { label: "Passing Yards",    cutoffs: [175, 200, 225, 250, 275, 300], positions: ["QB"] },
      completions:     { label: "Completions",      cutoffs: [15, 18, 20, 22, 25],           positions: ["QB"] },
      attempts:        { label: "Pass Attempts",    cutoffs: [25, 30, 33, 35, 40],           positions: ["QB"] },
      passing_tds:     { label: "Passing TDs",      cutoffs: [1, 2, 3],                      positions: ["QB"] },
    },
    // Regular season only: weeks 1-18.
    include: (r) => Number(r.week) >= 1 && Number(r.week) <= 18,
    order: (r, season) => (Number.isFinite(Number(r.season)) ? Number(r.season) : season) * 100 + Number(r.week),
    cut: (opts) => opts.season * 100 + (opts.beforeWeek ?? 99),
    tag: (r, season) => `${Number.isFinite(Number(r.season)) ? Number(r.season) : season}-W${r.week}`,
    staleDays: null,
  },
  nba: {
    label: "NBA", defaultGames: 10,
    markets: {
      points:    { label: "Points",              cutoffs: [10, 15, 20, 25, 30, 35], positions: [] },
      rebounds:  { label: "Rebounds",            cutoffs: [4, 6, 8, 10, 12],        positions: [] },
      assists:   { label: "Assists",             cutoffs: [2, 4, 6, 8, 10],         positions: [] },
      threes:    { label: "3-Pointers Made",     cutoffs: [1, 2, 3, 4, 5],          positions: [] },
      pra:       { label: "Pts + Reb + Ast",     cutoffs: [20, 25, 30, 35, 40, 45], positions: [] },
      pr:        { label: "Pts + Reb",           cutoffs: [15, 20, 25, 30, 35],     positions: [] },
      pa:        { label: "Pts + Ast",           cutoffs: [15, 20, 25, 30, 35],     positions: [] },
      ra:        { label: "Reb + Ast",           cutoffs: [6, 8, 10, 12, 15],       positions: [] },
      steals:    { label: "Steals",              cutoffs: [1, 2, 3],                positions: [] },
      blocks:    { label: "Blocks",              cutoffs: [1, 2, 3],                positions: [] },
      stocks:    { label: "Steals + Blocks",     cutoffs: [1, 2, 3, 4],             positions: [] },
      turnovers: { label: "Turnovers",           cutoffs: [1, 2, 3, 4, 5],          positions: [] },
    },
    // Regular season only (no preseason, playoffs or play-in).
    include: (r) => !r.seasonType || String(r.seasonType).toLowerCase().startsWith("regular"),
    order: (r) => Number(String(r.date || "").replace(/-/g, "")),
    cut: (opts) => (opts.beforeDate ? Number(String(opts.beforeDate).replace(/-/g, "")) : 99999999),
    tag: (r) => String(r.date || ""),
    // Drop players whose last game is this many days older than the newest game
    // in the data (injured, waived, out of the rotation).
    staleDays: 21,
  },
};

// ---------- Tendency grades ----------
// A letter grade for a player's recent record against the line the user entered:
// how consistently, and by how much, he finished on one side of it in the window,
// ranked against the other graded rows in the same market. It DESCRIBES the past.
// It is not a probability, a prediction or a pick, and in the backtest a player's
// recent record against the line did not predict the next result (see
// backtest/trend_backtest.mjs).
export const GRADE_SCALE = [
  [0.95, "A+"], [0.85, "A"], [0.70, "A-"], [0.55, "B+"], [0.40, "B"], [0.25, "B-"], [0.10, "C+"], [0, "C"],
];
const GRADE_ORDER = GRADE_SCALE.map((g) => g[1]);
export const GRADE_NOTE = "Tendency grade: how consistently and by how much the player finished above or below this line in the games shown, ranked against the other lines in this market. Describes the past only; not a probability, a prediction or a pick.";

function sdOf(vals) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, vals.length - 1));
}

// Raw trend score for one row with a line (higher = more one-sided record).
export function trendScore(values, line) {
  const n = values.length;
  const above = values.filter((v) => v > line).length, below = values.filter((v) => v < line).length;
  const avg = values.reduce((a, b) => a + b, 0) / n;
  const direction = above > below ? "above" : below > above ? "below" : avg >= line ? "above" : "below";
  const consistency = Math.abs(above - below) / n;                     // 0..1
  const margin = (avg - line) / Math.max(sdOf(values), 0.5);          // in spreads
  const marginTerm = Math.sign(avg - line) === (direction === "above" ? 1 : -1) ? Math.min(1, Math.abs(margin) / 2) : 0; // 2 spreads clear of the line = full credit
  return { direction, above, below, n, score: consistency + 0.25 * marginTerm };
}

// Assign letters by midrank percentile within the graded rows, with two caps so a
// small or mixed record can't look strong: fewer than 5 games caps at B+, and a
// record within one game of even (e.g. 3 of 5) caps at B.
export function assignGrades(rows) {
  const graded = rows.filter((r) => r.trend);
  const scores = graded.map((r) => r.trend.score).sort((a, b) => a - b);
  for (const r of graded) {
    const s = r.trend.score;
    const below = scores.filter((x) => x < s).length, equal = scores.filter((x) => x === s).length;
    const pct = scores.length === 1 ? 0.5 : (below + (equal - 1) / 2) / (scores.length - 1);
    let letter = GRADE_SCALE.find(([cut]) => pct >= cut)[1];
    const cap = (c) => { if (GRADE_ORDER.indexOf(letter) < GRADE_ORDER.indexOf(c)) letter = c; };
    if (r.trend.n < 5) cap("B+");
    if (Math.abs(r.trend.above - r.trend.below) <= 1) cap("B");
    r.grade = { letter, direction: r.trend.direction, percentile: Math.round(pct * 100),
      basis: `${r.trend.direction === "above" ? r.trend.above : r.trend.below} of ${r.trend.n} ${r.trend.direction} ${r.line}` };
  }
  return rows;
}

// Backward compatible: NFL markets were the original export.
export const MARKETS = SPORTS.nfl.markets;

const dayNum = (ord) => { // YYYYMMDD -> days since epoch
  const s = String(ord); return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000;
};

/**
 * Collapse raw player-game rows into per-player game logs, most recent first.
 * NFL rows: { name, team, season?, week, position?, opponent?, stats }
 * NBA rows: { name, team, season, date: "YYYY-MM-DD", seasonType?, position?, opponent?, home?, stats }
 * Only games strictly before the cut (beforeWeek / beforeDate) are used.
 */
export function gameLogs(rows, opts) {
  const sp = SPORTS[opts.sport || "nfl"];
  const { stat, season } = opts;
  const cut = sp.cut(opts);
  const byPlayer = new Map();
  for (const r of rows) {
    if (!r || !r.stats || r.stats[stat] === undefined || r.stats[stat] === null || r.stats[stat] === "") continue;
    const value = Number(r.stats[stat]);
    if (!Number.isFinite(value)) continue; // review C15: "" or "abc" must not become 0 or NaN
    if (!sp.include(r)) continue;
    const k = sp.order(r, season);
    if (!Number.isFinite(k) || k >= cut) continue;
    const norm = r.norm || normalizeName(r.name);
    if (!byPlayer.has(norm)) byPlayer.set(norm, { norm, name: r.name, team: r.team, position: r.position || null, latest: -Infinity, games: [] });
    const p = byPlayer.get(norm);
    const rs = Number.isFinite(Number(r.season)) ? Number(r.season) : season;
    p.games.push({ key: k, season: rs, tag: sp.tag(r, season), team: r.team, opponent: r.opponent || null,
      value, minutes: Number.isFinite(Number(r.stats.minutes)) && r.stats.minutes !== null && r.stats.minutes !== "" ? Number(r.stats.minutes) : null });
    // The most recent row decides the player's current team, position and name.
    if (k > p.latest) { p.latest = k; p.team = r.team; if (r.position) p.position = r.position; p.name = r.name; }
  }
  for (const p of byPlayer.values()) p.games.sort((a, b) => b.key - a.key);
  return byPlayer;
}

// Rank each value within its column into 5 buckets (0 = lowest, 4 = highest),
// so colors compare players to each other rather than to a fixed threshold.
function bucketColumn(values) {
  const sorted = values.filter((v) => v !== null).slice().sort((a, b) => a - b);
  if (!sorted.length) return values.map(() => null);
  // A single value has nothing to rank against: neutral, not "worst".
  if (sorted.length === 1) return values.map((v) => (v === null ? null : 2));
  return values.map((v) => {
    if (v === null) return null;
    // Midrank percentile handles ties: equal values always get the same bucket.
    const below = sorted.filter((x) => x < v).length, equal = sorted.filter((x) => x === v).length;
    const pct = (below + (equal - 1) / 2) / Math.max(1, sorted.length - 1);
    return Math.min(4, Math.max(0, Math.round(pct * 4)));
  });
}

/**
 * Build the grid.
 * opts: {
 *   sport = "nfl" | "nba",
 *   stat, season, beforeWeek (NFL) | beforeDate "YYYY-MM-DD" (NBA),  // no lookahead
 *   games = sport default, minGames = games,
 *   positions = market default ([] or null = all),
 *   cutoffs = market default,
 *   lines = {},                // { normName: line } (optional)
 *   sortBy = middle cutoff, limit = 25,
 *   players = null,            // optional list of names to restrict to (e.g. this slate)
 *   requireCurrentSeason       // NFL default true; NBA default: only once the season has games
 * }
 */
export function buildTrendGrid(rows, opts) {
  const sport = opts.sport || "nfl";
  const sp = SPORTS[sport];
  if (!sp) throw new Error(`unknown sport ${sport}`);
  const m = sp.markets[opts.stat];
  if (!m) throw new Error(`unknown stat ${opts.stat}`);
  const games = opts.games ?? sp.defaultGames;
  const minGames = opts.minGames ?? games;
  const cutoffs = opts.cutoffs ?? m.cutoffs;
  const positions = opts.positions === undefined ? m.positions : opts.positions;
  const sortByGrade = opts.sortBy === "grade";
  const sortBy = sortByGrade || opts.sortBy === undefined ? cutoffs[Math.floor(cutoffs.length / 2)] : opts.sortBy;
  const lines = opts.lines || {};
  const only = opts.players ? new Set(opts.players.map((n) => normalizeName(n))) : null;

  const logs = gameLogs(rows, { ...opts, sport });
  const all = [...logs.values()];
  const newest = all.reduce((mx, p) => Math.max(mx, p.latest), -Infinity);
  const newestSeason = all.reduce((mx, p) => Math.max(mx, p.games.length ? p.games[0].season : -Infinity), -Infinity);
  // NBA: before opening night there are no current-season games yet, so the
  // window falls back to last season instead of showing an empty grid.
  const requireCurrent = opts.requireCurrentSeason ?? (sport === "nfl" ? true : newestSeason === opts.season);

  const out = [];
  for (const p of all) {
    if (only && !only.has(p.norm)) continue;
    if (positions && positions.length && p.position && !positions.some((x) => String(p.position).toUpperCase().includes(x))) continue;
    if (!p.games.length) continue;
    if (requireCurrent && p.games[0].season !== opts.season) continue;
    if (sp.staleDays && dayNum(newest) - dayNum(p.latest) > sp.staleDays) continue;
    const last = p.games.slice(0, games);
    if (last.length < minGames) continue;
    const vals = last.map((g) => g.value);
    const hits = {};
    for (const c of cutoffs) hits[c] = vals.filter((v) => v >= c).length / vals.length;
    const line = Number.isFinite(lines[p.norm]) ? lines[p.norm] : null;
    const sortedVals = vals.slice().sort((a, b) => a - b);
    const mins = last.map((g) => g.minutes).filter((x) => x !== null && Number.isFinite(x));
    out.push({
      player: p.name, norm: p.norm, team: p.team, position: p.position,
      n: vals.length, values: vals, weeks: last.map((g) => g.tag),
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      median: sortedVals.length % 2 ? sortedVals[(sortedVals.length - 1) / 2] : (sortedVals[sortedVals.length / 2 - 1] + sortedVals[sortedVals.length / 2]) / 2,
      avgMinutes: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null,
      line,
      overLineRate: line === null ? null : vals.filter((v) => v > line).length / vals.length,
      trend: line === null ? null : trendScore(vals, line),
      grade: null,
      hits,
    });
  }
  // Grades are ranked over every eligible row with a line, before the row limit.
  assignGrades(out);
  // Ties on the sort column break on the higher cutoffs, then on average.
  const order = [sortBy, ...cutoffs.filter((c) => c > sortBy), ...cutoffs.filter((c) => c < sortBy).reverse()];
  const byCutoff = (a, b) => {
    for (const c of order) { const d = b.hits[c] - a.hits[c]; if (d) return d; }
    return b.avg - a.avg;
  };
  out.sort(sortByGrade
    ? (a, b) => ((b.trend ? b.trend.score : -1) - (a.trend ? a.trend.score : -1)) || byCutoff(a, b)
    : byCutoff);
  const rowsOut = out.slice(0, opts.limit ?? 25);

  // Color buckets are computed over the rows actually shown.
  for (const c of cutoffs) {
    const col = bucketColumn(rowsOut.map((r) => r.hits[c]));
    rowsOut.forEach((r, i) => { (r.bucket ||= {})[c] = col[i]; });
  }
  return {
    sport, stat: opts.stat, label: m.label, games, minGames, positions, cutoffs, sortBy: sortByGrade ? "grade" : sortBy,
    gradeNote: GRADE_NOTE,
    asOf: { season: opts.season, beforeWeek: opts.beforeWeek ?? null, beforeDate: opts.beforeDate ?? null },
    windowSeasonFallback: !requireCurrent && sport === "nba",
    note: "How often each player reached each number in his last N regular-season games. Colors rank each column among the players shown. Not a forecast.",
    rows: rowsOut,
  };
}

// Posted NFL props (props.json) -> { normName: line } for one stat, so the
// grid's Line column comes from lines the user actually entered.
export function linesFromProps(props, stat, propTypeToStatKey) {
  const lines = {};
  for (const p of props || []) {
    if (!p || !Number.isFinite(Number(p.line))) continue;
    if (propTypeToStatKey(p.propType) !== stat) continue;
    lines[normalizeName(p.player)] = Number(p.line);
  }
  return lines;
}

// NBA lines entered in the NBA tab: [{ player, stat, line }] -> { normName: line }
export function linesFromList(list, stat) {
  const lines = {};
  for (const l of list || []) {
    if (!l || l.stat !== stat || !Number.isFinite(Number(l.line))) continue;
    lines[normalizeName(l.player)] = Number(l.line);
  }
  return lines;
}

// Parse pasted "Player, stat, line" text (one per line) into entries.
// Unknown stats and malformed rows are returned separately, never guessed.
export function parseLinesText(text, sport = "nba") {
  const markets = SPORTS[sport].markets;
  const alias = { pts: "points", reb: "rebounds", ast: "assists", "3pm": "threes", "3s": "threes", threes: "threes",
    "pts+reb+ast": "pra", "p+r+a": "pra", "pts+reb": "pr", "pts+ast": "pa", "reb+ast": "ra", stl: "steals", blk: "blocks",
    "stl+blk": "stocks", to: "turnovers", tov: "turnovers" };
  const ok = [], bad = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length !== 3) { bad.push({ line, reason: "expected: Player, stat, line" }); continue; }
    const key = parts[1].toLowerCase().replace(/\s+/g, "");
    const stat = markets[key] ? key : alias[key];
    const val = Number(parts[2]);
    if (!stat || !markets[stat]) { bad.push({ line, reason: `unknown stat "${parts[1]}"` }); continue; }
    if (!Number.isFinite(val)) { bad.push({ line, reason: "line is not a number" }); continue; }
    ok.push({ player: parts[0].slice(0, 60), stat, line: val });
  }
  return { ok, bad };
}
