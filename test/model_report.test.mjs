// node test/model_report.test.mjs
import assert from "node:assert/strict";
import { snapshotRungs, nbaDocAsOf, nflWeekOf, nflTrendAsOf, summarizeReports, fitPriceWeight, SNAPSHOT_SERIES } from "../src/model_report.js";
import { blendWithPrice, evPerDollar } from "../src/nba_board.js";
import worker from "../src/index.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// --- snapshot parsing keeps that day's games only
{
  const mk = (ev, who, n, bid, ask) => ({ ticker: `${ev}-X-${n}`, event_ticker: ev, status: "active", title: `${who}: ${n}+ points`, yes_bid_dollars: String(bid), yes_ask_dollars: String(ask) });
  const t = JSON.stringify({ markets: [mk("KXNBAPTS-26NOV02OKCCLE", "Shai Gilgeous-Alexander", 30, 0.6, 0.62), mk("KXNBAPTS-26NOV04PHIDET", "Joel Embiid", 25, 0.5, 0.52)], cursor: "" });
  const r = snapshotRungs([t, "not json"], "points", "2026-11-02");
  assert.equal(r.length, 1); assert.equal(r[0].player, "Shai Gilgeous-Alexander"); assert.equal(r[0].strike, 30); close(r[0].mid, 0.61);
}

// --- point-in-time NBA logs: only earlier games, that night's schedule from the played rows
{
  const doc = { players: [
    { name: "A", norm: "a", team: "OKC", opponent: "CLE", home: true, date: "2026-11-02", stats: {} },
    { name: "B", norm: "b", team: "CLE", opponent: "OKC", home: false, date: "2026-11-02", stats: {} },
    { name: "A", norm: "a", team: "OKC", opponent: "HOU", home: false, date: "2026-10-31", stats: {} }],
    teamGames: [{ d: "2026-10-31", t: "OKC" }, { d: "2026-11-02", t: "OKC" }], efficiency: { A: {} } };
  const d = nbaDocAsOf(doc, "2026-11-02");
  assert.deepEqual(d.players.map((r) => r.date), ["2026-10-31"]);
  assert.equal(d.teamGames.length, 1); assert.equal(d.efficiency, undefined);
  assert.equal(d.upcoming.length, 1); assert.equal(d.upcoming[0].home, "OKC"); assert.equal(d.upcoming[0].away, "CLE");
}

// --- NFL week from the schedule anchor (weeks start Thursday)
{
  const sched = [{ week: 9, date: "2026-11-08", away: "CIN", home: "ATL" }];
  assert.equal(nflWeekOf(sched, "2026-11-05"), 9);   // Thursday
  assert.equal(nflWeekOf(sched, "2026-11-09"), 9);   // Monday
  assert.equal(nflWeekOf(sched, "2026-11-01"), 8);
  assert.equal(nflWeekOf(sched, "2026-09-10"), 1);
  assert.equal(nflWeekOf([], "2026-11-01"), null);
  const trend = { season: 2026, players: [{ name: "X", team: "TB", opponent: "CAR", season: 2026, week: 8, stats: {} }, { name: "X", team: "TB", opponent: "NO", season: 2026, week: 7, stats: {} }] };
  const t = nflTrendAsOf(trend, 8, "2026-11-01");
  assert.deepEqual(t.players.map((r) => r.week), [7]); assert.equal(t.schedule.length, 1); assert.equal(t.schedule[0].week, 8);
}

// --- summary: log loss on shared rungs, paired difference, top-15 lists
{
  const rungs = [
    { player: "P1", strike: 20, mid: 0.7, overBuy: 0.72, underBuy: 0.32, cur: 0.8, proj: 0.7, y: 1 },
    { player: "P2", strike: 10, mid: 0.5, overBuy: 0.51, underBuy: 0.51, cur: 0.5, proj: 0.6, y: 0 },
    { player: "P3", strike: 5, mid: 0.6, overBuy: 0.62, underBuy: 0.42, cur: 0.6, proj: null, y: 1 },   // no proj: not in accuracy
    { player: "P4", strike: 5, mid: 0.6, overBuy: 0.62, underBuy: 0.42, cur: 0.6, proj: 0.6, y: null },  // DNP: ignored
  ];
  const s = summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "points", rungs }]);
  const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
  assert.equal(s.accuracy.rungs, 2);
  close(s.accuracy.logLoss.market, (ll(0.7, 1) + ll(0.5, 0)) / 2);
  close(s.accuracy.logLoss.model, (ll(0.8, 1) + ll(0.5, 0)) / 2);
  close(s.accuracy.logLoss.proj, (ll(0.7, 1) + ll(0.6, 0)) / 2);
  close(s.accuracy.projMinusModel, ((ll(0.7, 1) - ll(0.8, 1)) + (ll(0.6, 0) - ll(0.5, 0))) / 2);
  // 66-75 list: P1 Over at 0.72 (both estimates >= 0.62) -> hit; coin: P2 Over 0.51 with proj 0.6 (gap .09) -> miss for Proj only
  const L = s.lists;
  assert.equal(L["66-75|cur"].picks, 1); assert.equal(L["66-75|cur"].hits, 1);
  assert.equal(L["coin|proj"].picks, 1); assert.equal(L["coin|proj"].hits, 0); assert.equal(L["coin|cur"].picks, 0);
  close(L["66-75|proj"].units, Math.round(((1 - 0.72) / 0.72) * 100) / 100);
  assert.equal(s.accuracy.seSlate, null);   // one slate: no clustered SE
  // two slates: clustered SE from per-slate sums of (difference - mean)
  const r2 = summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "points", rungs }, { date: "2026-11-03", sport: "nba", stat: "points", rungs: rungs.map((r) => ({ ...r, y: r.y === null ? null : 1 - r.y })) }]);
  const diffs = [ll(0.7, 1) - ll(0.8, 1), ll(0.6, 0) - ll(0.5, 0), ll(0.7, 0) - ll(0.8, 0), ll(0.6, 1) - ll(0.5, 1)];
  const m = diffs.reduce((a, b) => a + b, 0) / 4, s1 = diffs[0] + diffs[1] - 2 * m, s2 = diffs[2] + diffs[3] - 2 * m;
  close(r2.accuracy.seSlate, Math.sqrt((s1 * s1 + s2 * s2) * 2) / 4); assert.equal(r2.accuracy.slates, 2);
}

// --- the Worker: snapshot cron writes raw pages and follows the cursor; report route scores a saved slate
{
  const store = new Map();
  const bucket = { async get(k) { return store.has(k) ? { text: async () => store.get(k), body: {} } : null; },
    async put(k, v) { store.set(k, String(v)); }, async delete(k) { store.delete(k); },
    async list({ prefix, delimiter }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const pre = new Set(keys.map((k) => { const rest = k.slice(prefix.length); const i = rest.indexOf(delimiter); return i >= 0 ? prefix + rest.slice(0, i + 1) : null; }).filter(Boolean));
      return { delimitedPrefixes: [...pre], objects: [], truncated: false };
    } };
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url)); calls++;
    const series = u.searchParams.get("series_ticker"), cursor = u.searchParams.get("cursor");
    if (series === "KXNBAPTS" && !cursor) return new Response(JSON.stringify({ markets: [{ ticker: "a" }], cursor: "NEXT" }));
    return new Response(JSON.stringify({ markets: [], cursor: "" }));
  };
  try {
    await worker.scheduled({ cron: "0 16 * * *" }, { PROP_DATA: bucket }, {});
    const keys = [...store.keys()].filter((k) => k.startsWith("snapshots/"));
    const n = Object.values(SNAPSHOT_SERIES).reduce((a, s) => a + Object.keys(s).length, 0);
    assert.equal(keys.length, n + 1, keys.join(","));             // one page each, two for KXNBAPTS
    assert.ok(keys.some((k) => /KXNBAPTS-1\.json$/.test(k)));
    assert.equal(calls, n + 1);
  } finally { globalThis.fetch = realFetch; }
}
// --- hit chance: the older-games block is cut to before the date; its own accuracy line and lists
{
  const doc = { players: [], history: { A: { dates: ["2026-11-03", "2026-11-01", "2026-10-30"], minutes: [30, 31, 32], points: [9, 8, 7], rebounds: [1, 2, 3], assists: [0, 0, 0], threes: [1, 1, 1] },
    B: { dates: ["2026-11-02"], minutes: [20], points: [5], rebounds: [1], assists: [1], threes: [0] } } };
  const d = nbaDocAsOf(doc, "2026-11-02");
  assert.deepEqual(d.history, { A: { dates: ["2026-11-01", "2026-10-30"], minutes: [31, 32], points: [8, 7], rebounds: [2, 3], assists: [0, 0], threes: [1, 1] } });
  const rungs = [
    { player: "P1", strike: 10, mid: 0.8, overBuy: 0.82, underBuy: 0.22, cur: 0.7, proj: null, hit: 0.9, y: 1 },
    { player: "P2", strike: 10, mid: 0.8, overBuy: 0.82, underBuy: 0.22, cur: 0.9, proj: null, hit: 0.75, y: 0 },
    { player: "P3", strike: 10, mid: 0.8, overBuy: 0.82, underBuy: 0.22, cur: 0.8, proj: null, hit: null, y: 1 },   // no hit chance: not in its accuracy
  ];
  const s = summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "rebounds", rungs }]);
  const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
  assert.equal(s.accuracy.hit.rungs, 2);
  close(s.accuracy.hit.logLoss.hit, (ll(0.9, 1) + ll(0.75, 0)) / 2); close(s.accuracy.hit.logLoss.model, (ll(0.7, 1) + ll(0.9, 0)) / 2);
  close(s.accuracy.hit.logLoss.market, (ll(0.8, 1) + ll(0.8, 0)) / 2);
  // lists made with the hit chance: nothing here is priced 66-75% or 48-53%, so they exist and are empty
  assert.equal(s.lists["66-75|hit"].picks, 0); assert.equal(s.lists["coin|hit"].picks, 0); assert.equal(s.lists["76-90|hit"], undefined);
  const band = summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "rebounds", rungs: rungs.map((r) => ({ ...r, overBuy: 0.72 })) }]);
  // Overs at 0.72: the hit chance list takes P1 (0.90), P2 (0.75) and P3 (no hit chance: the model, 0.80); the model list takes all three too (0.70 is within 10 of the price)
  assert.equal(band.lists["66-75|hit"].picks, 3); assert.equal(band.lists["66-75|hit"].hits, 2); assert.equal(band.lists["66-75|cur"].picks, 3);
  assert.equal(summarizeReports([{ date: "2026-11-02", sport: "nfl", stat: "receptions", rungs: rungs.map((r) => ({ ...r, hit: null, proj: 0.8 })) }]).accuracy.hit, null);
  // +EV lists: Overs at mid 0.49, ask 0.50. Blended (weight 0.30): P1 (hit chance 0.75) clears 3% after the fee; P2 (0.60) does not.
  // Raw: P2 (0.60) qualifies; P1 is 15+ points above the price and is set aside.
  const evr = [{ ...rungs[0], mid: 0.49, overBuy: 0.50, underBuy: 0.52, hit: 0.75, cur: 0.50, y: 1 }, { ...rungs[1], mid: 0.49, overBuy: 0.50, underBuy: 0.52, hit: 0.60, cur: 0.50, y: 0 }];
  assert.ok(evPerDollar(blendWithPrice(0.75, 0.49), 0.50) >= 0.03 && evPerDollar(blendWithPrice(0.60, 0.49), 0.50) < 0.03);
  const ev = summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "rebounds", rungs: evr }]).lists;
  assert.equal(ev["ev|hit"].picks, 1); assert.equal(ev["ev|hit"].hits, 1); close(ev["ev|hit"].units, 1);
  assert.equal(ev["evraw|hit"].picks, 1); assert.equal(ev["evraw|hit"].hits, 0);
  // a higher weight lets P2 in as well
  assert.equal(summarizeReports([{ date: "2026-11-02", sport: "nba", stat: "rebounds", rungs: evr }], { evWeight: 0.6 }).lists["ev|hit"].picks, 2);
}

// --- weight on the estimate next to the Kalshi price: recovered from simulated slates, pulled toward 0.30 when there is little data
{
  const lg = (p) => Math.log(p / (1 - p)), sg = (z) => 1 / (1 + Math.exp(-z));
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const make = (n, w) => Array.from({ length: n }, (_, i) => { const mid = 0.2 + 0.6 * rnd(), est = Math.min(0.95, Math.max(0.05, mid + (rnd() - 0.5) * 0.4));
    return { player: "P" + i, strike: 10, mid, cur: est, proj: null, hit: est, y: rnd() < sg(lg(mid) + w * (lg(est) - lg(mid))) ? 1 : 0 }; });
  const big = fitPriceWeight([{ date: "2026-11-02", sport: "nba", stat: "points", rungs: make(40000, 0.5) }]);
  assert.equal(big.playerNights, 40000); assert.ok(Math.abs(big.fitted - 0.5) < 0.08, String(big.fitted));
  close(big.weight, Math.round(((40000 * big.fitted + 1000 * 0.3) / 41000) * 1000) / 1000, 1e-9);
  const small = fitPriceWeight([{ date: "2026-11-02", sport: "nba", stat: "points", rungs: make(50, 0.5) }]);
  assert.ok(Math.abs(small.weight - 0.3) < 0.06, String(small.weight));       // 50 player-nights barely move it
  assert.deepEqual(fitPriceWeight([]), { weight: 0.3, fitted: null, playerNights: 0, rungs: 0 });
  // the market knows everything (true weight 0): the fit goes to about 0 and the used weight falls with it
  const zero = fitPriceWeight([{ date: "2026-11-02", sport: "nba", stat: "points", rungs: make(40000, 0) }]);
  assert.ok(Math.abs(zero.fitted) < 0.08 && zero.weight < 0.1, JSON.stringify(zero));
}
console.log("model report tests passed");
