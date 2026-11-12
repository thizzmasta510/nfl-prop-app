// node test/kalshi_vs_books.test.mjs : pure parts of backtest/kalshi_vs_books.mjs
import assert from "node:assert/strict";
import { eventDate, etDate, noVigOver, parseRung, probAtRung, phi, phiInv, quoteAtKickoff, sides, simulate, gapStats, makeClient, takerFeeFrac } from "../backtest/kalshi_vs_books.mjs";

assert.equal(eventDate("KXNFLREC-26SEP20INDKC"), "2026-09-20");
assert.equal(eventDate("KXNFLRSHYDS-25DEC28PHIBUF"), "2025-12-28");
assert.equal(etDate("2025-09-05T00:20:00.000Z"), "2025-09-04", "Thursday night game is Thursday in ET");
assert.ok(Math.abs(noVigOver(-116, -114) - 0.502) < 0.001, "-116 over is the favorite");
assert.ok(Math.abs(noVigOver(-300, 240) - 0.7183) < 0.001);
assert.deepEqual(parseRung("Noah Gray: 40+ receiving yards"), { player: "Noah Gray", strike: 40 });
assert.deepEqual(parseRung("Jaime Jaquez Jr.: 1+ threes"), { player: "Jaime Jaquez Jr.", strike: 1 });
assert.equal(parseRung("Who wins?"), null);
for (const p of [0.02, 0.2, 0.5, 0.8, 0.98]) assert.ok(Math.abs(phi(phiInv(p)) - p) < 1e-3);

// Exact rung: unchanged. Nearby: higher rung -> lower Over probability, and continuous.
assert.equal(probAtRung(0.55, 4.5, 5, "receiving_receptions"), 0.55);
const at50 = probAtRung(0.5, 54.5, 50, "rushing_yards"), at60 = probAtRung(0.5, 54.5, 60, "rushing_yards");
assert.ok(at50 > 0.5 && at60 < 0.5 && at50 - 0.5 < 0.08 && 0.5 - at60 < 0.08, `${at50} ${at60}`);
assert.ok(Math.abs(probAtRung(0.5, 54.5, 55, "rushing_yards") - 0.5) < 1e-9);

// Quote at kickoff: last two-sided candle at or before kickoff, later ones ignored.
const k = 1793493000;
const q = quoteAtKickoff([{ end_period_ts: k - 120, yes_bid: { close_dollars: "0.40" }, yes_ask: { close_dollars: "0.44" } },
  { end_period_ts: k - 60, yes_bid: { close_dollars: "0.41" }, yes_ask: {} },
  { end_period_ts: k + 60, yes_bid: { close_dollars: "0.05" }, yes_ask: { close_dollars: "0.07" } }], k);
assert.deepEqual(q, { bid: 0.4, ask: 0.44, at: k - 120 });
assert.equal(quoteAtKickoff([{ end_period_ts: k - 60, yes_bid: { close: 30 }, yes_ask: { close: 34 } }], k).ask, 0.34, "old cents format");

// Sides and fees.
const [o, u] = sides({ pAtRung: 0.6, bid: 0.5, ask: 0.54, yes: true });
assert.ok(Math.abs(o.edge - 0.06) < 1e-9 && o.won && Math.abs(u.buy - 0.5) < 1e-9 && Math.abs(u.edge - (-0.1)) < 1e-9 && !u.won);
assert.ok(Math.abs(takerFeeFrac(0.75) - 0.0175) < 1e-12);

// Simulate: books right and Kalshi cheap -> profit; one bet per player/stat/game.
const rows = [];
for (let i = 0; i < 400; i++) rows.push({ game: "g" + i, norm: "p", stat: "receiving_receptions", pAtRung: 0.7, bid: 0.6, ask: 0.62, yes: i % 10 < 7 });
rows.push({ game: "g0", norm: "p", stat: "receiving_receptions", pAtRung: 0.7, bid: 0.66, ask: 0.68, yes: true }); // worse rung, same bet
const s = simulate(rows, [0, 0.06, 0.2]);
assert.equal(s[0].n, 400); assert.ok(Math.abs(s[0].hit - 0.7) < 1e-9);
assert.ok(s[0].roiTaker > 0.08 && s[0].roiTaker < 0.11, String(s[0].roiTaker));   // 0.7/0.62 - 1 - 0.07*0.38
assert.equal(s[2].n, 0);
// Books no better than Kalshi -> no edge after fees.
const fair = Array.from({ length: 2000 }, (_, i) => ({ game: "h" + i, norm: "p", stat: "rushing_yards", pAtRung: 0.5, bid: 0.48, ask: 0.52, yes: i % 2 === 0 }));
assert.ok(simulate(fair, [0])[0].n === 0 || simulate(fair, [0])[0].roiTaker < 0);
const g = gapStats(rows.slice(0, 400));
assert.ok(Math.abs(g.median - (-9)) < 0.01 && g.over4 === 1);

// Client: retries a 429, returns null on 404.
let n = 0;
const fake = async (url) => { n++; if (url.includes("busy") && n < 3) return new Response("", { status: 429 }); if (url.includes("missing")) return new Response("", { status: 404 }); return Response.json({ ok: 1 }); };
const c = makeClient({ fetchImpl: fake, paceMs: 1 });
const origTimeout = globalThis.setTimeout; globalThis.setTimeout = (f) => origTimeout(f, 0);
assert.deepEqual(await c.get("/busy"), { ok: 1 }); assert.equal(await c.get("/missing"), null);
globalThis.setTimeout = origTimeout;
console.log("kalshi vs books tests passed");
