// NFL Board: Kalshi's NFL player-prop ladders (every rung, straight from Kalshi's
// public market data) scored with the app's NFL model, the same way the weekly
// "top 15 near -250" PDFs are built.
//
// For each rung: strike X = Over X-0.5, Under = the other side. A side is kept when
// its buy price is inside the band, the bid-ask spread is not too wide, the game
// has not kicked off (nflverse schedule), the player has 2026 games, and the model
// is not 10+ points below the market. Sides where the model is 15+ points ABOVE
// the market are set aside as likely data errors (usually a stale 2025 baseline).
// Pure functions; the Worker fetches the markets.

import { scoreProp, normalizeName } from "./model.js";
import { gameLogs } from "./trends.js";
import { parseKalshiMarket, boardSort, suggestedLimit, evPerDollar, blendWithPrice, EV_RULES } from "./nba_board.js";
import { impliedTotal } from "./game_script.js";

import { nflOppIndex, nflOpportunityProjection, nflProbAtLeast, nflOppSummary, NFL_OPP_STATS } from "./nfl_opportunity.js";
import { nflHitChance, nflRecentIndex } from "./hit_chance.js";

export const KALSHI_NFL_SERIES = {
  receptions: "KXNFLREC", receiving_yards: "KXNFLRECYDS", rushing_yards: "KXNFLRSHYDS",
  carries: "KXNFLRSHATT", passing_yards: "KXNFLPASSYDS",
};
export const NFL_PROP_TYPE = {
  receptions: "Receptions", receiving_yards: "Receiving Yards", rushing_yards: "Rushing Yards",
  carries: "Rush Attempts", passing_yards: "Passing Yards",
};
const UNIT = { receptions: "rec", receiving_yards: "rec yds", rushing_yards: "rush yds", carries: "rush att", passing_yards: "pass yds" };
// nflverse code -> codes Kalshi may use in event tickers.
const KALSHI_CODES = { LA: ["LAR", "LA"], JAX: ["JAX", "JAC"], WAS: ["WAS", "WSH"], LV: ["LV", "LVR"] };
const codesFor = (t) => KALSHI_CODES[t] || [t];

export { parseKalshiMarket };

const shortKey = (norm) => { const p = norm.split(" "); return p.length < 2 ? norm : `${p[0][0]} ${p[p.length - 1]}`; };

/** "KXNFLRECYDS-26OCT25TBCAR" + team "TB" -> true when the team is in that game. */
export function teamInEvent(event, team) {
  const seg = String(event || "").split("-")[1] || "";
  const codes = seg.replace(/^\d{2}[A-Z]{3}\d{2}/, "");
  return codesFor(team).some((c) => codes.startsWith(c) || codes.endsWith(c));
}

/**
 * opts: { markets: [parsed, stat = KALSHI_NFL_SERIES key], trend (trend-logs.json),
 *         weekly (weekly-stats.json), nowMs, band [lo, hi], limit, sortBy "model"|"market",
 *         onePerPlayer = true, maxSpread = 0.14, disagree = 0.10, errorGap = 0.15 }
 */
export function buildNflBoard(opts) {
  const { markets, trend } = opts;
  const weekly = opts.weekly || {};
  const nowMs = opts.nowMs ?? Date.now();
  const [lo, hi] = opts.band || [0.66, 0.75];
  const maxSpread = opts.maxSpread ?? 0.14, disagree = opts.disagree ?? 0.10, errorGap = opts.errorGap ?? 0.15;
  const sortBy = ["market", "edge", "ev"].includes(opts.sortBy) ? opts.sortBy : "model";
  const rankBy = ["hit", "proj"].includes(opts.rankBy) ? opts.rankBy : "model";
  // Plus-money / coin-flip bands: keep a side only when the model is minGap or more ABOVE the price.
  const minGap = Number.isFinite(opts.minGap) ? opts.minGap : null;
  const minEv = Number.isFinite(opts.minEv) ? opts.minEv : null;   // EV list: keep a side only at this EV or better
  const evWeight = Number.isFinite(opts.evWeight) ? opts.evWeight : EV_RULES.weight;
  const season = Number(trend.season) || new Date().getUTCFullYear();
  const schedule = Array.isArray(trend.schedule) ? trend.schedule : [];
  const priors = trend.priorSeason || {};
  const defense = {};
  for (const d of weekly.defense || []) defense[d.team] = d;
  const excluded = { unknownPlayer: 0, noCurrentSeason: 0, wrongGame: 0, started: 0, notOnSchedule: 0, wideSpread: 0,
    outOfBand: 0, modelDisagrees: 0, belowMinGap: 0, belowMinEv: 0, likelyDataError: 0, duplicateRung: 0 };
  const dataErrors = [], unknown = new Set();
  const logsByStat = {};
  // Game script: this week's spread/total (schedule) against the average lines
  // of the games already in each player's log (trend.lines, one row per team-week).
  const lineByTeamWeek = new Map();
  for (const l of trend.lines || []) lineByTeamWeek.set(`${l.team}|${l.week}`, l);
  const playedWeeks = new Map();   // norm -> [{week, team}] this season
  for (const r of trend.players || []) {
    if (Number(r.season) !== season) continue;
    const k = r.norm || normalizeName(r.name);
    if (!playedWeeks.has(k)) playedWeeks.set(k, []);
    playedWeeks.get(k).push({ week: Number(r.week), team: r.team });
  }
  const logLines = (norm) => {
    const ls = (playedWeeks.get(norm) || []).map((w) => lineByTeamWeek.get(`${w.team}|${w.week}`)).filter(Boolean);
    if (!ls.length) return {};
    const avgSpread = ls.reduce((a, l) => a + l.spread, 0) / ls.length;
    const avgImplied = ls.reduce((a, l) => a + impliedTotal(l.total, l.spread), 0) / ls.length;
    return { avgSpread, avgImplied };
  };
  let linesMissing = 0;
  let oppIdx = null;   // opportunity projection index, built on first use
  let recentIdx = null; // last games across seasons, for the hit chance
  const curWeek = Math.max(0, ...(trend.players || []).filter((r) => Number(r.season) === season).map((r) => Number(r.week)).filter(Number.isFinite));

  let rows = [];
  for (const mk of markets) {
    let L = logsByStat[mk.stat];
    if (!L) {
      const byNorm = gameLogs(trend.players || [], { sport: "nfl", stat: mk.stat, season });
      const byShort = new Map();
      for (const p of byNorm.values()) { const k = shortKey(p.norm); byShort.set(k, byShort.has(k) ? null : p); }
      L = logsByStat[mk.stat] = { byNorm, byShort };
    }
    const p = L.byNorm.get(mk.norm) || L.byShort.get(shortKey(mk.norm)) || null;
    if (!p) { excluded.unknownPlayer++; unknown.add(mk.player); continue; }
    const cur = p.games.filter((g) => g.season === season);
    if (!cur.length) { excluded.noCurrentSeason++; continue; }
    if (!teamInEvent(mk.event, p.team)) { excluded.wrongGame++; continue; }   // e.g. a traded player not yet in the logs
    // Kickoff check against the nflverse schedule: never price a game in progress.
    let game = null;
    if (schedule.length) {
      game = schedule.find((g) => g.date === mk.date && (g.away === p.team || g.home === p.team)) || null;
      if (!game) { excluded.notOnSchedule++; continue; }
      if (Date.parse(game.kickoff) <= nowMs) { excluded.started++; continue; }
    }
    if (mk.spread !== null && mk.spread > maxSpread) { excluded.wideSpread++; continue; }
    const opp = game ? (game.away === p.team ? game.home : game.away) : null;
    const d = opp ? defense[opp] : null;
    const pr = priors[p.norm];
    const prior = pr && pr.games >= 8 && Number.isFinite(pr[mk.stat]) ? pr[mk.stat] : undefined;
    const log = cur.map((g) => g.value);
    let teamSpread, gameTotal;
    if (game && Number.isFinite(game.spreadHome) && Number.isFinite(game.total)) {
      teamSpread = game.home === p.team ? game.spreadHome : -game.spreadHome;
      gameTotal = game.total;
    } else linesMissing++;
    const ll = teamSpread !== undefined ? logLines(p.norm) : {};
    const s = scoreProp({ week: curWeek + 1, team: p.team, player: p.name, propType: NFL_PROP_TYPE[mk.stat], line: mk.strike - 0.5,
      gameLog: log, injuryStatus: "Healthy", roleVolumeScore: 5, gamesPlayed: log.length, lineIsEstimate: true,
      priorYrBaseline: prior, oppDefRank: d ? d.defRank : undefined, matchupReliability: 0.75,
      teamSpread, gameTotal, logAvgSpread: ll.avgSpread, logAvgImplied: ll.avgImplied });
    const pOver = s.pOver;
    if (!Number.isFinite(pOver)) continue;
    // Opportunity projection (volume x regressed efficiency), with the same game-script
    // adjustment applied to volume. Shown next to Model; not used to pick or filter.
    let oppProj = null, oi = null;
    if (NFL_OPP_STATS.includes(mk.stat)) {
      oppIdx ||= nflOppIndex(trend, normalizeName);
      oi = oppIdx.get(p.norm);
      oppProj = oi && oi.games.length ? nflOpportunityProjection(oi.games, mk.stat, oi.prev, { volumeAdj: Number(s.gameScriptAdj) || 0 }) : null;
    }
    const oppOver = oppProj ? nflProbAtLeast(mk.strike, oppProj) : null;
    // rankBy "proj": the opportunity projection decides where it exists; the current model stays as modelCurrent.
    // Hit chance: Proj after a second pass over his last 10 games and last-game volume
    // (passing yards, rush attempts and rushing yards only; src/hit_chance.js).
    let hc = null;
    if (oppOver !== null && oi) { recentIdx ||= nflRecentIndex(trend, normalizeName); hc = nflHitChance({ pOver: oppOver, strike: mk.strike, stat: mk.stat, games: oi.games, recent: recentIdx.get(p.norm) }); }
    const hitOver = hc ? hc.pOver : null;
    const useHit = rankBy === "hit" && hitOver !== null;
    const useProj = !useHit && rankBy !== "model" && oppOver !== null;
    const sides = [
      { side: "Over", mid: mk.mid, buy: mk.ask, cur: pOver, proj: oppOver, hit: hitOver, hits: log.filter((v) => v >= mk.strike).length },
      { side: "Under", mid: 1 - mk.mid, buy: mk.bid !== null ? 1 - mk.bid : null, cur: 1 - pOver, proj: oppOver === null ? null : 1 - oppOver, hit: hitOver === null ? null : 1 - hitOver, hits: log.filter((v) => v < mk.strike).length },
    ];
    for (const sd of sides) sd.model = useHit ? sd.hit : useProj ? sd.proj : sd.cur;
    for (const sd of sides) {
      const price = sd.buy !== null && sd.buy > 0 && sd.buy < 1 ? sd.buy : sd.mid;
      if (price < lo || price > hi) { excluded.outOfBand++; continue; }
      if (sd.model < price - disagree) { excluded.modelDisagrees++; continue; }
      if (minGap !== null && sd.model < price + minGap) { excluded.belowMinGap++; continue; }
      const fair = blendWithPrice(sd.model, sd.mid, evWeight), ev = evPerDollar(fair, price);
      if (minEv !== null && !(ev >= minEv)) { excluded.belowMinEv++; continue; }
      const row = {
        player: p.name, norm: p.norm, team: p.team, position: p.position, stat: mk.stat, unit: UNIT[mk.stat], ticker: mk.ticker,
        side: sd.side, line: mk.strike - 0.5, rung: `${mk.strike}+`,
        market: price, mid: sd.mid, buy: sd.buy, spread: mk.spread, limit: suggestedLimit(sd.mid, sd.buy), model: sd.model, gap: sd.model - price,
        modelCurrent: sd.cur, modelProj: sd.proj, hitChance: sd.hit, ev, evRaw: evPerDollar(sd.model, price), fair, rankedBy: useHit ? "hit" : useProj ? "proj" : "model",
        hit: hc ? { games: hc.games, share: sd.side === "Over" ? hc.share : 1 - hc.share, lastVol: hc.lastVol } : null,
        caution: sd.model - price > 0.10 ? "model far above market: more likely model error than value" : null,
        projection: s.finalProjection, log, logRecord: `${sd.hits} of ${log.length}`,
        prior: prior ?? null, opp, oppDefRank: d ? d.defRank : null,
        teamSpread: teamSpread ?? null, gameTotal: gameTotal ?? null, gameScriptAdj: s.gameScriptAdj,
        opportunity: nflOppSummary(oppProj, { model: sd.proj }),
        week: game && Number.isFinite(Number(game.week)) ? Number(game.week) : curWeek + 1,
        game: game ? { opp, home: game.home === p.team, kickoff: game.kickoff, date: game.date } : { date: mk.date },
      };
      if (sd.model - price > errorGap) { excluded.likelyDataError++; dataErrors.push({ player: p.name, side: sd.side, line: row.line, unit: row.unit, model: sd.model, market: price }); continue; }
      rows.push(row);
    }
  }
  if (opts.onePerPlayer !== false) {
    const best = new Map();
    for (const r of rows) {
      const k = `${r.norm}|${r.stat}|${r.side}`;
      const cur = best.get(k);
      if (!cur || r.model > cur.model) { if (cur) excluded.duplicateRung++; best.set(k, { ...r, otherRungs: cur ? cur.otherRungs + 1 : 0 }); }
      else { excluded.duplicateRung++; cur.otherRungs++; }
    }
    rows = [...best.values()];
  }
  rows.sort(boardSort(sortBy));
  return {
    band: [lo, hi], sortBy, rankBy, minGap, minEv, evWeight, count: rows.length, excluded, unknownPlayers: [...unknown].slice(0, 25),
    dataErrors: dataErrors.sort((a, b) => (b.model - b.market) - (a.model - a.market)).slice(0, 15),
    scheduleIncluded: schedule.length > 0, defenseIncluded: Object.keys(defense).length > 0,
    linesIncluded: schedule.some((g) => Number.isFinite(g.spreadHome)), linesMissing,
    rows: rows.slice(0, opts.limit ?? 25),
    note: "Kalshi 'X+' rungs: Over = X-0.5, Under = the other side. Kept when the buy price is inside the band, the spread is at most 14 cents, the model is not 10+ points below the market, and the game has not kicked off. Sides where the model is 15+ points above the market are listed separately as likely data errors. Model: the app's NFL model with this season's game log, last season's per-game average (8+ games) season-to-date defensive EPA rank, and game script from the spread and total (favorites run more, underdogs and high team totals throw more; a few percent at most). NFL injury statuses are not loaded automatically: check the Friday reports and inactives.",
  };
}

export { normalizeName };
