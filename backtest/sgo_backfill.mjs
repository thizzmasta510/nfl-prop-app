// Backfill player prop lines + results from SportsGameOdds into a compact file.
// Run (Windows):  set SGO_KEY=...   then
//   node sgo_backfill.mjs                    (NFL -> sgo_backfill.json)
//   node sgo_backfill.mjs --league NBA       (NBA -> sgo_backfill_nba.json)
//   node sgo_backfill.mjs --league NBA --discover   (prints the NBA statIDs SGO uses; run this first)
// Safe to stop and re-run: finished weeks are skipped (progress kept in the output file).
// Never paste or commit the key itself.
import fs from "node:fs";

const argv = process.argv.slice(2);
const argOf = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LEAGUE = String(argOf("league", "NFL")).toUpperCase();
const CONFIG = {
  NFL: { out: "sgo_backfill.json", start: "2025-09-01T00:00:00Z",
    stats: ["passing_yards", "rushing_yards", "receiving_yards", "receiving_receptions",
      "passing_touchdowns", "passing_attempts", "passing_completions", "rushing_attempts"] },
  // NBA statIDs are UNVERIFIED guesses; run with --discover and edit this list to match.
  NBA: { out: "sgo_backfill_nba.json", start: "2025-10-20T00:00:00Z",
    stats: ["points", "rebounds", "assists", "threePointersMade", "points+rebounds+assists",
      "points+rebounds", "points+assists", "rebounds+assists", "steals", "blocks", "turnovers"] },
};
if (!CONFIG[LEAGUE]) { console.error("--league must be NFL or NBA"); process.exit(1); }
const OUT = argOf("out", CONFIG[LEAGUE].out);
const STATS = CONFIG[LEAGUE].stats;
const START = argOf("start", CONFIG[LEAGUE].start);
const WEEK_MS = 7 * 24 * 3600 * 1000;

const num = x => (x === undefined || x === null || x === "" ? null : Number(x));

// Turn one finalized event into compact rows (one per player-stat main line).
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

// --- self test on a local file: node sgo_backfill.mjs --selftest sgo_history_raw.json
if (process.argv[2] === "--selftest") {
  const d = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const all = d.data.flatMap(extract);
  console.log("rows:", all.length);
  console.log(all.slice(0, 5));
  process.exit(0);
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

if (argv.includes("--discover")) {
  const b = new Date().toISOString(), a = new Date(Date.now() - 10 * 86400000).toISOString();
  const r = await get(`/events?leagueID=${LEAGUE}&startsAfter=${a}&startsBefore=${b}&finalized=true&limit=1`);
  const e = r.json && r.json.data && r.json.data[0];
  if (!e) { console.log("No finalized event in the last 10 days:", r.status, r.text.slice(0, 300)); process.exit(1); }
  const ids = {};
  for (const o of Object.values(e.odds || {})) if (o.playerID && o.betTypeID === "ou" && o.periodID === "game") ids[o.statID] = (ids[o.statID] || 0) + 1;
  console.log(`${LEAGUE} player over/under statIDs in event ${e.eventID}:`, ids);
  process.exit(0);
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
    const q = `/events?leagueID=${LEAGUE}&startsAfter=${a}&startsBefore=${b}&finalized=true&limit=5` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await get(q);
    if (!r.json || !r.json.data) { console.log(`${key}: error ${r.status} ${r.text.slice(0, 200)}`); ok = false; break; }
    for (const e of r.json.data) { const rows = extract(e); state.rows.push(...rows); nEv++; nRows += rows.length; }
    cursor = r.json.nextCursor || null;
    await sleep(7000); // stay under 10 requests a minute
  } while (cursor);
  if (ok) {
    state.doneWindows.push(key);
    fs.writeFileSync(OUT, JSON.stringify(state));
    console.log(`${key}: ${nEv} events, ${nRows} rows (total ${state.rows.length})`);
  }
}
console.log("\nDone. File:", OUT, "| total rows:", state.rows.length);
