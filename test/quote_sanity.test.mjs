import assert from "node:assert/strict";
import { parseKalshiMarket, dropBrokenRungs } from "../src/nba_board.js";
const mk = (strike, yb, ya, nb, na, t = "KXNBAREB-26NOV16PORMIN-POR1CAMARA-") => ({ ticker: t + strike, title: `Toumani Camara: ${strike}+ rebounds`, status: "active",
  yes_bid_dollars: yb, yes_ask_dollars: ya, no_bid_dollars: nb, no_ask_dollars: na });
// a consistent book parses
assert.ok(parseKalshiMarket(mk(4, "0.59", "0.61", "0.39", "0.41"), "rebounds"));
// the NO side read as YES (yes 0.39/0.41 against no 0.39/0.41) is refused
assert.equal(parseKalshiMarket(mk(4, "0.39", "0.41", "0.39", "0.41"), "rebounds"), null);
// books with no no-side fields still parse
assert.ok(parseKalshiMarket({ ...mk(4, "0.59", "0.61"), no_bid_dollars: undefined, no_ask_dollars: undefined }, "rebounds"));
// ladder: 4+ cheaper than 6+ is broken, the high rung is dropped
const L = [2, 4, 6].map((k, i) => ({ ticker: "A-" + k, strike: k, mid: [0.9, 0.4, 0.5][i] }));
assert.deepEqual(dropBrokenRungs(L).map((m) => m.strike), [2, 4]);
const ok = [2, 4, 6].map((k, i) => ({ ticker: "A-" + k, strike: k, mid: [0.9, 0.6, 0.3][i] }));
assert.equal(dropBrokenRungs(ok).length, 3);
console.log("quote_sanity ok");
