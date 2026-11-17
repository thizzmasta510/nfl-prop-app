// node test/nfl_defense.test.mjs
import assert from "node:assert/strict";
import { nflDefenseTable, nflDefenseIndex, nflDefenseOpts, nflDefGroup, NFL_DEF_CFG, NFL_DEF_STATS, NFL_DEF_APPLIES } from "../src/nfl_defense.js";
import { nflOpportunityProjection } from "../src/nfl_opportunity.js";
import { buildNflBoard, parseKalshiMarket } from "../src/nfl_board.js";
import { normalizeName } from "../src/model.js";
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// --- pinned (measured walk-forward on 2023-2026; changing them must change this test)
assert.deepEqual(NFL_DEF_CFG, { shrinkGames: 8, prevWeight: 0.3, strength: 0.5, min: 0.8, max: 1.25, minPriorGames: 2 });
assert.deepEqual(NFL_DEF_STATS, ["receptions", "receiving_yards", "rushing_yards", "carries", "passing_yards"]);
assert.deepEqual(NFL_DEF_APPLIES, { receptions: "volume", carries: "volume", receiving_yards: "rate", rushing_yards: "rate", passing_yards: "rate" });
assert.equal(nflDefGroup("QB", "QB"), "QB"); assert.equal(nflDefGroup("RB", "WR"), "RB"); assert.equal(nflDefGroup("REC", "TE"), "TE"); assert.equal(nflDefGroup("REC", "wr"), "WR"); assert.equal(nflDefGroup("REC", null), "REC");

// --- the table by hand
{
  const row = (season, week, opp, actual, mean) => ({ season, week, opp, group: "RB", stat: "rushing_yards", actual, mean });
  // 2026: defense AAA allowed 120 against 100 projected in each of weeks 1-4; the rest of the league was exactly on projection
  const rows = [1, 2, 3, 4].flatMap((w) => [row(2026, w, "AAA", 120, 100), row(2026, w, "BBB", 100, 100), row(2026, w, "CCC", 80, 100)]);
  const t = nflDefenseTable(rows);
  // league ratio 300/300 = 1; AAA ratio 1.2 on 4 games -> 1 + 0.2 x 4/12, then the square root
  close(t.factor(2026, 5, "AAA", "RB", "rushing_yards"), Math.sqrt(1 + 0.2 * 4 / 12));
  close(t.factor(2026, 5, "CCC", "RB", "rushing_yards"), Math.sqrt(1 - 0.2 * 4 / 12));
  close(t.factor(2026, 5, "BBB", "RB", "rushing_yards"), 1);
  // only earlier weeks count: as of week 3 there are 2 games
  close(t.factor(2026, 3, "AAA", "RB", "rushing_yards"), Math.sqrt(1 + 0.2 * 2 / 10));
  close(t.factor(2026, 1, "AAA", "RB", "rushing_yards"), 1);                 // nothing yet
  assert.equal(t.factor(2026, 5, "ZZZ", "RB", "rushing_yards"), 1);          // unknown defense
  assert.equal(t.factor(2026, 5, "AAA", "WR", "rushing_yards"), 1);          // other group
  // last season counts at 0.3: in week 1 of 2027 AAA has 0.3 x 4 = 1.2 games of the same ratio
  close(t.factor(2027, 1, "AAA", "RB", "rushing_yards"), Math.sqrt(1 + 0.2 * 1.2 / 9.2));
  // capped
  const wild = nflDefenseTable(Array.from({ length: 17 }, (_, i) => [row(2026, i + 1, "AAA", 400, 100), row(2026, i + 1, "DDD", 5, 100), ...Array.from({ length: 9 }, (_, j) => row(2026, i + 1, "B" + j, 100, 100))]).flat());
  assert.equal(wild.factor(2026, 18, "AAA", "RB", "rushing_yards"), 1.25); assert.equal(wild.factor(2026, 18, "DDD", "RB", "rushing_yards"), 0.8);
}

// --- where the factor goes: volume for catches and carries, rate for yards; game script is kept
{
  assert.deepEqual(nflDefenseOpts("rushing_yards", 1.1, 0.05), { volumeAdj: 0.05, rateAdj: 1.1 });
  const o = nflDefenseOpts("carries", 1.1, 0.05); close(o.volumeAdj, 1.05 * 1.1 - 1); assert.equal(o.rateAdj, undefined);
  assert.deepEqual(nflDefenseOpts("receiving_yards", 0, 0), { volumeAdj: 0, rateAdj: 1 });
  const g = Array.from({ length: 5 }, () => ({ carries: 15, rushing_yards: 60, targets: 2, receptions: 1, receiving_yards: 8, attempts: 0, passing_yards: 0 }));
  const base = nflOpportunityProjection(g, "rushing_yards"), up = nflOpportunityProjection(g, "rushing_yards", null, nflDefenseOpts("rushing_yards", 1.1));
  close(up.mean, base.mean * 1.1, 1e-9); close(up.volume, base.volume);
  const c0 = nflOpportunityProjection(g, "carries"), c1 = nflOpportunityProjection(g, "carries", null, nflDefenseOpts("carries", 0.9));
  close(c1.mean, c0.mean * 0.9, 1e-9);
  // the cheap mean matches the full projection
  close(nflOpportunityProjection(g, "rushing_yards", null, { meanOnly: true }).mean, base.mean); close(nflOpportunityProjection(g, "receptions", null, { meanOnly: true }).mean, nflOpportunityProjection(g, "receptions").mean);
}

// --- from the weekly logs, and on the Board
{
  const st = (carries, yards) => ({ carries, rushing_yards: yards, targets: 2, receptions: 1, receiving_yards: 8, attempts: 0, passing_yards: 0 });
  const players = [];
  // six backs on six teams; weeks 1-2 at 60 yards on 15 carries (history), then weeks 3-6: whoever faces SOFT gets 90, whoever faces HARD gets 30, others 60
  const teams = ["T1", "T2", "T3", "T4", "T5", "T6"];
  for (let i = 0; i < teams.length; i++) for (let w = 1; w <= 6; w++) {
    const opp = w <= 2 ? "MID" : (i + w) % 3 === 0 ? "SOFT" : (i + w) % 3 === 1 ? "HARD" : "MID";
    players.push({ name: "Back " + i, team: teams[i], opponent: opp, position: "RB", season: 2026, week: w, stats: st(15, opp === "SOFT" ? 90 : opp === "HARD" ? 30 : 60) });
  }
  const trend = { season: 2026, players, priorSeason: {}, lines: [], schedule: [{ week: 7, date: "2026-10-25", kickoff: "2026-10-25T17:00:00Z", away: "T1", home: "SOFT" }, { week: 7, date: "2026-10-25", kickoff: "2026-10-25T17:00:00Z", away: "T2", home: "HARD" }] };
  const idx = nflDefenseIndex(trend, normalizeName);
  assert.equal(idx, nflDefenseIndex(trend, normalizeName));                    // built once per logs object
  const soft = idx.factor("SOFT", "back 0", "RB", "rushing_yards"), hard = idx.factor("HARD", "back 0", "RB", "rushing_yards");
  assert.ok(soft > 1.03 && soft <= 1.25, String(soft)); assert.ok(hard < 0.97 && hard >= 0.8, String(hard));
  assert.equal(idx.factor("SOFT", "back 0", "RB", "passing_tds"), 1); assert.equal(idx.factor(null, "back 0", "RB", "rushing_yards"), 1);
  assert.ok(idx.factor("SOFT", "back 0", "RB", "rushing_yards", 4) < soft);    // as of week 4: one game of evidence, closer to 1
  const km = (who, ev) => parseKalshiMarket({ ticker: `${ev}-X-60`, event_ticker: ev, title: `${who}: 60+ yards`, status: "active", yes_bid_dollars: "0.49", yes_ask_dollars: "0.51" }, "rushing_yards");
  const markets = [km("Back 0", "KXNFLRSHYDS-26OCT25T1SOFT"), km("Back 1", "KXNFLRSHYDS-26OCT25T2HARD")];
  const run = (o = {}) => buildNflBoard({ markets, trend, weekly: {}, nowMs: Date.parse("2026-10-23T22:00:00Z"), band: [0.05, 0.97], disagree: 1, errorGap: 1, onePerPlayer: false, rankBy: "proj", ...o });
  const on = run().rows.filter((r) => r.side === "Over"), off = run({ defense: false }).rows.filter((r) => r.side === "Over");
  const b0 = on.find((r) => r.player === "Back 0"), b1 = on.find((r) => r.player === "Back 1");
  close(b0.opportunity.defense, soft); close(b1.opportunity.defense, idx.factor("HARD", "back 1", "RB", "rushing_yards"));
  assert.ok(b0.modelProj > off.find((r) => r.player === "Back 0").modelProj);  // soft defense: more likely to clear 60
  assert.ok(b1.modelProj < off.find((r) => r.player === "Back 1").modelProj);
  assert.equal(off.find((r) => r.player === "Back 0").opportunity.defense, 1);
}
console.log("nfl defense tests passed");
