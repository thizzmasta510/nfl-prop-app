// My Picks: grading and the running record for tracked picks.
//
// Picks reach the tracker from the Track button on the NFL and NBA Boards (with
// the price paid) or from Scored Props. NFL results come from player-stats.json
// by week; NBA results from the NBA game logs by game date. Pure functions; the
// Worker reads and writes the files.

import { normalizeName, shortKey, matchPlayerStat } from "./model.js";

/** American odds from a price (probability). 0.75 -> -300, 0.40 -> +150. */
export function priceToOdds(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) return null;
  return x >= 0.5 ? -Math.round((100 * x) / (1 - x)) : Math.round((100 * (1 - x)) / x);
}

/** Profit per 1 unit staked at American odds, or null. */
export function oddsProfit(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? o / 100 : 100 / Math.abs(o);
}

/** Same pick logged twice (same game, player, market, side and line) is a duplicate. */
export function trackerDupeKey(e) {
  const s = (v) => String(v ?? "").toLowerCase().trim();
  return [s(e.sport || "nfl"), s(e.week), s(e.gameDate), s(e.player), s(e.propType), s(e.lean), s(e.openingLine)].join("|");
}

/** HIT / MISS / PUSH / VOID (did not play) / "" (not graded yet). */
export function gradeResult(e) {
  if (String(e.actual ?? "").toUpperCase() === "DNP") return "VOID";
  const line = Number.isFinite(Number(e.closingLine)) && Number(e.closingLine) !== 0 ? Number(e.closingLine) : Number(e.openingLine);
  if (e.actual === undefined || e.actual === null || e.actual === "" || !Number.isFinite(line)) return "";
  const a = Number(e.actual);
  if (!Number.isFinite(a)) return "";
  if (a === line) return "PUSH";
  const lean = String(e.lean || "").toUpperCase();
  if ((lean === "OVER" && a > line) || (lean === "UNDER" && a < line)) return "HIT";
  if (lean === "OVER" || lean === "UNDER") return "MISS";
  return "";
}

const NBA_PROP_STAT = { points: "points", rebounds: "rebounds", assists: "assists", "3-pointers": "threes", threes: "threes" };
export function nbaStatKey(entry) {
  if (entry.stat) return String(entry.stat);
  const t = String(entry.propType || "").toLowerCase();
  for (const k of Object.keys(NBA_PROP_STAT)) if (t.includes(k)) return NBA_PROP_STAT[k];
  return null;
}

/**
 * NBA result for a tracked pick from the NBA game logs.
 * -> { status: "matched", value } | { status: "dnp" } | { status: "pending" | "no_stat_key" | "ambiguous", reason }
 */
export function matchNbaStat(entry, rows) {
  const stat = nbaStatKey(entry);
  if (!stat) return { status: "no_stat_key", reason: `no stat for "${entry.propType || ""}"` };
  const date = String(entry.gameDate || "");
  if (!date) return { status: "pending", reason: "no game date on this pick" };
  const sameDay = rows.filter((r) => r.date === date);
  const norm = normalizeName(entry.player), team = String(entry.team || "").toUpperCase();
  let hits = sameDay.filter((r) => (r.norm || normalizeName(r.name)) === norm && (!team || r.team === team));
  if (!hits.length) hits = sameDay.filter((r) => (r.norm || normalizeName(r.name)) === norm);
  if (!hits.length && team) hits = sameDay.filter((r) => (r.short || shortKey(r.name)) === shortKey(entry.player) && r.team === team);
  if (hits.length > 1) return { status: "ambiguous", reason: `${hits.length} players matched "${entry.player}" on ${date}` };
  if (hits.length === 1) {
    const v = hits[0].stats ? Number(hits[0].stats[stat]) : NaN;
    return Number.isFinite(v) ? { status: "matched", value: v, matchedName: hits[0].name } : { status: "pending", reason: `no ${stat} recorded` };
  }
  // His team has a box score for that day but he isn't in it: he did not play.
  if (team && sameDay.some((r) => r.team === team)) return { status: "dnp", reason: "not in the box score (did not play)" };
  return { status: "pending", reason: `no box score for ${date} yet` };
}

/**
 * Fill `actual` on ungraded picks. nflRows: player-stats.json rows (may be empty);
 * nbaRows: NBA game-log rows (may be empty). Mutates entries when apply is true.
 */
export function autogradeEntries(entries, { nflRows = [], nbaRows = [], apply = true } = {}) {
  const applied = [], needsReview = [], pending = [];
  for (const e of entries) {
    if (e.actual !== undefined && e.actual !== null && e.actual !== "") continue;
    if (String(e.sport || "nfl") === "nba") {
      const m = matchNbaStat(e, nbaRows);
      if (m.status === "matched") { applied.push({ id: e.id, player: e.player, value: m.value }); if (apply) e.actual = m.value; }
      else if (m.status === "dnp") { applied.push({ id: e.id, player: e.player, value: "DNP" }); if (apply) e.actual = "DNP"; }
      else if (m.status === "pending") pending.push({ id: e.id, player: e.player, reason: m.reason });
      else needsReview.push({ id: e.id, player: e.player, status: m.status, reason: m.reason });
      continue;
    }
    if (!nflRows.length) { pending.push({ id: e.id, player: e.player, reason: "NFL stats not loaded" }); continue; }
    const m = matchPlayerStat(e, nflRows);
    if (m.status === "matched") { applied.push({ id: e.id, player: e.player, value: m.value }); if (apply) e.actual = m.value; }
    else if (m.status === "missing_week") pending.push({ id: e.id, player: e.player, reason: m.reason });
    // A week can be partly published (Thursday's game is in, Sunday's isn't): if his team has
    // no rows for that week yet, his game hasn't been loaded, so the pick is still waiting.
    else if (m.status === "no_match" && e.team && !nflRows.some((r) => Number(r.week) === Number(e.week) && String(r.team).toUpperCase() === String(e.team).toUpperCase()))
      pending.push({ id: e.id, player: e.player, reason: `no week ${e.week} stats for ${e.team} yet` });
    else needsReview.push({ id: e.id, player: e.player, status: m.status, reason: m.reason });
  }
  return { applied, needsReview, pending };
}

// ---- Closing line value (CLV) ----
// The market's fair price for the same side at kickoff / tip-off (the bid-ask mid),
// read afterwards from Kalshi's public candlesticks. CLV = closing mid - price paid.
// Positive means you bought below where the market settled before the game, the best
// quick sign of a real edge (it needs far fewer picks than win-loss to mean anything).
// The mid is used, not the closing buy price, because spreads often widen right before
// tip-off (13c / 28c was seen), which would make a buy-price close look like a big win.

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
/** Close of an OHLC object in dollars (new API: close_dollars "0.2500"; old: close in cents). */
function ohlcClose(o) {
  if (!o) return NaN;
  const d = num(o.close_dollars);
  if (Number.isFinite(d)) return d;
  const c = num(o.close);
  return Number.isFinite(c) ? c / 100 : NaN;
}

/**
 * Fair price of a side at kickoff from Kalshi candlesticks: the last candle that ended
 * at or before kickoff. YES mid = (bid + ask) / 2; Over = mid, Under = 1 - mid. Falls
 * back to the one quote there is, then to the last trade.
 * -> { price, at, spread } or null
 */
export function closeFromCandles(candles, lean, kickoffMs) {
  const list = (candles || []).filter((c) => c && Number.isFinite(num(c.end_period_ts)) && num(c.end_period_ts) * 1000 <= kickoffMs)
    .sort((a, b) => num(a.end_period_ts) - num(b.end_period_ts));
  const over = String(lean || "").toUpperCase() === "OVER";
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    const bid = ohlcClose(c.yes_bid), ask = ohlcClose(c.yes_ask), last = ohlcClose(c.price);
    const okBid = bid > 0 && bid < 1, okAsk = ask > 0 && ask < 1;
    const yes = okBid && okAsk ? (bid + ask) / 2 : okAsk ? ask : okBid ? bid : last;
    const p = over ? yes : 1 - yes;
    if (Number.isFinite(p) && p > 0 && p < 1) return { price: Math.round(p * 1000) / 1000, at: new Date(num(c.end_period_ts) * 1000).toISOString(),
      spread: okBid && okAsk ? Math.round((ask - bid) * 1000) / 1000 : null };
  }
  return null;
}

/** Tracked from a Board, game started, closing price not read yet. */
export function needsClose(e, nowMs = Date.now()) {
  if (!e || !e.ticker || !e.kickoff) return false;
  if (Number.isFinite(num(e.closePrice))) return false;
  if ((Number(e.closeTries) || 0) >= 3) return false;   // no price history for this market: stop asking
  const k = Date.parse(e.kickoff);
  return Number.isFinite(k) && k <= nowMs;
}

/** CLV in probability points (0.02 = 2 cents), or null. */
export function clvOf(e) {
  const c = num(e.closePrice), p = num(e.marketProb);
  return Number.isFinite(c) && Number.isFinite(p) && p > 0 ? Math.round((c - p) * 1000) / 1000 : null;
}

/**
 * CLV split in two (needs the side's mid when tracked):
 *   execution = mid when tracked - price paid   (what taking the ask cost; limit orders fix it)
 *   movement  = closing mid - mid when tracked  (did the market move your way; needs sample size)
 * execution + movement = CLV.
 */
export function clvParts(e) {
  const c = num(e.closePrice), p = num(e.marketProb), m = num(e.pickMid);
  if (!Number.isFinite(m) || !(m > 0 && m < 1)) return null;
  const r = (x) => Math.round(x * 1000) / 1000;
  return { execution: Number.isFinite(p) ? r(m - p) : null, movement: Number.isFinite(c) ? r(c - m) : null };
}

/** The closing candle ended more than 30 minutes before kickoff: too old to count as the close. */
export const STALE_CLOSE_MINUTES = 30;
export function closeIsStale(e) {
  const k = Date.parse(e.kickoff || ""), a = Date.parse(e.closeAt || "");
  return Number.isFinite(k) && Number.isFinite(a) && k - a > STALE_CLOSE_MINUTES * 60000;
}

/**
 * Kalshi trading fee as a fraction of the amount staked. Taker: 7% x P x (1 - P) per
 * contract (rounded up to the next cent per order, so 1-contract orders pay up to 2c);
 * per dollar staked that is 0.07 x (1 - P). Resting limit orders (makers) pay 0 on most
 * markets. Uses the unrounded rate, so small orders pay a little more than shown.
 */
export const TAKER_FEE = 0.07;
export function feeFraction(e) {
  if (String(e.orderType || "").toLowerCase() === "maker") return 0;
  const p = num(e.marketProb) > 0 && num(e.marketProb) < 1 ? num(e.marketProb) : (() => { const o = num(e.odds); return o < 0 ? -o / (-o + 100) : o > 0 ? 100 / (o + 100) : NaN; })();
  return Number.isFinite(p) && p > 0 && p < 1 ? TAKER_FEE * (1 - p) : 0;
}

function bucket() { return { picks: 0, graded: 0, hits: 0, misses: 0, pushes: 0, voids: 0, pending: 0, priced: 0, impliedSum: 0, staked: 0, profit: 0, fees: 0,
  clvN: 0, clvSum: 0, clvBeat: 0, clvSame: 0, clvStale: 0, execN: 0, execSum: 0, moveN: 0, moveSum: 0 }; }
function finish(b) {
  const decided = b.hits + b.misses;
  return {
    picks: b.picks, record: `${b.hits}-${b.misses}${b.pushes ? `-${b.pushes}` : ""}`, hits: b.hits, misses: b.misses, pushes: b.pushes, voids: b.voids, pending: b.pending,
    hitRate: decided ? b.hits / decided : null,
    impliedRate: b.priced ? b.impliedSum / b.priced : null,   // what the prices paid said they'd hit
    units: Math.round(b.profit * 100) / 100, staked: Math.round(b.staked * 100) / 100,
    roi: b.staked ? b.profit / b.staked : null, priced: b.priced,
    fees: Math.round(b.fees * 100) / 100, unitsAfterFees: Math.round((b.profit - b.fees) * 100) / 100,
    clv: b.clvN || b.clvStale ? { n: b.clvN, avg: b.clvN ? Math.round((b.clvSum / b.clvN) * 1000) / 1000 : null, beat: b.clvBeat, same: b.clvSame,
      beatRate: b.clvN ? b.clvBeat / b.clvN : null, stale: b.clvStale,
      execution: b.execN ? Math.round((b.execSum / b.execN) * 1000) / 1000 : null, movement: b.moveN ? Math.round((b.moveSum / b.moveN) * 1000) / 1000 : null } : null,
  };
}

/** Grades every entry and returns { entries (with result), summary: { all, nfl, nba } }. */
export function picksSummary(entries) {
  const out = entries.map((e) => ({ ...e, result: gradeResult(e), clv: clvOf(e), clvParts: clvParts(e), closeStale: closeIsStale(e) }));
  const b = { all: bucket(), nfl: bucket(), nba: bucket() };
  for (const e of out) {
    for (const k of ["all", String(e.sport || "nfl") === "nba" ? "nba" : "nfl"]) {
      const x = b[k];
      x.picks++;
      // CLV counts every pick with a closing price, graded or not (it is known at kickoff).
      // Stale closes (last candle 30+ minutes before kickoff) are shown but not averaged.
      if (e.clv !== null && String(e.actual ?? "").toUpperCase() !== "DNP") {
        if (e.closeStale) x.clvStale++;
        else {
          x.clvN++; x.clvSum += e.clv;
          if (e.clv > 0.0005) x.clvBeat++; else if (e.clv >= -0.0005) x.clvSame++;
          if (e.clvParts && e.clvParts.movement !== null) { x.moveN++; x.moveSum += e.clvParts.movement; }
        }
      }
      if (e.clvParts && e.clvParts.execution !== null) { x.execN++; x.execSum += e.clvParts.execution; }
      if (!e.result) { x.pending++; continue; }
      if (e.result === "VOID") { x.voids++; continue; }
      if (e.result === "PUSH") { x.pushes++; continue; }
      x.graded++;
      if (e.result === "HIT") x.hits++; else x.misses++;
      const p = oddsProfit(e.odds);
      if (p === null) continue;
      const stake = Number.isFinite(Number(e.stake)) && Number(e.stake) > 0 ? Number(e.stake) : 1;
      x.priced++; x.impliedSum += 1 / (1 + p); x.staked += stake;
      x.profit += e.result === "HIT" ? stake * p : -stake;
      x.fees += stake * feeFraction(e);
    }
  }
  const key = (e) => String(e.gameDate || "") || `w${String(e.week || "").padStart(2, "0")}`;
  out.sort((a, b2) => key(b2).localeCompare(key(a)) || String(b2.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { entries: out, summary: { all: finish(b.all), nfl: finish(b.nfl), nba: finish(b.nba) } };
}
