// node test/sgo_check.test.mjs
import assert from "node:assert/strict";
import { pregameCheck, warnIfInGame, NEAR_RESULT_LIMIT } from "../backtest/sgo_check.mjs";
// 2025-like rows: 40% of closes within 3 yards of the result; 2026-like: 10%
const rows = [];
for (let i = 0; i < 100; i++) {
  rows.push({ startsAt: "2025-10-12T17:00:00Z", stat: "receiving_yards", close: 50.5, actual: i < 40 ? 52 : 80 });
  rows.push({ startsAt: "2026-10-11T17:00:00Z", stat: "rushing_yards", close: 60.5, actual: i < 10 ? 59 : 30 });
  rows.push({ startsAt: "2026-10-11T17:00:00Z", stat: "receiving_receptions", close: 4.5, actual: 4 });   // not a yards prop: ignored
}
const c = pregameCheck(rows);
assert.deepEqual(c.map((x) => [x.season, x.n, Math.round(x.share * 100), x.inGame]), [[2025, 100, 40, true], [2026, 100, 10, false]]);
assert.ok(NEAR_RESULT_LIMIT === 0.15);
const msgs = []; assert.deepEqual(warnIfInGame(rows, (m) => msgs.push(m)), [2025]); assert.equal(msgs.length, 1);
console.log("sgo check tests passed");
