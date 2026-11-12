// Kalshi vs sportsbooks backtest.
//
// Question: when Kalshi's price for a player prop is clearly cheaper than the
// sportsbooks' consensus says it should be, does buying it on Kalshi make money
// after fees?
//
//   1. Sportsbook side: closing lines and no-vig probabilities from your SportsGameOdds
//      backfill (sgo_backfill.json; made by backtest/sgo_backfill.mjs).
//   2. Kalshi side: every NFL prop ladder rung near the book's line, with Kalshi's bid
//      and ask at kickoff (public candlesticks) and how the contract settled.
//   3. Strategy: buy the Kalshi side when the books' fair probability is at least T
//      points above Kalshi's buy price. Profit per unit staked, after the taker fee
//      (7% x P x (1-P) per contract), and also at the mid with no fee (a resting limit
//      order that filled: the optimistic case).
//
// Book lines rarely sit exactly on a Kalshi rung (a 54.5 line vs Kalshi's 50+ / 55+).
// "Exact" rows are the clean test (the rung is the book line + 0.5, common for
// receptions). "Nearby" rows move the book's probability to Kalshi's rung with a
// normal approximation (typical game-to-game spread per stat); they are reported
// separately because that step is an assumption.
//
// Run from the app folder (needs internet; about 15-30 minutes the first time,
// resumable, progress kept in backtest/kvb_cache.json):
//   node backtest/kalshi_vs_books.mjs --books path\to\sgo_backfill.json
// Options: --limit 300 (quick trial), --analyze-only (re-run the report from the cache),
//          --max-gap 7.5 (yards between book line and rung for "nearby" rows).
// Outputs (local only, git-ignored: they contain licensed odds): backtest/kvb_rows.json,
// backtest/kvb_cache.json. The report (backtest/kvb_report.txt) is aggregates only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "../src/model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERIES = { rushing_yards: "KXNFLRSHYDS", receiving_yards: "KXNFLRECYDS", receiving_receptions: "KXNFLREC",
  passing_yards: "KXNFLPASSYDS", rushing_attempts: "KXNFLRSHATT" };
// Typical game-to-game coefficient of variation (sd / mean) for one player, used only to
// move a book probability a few yards to Kalshi's rung.
export const CV = { passing_yards: 0.28, rushing_yards: 0.55, receiving_yards: 0.65, receiving_receptions: 0.5, rushing_attempts: 0.35 };
// How far a rung may be from the book line (in stat units) for a "nearby" row.
export const MAX_GAP = { passing_yards: 15, rushing_yards: 7.5, receiving_yards: 7.5, receiving_receptions: 0, rushing_attempts: 0 };
export const TAKER_FEE = 0.07;
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// ---------------- pure helpers (tested in test/kalshi_vs_books.test.mjs) ----------------

/** "KXNFLREC-26SEP20INDKC" -> "2026-09-20" */
export function eventDate(eventTicker) {
  const m = String(eventTicker || "").split("-")[1]?.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  return m && MONTHS[m[2]] ? `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[3]}` : null;
}
/** ISO time -> Eastern date "YYYY-MM-DD" (Kalshi dates games by ET). */
export function etDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const implied = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
/** No-vig probability of the Over from the closing over/under American odds. */
export function noVigOver(overOdds, underOdds) {
  const o = Number(overOdds), u = Number(underOdds);
  if (!Number.isFinite(o) || !Number.isFinite(u) || o === 0 || u === 0) return null;
  const a = implied(o), b = implied(u);
  return a / (a + b);
}
/** "Noah Gray: 40+ receiving yards" -> { player, strike: 40 } */
export function parseRung(title) {
  const m = String(title || "").match(/^\s*(.+?)\s*:\s*(\d+)\s*\+/);
  return m ? { player: m[1], strike: Number(m[2]) } : null;
}
// Standard normal CDF and inverse (Acklam), enough precision for this.
export function phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export function phiInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/**
 * Book probability of Over `line`, moved to Kalshi's rung `strike` (X >= strike).
 * Exact when strike - 0.5 === line. Otherwise X ~ Normal(mu, (cv*mu)^2) with mu chosen so
 * P(X > line) matches the book, then P(X > strike - 0.5).
 */
export function probAtRung(pOver, line, strike, stat) {
  const k = strike - 0.5;
  if (Math.abs(k - line) < 1e-9) return pOver;
  const cv = CV[stat];
  if (!cv || !(pOver > 0 && pOver < 1)) return null;
  const z = phiInv(1 - pOver);
  const denom = 1 + cv * z;
  if (!(denom > 0.05)) return null;
  const mu = line / denom, sd = cv * mu;
  if (!(sd > 0)) return null;
  return 1 - phi((k - mu) / sd);
}
const dollars = (o) => {
  if (!o) return NaN;
  const d = Number(o.close_dollars);
  if (Number.isFinite(d)) return d;
  const c = Number(o.close);
  return Number.isFinite(c) && o.close !== null ? c / 100 : NaN;
};
/** Last candle ending at or before kickoff with a two-sided quote -> { bid, ask, at } or null. */
export function quoteAtKickoff(candles, kickoffSec) {
  const list = (candles || []).filter((c) => c && Number(c.end_period_ts) <= kickoffSec).sort((a, b) => a.end_period_ts - b.end_period_ts);
  for (let i = list.length - 1; i >= 0; i--) {
    const bid = dollars(list[i].yes_bid), ask = dollars(list[i].yes_ask);
    if (bid > 0 && ask > 0 && ask < 1 && ask >= bid) return { bid, ask, at: Number(list[i].end_period_ts) };
  }
  return null;
}
export const takerFeeFrac = (p) => TAKER_FEE * (1 - p);   // fee per unit staked at price p

/**
 * Sides and outcomes for one matched row. row: { pAtRung, bid, ask, yes (true/false: Over won) }
 * -> [{ side, buy, mid, fair, edge, won }]
 */
export function sides(row) {
  const mid = (row.bid + row.ask) / 2;
  return [
    { side: "Over", buy: row.ask, mid, fair: row.pAtRung, edge: row.pAtRung - row.ask, won: row.yes === true },
    { side: "Under", buy: 1 - row.bid, mid: 1 - mid, fair: 1 - row.pAtRung, edge: (1 - row.pAtRung) - (1 - row.bid), won: row.yes === false },
  ];
}

/** Strategy table: buy the best side when edge >= t; one bet per player-stat-game. */
export function simulate(rows, thresholds = [0, 0.02, 0.04, 0.06, 0.08, 0.10]) {
  // One bet per player, stat and game: the rung/side with the biggest edge.
  const best = new Map();
  for (const r of rows) {
    if (r.yes !== true && r.yes !== false) continue;
    for (const s of sides(r)) {
      if (!(s.buy > 0 && s.buy < 1)) continue;
      const k = `${r.game}|${r.norm}|${r.stat}`;
      const cur = best.get(k);
      if (!cur || s.edge > cur.edge) best.set(k, { ...s, row: r });
    }
  }
  const bets = [...best.values()];
  return thresholds.map((t) => {
    const take = bets.filter((b) => b.edge >= t);
    const n = take.length;
    if (!n) return { t, n: 0 };
    let won = 0, pnlTaker = 0, pnlMid = 0, sumBuy = 0, sumFair = 0;
    const per = [];
    for (const b of take) {
      if (b.won) won++;
      const fee = takerFeeFrac(b.buy);
      const pt = (b.won ? (1 - b.buy) / b.buy : -1) - fee;
      const pm = b.won ? (1 - b.mid) / b.mid : -1;
      pnlTaker += pt; pnlMid += pm; sumBuy += b.buy; sumFair += b.fair; per.push(pt);
    }
    const mean = pnlTaker / n;
    const sd = Math.sqrt(per.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    return { t, n, hit: won / n, avgBuy: sumBuy / n, avgFair: sumFair / n, roiTaker: mean, seTaker: sd / Math.sqrt(n), roiMid: pnlMid / n };
  });
}

/** How far apart the two markets are: Kalshi mid vs book fair (Over), in points. */
export function gapStats(rows) {
  rows = rows.filter((r) => r.yes === true || r.yes === false);
  const g = rows.map((r) => ((r.bid + r.ask) / 2 - r.pAtRung) * 100).sort((a, b) => a - b);
  if (!g.length) return null;
  const q = (p) => g[Math.min(g.length - 1, Math.floor(p * g.length))];
  const abs = g.map(Math.abs).sort((a, b) => a - b);
  const brier = (f) => rows.reduce((a, r) => a + (f(r) - (r.yes ? 1 : 0)) ** 2, 0) / rows.length;
  return { n: g.length, median: q(0.5), p10: q(0.1), p90: q(0.9), absMedian: abs[Math.floor(abs.length / 2)],
    over4: abs.filter((x) => x >= 4).length / abs.length,
    brierKalshi: brier((r) => (r.bid + r.ask) / 2), brierBooks: brier((r) => r.pAtRung) };
}

export function report(rows) {
  const pct = (x, d = 1) => (x === undefined || x === null ? "-" : (x * 100).toFixed(d) + "%");
  const lines = [];
  const block = (label, rs) => {
    lines.push("", `== ${label}: ${rs.length} Kalshi rungs matched ==`);
    const g = gapStats(rs);
    if (!g) { lines.push("  (none)"); return; }
    lines.push(`  Kalshi mid minus books' fair price (Over), points: median ${g.median.toFixed(1)}, 10th-90th pct ${g.p10.toFixed(1)} to ${g.p90.toFixed(1)}; typical size ${g.absMedian.toFixed(1)}; ${pct(g.over4, 0)} differ by 4+`);
    lines.push(`  Accuracy (Brier, lower is better): Kalshi mid ${g.brierKalshi.toFixed(4)}  books ${g.brierBooks.toFixed(4)}`);
    lines.push("  Buy the Kalshi side when books' fair price beats Kalshi's buy price by at least T (one bet per player/stat/game):");
    lines.push("    T      bets   hit     avg buy  books fair  ROI after taker fee (SE)   ROI at mid, no fee");
    for (const s of simulate(rs)) {
      if (!s.n) { lines.push(`    ${String(Math.round(s.t * 100)).padStart(2)}pt   0`); continue; }
      lines.push(`    ${String(Math.round(s.t * 100)).padStart(2)}pt  ${String(s.n).padStart(5)}  ${pct(s.hit).padStart(6)}  ${pct(s.avgBuy).padStart(7)}  ${pct(s.avgFair).padStart(9)}   ${(s.roiTaker >= 0 ? "+" : "") + pct(s.roiTaker)} (${pct(s.seTaker)})`.padEnd(78) + `${(s.roiMid >= 0 ? "+" : "") + pct(s.roiMid)}`);
    }
  };
  const fresh = rows.filter((r) => !r.stale);
  lines.push("Kalshi vs sportsbooks backtest (NFL player props). Books: SportsGameOdds consensus close, no-vig.",
    "Kalshi: bid/ask at kickoff from public candlesticks; outcome = how the Kalshi contract settled.",
    `Rows: ${rows.length} matched (${rows.length - fresh.length} with a quote 30+ min before kickoff, left out below).`);
  block("EXACT (rung = book line + 0.5) - the clean test", fresh.filter((r) => r.exact));
  block("NEARBY (book probability moved to the rung; an assumption)", fresh.filter((r) => !r.exact));
  for (const st of Object.keys(SERIES)) {
    const rs = fresh.filter((r) => r.stat === st);
    if (rs.length >= 50) block(`by stat: ${st} (exact + nearby)`, rs);
  }
  const seasons = [...new Set(fresh.map((r) => r.date.slice(0, 7) < "2026-07" ? "2025-26 season" : "2026-27 season"))];
  if (seasons.length > 1) for (const s of seasons) block(s, fresh.filter((r) => (r.date.slice(0, 7) < "2026-07" ? "2025-26 season" : "2026-27 season") === s));
  lines.push("", "Read: an edge is real only if ROI after the taker fee is positive by more than ~2 SE, at a threshold with a few hundred bets,",
    "and holds in both seasons. 'ROI at mid' is the best case (every limit order filled at the mid).");
  return lines.join("\n");
}

// ---------------- Kalshi fetching (paced, retried, cached) ----------------
const BASES = ["https://api.elections.kalshi.com/trade-api/v2", "https://external-api.kalshi.com/trade-api/v2"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function makeClient({ fetchImpl = fetch, paceMs = 110, log = () => {} } = {}) {
  let last = 0, calls = 0;
  return {
    get calls() { return calls; },
    async get(p) {
      for (let attempt = 0; attempt < 7; attempt++) {
        const wait = last + paceMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now(); calls++;
        let res;
        try { res = await fetchImpl(BASES[attempt % 2 === 0 ? 0 : 1] + p, { headers: { accept: "application/json" } }); }
        catch (e) { await sleep(500 * 2 ** attempt); continue; }
        if (res.status === 404) return null;
        if (res.status === 429 || res.status >= 500) { log(`  (Kalshi ${res.status}, waiting)`); await sleep(1000 * 2 ** attempt); continue; }
        if (!res.ok) return null;
        return res.json();
      }
      return null;
    },
  };
}

async function run() {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
  const has = (n) => argv.includes(`--${n}`);
  const OUT = process.env.KVB_DIR || HERE;
  const cachePath = path.join(OUT, "kvb_cache.json"), rowsPath = path.join(OUT, "kvb_rows.json"), reportPath = path.join(OUT, "kvb_report.txt");
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : { events: {}, markets: {}, candles: {} };
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));

  if (has("analyze-only")) {
    const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
    const rep = report(rows); fs.writeFileSync(reportPath, rep); console.log(rep); return;
  }
  const booksPath = arg("books") || ["sgo_backfill.json", path.join("backtest", "sgo_backfill.json")].find((p) => fs.existsSync(p));
  if (!booksPath || !fs.existsSync(booksPath)) { console.error("Point --books at your sgo_backfill.json"); process.exit(1); }
  const doc = JSON.parse(fs.readFileSync(booksPath, "utf8"));
  // The books' "close" is the benchmark here; 2025's are often in-game lines (sgo_check.mjs).
  { const { warnIfInGame } = await import("./sgo_check.mjs"); warnIfInGame(doc.rows || doc); }
  const gapOverride = arg("max-gap") ? Number(arg("max-gap")) : null;
  let books = (doc.rows || doc).filter((r) => SERIES[r.stat] && r.startsAt && Number.isFinite(r.close) && r.overCloseOdds && r.underCloseOdds && r.name)
    .map((r) => ({ ...r, date: etDate(r.startsAt), norm: normalizeName(r.name), pOver: noVigOver(r.overCloseOdds, r.underCloseOdds) }))
    .filter((r) => r.date && r.pOver !== null);
  const limit = Number(arg("limit")) || 0;
  console.log(`Book props with a usable close: ${books.length}`);
  const client = makeClient({ log: console.log });

  // 1. Kalshi events per series on the dates we have book lines for.
  const dates = new Set(books.map((b) => b.date));
  const events = [];
  for (const [stat, series] of Object.entries(SERIES)) {
    if (!cache.events[series]) {
      const list = []; let cursor = "";
      for (let page = 0; page < 60; page++) {
        const q = new URLSearchParams({ series_ticker: series, limit: "200" }); if (cursor) q.set("cursor", cursor);
        const d = await client.get("/events?" + q.toString());
        if (!d) break;
        for (const e of d.events || []) if (e && e.event_ticker) list.push(e.event_ticker);
        cursor = d.cursor || ""; if (!cursor) break;
      }
      cache.events[series] = list; save();
    }
    for (const ev of cache.events[series]) if (dates.has(eventDate(ev))) events.push({ stat, series, ev, date: eventDate(ev) });
  }
  console.log(`Kalshi games on those dates: ${events.length} (across ${Object.keys(SERIES).length} markets)`);
  const datesWithKalshi = new Set(events.map((e) => e.date));
  books = books.filter((b) => datesWithKalshi.has(b.date));
  if (limit) books = books.slice(0, limit);
  console.log(`Book props on dates Kalshi covered: ${books.length}`);

  // 2. Markets (rungs) per event.
  const rungIndex = new Map();   // date|stat|norm -> [{ ticker, strike, result }]
  let i = 0;
  for (const e of events) {
    if (!cache.markets[e.ev]) {
      const ms = [];
      // Older settled markets may be archived: try the live endpoint, then /historical/markets.
      for (const base of ["/markets", "/historical/markets"]) {
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          const q = new URLSearchParams({ event_ticker: e.ev, limit: "1000" }); if (cursor) q.set("cursor", cursor);
          const d = await client.get(base + "?" + q.toString());
          if (!d) break;
          for (const m of d.markets || []) { const pr = parseRung(m.title); if (pr) ms.push({ t: m.ticker, p: pr.player, s: pr.strike, r: m.result || null }); }
          cursor = d.cursor || ""; if (!cursor) break;
        }
        if (ms.length) break;
      }
      cache.markets[e.ev] = ms;
      if (++i % 25 === 0) { save(); console.log(`  markets: ${i} games read`); }
    }
    for (const m of cache.markets[e.ev]) {
      const k = `${e.date}|${e.stat}|${normalizeName(m.p)}`;
      if (!rungIndex.has(k)) rungIndex.set(k, []);
      rungIndex.get(k).push({ ticker: m.t, strike: m.s, result: m.r });
    }
  }
  save();

  // 3. For each book prop, the rungs at or near its line; Kalshi's quote at kickoff.
  const rows = []; let done = 0, noRung = 0, noQuote = 0;
  for (const b of books) {
    const cands = (rungIndex.get(`${b.date}|${b.stat}|${b.norm}`) || []).filter((m) => {
      const gap = Math.abs(m.strike - 0.5 - b.close);
      return gap < 1e-9 || gap <= (gapOverride ?? MAX_GAP[b.stat]);
    });
    if (!cands.length) { noRung++; continue; }
    const k = Math.floor(Date.parse(b.startsAt) / 1000);
    for (const m of cands) {
      if (!(m.ticker in cache.candles)) {
        const series = m.ticker.split("-")[0];
        const q1 = new URLSearchParams({ start_ts: String(k - 3 * 3600), end_ts: String(k), period_interval: "1" }).toString();
        let d = await client.get(`/series/${series}/markets/${m.ticker}/candlesticks?${q1}`);
        if (!d || !(d.candlesticks || []).length) d = await client.get(`/historical/markets/${m.ticker}/candlesticks?${q1}`);
        let qt = quoteAtKickoff(d && d.candlesticks, k);
        if (!qt) {
          const q2 = new URLSearchParams({ start_ts: String(k - 24 * 3600), end_ts: String(k), period_interval: "60" }).toString();
          d = await client.get(`/series/${series}/markets/${m.ticker}/candlesticks?${q2}`)
            || await client.get(`/historical/markets/${m.ticker}/candlesticks?${q2}`);
          qt = quoteAtKickoff(d && d.candlesticks, k);
        }
        cache.candles[m.ticker] = qt;
        if (++done % 50 === 0) { save(); console.log(`  prices: ${done} rungs read (${client.calls} requests)`); }
      }
      const qt = cache.candles[m.ticker];
      if (!qt) { noQuote++; continue; }
      const pAtRung = probAtRung(b.pOver, b.close, m.strike, b.stat);
      if (pAtRung === null) continue;
      const yes = m.result === "yes" ? true : m.result === "no" ? false : (Number.isFinite(b.actual) ? b.actual >= m.strike : null);
      rows.push({ game: b.eventID, date: b.date, name: b.name, norm: b.norm, stat: b.stat, line: b.close, strike: m.strike,
        exact: Math.abs(m.strike - 0.5 - b.close) < 1e-9, pOver: b.pOver, pAtRung, bid: qt.bid, ask: qt.ask,
        stale: k - qt.at > 30 * 60, yes, nBooks: b.nBooks });
    }
  }
  save();
  fs.writeFileSync(rowsPath, JSON.stringify(rows));
  console.log(`Matched rungs: ${rows.length}; book props with no Kalshi rung nearby: ${noRung}; rungs with no price history: ${noQuote}; Kalshi requests: ${client.calls}`);
  const rep = report(rows);
  fs.writeFileSync(reportPath, rep);
  console.log(rep);
  console.log(`\nReport saved to ${reportPath} (aggregates only; safe to share). Row data stays in kvb_rows.json (do not commit).`);
}

if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "kalshi_vs_books.mjs") {
  run().catch((e) => { console.error(e); process.exit(1); });
}
