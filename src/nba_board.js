// NBA Board: the NFL "most probable near -250" workflow, automated for the NBA.
//
// 1. Kalshi lists NBA player props as "X+" ladders (e.g. "Jalen Brunson: 25+
//    points"). Each rung is Over X-0.5; the Under is the other side of the rung.
// 2. Keep sides the market prices inside a band (default 66-75%, about -195 to
//    -300), skip games that have started, players with no recent games, wide
//    spreads, and sides where the model strongly disagrees with the market.
// 3. Rank what is left by the model's probability, with the matchup context
//    and the last-10 record at that number next to it.
//
// Pure functions; the Worker fetches the markets (src/index.js). Research tool:
// the market price is usually the better estimate, and a big model-over-market
// gap is more often model error than value.

import { normalizeName } from "./model.js";
import { gameLogs } from "./trends.js";
import { nbaProjection, probAtLeast, matchupFactor, nextGame, posGroup } from "./nba_model.js";
import { injuryFor, teammatesOut, SKIP_STATUSES, PLAY_PROBABILITY } from "./nba_injuries.js";

export const KALSHI_NBA_SERIES = { points: "KXNBAPTS", rebounds: "KXNBAREB", assists: "KXNBAAST", threes: "KXNBA3PT" };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// "26OCT21NYKCLE" -> "2026-10-21"
export function eventDate(eventTicker) {
  const seg = String(eventTicker || "").split("-")[1] || "";
  const m = seg.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || !MONTHS[m[2]]) return null;
  return `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[3]}`;
}

const price = (dollars, cents) => {
  const d = Number(dollars);
  if (dollars !== undefined && dollars !== null && dollars !== "" && Number.isFinite(d)) return d;
  const c = Number(cents);
  return cents !== undefined && cents !== null && Number.isFinite(c) ? c / 100 : null;
};

/** One Kalshi market object -> { player, strike, stat, date, bid, ask, mid, ticker } or null. */
export function parseKalshiMarket(m, stat) {
  if (!m || !m.ticker) return null;
  if (m.status && !["active", "open", "initialized"].includes(String(m.status).toLowerCase())) return null;
  const title = String(m.title || m.yes_sub_title || "");
  const t = title.match(/^\s*(.+?)\s*:\s*(\d+)\s*\+/);
  const strikeFromTicker = Number(String(m.ticker).split("-").pop());
  const strike = t ? Number(t[2]) : strikeFromTicker;
  const player = t ? t[1] : null;
  if (!player || !Number.isFinite(strike) || strike <= 0) return null;
  const bid = price(m.yes_bid_dollars, m.yes_bid), ask = price(m.yes_ask_dollars, m.yes_ask), last = price(m.last_price_dollars, m.last_price);
  let mid = null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask < 1 && ask >= bid) mid = (bid + ask) / 2;
  else if (last !== null && last > 0 && last < 1) mid = last;
  if (mid === null) return null;
  return { ticker: m.ticker, event: m.event_ticker || String(m.ticker).split("-").slice(0, 2).join("-"),
    date: eventDate(m.event_ticker || m.ticker), player, norm: normalizeName(player), stat, strike,
    bid: bid && bid > 0 ? bid : null, ask: ask && ask > 0 && ask < 1 ? ask : null, mid,
    spread: bid && ask && ask >= bid ? ask - bid : null };
}

function gameOn(doc, team, date) {
  for (const g of doc.upcoming || []) {
    if ((g.home === team || g.away === team) && (!date || g.date === date)) {
      return { gameId: g.g, date: g.date, tip: g.tip, home: g.home === team, opp: g.home === team ? g.away : g.home };
    }
  }
  return null;
}

const shortKey = (norm) => { const p = norm.split(" "); return p.length < 2 ? norm : `${p[0][0]} ${p[p.length - 1]}`; };

const DAY = 86400000;
const dayMs = (d) => Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Did the team play (or is it scheduled to play) the day before `date`? */
function backToBack(doc, team, date) {
  if (!team || !date) return false;
  const prev = ymdOf(dayMs(date) - DAY);
  return (doc.teamGames || []).some((g) => g.t === team && String(g.d) === prev) ||
    (doc.upcoming || []).some((g) => (g.home === team || g.away === team) && g.date === prev);
}

/**
 * opts: { markets: [parsed], doc, ctx, season, nowMs, band: [lo, hi], limit, injuries,
 *         sortBy = "market" | "model", onePerPlayer = true, dnpRule = "no" | "void",
 *         maxSpread = 0.10, disagree = 0.10, staleDays = 21 }
 *
 * Band and sort use the BUY price (the ask for an Over, 1 - bid for an Under), the
 * price you can actually get; the mid is used only when there is no quote.
 * Default sort is by that market price, with the model as a veto: within a narrow
 * band, ranking by the model mostly ranks the model's own errors (it has not been
 * shown to beat the market). sortBy = "model" is kept as a research view.
 * dnpRule: how Kalshi settles a player who does not play. "no" (default) treats it
 * as a No, so P(Over) = P(plays) x P(Over | plays); "void" uses P(Over | plays).
 * Check the contract terms on Kalshi and set KALSHI_DNP_RULE if they say void.
 */
export function buildNbaBoard(opts) {
  const { markets, doc, ctx, season } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const [lo, hi] = opts.band || [0.66, 0.75];
  const maxSpread = opts.maxSpread ?? 0.10, disagree = opts.disagree ?? 0.10, staleDays = opts.staleDays ?? 21;
  const sortBy = opts.sortBy === "model" ? "model" : "market";
  const onePerPlayer = opts.onePerPlayer !== false;
  const dnpRule = opts.dnpRule === "void" ? "void" : "no";
  const excluded = { unknownPlayer: 0, inactive: 0, started: 0, notOnSchedule: 0, wideSpread: 0, outOfBand: 0,
    modelDisagrees: 0, fewGames: 0, injured: 0, duplicateRung: 0 };
  const inj = opts.injuries || null;             // injuryIndex(...) or null
  const injuredSkipped = new Map(), notScheduled = new Set();
  const unknown = new Set();
  const logsByStat = {};
  const newestDate = (doc.players || []).reduce((mx, r) => (String(r.date) > mx ? String(r.date) : mx), "");
  const hasSchedule = Array.isArray(doc.upcoming) && doc.upcoming.length > 0;

  let rows = [];
  for (const mk of markets) {
    let logs = logsByStat[mk.stat];
    if (!logs) {
      const byNorm = gameLogs(doc.players || [], { sport: "nba", stat: mk.stat, season });
      const byShort = new Map();
      for (const p of byNorm.values()) { const k = shortKey(p.norm); byShort.set(k, byShort.has(k) ? null : p); } // null = ambiguous
      logs = logsByStat[mk.stat] = { byNorm, byShort };
    }
    const p = logs.byNorm.get(mk.norm) || logs.byShort.get(shortKey(mk.norm)) || null;
    if (!p) { excluded.unknownPlayer++; unknown.add(mk.player); continue; }
    // Official injury report: skip Out / Doubtful; Questionable and Probable are kept,
    // with their chance of playing applied below.
    const ir = injuryFor(inj, p.norm, p.team);
    if (ir && SKIP_STATUSES.has(ir.status)) { excluded.injured++; injuredSkipped.set(p.name, ir.status); continue; }
    const lastDate = p.games.length ? String(p.games[0].tag) : "";
    if (!lastDate || (newestDate && (dayMs(newestDate) - dayMs(lastDate)) / DAY > staleDays)) { excluded.inactive++; continue; }
    // This market's game must be on the schedule with tip-off still ahead. Games
    // missing from the schedule (postponed, moved, or the schedule is stale) are
    // counted separately from games that have started, and listed.
    let ng = null;
    if (hasSchedule) {
      ng = gameOn(doc, p.team, mk.date);
      if (!ng) { excluded.notOnSchedule++; notScheduled.add(`${p.team} ${mk.date}`); continue; }
      if (Date.parse(ng.tip) <= nowMs) { excluded.started++; continue; }
    } else {
      ng = nextGame(doc, p.team, nowMs);
    }
    if (mk.spread !== null && mk.spread > maxSpread) { excluded.wideSpread++; continue; }
    const mf = matchupFactor(mk.stat, ctx, p.team, ng && ng.opp, p.position);
    const proj = nbaProjection(p.games, ng ? mf.factor : 1, mk.stat);
    if (!proj) { excluded.fewGames++; continue; }
    const pOverIfPlays = probAtLeast(mk.strike, proj.mean, proj.dispersion);
    const pPlays = ir ? (PLAY_PROBABILITY[ir.status] ?? 1) : 1;
    const pOver = dnpRule === "no" ? pPlays * pOverIfPlays : pOverIfPlays;
    const gameDate = (ng && ng.date) || mk.date;
    const daysOff = gameDate && lastDate ? Math.round((dayMs(gameDate) - dayMs(lastDate)) / DAY) : null;
    const flags = {
      backToBack: backToBack(doc, p.team, gameDate),
      returning: daysOff !== null && daysOff > 10 ? daysOff : null,  // days since his last game
      matchupCapped: !!mf.capped,
    };
    const last10 = p.games.slice(0, 10).map((g) => g.value);
    const sides = [
      { side: "Over", mid: mk.mid, buy: mk.ask, model: pOver, hits: last10.filter((v) => v >= mk.strike).length },
      { side: "Under", mid: 1 - mk.mid, buy: mk.bid !== null ? 1 - mk.bid : null, model: 1 - pOver, hits: last10.filter((v) => v < mk.strike).length },
    ];
    for (const s of sides) {
      const price = s.buy !== null && s.buy > 0 && s.buy < 1 ? s.buy : s.mid;   // what you can actually get
      if (price < lo || price > hi) { excluded.outOfBand++; continue; }
      if (s.model < price - disagree) { excluded.modelDisagrees++; continue; }
      const O = ng && ctx && ctx.teams[ng.opp];
      const grp = posGroup(p.position);
      const d = ng && ctx && grp && ctx.dvp[ng.opp] && ctx.dvp[ng.opp][grp] && ctx.dvp[ng.opp][grp][mk.stat];
      const avgMin = (norm) => {
        const q = logs.byNorm.get(norm);
        const ms = q ? q.games.slice(0, 10).map((x) => x.minutes).filter((x) => Number.isFinite(x)) : [];
        return ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
      };
      rows.push({
        player: p.name, norm: p.norm, team: p.team, position: p.position, stat: mk.stat, ticker: mk.ticker,
        side: s.side, line: mk.strike - 0.5, rung: `${mk.strike}+`,
        market: price, mid: s.mid, buy: s.buy, priceBasis: price === s.buy ? "buy" : "mid",
        model: s.model, modelIfPlays: s.side === "Over" ? pOverIfPlays : 1 - pOverIfPlays, pPlays,
        gap: s.model - price,
        caution: s.model - price > 0.10 ? "model far above market: more likely model error than value" : null,
        injury: ir ? { status: ir.status, reason: ir.reason } : null,
        teammatesOut: teammatesOut(inj, p.team, p.norm, avgMin).slice(0, 4),
        reportPending: inj ? inj.notSubmitted.has(p.team) : false,
        flags,
        projection: proj.mean, minutes: proj.minutes, minutesSd: proj.minutesSd,
        last10, last10Record: `${s.hits} of ${last10.length}`,
        game: ng ? { opp: ng.opp, home: ng.home, tip: ng.tip, date: ng.date } : { date: mk.date },
        context: {
          paceRank: O ? O.paceRank : null, drtgRank: O ? O.drtgRank : null,
          dvp: d ? { group: grp, rank: d.rank, of: d.of } : null, factor: mf.factor,
        },
      });
    }
  }
  // One row per player, stat and side: neighboring rungs (Under 29.5 and Under 24.5
  // points) are the same bet on the same game, so keep the one the market rates
  // most likely and count the rest.
  if (onePerPlayer) {
    const best = new Map();
    for (const r of rows) {
      const k = `${r.norm}|${r.stat}|${r.side}`;
      const cur = best.get(k);
      if (!cur || r.market > cur.market) { if (cur) excluded.duplicateRung++; best.set(k, { ...r, otherRungs: (cur ? cur.otherRungs + 1 : 0) }); }
      else { excluded.duplicateRung++; cur.otherRungs++; }
    }
    rows = [...best.values()];
  }
  // Flag players who appear in more than one market (points and 3-pointers move together).
  const perPlayer = {};
  for (const r of rows) perPlayer[r.norm] = (perPlayer[r.norm] || 0) + 1;
  for (const r of rows) r.sameGameRows = perPlayer[r.norm] - 1;
  rows.sort(sortBy === "model"
    ? (a, b) => b.model - a.model || b.market - a.market
    : (a, b) => b.market - a.market || b.model - a.model);
  return {
    band: [lo, hi], priceBasis: "buy price (mid when there is no quote)", sortBy, dnpRule,
    count: rows.length, excluded, unknownPlayers: [...unknown].slice(0, 25),
    injuredSkipped: [...injuredSkipped].slice(0, 25).map(([name, status]) => ({ name, status })),
    notOnSchedule: [...notScheduled].slice(0, 25),
    injuries: inj ? inj.meta : null,
    rows: rows.slice(0, opts.limit ?? 25),
    note: "Kalshi 'X+' rungs: Over = X-0.5, Under = the other side of the rung. A side is kept when its buy price is inside the band and the model is not 10+ points below it; one rung per player, stat and side. " +
      (sortBy === "market" ? "Sorted by market price; the model is only a veto." : "Sorted by the model (research view; the model has not been shown to beat the market).") +
      " Out and Doubtful players are skipped; Questionable and Probable players' chance of playing (rough, unfitted: 75% and 97%) is applied" +
      (dnpRule === "no" ? ", assuming a player who doesn't play settles as No" : "") + ". Teammates out, back-to-backs and returns from absence are shown, not modeled. Check lineups before tip-off.",
  };
}

// American odds for a probability (for display).
export function americanOdds(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
