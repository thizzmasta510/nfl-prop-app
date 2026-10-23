// node test/nba_model.test.mjs
import assert from "node:assert/strict";
import { posGroup, teamContext, nextGame, matchupFactor, nbaProjection, probAtLeast, probOver, probUnder, decorateNbaGrid } from "../src/nba_model.js";
import { injuryFor } from "../src/nba_injuries.js";
import { parseKalshiMarket, eventDate, buildNbaBoard, americanOdds } from "../src/nba_board.js";
import { buildTrendGrid } from "../src/trends.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// --- posGroup
assert.equal(posGroup("G"), "G"); assert.equal(posGroup("Forward-Center"), "F"); assert.equal(posGroup("C"), "C");
assert.equal(posGroup(""), null); assert.equal(posGroup(null), null);

// --- probability: Poisson branch equals the direct sum; NB has the right mean and fatter tails
const pois = (k, mu) => { let c = 0, t = Math.exp(-mu); for (let x = 0; x < k; x++) { c += t; t *= mu / (x + 1); } return 1 - c; };
close(probAtLeast(5, 4.2, 1.0), pois(5, 4.2));
assert.equal(probAtLeast(0, 3, 2), 1);
{
  const mu = 22, d = 2.5; let mean = 0, prevTail = 1;
  for (let x = 1; x < 200; x++) {
    const tail = probAtLeast(x, mu, d); assert.ok(tail <= prevTail + 1e-12); prevTail = tail;
    if (tail <= 0.001) break;                              // display floor reached
    mean += tail;
  }
  close(mean, mu, 0.1);                                    // E[X] = sum of P(X >= x)
  assert.ok(probAtLeast(35, mu, d) > pois(35, mu), "overdispersed tail is fatter than Poisson");
}
// Over/Under on a half line are complements; a whole line leaves room for a push.
{
  const proj = { mean: 7.1, dispersion: 1.4 };
  close(probOver(6.5, proj) + probUnder(6.5, proj), 1);
  assert.ok(probOver(7, proj) + probUnder(7, proj) < 1);
}

// --- projection: per-minute rate x recent minutes
{
  const games = Array.from({ length: 10 }, (_, i) => ({ value: 10, minutes: i < 3 ? 40 : 20 })); // rate 0.5/min, minutes up lately
  const p = nbaProjection(games);
  assert.ok(p.minutes > 30 && p.minutes < 40, `recent minutes weighted: ${p.minutes}`);
  assert.ok(p.mean > 10, "more minutes lately -> projection above the plain average");
  assert.equal(nbaProjection(games.slice(0, 2)), null);
  close(nbaProjection(games, 1.1).mean, p.mean * 1.1);
}

// --- team context from teamGames, with no lookahead
const tg = (d, t, o, pts, opp, poss, s = 2026) => ({ g: d + t, d, s, t, o, pts, opp, poss, min: 240 });
const teamGames = [];
for (let i = 0; i < 6; i++) {
  const d = `2026-10-${String(10 + i).padStart(2, "0")}`;
  teamGames.push(tg(d, "FST", "SLW", 120, 110, 105), tg(d, "SLW", "FST", 110, 120, 105));
  teamGames.push(tg(d, "MID", "DEF", 100, 95, 98), tg(d, "DEF", "MID", 95, 100, 98));
}
teamGames.push(tg("2026-10-30", "SLW", "DEF", 200, 50, 60)); // a later game the "as of" view must not see
const players = [];
const pr = (name, team, opp, pos, date, pts, reb, season = 2026) => ({ name, team, opponent: opp, position: pos, season, date, seasonType: "Regular Season",
  stats: { points: pts, rebounds: reb, assists: 3, threes: 2, pra: pts + reb + 3, minutes: 33 } });
for (let i = 0; i < 6; i++) {
  const d = `2026-10-${String(10 + i).padStart(2, "0")}`;
  for (let k = 0; k < 2; k++) {
    players.push(pr(`Fast G${k}`, "FST", "SLW", "G", d, 30, 4), pr(`Slow G${k}`, "SLW", "FST", "G", d, 12, 4));
    players.push(pr(`Mid G${k}`, "MID", "DEF", "G", d, 20, 4), pr(`Def G${k}`, "DEF", "MID", "G", d, 18, 4));
  }
}
const upcoming = [
  { g: "1", tip: "2026-10-21T23:30:00Z", date: "2026-10-21", home: "FST", away: "DEF" },
  { g: "2", tip: "2026-10-22T00:00:00Z", date: "2026-10-21", home: "SLW", away: "MID" },
  { g: "3", tip: "2026-10-23T23:30:00Z", date: "2026-10-23", home: "DEF", away: "FST" },
];
const doc = { season: 2026, generatedAt: "x", players, teamGames, upcoming };
const ctx = teamContext(doc, "2026-10-20");
close(ctx.teams.FST.pace, 48 * 6 * 105 / (6 * 240 / 5));
close(ctx.teams.FST.drtg, 100 * 110 / 105);
assert.equal(ctx.teams.SLW.games, 6, "the Oct 30 game is after the as-of date");
assert.equal(ctx.teams.MID.drtgRank, 1, "MID allows the fewest points per 100 (95 on 98)");
assert.equal(ctx.teams.FST.paceRank <= 2, true);
// DvP: SLW lets FST guards score 30 per game -> softest vs G; DEF allows 20 -> toughest along with ...
assert.equal(ctx.dvp.SLW.G.points.avg, 30);
assert.equal(ctx.dvp.SLW.G.points.rank, 4, "allows the most (4 teams)");
assert.equal(ctx.dvp.FST.G.points.rank, 1, "allows the least (12 per guard)");
// Last-season blend: no current games -> last season's value; some -> in between.
{
  const d2 = { players: [], teamGames: [tg("2026-01-01", "AAA", "BBB", 100, 100, 100, 2025), tg("2026-11-01", "AAA", "BBB", 100, 120, 100, 2026)] };
  const early = teamContext(d2, "2026-10-31");
  close(early.teams.AAA.drtg, 100, 1e-9);
  const later = teamContext(d2, "2026-11-02");
  close(later.teams.AAA.drtg, (1 * 120 + 1 * 100) / 2); // 1 current game, 1 prior game available
}

// --- next game and matchup factor
assert.deepEqual(nextGame(doc, "FST", Date.parse("2026-10-21T12:00:00Z")).opp, "DEF");
assert.equal(nextGame(doc, "FST", Date.parse("2026-10-22T12:00:00Z")).gameId, "3", "game 1 already tipped off");
{
  const soft = matchupFactor("points", ctx, "MID", "SLW", "G");
  const tough = matchupFactor("points", ctx, "MID", "DEF", "G");
  assert.ok(soft.factor > tough.factor, "softer, faster opponent -> bigger factor");
  assert.ok(soft.factor <= 1.15 && tough.factor >= 0.85, "capped at +/-15%");
  assert.equal(matchupFactor("steals", ctx, "MID", "SLW", "G").parts.defense, 1, "DRtg only for scoring stats");
  assert.equal(matchupFactor("points", ctx, "MID", null, "G").factor, 1);
}

// --- Kalshi parsing
assert.equal(eventDate("KXNBAPTS-26OCT21NYKCLE"), "2026-10-21");
assert.equal(eventDate("garbage"), null);
const km = (title, ticker, bid, ask, extra = {}) => ({ ticker, event_ticker: ticker.split("-").slice(0, 2).join("-"), title, status: "active",
  yes_bid_dollars: bid === null ? undefined : String(bid), yes_ask_dollars: ask === null ? undefined : String(ask), ...extra });
{
  const m = parseKalshiMarket(km("Mid G0: 25+ points", "KXNBAPTS-26OCT21MIDSLW-MIDG0-25", 0.30, 0.32), "points");
  assert.equal(m.strike, 25); assert.equal(m.player, "Mid G0"); assert.equal(m.date, "2026-10-21"); close(m.mid, 0.31); close(m.spread, 0.02);
  const cents = parseKalshiMarket({ ticker: "KXNBAREB-26OCT21MIDSLW-MIDG0-6", title: "Mid G0: 6+ rebounds", yes_bid: 40, yes_ask: 44 }, "rebounds");
  close(cents.mid, 0.42);
  assert.equal(parseKalshiMarket(km("Mid G0: 25+ points", "KXNBAPTS-26OCT21MIDSLW-MIDG0-25", 0, 0), "points"), null, "no price -> skipped");
  assert.equal(parseKalshiMarket(km("Mid G0: 25+ points", "KXNBAPTS-26OCT21MIDSLW-MIDG0-25", 0.3, 0.32, { status: "settled" }), "points"), null);
}
assert.equal(americanOdds(0.75), -300); assert.equal(americanOdds(0.25), 300);

// --- Board
{
  const now = Date.parse("2026-10-21T15:00:00Z");
  const mk = (who, strike, bid, ask, date = "26OCT21") => parseKalshiMarket(km(`${who}: ${strike}+ points`, `KXNBAPTS-${date}XXXYYY-P-${strike}`, bid, ask), "points");
  const markets = [
    mk("Mid G0", 30, 0.27, 0.29),   // Under 29.5 priced 72% -> in band (MID guard averages 20)
    mk("Mid G0", 15, 0.71, 0.73),   // Over 14.5 priced 72% -> in band
    mk("Mid G0", 20, 0.49, 0.51),   // 50/50 -> out of band
    mk("Fast G0", 31, 0.25, 0.30),  // FST plays today at 23:30 UTC
    mk("Slow G1", 10, 0.50, 0.90),  // spread 0.40 -> skipped
    mk("Nobody Here", 10, 0.7, 0.72),
    mk("Def G0", 12, 0.70, 0.74, "26OCT20"), // DEF has no game on Oct 20 in the schedule -> treated as started
  ].filter(Boolean);
  const b = buildNbaBoard({ markets, doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75] });
  const keys = b.rows.map((r) => `${r.player} ${r.side} ${r.line}`);
  assert.ok(keys.includes("Mid G0 Under 29.5"), keys.join("; "));
  assert.ok(keys.includes("Mid G0 Over 14.5"));
  assert.ok(!keys.some((k) => k.startsWith("Slow G1")), "wide spread skipped");
  assert.ok(!keys.some((k) => k.startsWith("Def G0")), "game not on schedule -> skipped");
  assert.equal(b.excluded.unknownPlayer, 1);
  assert.ok(b.excluded.wideSpread >= 1 && b.excluded.notOnSchedule >= 1, JSON.stringify(b.excluded));
  assert.deepEqual(b.notOnSchedule, ["DEF 2026-10-20"]);
  for (let i = 1; i < b.rows.length; i++) assert.ok(b.rows[i - 1].market >= b.rows[i].market, "sorted by market (buy) price");
  const u = b.rows.find((r) => r.player === "Mid G0" && r.side === "Under");
  close(u.market, 0.73, 1e-9); close(u.mid, 0.72); assert.equal(u.priceBasis, "buy");
  const bm = buildNbaBoard({ markets, doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75], sortBy: "model" });
  for (let i = 1; i < bm.rows.length; i++) assert.ok(bm.rows[i - 1].model >= bm.rows[i].model, "model view sorted by model"); assert.equal(u.game.opp, "SLW"); assert.equal(u.last10Record.endsWith("of 6"), true);
  // After tip-off nothing from that game is priced.
  const late = buildNbaBoard({ markets, doc, ctx, season: 2026, nowMs: Date.parse("2026-10-22T01:00:00Z"), band: [0.66, 0.75] });
  assert.ok(!late.rows.some((r) => r.player === "Mid G0" || r.player === "Fast G0"), "started games excluded");
  // A side where the model is far below the market is dropped.
  const silly = parseKalshiMarket(km("Mid G0: 5+ points", "KXNBAPTS-26OCT21XXXYYY-P-5", 0.26, 0.28), "points"); // market says 73% UNDER 4.5 for a 20-ppg guard
  const s2 = buildNbaBoard({ markets: [silly], doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75] });
  assert.equal(s2.rows.length, 0); assert.equal(s2.excluded.modelDisagrees, 1);
}

// --- Matrix decoration
{
  const grid = buildTrendGrid(players, { sport: "nba", stat: "points", season: 2026, games: 5, lines: { "mid g0": 19.5 } });
  decorateNbaGrid(grid, doc, { stat: "points", season: 2026, nowMs: Date.parse("2026-10-21T15:00:00Z"), ctx });
  const r = grid.rows.find((x) => x.player === "Mid G0");
  assert.equal(r.matchup.opp, "SLW"); assert.equal(r.matchup.home, false);
  assert.ok(r.model.pOver > 0.5 && r.model.pOver < 0.999);
  close(r.model.pOver + r.model.pUnder, 1);
  const noLine = grid.rows.find((x) => x.player === "Fast G0");
  assert.equal(noLine.model.pOver, null); assert.ok(noLine.model.mean > 25);
}

console.log("nba model tests passed");

// --- Injury report: skip Out/Doubtful, flag Questionable, list teammates out
{
  const { injuryIndex, injuryFor, teammatesOut } = await import("../src/nba_injuries.js");
  const injDoc = { source: "NBA official injury report", reportTime: "2026-10-21T16:30:00-04:00", players: [
    { name: "Mid G0", team: "MID", status: "Questionable", reason: "Left Ankle; Sprain" },
    { name: "Mid G1", team: "MID", status: "Out", reason: "Rest" },
    { name: "Fast G0", team: "FST", status: "Out", reason: "Right Knee" },
    { name: "Slow G0", team: "SLW", status: "Doubtful", reason: "Illness" },
    { name: "Def G0", team: "DEF", status: "Available", reason: "" },
  ], notSubmitted: [{ team: "SLW" }] };
  const idx = injuryIndex(injDoc, Date.parse("2026-10-21T21:00:00Z"));
  assert.equal(idx.meta.ageHours, 0.5); assert.equal(idx.meta.stale, false);
  assert.equal(injuryFor(idx, "mid g0", "MID").status, "Questionable");
  assert.equal(injuryFor(idx, "m guard", "XXX"), null);
  assert.deepEqual(teammatesOut(idx, "MID", "mid g0").map((t) => t.name), ["Mid G1"]);
  const now = Date.parse("2026-10-21T15:00:00Z");
  const mk2 = (who, strike, bid, ask) => parseKalshiMarket(km(`${who}: ${strike}+ points`, `KXNBAPTS-26OCT21XXXYYY-P-${strike}`, bid, ask), "points");
  const b = buildNbaBoard({ markets: [mk2("Mid G0", 30, 0.27, 0.29), mk2("Fast G0", 20, 0.27, 0.29), mk2("Mid G1", 30, 0.27, 0.29)],
    doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75], injuries: idx });
  assert.equal(b.excluded.injured, 2, "Out players skipped");
  assert.deepEqual(b.injuredSkipped.map((x) => x.name).sort(), ["Fast G0", "Mid G1"]);
  const row = b.rows.find((r) => r.player === "Mid G0");
  assert.equal(row.injury.status, "Questionable");
  assert.deepEqual(row.teammatesOut.map((t) => t.name), ["Mid G1"]);
  assert.equal(row.teammatesOut[0].minutes, 33, "teammate minutes from the logs");
  assert.equal(b.injuries.source, "NBA official injury report");
  // No report loaded: nothing skipped for injuries, rows carry no injury info.
  const b2 = buildNbaBoard({ markets: [mk2("Fast G0", 20, 0.27, 0.29)], doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75] });
  assert.equal(b2.excluded.injured, 0); assert.equal(b2.injuries, null);
  // Matrix badge
  const grid = buildTrendGrid(players, { sport: "nba", stat: "points", season: 2026, games: 5 });
  decorateNbaGrid(grid, doc, { stat: "points", season: 2026, nowMs: now, ctx, injuries: idx });
  assert.equal(grid.rows.find((x) => x.player === "Fast G0").injury.status, "Out");
  assert.deepEqual(grid.rows.find((x) => x.player === "Mid G0").teammatesOut, ["Mid G1"]);
  console.log("nba injury tests passed");
}

// --- Review round: one rung per player/stat/side, buy-price band, DNP mixture, flags
{
  const { injuryIndex } = await import("../src/nba_injuries.js");
  const now = Date.parse("2026-10-21T15:00:00Z");
  const mk3 = (who, strike, bid, ask) => parseKalshiMarket(km(`${who}: ${strike}+ points`, `KXNBAPTS-26OCT21XXXYYY-P-${strike}`, bid, ask), "points");
  // Under 29.5 (buy 0.73) and Under 27.5 (buy 0.70): same bet, keep the market's favorite.
  const b = buildNbaBoard({ markets: [mk3("Mid G0", 30, 0.27, 0.29), mk3("Mid G0", 28, 0.30, 0.32)], doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75] });
  const unders = b.rows.filter((r) => r.player === "Mid G0" && r.side === "Under");
  assert.equal(unders.length, 1); assert.equal(unders[0].line, 29.5); assert.equal(unders[0].otherRungs, 1);
  assert.equal(b.excluded.duplicateRung, 1);
  const all = buildNbaBoard({ markets: [mk3("Mid G0", 30, 0.27, 0.29), mk3("Mid G0", 28, 0.30, 0.32)], doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75], onePerPlayer: false });
  assert.equal(all.rows.filter((r) => r.side === "Under").length, 2);
  // Band uses the buy price: Over mid 0.745 is inside 66-75 but the ask (0.76) is not.
  const em = mk3("Mid G0", 15, 0.73, 0.76); close(em.mid, 0.745);
  const edge = buildNbaBoard({ markets: [em], doc, ctx, season: 2026, nowMs: now, band: [0.66, 0.75] });
  assert.ok(!edge.rows.some((r) => r.side === "Over"), "Over buy 0.76 is outside the band");
  assert.equal(edge.excluded.outOfBand, 2);
  // Questionable: P(Over) scaled by P(plays) when a DNP settles No; unchanged when void.
  const q = injuryIndex({ players: [{ name: "Mid G0", team: "MID", status: "Questionable", reason: "Ankle" }] }, now);
  const m = [mk3("Mid G0", 15, 0.71, 0.73)];
  const rNo = buildNbaBoard({ markets: m, doc, ctx, season: 2026, nowMs: now, band: [0.5, 0.97], injuries: q }).rows.find((r) => r.side === "Over");
  const rVoid = buildNbaBoard({ markets: m, doc, ctx, season: 2026, nowMs: now, band: [0.5, 0.97], injuries: q, dnpRule: "void" }).rows.find((r) => r.side === "Over");
  close(rNo.model, 0.75 * rNo.modelIfPlays); close(rVoid.model, rVoid.modelIfPlays); assert.equal(rNo.pPlays, 0.75);
  // Back-to-back: MID played Oct 20? No. Add a team game on Oct 20 and check the flag.
  const doc2 = { ...doc, teamGames: [...doc.teamGames, { g: "x", d: "2026-10-20", s: 2026, t: "MID", o: "FST", pts: 100, opp: 100, poss: 100, min: 240 }] };
  const r2 = buildNbaBoard({ markets: m, doc: doc2, ctx, season: 2026, nowMs: now, band: [0.5, 0.97] }).rows[0];
  assert.equal(r2.flags.backToBack, true);
  assert.equal(r2.flags.returning, null, "last game Oct 15, six days earlier");
  // Injury matching: exact name on another team only when that name is unique in the report.
  const dup = injuryIndex({ players: [{ name: "Mid G0", team: "AAA", status: "Out" }, { name: "Mid G0", team: "BBB", status: "Out" }] }, now);
  assert.equal(injuryFor(dup, "mid g0", "MID"), null);
  const uniq = injuryIndex({ players: [{ name: "Mid G0", team: "AAA", status: "Out" }] }, now);
  assert.equal(injuryFor(uniq, "mid g0", "MID").status, "Out");
  // Unclamped probabilities for backtests.
  assert.ok(probAtLeast(60, 10, 1.5, { clamp: false }) < 0.001 && probAtLeast(60, 10, 1.5) === 0.001);
  // Variance split: a player whose minutes swing has a wider spread than a steady one with the same rate.
  const steady = nbaProjection(Array.from({ length: 12 }, () => ({ value: 20, minutes: 32 })), 1, "points");
  const swing = nbaProjection(Array.from({ length: 12 }, (_, i) => ({ value: i % 2 ? 26 : 14, minutes: i % 2 ? 41.6 : 22.4 })), 1, "points");
  assert.ok(swing.dispersion > steady.dispersion && swing.minutesSd > steady.minutesSd);
  // Matchup: DvP for points is measured beyond the opponent's overall DRtg.
  const mf = matchupFactor("points", ctx, "MID", "SLW", "G");
  const dr = ctx.teams.SLW.drtg / ctx.league.drtg, dv = ctx.dvp.SLW.G.points.avg / ctx.dvpLeague.G.points;
  close(mf.parts.position, 1 + 0.25 * (dv / dr - 1));
  console.log("nba review-round tests passed");
}
