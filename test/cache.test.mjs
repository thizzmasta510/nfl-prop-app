// node test/cache.test.mjs : the trend endpoint reuses the parsed file until the etag changes,
// and /api/nba-lines rejects oversized bodies even without a content-length header.
import assert from "node:assert/strict";
import worker from "../src/index.js";
const store = new Map(); let bodyReads = 0;
// Minimal R2 mock, including the onlyIf.etagDoesNotMatch precondition (R2 returns
// metadata without a body when the etag still matches).
const bucket = {
  async get(k, opts) {
    if (!store.has(k)) return null;
    const o = store.get(k);
    // Real R2: a failed precondition returns an R2Object with body undefined (and no text()).
    if (opts?.onlyIf?.etagDoesNotMatch === o.etag) return { key: k, etag: o.etag, body: undefined };
    return { key: k, etag: o.etag, body: {}, text: async () => { bodyReads++; return o.body; } };
  },
  async put(k, v) { store.set(k, { body: String(v), etag: "e" + Math.random() }); },
};
const rows = [1, 2, 3].map((w) => ({ name: "A B", team: "T", week: w, season: 2026, position: "WR", stats: { receptions: 5 } }));
await bucket.put("trend-logs.json", JSON.stringify({ season: 2026, players: rows }));
const env = { PROP_DATA: bucket, ALLOW_OPEN: "true" };
const call = () => worker.fetch(new Request("http://x/api/trends?stat=receptions&games=3"), env).then((r) => r.json());
const r1 = await call(); assert.equal(r1.rows.length, 1);
const before = bodyReads; const r2 = await call();
assert.equal(bodyReads - before, 0, "trend body not re-read when etag unchanged (props.json absent here)");
assert.equal(r2.rows.length, 1, "cache hit returns the cached data, not the 503 fallback (review F1)");
await bucket.put("trend-logs.json", JSON.stringify({ season: 2026, players: rows.slice(0, 2) }));
const r3 = await call();
assert.equal(r3.rows.length, 0, "new upload picked up (only 2 games now, min 3)");

// Bounded body read: a 25 KB body sent as a stream (no content-length) is refused with 413.
const big = JSON.stringify({ text: "x, points, 1\n".repeat(2000) });
const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
const res = await worker.fetch(new Request("http://x/api/nba-lines", { method: "POST", body: stream, duplex: "half" }), env);
assert.equal(res.status, 413);
const ok = await worker.fetch(new Request("http://x/api/nba-lines", { method: "POST", body: JSON.stringify({ text: "A B, pts, 4.5" }) }), env);
assert.equal(ok.status, 200);
assert.equal((await ok.json()).saved, 1);
console.log("cache test passed");
