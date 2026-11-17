import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fetchKalshiSeries, trimEvent, fetchSgoLeague, main } from "../snapshot/snapshot.mjs";
const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
// Kalshi pages are followed until the cursor is empty
let n = 0;
const kf = async (url) => { n++; return url.includes("cursor=c2") ? res({ markets: [{ ticker: "B" }], cursor: "" }) : res({ markets: [{ ticker: "A" }], cursor: "c2" }); };
const k = await fetchKalshiSeries("KXNBAPTS", kf, 0);
assert.equal(k.count, 2); assert.equal(n, 2);
// only player props are kept and raw book data survives
const ev = trimEvent({ eventID: "E1", status: { startsAt: "2026-11-18T00:00:00Z" }, teams: { away: { names: { short: "ORL" } }, home: { names: { short: "BOS" } } },
  odds: { a: { playerID: "P1", statID: "points", sideID: "over", bookOverUnder: "24.5", byBookmaker: { pinnacle: { odds: "-110" } } }, b: { statID: "points" } } });
assert.equal(ev.props.length, 1); assert.equal(ev.props[0].byBookmaker.pinnacle.odds, "-110");
// SportsGameOdds stops at maxEvents and sends the key as a header
let sawKey = null;
const sf = async (url, opt) => { sawKey = opt.headers["x-api-key"]; return res({ data: [{ eventID: "x", odds: {} }, { eventID: "y", odds: {} }], nextCursor: "more" }); };
const g = await fetchSgoLeague("NBA", "KEY", { fetchFn: sf, maxEvents: 4, wait: 0 });
assert.equal(g.count, 4); assert.equal(sawKey, "KEY");
// full run without a key skips SportsGameOdds and writes the manifest
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
const { dir, manifest } = await main(["--leagues", "NBA", "--out", tmp], {}, async () => res({ markets: [{ ticker: "Z" }], cursor: "" }));
assert.equal(manifest.sgo.skipped, "SGO_KEY not set"); assert.equal(manifest.errors.length, 0);
assert.ok(fs.existsSync(path.join(dir, "kalshi_KXNBAPTS.json")) && fs.existsSync(path.join(dir, "manifest.json")));
console.log("snapshot tests passed");
