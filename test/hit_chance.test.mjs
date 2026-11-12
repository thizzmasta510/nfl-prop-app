// node test/hit_chance.test.mjs
import assert from "node:assert/strict";
import { hitFeatures, nbaHitChance, historyIndex, HIT_COEF, HIT_WINDOWS, HIT_STATS,
  nflHitFeatures, nflHitChance, nflRecentIndex, NFL_HIT_COEF, NFL_HIT_GAMES, NFL_HIT_VOLUME } from "../src/hit_chance.js";
import { buildNflBoard, parseKalshiMarket as parseNfl } from "../src/nfl_board.js";
import { buildNbaBoard, parseKalshiMarket, evPerDollar, blendWithPrice, EV_RULES, KALSHI_TAKER_FEE, boardSort } from "../src/nba_board.js";
import { nbaProjection, probAtLeast, SPREAD_ADJ } from "../src/nba_model.js";
import { normalizeName } from "../src/model.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const logit = (p) => Math.log(p / (1 - p));

// --- features by hand: 20 games on file -> the 20-game table
{
  // newest first: last game 36 minutes, the rest 30; values 12 then alternating 8 / 16
  const games = Array.from({ length: 20 }, (_, i) => ({ value: i === 0 ? 12 : i % 2 ? 8 : 16, minutes: i === 0 ? 36 : 30 }));
  const f = hitFeatures({ pOver: 0.6, strike: 10, games, modelMean: 12, projMinutes: 31, factor: 1.05 });
  assert.equal(f.window, 20); assert.equal(f.games, 20);
  close(f.share, 10 / 20);                                   // 12 and the nine 16s
  const sv = 12 + 10 * 8 + 9 * 16, sm = 36 + 19 * 30;
  close(f.longr, Math.log((sv / sm) * 31 * 1.05 / 12));
  close(f.lastMin, 36 / ((36 + 9 * 30) / 10));
  assert.deepEqual(f.x.slice(0, 2), [1, logit(0.6)]);
  const h = nbaHitChance("rebounds", { pOver: 0.6, strike: 10, games, modelMean: 12, projMinutes: 31, factor: 1.05 });
  const c = HIT_COEF[20].rebounds;
  close(h.pOver, 1 / (1 + Math.exp(-(c[0] + c[1] * logit(0.6) + c[2] * f.share + c[3] * f.longr + c[4] * f.lastMin))));
  // 30+ games -> the 40-game table, at most 40 games used
  const long = games.concat(Array.from({ length: 30 }, () => ({ value: 20, minutes: 30 })));
  const f40 = hitFeatures({ pOver: 0.6, strike: 10, games: long, modelMean: 12, projMinutes: 31 });
  assert.equal(f40.window, 40); assert.equal(f40.games, 40); close(f40.share, 30 / 40);
  assert.equal(hitFeatures({ pOver: 0.6, strike: 10, games: games.slice(0, 29), modelMean: 12, projMinutes: 31 }).window, 20);
  // a longer record of clearing the number raises the chance; games without minutes are ignored
  assert.ok(nbaHitChance("points", { pOver: 0.6, strike: 10, games: long, modelMean: 12, projMinutes: 31 }).pOver > nbaHitChance("points", { pOver: 0.6, strike: 10, games, modelMean: 12, projMinutes: 31 }).pOver);
  assert.equal(hitFeatures({ pOver: 0.6, strike: 10, games: games.slice(0, 4), modelMean: 12, projMinutes: 31 }), null);
  assert.equal(nbaHitChance("steals", { pOver: 0.6, strike: 1, games, modelMean: 1, projMinutes: 31 }), null);
  assert.equal(hitFeatures({ pOver: 0.6, strike: 10, games: games.map((g) => ({ ...g, minutes: 0 })), modelMean: 12, projMinutes: 31 }), null);
}

// --- pinned (fit by backtest/nba_hit_chance_backtest.mjs; changing them must change this test)
assert.deepEqual(HIT_WINDOWS, { short: 20, long: 40, longMin: 30 });
assert.deepEqual(HIT_STATS, ["points", "rebounds", "assists", "threes"]);
assert.deepEqual(HIT_COEF, {
  20: { points: [-0.817, 0.848, 0.88, -0.108, 0.428], rebounds: [-0.737, 0.843, 0.81, 1.556, 0.341], assists: [-0.468, 0.943, 0.375, 0.979, 0.316], threes: [-0.451, 0.944, 0.43, -0.03, 0.267] },
  40: { points: [-0.966, 0.809, 1.161, 0.221, 0.448], rebounds: [-0.953, 0.791, 1.2, 1.485, 0.366], assists: [-0.581, 0.924, 0.6, 1.178, 0.341], threes: [-0.732, 0.851, 0.957, 0.093, 0.29] },
});
assert.deepEqual(SPREAD_ADJ, { points: 1.2 });

// --- points spread is 20% wider than rebounds built from the same numbers
{
  const g = Array.from({ length: 20 }, (_, i) => ({ value: 10 + (i % 5), minutes: 28 + (i % 3) }));
  const pts = nbaProjection(g, 1, "points"), other = nbaProjection(g, 1, "pra");
  close(pts.mean, other.mean);
  // same mean, wider spread: a rung well below the mean is less certain
  assert.ok(pts.dispersion > 1.02);
  const reb = nbaProjection(g, 1, "rebounds");
  assert.ok(probAtLeast(8, pts.mean, pts.dispersion) < probAtLeast(8, reb.mean, reb.dispersion));
}

// --- history block and the Board
{
  const day = (i) => new Date(Date.UTC(2026, 10, 1) - i * 2 * 864e5).toISOString().slice(0, 10);
  const players = Array.from({ length: 20 }, (_, i) => ({ name: "Ann Guard", team: "AAA", opponent: "BBB", season: 2026, date: day(i + 1), seasonType: "Regular Season", position: "G",
    stats: { points: 18 + (i % 4), rebounds: 4, assists: 5, threes: 2, minutes: 32 } }));
  const history = { "Ann Guard": { dates: Array.from({ length: 20 }, (_, i) => day(i + 21)), minutes: Array(20).fill(32), points: Array(20).fill(30), rebounds: Array(20).fill(4), assists: Array(20).fill(5), threes: Array(20).fill(2) } };
  const idx = historyIndex({ history }, normalizeName);
  assert.equal(idx.get("ann guard").length, 20); assert.equal(idx.get("ann guard")[0].points, 30); assert.equal(historyIndex({}, normalizeName).size, 0);
  const upcoming = [{ g: "1", date: "2026-11-02", tip: "2026-11-03T00:00:00Z", home: "AAA", away: "BBB" }];
  const market = parseKalshiMarket({ ticker: "KXNBAPTS-26NOV02BBBAAA-AG-25", event_ticker: "KXNBAPTS-26NOV02BBBAAA", title: "Ann Guard: 25+ points", status: "active", yes_bid_dollars: "0.20", yes_ask_dollars: "0.22" }, "points");
  const run = (doc, rankBy, sortBy) => buildNbaBoard({ markets: [market], doc, ctx: null, season: 2026, nowMs: Date.parse("2026-11-02T15:00:00Z"), band: [0.5, 0.95], disagree: 1, rankBy, sortBy });
  const short = run({ players, upcoming }, "hit").rows.find((r) => r.side === "Under");
  const long = run({ players, upcoming, history }, "hit").rows.find((r) => r.side === "Under");
  assert.equal(short.rankedBy, "hit"); assert.equal(short.hit.games, 20); assert.equal(long.hit.games, 40);
  close(short.model, short.hitChance); close(short.hit.share, 1);          // never reached 25 in the last 20
  close(long.hit.share, 0.5);                                               // but did in all 20 older games
  assert.ok(long.hitChance < short.hitChance, `${long.hitChance} ${short.hitChance}`);
  // the other rankings ignore it but still carry it
  const m = run({ players, upcoming, history }, "model").rows.find((r) => r.side === "Under");
  assert.equal(m.rankedBy, "model"); close(m.model, m.modelCurrent); close(m.hitChance, long.hitChance);
  assert.equal(run({ players, upcoming }, "hit", "likely").sortBy, "market");   // no such order: falls back
}
// --- NFL: features by hand
{
  const rb = (carries, yards) => ({ carries, rushing_yards: yards, targets: 2, receptions: 1, receiving_yards: 8, attempts: 0, passing_yards: 0 });
  const games = [rb(20, 90), rb(10, 40), rb(15, 70)];                    // this season, newest first
  const recent = [...games, ...Array.from({ length: 12 }, () => rb(12, 55))];   // then last season
  const f = nflHitFeatures({ pOver: 0.7, strike: 60, stat: "rushing_yards", games, recent });
  assert.equal(f.games, 10); close(f.share, 2 / 10);                    // 90 and 70; the 55s and 40 miss; only 10 games counted
  close(f.lastVol, 20 / 15); assert.deepEqual(f.x, [1, logit(0.7), 0.2, 20 / 15]);
  const c = NFL_HIT_COEF.rushing_yards, h = nflHitChance({ pOver: 0.7, strike: 60, stat: "rushing_yards", games, recent });
  close(h.pOver, 1 / (1 + Math.exp(-(c[0] + c[1] * logit(0.7) + c[2] * 0.2 + c[3] * (20 / 15)))));
  assert.ok(h.pOver < 0.7);                                               // he cleared it in 2 of 10: pulled down
  assert.ok(nflHitChance({ pOver: 0.5, strike: 3, stat: "receptions", games, recent }).pOver < 0.5);     // never caught 3 in the last 10: below Proj
  assert.equal(nflHitChance({ pOver: 0.7, strike: 40, stat: "receiving_yards", games, recent }), null);
  assert.equal(nflHitFeatures({ pOver: 0.7, strike: 60, stat: "rushing_yards", games: games.slice(0, 1), recent }), null);   // needs 2 games this season
  close(nflHitFeatures({ pOver: 0.7, strike: 60, stat: "rushing_yards", games }).share, 2 / 3);          // no older games: this season's
  const idx = nflRecentIndex({ players: [{ name: "A B", season: 2025, week: 17, stats: rb(1, 1) }, { name: "A B", season: 2026, week: 2, stats: rb(2, 2) }, { name: "A B", season: 2026, week: 1, stats: rb(3, 3) },
    { name: "A B", season: 2025, week: 20, stats: rb(9, 9) }] }, normalizeName);
  assert.deepEqual(idx.get("a b").map((g) => g.carries), [2, 3, 1]);     // newest first, playoffs left out
}
assert.equal(NFL_HIT_GAMES, 10);
assert.deepEqual(NFL_HIT_VOLUME, { receptions: "targets", receiving_yards: "targets", rushing_yards: "carries", carries: "carries", passing_yards: "attempts" });
assert.deepEqual(NFL_HIT_COEF, { receptions: [-0.423, 0.855, 0.515, 0.116], rushing_yards: [-0.427, 0.875, 0.439, 0.172], carries: [-0.492, 0.948, 0.49, 0.321], passing_yards: [-1.311, 0.648, 1.774, 0.469] });

// --- NFL Board: rushing yards rows are ranked by the hit chance, receiving yards rows by Proj
{
  const g = (name, team, pos, season, week, stats) => ({ name, team, position: pos, season, week, stats });
  const players = [];
  for (let w = 1; w <= 6; w++) {
    players.push(g("Steady Back", "TB", "RB", 2026, w, { rushing_yards: 80 + (w % 3) * 5, carries: 18, receptions: 2, targets: 3, receiving_yards: 10 }));
    players.push(g("Rookie Wr", "CAR", "WR", 2026, w, { receiving_yards: 30, receptions: 3, targets: 5 }));
  }
  for (let w = 10; w <= 17; w++) players.push(g("Steady Back", "TB", "RB", 2025, w, { rushing_yards: 40, carries: 12, receptions: 1, targets: 2, receiving_yards: 5 }));
  const trend = { season: 2026, players, priorSeason: {}, schedule: [{ week: 7, date: "2026-10-25", kickoff: "2026-10-25T17:00:00Z", away: "TB", home: "CAR" }], lines: [] };
  const km = (who, stat, strike, bid, ask, ev) => parseNfl({ ticker: `${ev}-X-${strike}`, event_ticker: ev, title: `${who}: ${strike}+ yards`, status: "active", yes_bid_dollars: String(bid), yes_ask_dollars: String(ask) }, stat);
  const markets = [km("Steady Back", "rushing_yards", 60, 0.69, 0.72, "KXNFLRSHYDS-26OCT25TBCAR"), km("Rookie Wr", "receiving_yards", 40, 0.27, 0.30, "KXNFLRECYDS-26OCT25TBCAR")];
  const run = (rankBy) => buildNflBoard({ markets, trend, weekly: {}, nowMs: Date.parse("2026-10-23T22:00:00Z"), band: [0.05, 0.97], disagree: 1, errorGap: 1, onePerPlayer: false, rankBy });
  const b = run("hit"); assert.equal(b.rankBy, "hit");
  const rush = b.rows.find((r) => r.player === "Steady Back" && r.side === "Over"), rec = b.rows.find((r) => r.player === "Rookie Wr" && r.side === "Under");
  assert.equal(rush.rankedBy, "hit"); close(rush.model, rush.hitChance); assert.equal(rush.hit.games, 10); close(rush.hit.share, 6 / 10);   // 6 this season over 60, 4 of last season's under
  assert.ok(rush.hitChance < rush.modelProj);                              // the weaker older record pulls it under Proj
  close(b.rows.find((r) => r.player === "Steady Back" && r.side === "Under").hitChance, 1 - rush.hitChance);
  assert.equal(rec.rankedBy, "proj"); assert.equal(rec.hitChance, null); close(rec.model, rec.modelProj);
  const pj = run("proj").rows.find((r) => r.player === "Steady Back" && r.side === "Over");
  assert.equal(pj.rankedBy, "proj"); close(pj.hitChance, rush.hitChance);  // carried either way
  assert.equal(run("model").rows.find((r) => r.player === "Steady Back" && r.side === "Over").rankedBy, "model");
}
// --- EV after the fee, and the EV list
{
  close(evPerDollar(0.60, 0.50), (0.60 - 0.50 - 0.07 * 0.25) / 0.50);      // +16.5% per dollar
  assert.ok(evPerDollar(0.51, 0.50) < 0);                                    // one point is less than the fee
  assert.equal(evPerDollar(0.6, 0), null); assert.equal(KALSHI_TAKER_FEE, 0.07);
  assert.deepEqual(EV_RULES, { band: [0.30, 0.65], minEv: 0.03, weight: 0.30, priorNights: 1000, errorGap: 0.25, rawErrorGap: 0.15 });
  // the chance used for EV: the Kalshi mid moved 30% of the way (log-odds) toward the estimate
  close(blendWithPrice(0.77, 0.61), 1 / (1 + Math.exp(-(logit(0.61) + 0.3 * (logit(0.77) - logit(0.61))))));
  close(blendWithPrice(0.6, 0.6), 0.6); close(blendWithPrice(0.8, 0.5, 0), 0.5); close(blendWithPrice(0.8, 0.5, 1), 0.8); assert.equal(blendWithPrice(0.7, null), 0.7);
  assert.deepEqual([{ ev: 0.04, model: 0.5 }, { ev: 0.12, model: 0.4 }].sort(boardSort("ev")).map((r) => r.ev), [0.12, 0.04]);
  const day = (i) => new Date(Date.UTC(2026, 10, 1) - i * 2 * 864e5).toISOString().slice(0, 10);
  const players = Array.from({ length: 20 }, (_, i) => ({ name: "Ann Guard", team: "AAA", opponent: "BBB", season: 2026, date: day(i + 1), seasonType: "Regular Season", position: "G",
    stats: { points: 16 + (i % 9), rebounds: 4, assists: 5, threes: 2, minutes: 32 } }));
  const upcoming = [{ g: "1", date: "2026-11-02", tip: "2026-11-03T00:00:00Z", home: "AAA", away: "BBB" }];
  const mk = (bid, ask) => parseKalshiMarket({ ticker: "KXNBAPTS-26NOV02BBBAAA-AG-20", event_ticker: "KXNBAPTS-26NOV02BBBAAA", title: "Ann Guard: 20+ points", status: "active", yes_bid_dollars: bid.toFixed(2), yes_ask_dollars: ask.toFixed(2) }, "points");
  const run = (m, o = {}) => buildNbaBoard({ markets: [m], doc: { players, upcoming }, ctx: null, season: 2026, nowMs: Date.parse("2026-11-02T15:00:00Z"), band: [0.2, 0.8], rankBy: "hit", sortBy: "ev", disagree: 1, ...o });
  const est = run(mk(0.49, 0.51)).rows.find((r) => r.side === "Over").hitChance;
  const ask = Math.round((est - 0.20) * 100) / 100;                          // price the Over 20 points under the estimate
  const b = run(mk(ask - 0.02, ask), { minEv: EV_RULES.minEv }), over = b.rows.find((r) => r.side === "Over");
  assert.equal(b.sortBy, "ev"); assert.equal(b.evWeight, 0.30);
  close(over.fair, blendWithPrice(over.hitChance, ask - 0.01)); close(over.ev, evPerDollar(over.fair, ask)); close(over.evRaw, evPerDollar(over.hitChance, ask));
  assert.ok(over.ev >= 0.03 && over.ev < over.evRaw / 2);                    // blended EV is a fraction of the raw number
  assert.equal(b.rows.some((r) => r.side === "Under"), false);
  // a higher weight trusts the estimate more; weight 0 is the price itself: never +EV at the ask
  assert.ok(run(mk(ask - 0.02, ask), { evWeight: 0.6 }).rows.find((r) => r.side === "Over").ev > over.ev);
  const w0 = run(mk(ask - 0.02, ask), { minEv: EV_RULES.minEv, evWeight: 0 }); assert.equal(w0.rows.length, 0); assert.ok(w0.excluded.belowMinEv >= 1);
  // 8 points under the estimate is not enough once blended
  const near = Math.round((est - 0.08) * 100) / 100;
  assert.equal(run(mk(near - 0.02, near), { minEv: EV_RULES.minEv }).rows.length, 0);
}
console.log("hit chance tests passed");
