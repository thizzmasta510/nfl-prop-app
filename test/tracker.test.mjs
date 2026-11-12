// node test/tracker.test.mjs
import assert from "node:assert/strict";
import { priceToOdds, oddsProfit, trackerDupeKey, gradeResult, matchNbaStat, autogradeEntries, picksSummary, closeFromCandles, needsClose, clvOf, clvParts, closeIsStale, feeFraction } from "../src/tracker.js";
import { suggestedLimit } from "../src/nba_board.js";

assert.equal(priceToOdds(0.75), -300);
assert.equal(priceToOdds(0.4), 150);
assert.equal(priceToOdds(1), null);
assert.ok(Math.abs(oddsProfit(-300) - 1 / 3) < 1e-9);
assert.equal(oddsProfit(150), 1.5);

// Duplicates: same game/player/market/side/line; a different line or side is a new pick.
const a = { sport: "nfl", week: 8, gameDate: "2026-11-01", player: "James Cook III", propType: "Rushing Yards", lean: "OVER", openingLine: 59.5 };
assert.equal(trackerDupeKey(a), trackerDupeKey({ ...a, player: " james cook iii " }));
assert.notEqual(trackerDupeKey(a), trackerDupeKey({ ...a, lean: "UNDER" }));
assert.notEqual(trackerDupeKey(a), trackerDupeKey({ ...a, openingLine: 69.5 }));

assert.equal(gradeResult({ ...a, actual: 80 }), "HIT");
assert.equal(gradeResult({ ...a, actual: 40 }), "MISS");
assert.equal(gradeResult({ ...a, lean: "UNDER", actual: 40 }), "HIT");
assert.equal(gradeResult({ ...a, openingLine: 60, actual: 60 }), "PUSH");
assert.equal(gradeResult({ ...a, actual: "DNP" }), "VOID");
assert.equal(gradeResult({ ...a }), "");

// NBA grading by game date.
const nbaRows = [
  { name: "Jalen Brunson", norm: "jalen brunson", short: "j brunson", team: "NYK", date: "2026-11-02", stats: { points: 31, threes: 4 } },
  { name: "Josh Hart", norm: "josh hart", short: "j hart", team: "NYK", date: "2026-11-02", stats: { points: 8 } },
];
const nb = { sport: "nba", gameDate: "2026-11-02", player: "Jalen Brunson", team: "NYK", stat: "points", lean: "OVER", openingLine: 25.5 };
assert.deepEqual(matchNbaStat(nb, nbaRows).value, 31);
assert.equal(matchNbaStat({ ...nb, stat: undefined, propType: "3-pointers" }, nbaRows).value, 4);
assert.equal(matchNbaStat({ ...nb, player: "Mitchell Robinson" }, nbaRows).status, "dnp", "team played, he didn't");
assert.equal(matchNbaStat({ ...nb, gameDate: "2026-11-03" }, nbaRows).status, "pending");

// Autograde both sports; hand-entered values are never overwritten.
const nflRows = [{ name: "James Cook III", norm: "james cook iii", short: "j cook", team: "BUF", week: 8, stats: { rushing_yards: 88 } }];
const entries = [
  { id: "1", ...a, team: "BUF" },
  { id: "2", ...nb },
  { id: "3", ...nb, player: "Mitchell Robinson" },
  { id: "4", ...a, player: "Derrick Henry", team: "BAL", actual: 61 },
  { id: "5", ...a, week: 9 },
];
const dry = autogradeEntries(structuredClone(entries), { nflRows, nbaRows, apply: false });
assert.equal(dry.applied.length, 3);
const r = autogradeEntries(entries, { nflRows, nbaRows });
assert.equal(entries[0].actual, 88); assert.equal(entries[1].actual, 31); assert.equal(entries[2].actual, "DNP");
assert.equal(entries[3].actual, 61, "manual value kept");
assert.equal(r.pending.length, 1, "week 9 not played yet");
// Week partly published (another team's game is in): his pick waits instead of needing review.
const partial = autogradeEntries([{ id: "p", ...a, team: "BUF", week: 9 }], { nflRows: [{ ...nflRows[0], name: "Josh Jacobs", norm: "josh jacobs", team: "GB", week: 9 }], nbaRows });
assert.equal(partial.pending.length, 1); assert.equal(partial.needsReview.length, 0);
// NFL stats missing: NFL picks wait, NBA still grades.
const only = autogradeEntries([{ id: "x", ...a }, { id: "y", ...nb }], { nflRows: [], nbaRows });
assert.equal(only.applied.length, 1); assert.equal(only.pending.length, 1);

// Summary: record, implied rate from the price paid, units at 1 per pick.
const s = picksSummary([
  { ...a, odds: -300, actual: 80 },            // win +0.333
  { ...a, odds: -300, actual: 40 },            // loss -1
  { ...nb, sport: "nba", odds: -200, actual: 31 }, // win +0.5
  { ...nb, sport: "nba", actual: "DNP" },      // void
  { ...a, week: 9 },                           // pending
]);
assert.equal(s.summary.all.record, "2-1");
assert.equal(s.summary.all.voids, 1); assert.equal(s.summary.all.pending, 1);
assert.ok(Math.abs(s.summary.all.units - (1 / 3 - 1 + 0.5)) < 0.01);
assert.ok(Math.abs(s.summary.all.impliedRate - (0.75 + 0.75 + 2 / 3) / 3) < 1e-9);
assert.equal(s.summary.nfl.record, "1-1"); assert.equal(s.summary.nba.record, "1-0");
assert.equal(s.entries.length, 5);

// CLV: real candles from Kalshi (Jared McCain 20+ points, Oct 31; tip 00:30 UTC Nov 1).
const tip = Date.parse("2026-11-01T00:30:00Z");
const candles = [1793476800, 1793480400, 1793484000, 1793487600, 1793491200].map((t) => ({ end_period_ts: t,
  yes_bid: { close_dollars: "0.2500" }, yes_ask: { close_dollars: "0.2600" }, price: { close_dollars: "0.2600" } }));
candles.push({ end_period_ts: 1793494800, yes_bid: { close_dollars: "0.0500" }, yes_ask: { close_dollars: "0.0700" } }); // after tip: ignored
assert.deepEqual(closeFromCandles(candles, "UNDER", tip), { price: 0.745, at: "2026-11-01T00:00:00.000Z", spread: 0.01 });
assert.equal(closeFromCandles(candles, "OVER", tip).price, 0.255);
assert.equal(closeFromCandles([{ end_period_ts: 1793491200, yes_bid: { close: 40 }, yes_ask: { close: null }, price: {} }], "OVER", tip).price, 0.4, "old cents format, ask missing -> bid");
assert.equal(closeFromCandles([], "OVER", tip), null);
const mc = { ticker: "KXNBAPTS-26OCT31OKCHOU-OKCJMCCAIN3-20", kickoff: "2026-11-01T00:30:00Z", lean: "UNDER", marketProb: 0.74 };
assert.equal(needsClose(mc, tip + 1), true); assert.equal(needsClose(mc, tip - 60000), false, "not before tip");
assert.equal(needsClose({ ...mc, closePrice: 0.75 }, tip + 1), false); assert.equal(needsClose({ ...mc, closeTries: 3 }, tip + 1), false);
assert.equal(needsClose({ ...mc, ticker: "" }, tip + 1), false, "hand-entered picks have no market");
assert.equal(clvOf({ ...mc, closePrice: 0.745 }), 0.005);
const cs = picksSummary([{ ...mc, closePrice: 0.75 }, { ...mc, closePrice: 0.70 }, { ...mc, closePrice: 0.74 }, { ...mc, closePrice: 0.8, actual: "DNP" }, { ...mc }]).summary.all.clv;
assert.equal(cs.n, 3); assert.equal(cs.beat, 1); assert.equal(cs.same, 1); assert.ok(Math.abs(cs.avg - (-0.01)) < 1e-9);

// Execution: suggested limit = mid + 1c in whole cents, never above the buy price.
assert.equal(suggestedLimit(0.705, 0.75), 0.71);   // Avdija Oct 31: bid 66 / ask 75
assert.equal(suggestedLimit(0.735, 0.74), 0.74);   // 1c spread: the ask itself
assert.equal(suggestedLimit(0.70, null), 0.71);
assert.equal(suggestedLimit(null, 0.7), null);
// CLV split: Avdija paid 75 at the ask, mid 70.5 when tracked, closed at 66.
const av = { lean: "OVER", marketProb: 0.75, pickMid: 0.705, closePrice: 0.66, kickoff: "2026-10-31T19:00:00Z", closeAt: "2026-10-31T19:00:00.000Z" };
assert.deepEqual(clvParts(av), { execution: -0.045, movement: -0.045 });
assert.ok(Math.abs(clvOf(av) - (clvParts(av).execution + clvParts(av).movement)) < 1e-9, "parts add up to CLV");
assert.equal(clvParts({ ...av, pickMid: "" }), null, "older picks have no mid");
assert.equal(closeIsStale(av), false);
assert.equal(closeIsStale({ ...av, closeAt: "2026-10-31T18:00:00.000Z" }), true, "hourly fallback an hour early");
// Fees: taker 7% x (1 - P) of the stake; maker (resting limit order) 0.
assert.ok(Math.abs(feeFraction({ marketProb: 0.75 }) - 0.0175) < 1e-12);
assert.equal(feeFraction({ marketProb: 0.75, orderType: "maker" }), 0);
assert.ok(Math.abs(feeFraction({ odds: -300 }) - 0.0175) < 1e-9, "from odds when no price");
const fs2 = picksSummary([
  { ...av, odds: -300, actual: 25, openingLine: 19.5, sport: "nba" },                                   // hit, taker
  { ...av, odds: -300, actual: 10, openingLine: 19.5, sport: "nba", orderType: "maker" },               // miss, maker
  { ...av, odds: -300, actual: 25, openingLine: 19.5, sport: "nba", closeAt: "2026-10-31T17:00:00.000Z" }, // stale close
]).summary.all;
assert.ok(Math.abs(fs2.fees - 0.04) < 0.006, String(fs2.fees));        // 2 taker picks x 0.0175, rounded
assert.ok(Math.abs(fs2.unitsAfterFees - (fs2.units - 0.035)) < 0.011);
assert.equal(fs2.clv.n, 2); assert.equal(fs2.clv.stale, 1);
assert.ok(Math.abs(fs2.clv.execution - (-0.045)) < 1e-9 && Math.abs(fs2.clv.movement - (-0.045)) < 1e-9);
// --- Proj vs Model on graded picks
{
  const { compareEstimates } = await import("../src/tracker.js");
  const e = (result, modelProb, projProb, rankedBy, odds = -200) => ({ result, modelProb, projProb, rankedBy, odds });
  const c = compareEstimates([e("HIT", 0.8, 0.7, "proj"), e("MISS", 0.8, 0.6, "proj"), e("HIT", 0.75, 0.72, "model"), e("PUSH", 0.7, 0.7, "proj"),
    e("HIT", "", "", "model"), e(null, 0.7, 0.7, "proj")]);
  assert.equal(c.n, 3); assert.ok(Math.abs(c.hitRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(c.brierModel - ((0.2 ** 2 + 0.8 ** 2 + 0.25 ** 2) / 3)) < 1e-9);
  assert.ok(Math.abs(c.brierProj - ((0.3 ** 2 + 0.6 ** 2 + 0.28 ** 2) / 3)) < 1e-9);
  assert.equal(c.rankedByProj.record, "1-1"); assert.equal(c.rankedByModel.record, "2-0");
  assert.equal(c.rankedByProj.units, -0.5); assert.equal(c.rankedByModel.units, 1);
}
console.log("tracker tests passed");
