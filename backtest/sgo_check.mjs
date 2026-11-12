// Pregame check for SportsGameOdds backfill rows (review round 5).
// The 2025 backfill's "close" is often an in-game line: about a third of 2025 yards
// closes sit within 3 yards of the final result, vs about 1 in 10 for pregame lines
// (2026 rows: 11-12%). Results that used those rows (rounds 1-3: "the model adds nothing
// beyond the market", "the 66-75% band returned +2.8% at the price paid") may overstate
// how sharp the market was; they are pending a re-check with pregame closes.
export const NEAR_RESULT_LIMIT = 0.15;
const seasonOf = (iso) => { const y = +String(iso).slice(0, 4), m = +String(iso).slice(5, 7); return m >= 3 ? y : y - 1; };
/** rows: SGO rows ({ startsAt, stat, close, actual }). Returns [{ season, n, share, inGame }]. */
export function pregameCheck(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!/yards/.test(String(r.stat)) || r.close == null || r.actual == null || !r.startsAt) continue;
    const s = seasonOf(r.startsAt), c = by.get(s) || by.set(s, { n: 0, near: 0 }).get(s);
    c.n++; if (Math.abs(Number(r.actual) - Number(r.close)) < 3) c.near++;
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([season, c]) => ({ season, n: c.n, share: c.n ? c.near / c.n : 0, inGame: c.n >= 50 && c.near / c.n > NEAR_RESULT_LIMIT }));
}
/** Prints the check; returns the seasons that look contaminated. */
export function warnIfInGame(rows, log = console.log) {
  const bad = pregameCheck(rows).filter((x) => x.inGame);
  for (const b of bad) log(`WARNING: ${b.season} closes look like in-game lines (${Math.round(100 * b.share)}% of yards closes within 3 yards of the result; pregame is about 10%). Results for ${b.season} overstate the market; use pregame closes or --season to skip it.`);
  return bad.map((b) => b.season);
}
