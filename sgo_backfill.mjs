// Backfill NFL prop lines + results from SportsGameOdds into a compact file.
// Run:  set SGO_KEY=...   then   node sgo_backfill.mjs
// Safe to stop and re-run: finished weeks are skipped (progress kept in sgo_backfill.json).
import fs from "node:fs";

const OUT = "sgo_backfill.json";
const STATS = ["passing_yards", "rushing_yards", "receiving_yards", "receiving_receptions",
  "passing_touchdowns", "passing_attempts", "passing_completions", "rushing_attempts"];
const START = "2025-09-01T00:00:00Z";
const WEEK_MS = 7 * 24 * 3600 * 1000;

const num = x => (x === undefined || x === null || x === "" ? null : Number(x));

export function extract(e) {
  const odds = e.odds || {};
  const res = (e.results && e.results.game) || {};
  const t = e.teams || {};
  const rows = [];
  for (const o of Object.values(odds)) {
    if (!o.playerID || o.betTypeID !== "ou" || o.periodID !== "game" || o.sideID !== "over") continue;
    if (!STATS.includes(o.statID)) continue;
    const nBooks = Object.keys(o.byBookmaker || {}).length;
    if (nBooks === 0) continue;
    const close = num(o.closeBookOverUnder);
    if (close === null) continue;
    const under = odds[o.opposingOddID] || {};
    const pl = (e.players && e.players[o.playerID]) || {};
    const actual = res[o.playerID] && res[o.playerID][o.statID] !== undefined ? num(res[o.playerID][o.statID]) : num(o.score);
    rows.push({
      eventID: e.eventID, startsAt: e.status && e.status.startsAt,
      away: t.away && t.away.names && t.away.names.short, home: t.home && t.home.names && t.home.names.short,
      playerID: o.playerID, name: pl.name || null, team: pl.teamID || null,
      stat: o.statID, open: num(o.openBookOverUnder), close,
      overCloseOdds: num(o.closeBookOdds), underCloseOdds: num(under.closeBookOdds),
      nBooks, actual,
    });
  }
  return rows;
}

const KEY = process.env.SGO_KEY;
if (!KEY) { console.error("Set SGO_KEY first."); process.exit(1); }
const BASE = "https://api.sportsgameodds.com/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(BASE + path, { headers: { "x-api-key": KEY } });
    const text = await r.text();
    if (r.status === 429) { console.log("  rate limited, waiting 65s"); await sleep(65000); continue; }
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, json: j, text };
  }
  return { status: 429, json: null, text: "rate limited repeatedly" };
}

let state = { doneWindows: [], rows: [] };
if (fs.existsSync(OUT)) { try { state = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {} }
const done = new Set(state.doneWindows);

const now = Date.now();
for (let t0 = Date.parse(START); t0 < now; t0 += WEEK_MS) {
  const a = new Date(t0).toISOString(), b = new Date(Math.min(t0 + WEEK_MS, now)).toISOString();
  const key = a.slice(0, 10);
  if (done.has(key)) continue;
  let cursor = null, nEv = 0, nRows = 0, ok = true;
  do {
    const q = `/events?leagueID=NFL&startsAfter=${a}&startsBefore=${b}&finalized=true&limit=5` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await get(q);
    if (!r.json || !r.json.data) { console.log(`${key}: error ${r.status} ${r.text.slice(0, 200)}`); ok = false; break; }
    for (const e of r.json.data) { const rows = extract(e); state.rows.push(...rows); nEv++; nRows += rows.length; }
    cursor = r.json.nextCursor || null;
    await sleep(7000);
  } while (cursor);
  if (ok) {
    state.doneWindows.push(key);
    fs.writeFileSync(OUT, JSON.stringify(state));
    console.log(`${key}: ${nEv} events, ${nRows} rows (total ${state.rows.length})`);
  }
}
console.log("\nDone. File:", OUT, "| total rows:", state.rows.length);