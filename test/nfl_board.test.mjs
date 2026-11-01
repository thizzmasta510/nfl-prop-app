// node test/nfl_board.test.mjs
import assert from "node:assert/strict";
import { buildNflBoard, teamInEvent, parseKalshiMarket } from "../src/nfl_board.js";

assert.equal(teamInEvent("KXNFLRECYDS-26OCT25TBCAR", "TB"), true);
assert.equal(teamInEvent("KXNFLRECYDS-26OCT25TBCAR", "CAR"), true);
assert.equal(teamInEvent("KXNFLRECYDS-26OCT25LARLV", "LA"), true, "nflverse LA = Kalshi LAR");
assert.equal(teamInEvent("KXNFLRECYDS-26OCT25TBCAR", "ATL"), false);

const g = (name, team, pos, season, week, stats) => ({ name, team, position: pos, season, week, stats });
const players = [];
for (let w = 1; w <= 6; w++) {
  players.push(g("Steady Back", "TB", "RB", 2026, w, { rushing_yards: 80 + (w % 3) * 5, receptions: 2 }));
  players.push(g("Rookie Wr", "CAR", "WR", 2026, w, { receiving_yards: 30, receptions: 3 }));
  players.push(g("Stale Prior", "TB", "RB", 2026, w, { rushing_yards: 90 }));
}
players.push(g("Old Guy", "TB", "WR", 2025, 17, { receiving_yards: 50 }));
players.push(g("Traded Te", "NYJ", "TE", 2026, 6, { receptions: 4 }));
const trend = { season: 2026, players,
  priorSeason: { "stale prior": { games: 15, rushing_yards: 8 }, "steady back": { games: 16, rushing_yards: 85 } },
  schedule: [{ week: 7, date: "2026-10-25", kickoff: "2026-10-25T17:00:00Z", away: "TB", home: "CAR", spreadHome: -6.5, total: 44.5 }],
  lines: [1, 2, 3, 4, 5, 6].flatMap((w) => [{ week: w, team: "TB", spread: 0, total: 44 }, { week: w, team: "CAR", spread: 0, total: 44 }]) };
const weekly = { defense: [{ team: "CAR", defRank: 18, seasonDefEpaPerPlay: 0.01 }, { team: "TB", defRank: 6, seasonDefEpaPerPlay: -0.05 }] };
const km = (who, stat, strike, bid, ask, ev = "KXNFLRSHYDS-26OCT25TBCAR") =>
  parseKalshiMarket({ ticker: `${ev}-X-${strike}`, event_ticker: ev, title: `${who}: ${strike}+ yards`, status: "active",
    yes_bid_dollars: String(bid), yes_ask_dollars: String(ask) }, stat);
const now = Date.parse("2026-10-23T22:00:00Z");
const markets = [
  km("Steady Back", "rushing_yards", 60, 0.69, 0.72),         // Over 59.5 buy 72
  km("Steady Back", "rushing_yards", 50, 0.74, 0.75),         // Over 49.5 buy 75 (same side, another rung)
  km("Rookie Wr", "receiving_yards", 40, 0.27, 0.30, "KXNFLRECYDS-26OCT25TBCAR"),  // Under 39.5 buy 73
  km("Stale Prior", "rushing_yards", 80, 0.34, 0.36),         // Under 79.5 buy 66: prior 8 drags the model far above the market
  km("Nobody", "rushing_yards", 30, 0.7, 0.72),
  km("Traded Te", "receptions", 3, 0.7, 0.72, "KXNFLREC-26OCT25TBCAR"),
  km("Steady Back", "rushing_yards", 70, 0.20, 0.60),         // wide spread
];
const b = buildNflBoard({ markets, trend, weekly, nowMs: now, band: [0.66, 0.75] });
const keys = b.rows.map((r) => `${r.player} ${r.side} ${r.line}`);
assert.ok(keys.includes("Rookie Wr Under 39.5"), keys.join("; "));
assert.equal(b.rows.filter((r) => r.player === "Steady Back" && r.side === "Over").length, 1, "one rung per player/stat/side");
assert.equal(b.excluded.unknownPlayer, 1);
assert.equal(b.excluded.wrongGame, 1, "player whose team isn't in the event");
assert.equal(b.excluded.wideSpread, 1);
assert.ok(b.dataErrors.some((e) => e.player === "Stale Prior") || !keys.some((k) => k.startsWith("Stale Prior")), "stale-prior side set aside or vetoed");
const sb = b.rows.find((r) => r.player === "Steady Back");
assert.equal(sb.oppDefRank, 18); assert.equal(sb.game.opp, "CAR"); assert.equal(sb.prior, 85);
for (let i = 1; i < b.rows.length; i++) assert.ok(b.rows[i - 1].model >= b.rows[i].model, "sorted by model");
// Game script: TB is a 6.5-point favorite after even games, so its RB gets a rushing bump.
assert.equal(sb.teamSpread, 6.5); assert.equal(sb.gameTotal, 44.5); assert.ok(sb.gameScriptAdj > 0);
assert.equal(b.linesIncluded, true);
const noLines = buildNflBoard({ markets, trend: { ...trend, schedule: trend.schedule.map(({ spreadHome, total, ...g }) => g) }, weekly, nowMs: now, band: [0.66, 0.75] });
const sb0 = noLines.rows.find((r) => r.player === "Steady Back");
assert.equal(sb0.gameScriptAdj, 0); assert.ok(sb0.projection < sb.projection);
// After kickoff nothing is priced.
const late = buildNflBoard({ markets, trend, weekly, nowMs: Date.parse("2026-10-25T17:30:00Z"), band: [0.66, 0.75] });
assert.equal(late.rows.length, 0); assert.ok(late.excluded.started > 0);
// Market sort option
const bm = buildNflBoard({ markets, trend, weekly, nowMs: now, band: [0.66, 0.75], sortBy: "market" });
for (let i = 1; i < bm.rows.length; i++) assert.ok(bm.rows[i - 1].market >= bm.rows[i].market);
// Plus-money bands: every kept side has the model 5+ points above the price; edge sort is model / price.
const lp = buildNflBoard({ markets, trend, weekly, nowMs: now, band: [0.17, 0.45], minGap: 0.05, sortBy: "edge", onePerPlayer: false });
for (const r of lp.rows) { assert.ok(r.market >= 0.17 && r.market <= 0.45); assert.ok(r.model >= r.market + 0.05 - 1e-9); }
for (let i = 1; i < lp.rows.length; i++) assert.ok(lp.rows[i - 1].model / lp.rows[i - 1].market >= lp.rows[i].model / lp.rows[i].market - 1e-9);
const lp0 = buildNflBoard({ markets, trend, weekly, nowMs: now, band: [0.17, 0.45], onePerPlayer: false });
assert.ok(lp0.rows.length >= lp.rows.length && lp.excluded.belowMinGap === lp0.rows.length - lp.rows.length - lp.excluded.likelyDataError + lp0.excluded.likelyDataError);
console.log("nfl board tests passed");
