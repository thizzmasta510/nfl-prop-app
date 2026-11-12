// Model report: how the current model and the projection did on every Kalshi rung of a
// past slate, against Kalshi's own price.
//
// A cron saves Kalshi's open NBA and NFL player-prop markets every morning (16:00 UTC,
// about 11 AM ET, before any regular game). After the games, each saved rung is scored
// with only the game logs from before that day (the same Board code, no veto, no band),
// and graded against the result. Grading every rung, and comparing the estimates on the
// same rungs, is far less noisy than the hit rate of 15 picks.
//
// Pure functions; src/index.js does the I/O.

import { buildNbaBoard, parseKalshiMarket, eventDate, evPerDollar, blendWithPrice, EV_RULES } from "./nba_board.js";
import { teamContext } from "./nba_model.js";
import { buildNflBoard } from "./nfl_board.js";

export const SNAPSHOT_SERIES = {
  nba: { points: "KXNBAPTS", rebounds: "KXNBAREB", assists: "KXNBAAST", threes: "KXNBA3PT" },
  nfl: { receptions: "KXNFLREC", receiving_yards: "KXNFLRECYDS", rushing_yards: "KXNFLRSHYDS", carries: "KXNFLRSHATT", passing_yards: "KXNFLPASSYDS" },
};
const NBA_STAT_KEY = { points: "points", rebounds: "rebounds", assists: "assists", threes: "threes" };

/** Kalshi /markets response text(s) -> parsed rungs for games on `date`. */
export function snapshotRungs(texts, stat, date) {
  const out = [];
  for (const t of texts) {
    let d; try { d = JSON.parse(t); } catch (e) { continue; }
    for (const m of (d && d.markets) || []) {
      const pm = parseKalshiMarket(m, stat);
      if (pm && pm.date === date) out.push(pm);
    }
  }
  return out;
}

/** The NBA logs as they were before `date` (no season shooting totals: they include later games). */
export function nbaDocAsOf(doc, date) {
  const players = (doc.players || []).filter((r) => String(r.date) < date);
  // That night's schedule, from the games that were played (rows dated `date`).
  const games = new Map();
  for (const r of doc.players || []) {
    if (String(r.date) !== date || !r.team || !r.opponent) continue;
    const key = [r.team, r.opponent].sort().join("-");
    if (!games.has(key)) games.set(key, { g: r.gameId || key, date, tip: date + "T23:30:00Z", home: r.home ? r.team : r.opponent, away: r.home ? r.opponent : r.team });
  }
  // Older games for the hit chance: keep only those before `date`.
  let history;
  if (doc.history && typeof doc.history === "object") {
    history = {};
    for (const [name, h] of Object.entries(doc.history)) {
      if (!h || !Array.isArray(h.dates)) continue;
      const keep = h.dates.map((d, i) => (String(d) < date ? i : -1)).filter((i) => i >= 0);
      if (keep.length) history[name] = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? keep.map((i) => v[i]) : v]));
    }
  }
  return { ...doc, players, teamGames: (doc.teamGames || []).filter((g) => String(g.d) < date), upcoming: [...games.values()], efficiency: undefined, history };
}

/** NFL week for a date, anchored on any row of trend.schedule (weeks start Thursday). */
export function nflWeekOf(schedule, date) {
  const a = (schedule || []).find((g) => g && g.date && Number(g.week));
  if (!a) return null;
  const day = (d) => Date.parse(d + "T12:00:00Z") / 864e5;
  const dow = new Date(a.date + "T12:00:00Z").getUTCDay();   // 4 = Thursday
  const thursday = day(a.date) - ((dow - 4 + 7) % 7);
  return Number(a.week) + Math.floor((day(date) - thursday) / 7);
}

/** NFL logs as they were before week W, with that week's games (from the played rows) as the schedule. */
export function nflTrendAsOf(trend, week, date) {
  const season = Number(trend.season);
  const players = (trend.players || []).filter((r) => !(Number(r.season) === season && Number(r.week) >= week));
  const games = new Map();
  for (const r of trend.players || []) {
    if (Number(r.season) !== season || Number(r.week) !== week || !r.team || !r.opponent) continue;
    const key = [r.team, r.opponent].sort().join("-");
    if (!games.has(key)) games.set(key, { week, date, kickoff: date + "T20:00:00Z", away: r.team, home: r.opponent });
  }
  return { ...trend, players, schedule: [...games.values()] };
}

/**
 * Score every rung. Returns [{ player, strike, mid, overBuy, underBuy, cur, proj, hit, y }]
 * (cur / proj / hit = P(Over) from the current model / the projection / the hit chance
 * (NBA only); y = 1 if the Over hit,
 * null when he didn't play).
 */
export function scoreRungs({ sport, stat, date, markets, doc, trend, weekly, season, normalize }) {
  const wide = { band: [0, 1], limit: 100000, onePerPlayer: false, disagree: 1, maxSpread: 0.2, rankBy: "proj", nowMs: Date.parse(date + "T16:00:00Z") };
  let rows, result;
  if (sport === "nba") {
    const d = nbaDocAsOf(doc, date);
    const b = buildNbaBoard({ ...wide, markets, doc: d, ctx: teamContext(d, date), season, sortBy: "market", dnpRule: "no" });
    rows = b.rows;
    const res = new Map((doc.players || []).filter((r) => String(r.date) === date).map((r) => [r.norm || normalize(r.name), r.stats]));
    result = (norm) => { const s = res.get(norm); const v = s ? Number(s[NBA_STAT_KEY[stat]]) : NaN; return s && Number(s.minutes) > 0 && Number.isFinite(v) ? v : null; };
  } else {
    const week = nflWeekOf(trend.schedule, date);
    if (!week) return [];
    const t = nflTrendAsOf(trend, week, date);
    const b = buildNflBoard({ ...wide, markets, trend: t, weekly, errorGap: 1, sortBy: "market" });
    rows = b.rows;
    const res = new Map((trend.players || []).filter((r) => Number(r.season) === Number(trend.season) && Number(r.week) === week).map((r) => [r.norm || normalize(r.name), r.stats]));
    result = (norm) => { const s = res.get(norm); return s ? Number(s[stat]) || 0 : null; };
  }
  const by = new Map();
  for (const r of rows) {
    const k = `${r.norm}|${r.line}`;
    const e = by.get(k) || by.set(k, { player: r.player, norm: r.norm, strike: Math.floor(r.line) + 1, mid: null, overBuy: null, underBuy: null, cur: null, proj: null, hit: null }).get(k);
    const over = r.side === "Over";
    if (over) { e.mid = r.mid; e.overBuy = r.market; e.cur = r.modelCurrent; e.proj = r.modelProj; e.hit = Number.isFinite(r.hitChance) ? r.hitChance : null; }
    else e.underBuy = r.market;
  }
  const out = [];
  for (const e of by.values()) {
    if (e.mid === null || !Number.isFinite(e.cur)) continue;
    const v = result(e.norm);
    out.push({ player: e.player, strike: e.strike, mid: r4(e.mid), overBuy: r4(e.overBuy), underBuy: r4(e.underBuy), cur: r4(e.cur),
      proj: Number.isFinite(e.proj) ? r4(e.proj) : null, hit: r4(e.hit), y: v === null ? null : v >= e.strike ? 1 : 0 });
  }
  return out;
}
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

// ---------------- summary ----------------
const clip = (p) => Math.min(0.999, Math.max(0.001, p));
const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));

/**
 * reports: [{ date, sport, stat, rungs }]. Returns
 *  accuracy: on rungs where all three exist and the player played: log loss and Brier of
 *            Kalshi's mid, the current model and the projection, with the paired
 *            difference projection - model and its standard error (by player-night).
 *  lists:    the top-15 lists each estimate would have made per slate (66-75% band:
 *            buy price in band, estimate not 10+ below it, highest price first, one per
 *            player; coin flip: buy 48-53%, estimate 5-15 points above, biggest gap first),
 *            graded at the buy price. Each list is also made with the hit chance
 *            ("66-75|hit", "coin|hit"; Proj or the model where there is no hit chance).
 *  accuracy.hit: the same log loss comparison on rungs that have a hit chance (NBA, all
 *            four stats): Kalshi's mid, the current model and the hit chance.
 */
export function summarizeReports(reports, opts = {}) {
  const weight = Number.isFinite(opts.evWeight) ? opts.evWeight : EV_RULES.weight;
  const acc = { n: 0, mkt: 0, cur: 0, proj: 0, bMkt: 0, bCur: 0, bProj: 0 };
  const hacc = { n: 0, mkt: 0, cur: 0, hit: 0 };
  const pairs = new Map();   // player-night -> summed log loss difference
  const slateOf = new Map(); // player-night -> slate (date|sport), for the clustered SE
  const lists = {};
  for (const rep of reports) {
    const rs = (rep.rungs || []).filter((r) => r.y !== null && r.y !== undefined);
    for (const r of rs) {
      if (Number.isFinite(r.hit) && r.mid !== null) { hacc.n++; hacc.mkt += ll(r.mid, r.y); hacc.cur += ll(r.cur, r.y); hacc.hit += ll(r.hit, r.y); }
      if (r.proj === null || r.mid === null) continue;
      acc.n++; acc.mkt += ll(r.mid, r.y); acc.cur += ll(r.cur, r.y); acc.proj += ll(r.proj, r.y);
      acc.bMkt += (r.mid - r.y) ** 2; acc.bCur += (r.cur - r.y) ** 2; acc.bProj += (r.proj - r.y) ** 2;
      const k = `${rep.date}|${rep.sport}|${r.player}`;
      pairs.set(k, (pairs.get(k) || 0) + ll(r.proj, r.y) - ll(r.cur, r.y)); slateOf.set(k, `${rep.date}|${rep.sport}`);
    }
  }
  // lists per slate (date + sport), across that sport's stats
  const slates = new Map();
  for (const rep of reports) { const k = `${rep.date}|${rep.sport}`; (slates.get(k) || slates.set(k, []).get(k)).push(rep); }
  for (const [k, reps] of slates) {
    const sides = [];
    for (const rep of reps) for (const r of rep.rungs || []) {
      if (r.y === null || r.y === undefined) continue;
      const hc = Number.isFinite(r.hit) ? r.hit : null;
      for (const [side, buy, pc, pp, ph, hit] of [["Over", r.overBuy, r.cur, r.proj, hc, r.y === 1], ["Under", r.underBuy, 1 - r.cur, r.proj === null ? null : 1 - r.proj, hc === null ? null : 1 - hc, r.y === 0]]) {
        if (!(buy > 0 && buy < 1)) continue;
        const proj = pp === null ? pc : pp;
        sides.push({ player: r.player, stat: rep.stat, side, mid: side === "Over" ? r.mid : 1 - r.mid, buy, cur: pc, proj, hc: ph === null ? proj : ph, hit });
      }
    }
    if (!sides.length) continue;
    for (const est of ["cur", "proj", "hc"]) {
      const band = sides.filter((s) => s.buy >= 0.66 && s.buy <= 0.75 && s[est] >= s.buy - 0.10).sort((a, b) => b.buy - a.buy || b[est] - a[est]);
      const coin = sides.filter((s) => s.buy >= 0.48 && s.buy <= 0.53 && s[est] >= s.buy + 0.05 && s[est] - s.buy <= 0.15).sort((a, b) => (b[est] - b.buy) - (a[est] - a.buy));
      // +EV list (the Board's band=ev): price 30-65%, EV 3%+ after the fee on the chance blended with the Kalshi mid, estimates 25+ points above the price set aside, highest EV first.
      // "evraw": the same list on the raw estimate (no blend; estimates 15+ points above the price set aside), kept to see whether blending helps.
      const evOf = (s2) => evPerDollar(blendWithPrice(s2[est], s2.mid, weight), s2.buy);
      const inBand = sides.filter((s2) => s2.buy >= EV_RULES.band[0] && s2.buy <= EV_RULES.band[1]);
      const evL = inBand.filter((s2) => evOf(s2) >= EV_RULES.minEv && s2[est] - s2.buy <= EV_RULES.errorGap + 1e-9).sort((x, y) => evOf(y) - evOf(x));
      const evRaw = inBand.filter((s2) => evPerDollar(s2[est], s2.buy) >= EV_RULES.minEv && s2[est] - s2.buy <= EV_RULES.rawErrorGap).sort((x, y) => evPerDollar(y[est], y.buy) - evPerDollar(x[est], x.buy));
      for (const [name, L] of [["66-75", band], ["coin", coin], ["ev", evL], ["evraw", evRaw]]) {
        const seen = new Set(), top = [];
        for (const s of L) { if (seen.has(s.player)) continue; seen.add(s.player); top.push(s); if (top.length === 15) break; }
        const t = (lists[`${name}|${est === "hc" ? "hit" : est}`] ||= { picks: 0, hits: 0, priceSum: 0, units: 0, slates: 0 });
        t.slates++;
        for (const s of top) { t.picks++; t.priceSum += s.buy; if (s.hit) { t.hits++; t.units += (1 - s.buy) / s.buy; } else t.units -= 1; }
      }
    }
  }
  const d = [...pairs.values()], mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  const se = d.length > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1) / d.length) : null;
  // Slate-clustered SE: player-nights on one slate share games, injuries and weather.
  let seSlate = null;
  if (d.length > 1 && mean !== null) {
    const bySlate = new Map(); for (const [k, v] of pairs) bySlate.set(slateOf.get(k), (bySlate.get(slateOf.get(k)) || 0) + (v - mean));
    const G = bySlate.size;
    if (G > 1) seSlate = Math.sqrt([...bySlate.values()].reduce((a, s) => a + s * s, 0) * (G / (G - 1))) / d.length;
  }
  const n = acc.n || 1;
  return {
    accuracy: { rungs: acc.n, playerNights: d.length,
      logLoss: { market: acc.mkt / n, model: acc.cur / n, proj: acc.proj / n }, brier: { market: acc.bMkt / n, model: acc.bCur / n, proj: acc.bProj / n },
      projMinusModel: mean, se, seSlate, slates: new Set(slateOf.values()).size,
      hit: hacc.n ? { rungs: hacc.n, logLoss: { market: hacc.mkt / hacc.n, model: hacc.cur / hacc.n, hit: hacc.hit / hacc.n } } : null },
    lists: Object.fromEntries(Object.entries(lists).map(([k, t]) => [k, { ...t, hitRate: t.picks ? t.hits / t.picks : null, breakEven: t.picks ? t.priceSum / t.picks : null, units: Math.round(t.units * 100) / 100 }])),
  };
}

/**
 * How much weight the app's estimate deserves next to the Kalshi price, from graded slates.
 * Fits one number w in  P(Over) = sigmoid( logit(mid) + w x (logit(estimate) - logit(mid)) )
 * by maximum likelihood (estimate = hit chance, else Proj, else the model). The weight the
 * Board uses is that fit pulled toward the starting value: with n graded player-nights,
 * (n x fit + priorNights x start) / (n + priorNights), kept inside 0-0.6.
 * Returns { weight, fitted, playerNights, rungs } (fitted null with nothing to fit).
 */
export function fitPriceWeight(reports, start = EV_RULES.weight, priorNights = EV_RULES.priorNights) {
  const lg = (p) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
  const rows = [], nights = new Set();
  for (const rep of reports || []) for (const r of rep.rungs || []) {
    if (r.y !== 0 && r.y !== 1) continue;
    const est = Number.isFinite(r.hit) ? r.hit : Number.isFinite(r.proj) ? r.proj : r.cur;
    if (!(r.mid > 0.02 && r.mid < 0.98) || !Number.isFinite(est)) continue;
    rows.push({ o: lg(r.mid), d: lg(est) - lg(r.mid), y: r.y }); nights.add(`${rep.date}|${rep.sport}|${r.player}`);
  }
  if (!rows.length) return { weight: start, fitted: null, playerNights: 0, rungs: 0 };
  let w = start;
  for (let it = 0; it < 50; it++) {
    let g = 0, h = 0;
    for (const r of rows) { const p = 1 / (1 + Math.exp(-(r.o + w * r.d))); g += (r.y - p) * r.d; h += p * (1 - p) * r.d * r.d; }
    if (!(h > 1e-12)) break;
    const step = g / h; w += step; if (Math.abs(step) < 1e-9) break;
  }
  const fitted = Math.min(1.5, Math.max(-0.5, w)), n = nights.size;
  const weight = Math.min(0.6, Math.max(0, (n * fitted + priorNights * start) / (n + priorNights)));
  return { weight: Math.round(weight * 1000) / 1000, fitted: Math.round(fitted * 1000) / 1000, playerNights: n, rungs: rows.length };
}

export { eventDate };
