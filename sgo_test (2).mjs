// Test SportsGameOdds coverage for NFL player props.
// Run (PowerShell):  $env:SGO_KEY="your_key"; node sgo_test.mjs
// Run (mac/linux):   SGO_KEY=your_key node sgo_test.mjs
// Endpoint/header names are from memory; the script prints raw errors so a wrong guess is visible.
import fs from "node:fs";

const KEY = process.env.SGO_KEY;
if (!KEY) { console.error("Set SGO_KEY first."); process.exit(1); }
const BASE = "https://api.sportsgameodds.com/v2";
let H = { "x-api-key": KEY };
let Q = "";

async function get(path) {
  const url = BASE + path + (Q ? (path.includes("?") ? "&" : "?") + Q : "");
  const r = await fetch(url, { headers: H });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}

// 0. Auth check: try the header form, then the query-param form, and keep whichever works.
console.log("key length:", KEY.length, "| starts/ends:", KEY.slice(0, 3) + "..." + KEY.slice(-3));
let probe = await get("/account/usage");
if (probe.status === 401) {
  console.log("header auth: 401, trying apiKey query param");
  H = {}; Q = "apiKey=" + encodeURIComponent(KEY);
  probe = await get("/account/usage");
  console.log("query-param auth:", probe.status);
  if (probe.status === 401) { console.log("Both forms rejected. Re-copy the key from the dashboard."); process.exit(1); }
}
// 1. Account / quota
const usage = probe;
console.log("usage:", usage.status, (usage.text || "").slice(0, 600));

// 2. A few upcoming NFL events with odds
const ev = await get("/events?leagueID=NFL&oddsAvailable=true&limit=3");
console.log("events status:", ev.status);
if (!ev.json) { console.log(ev.text.slice(0, 600)); process.exit(1); }
fs.writeFileSync("sgo_events_raw.json", JSON.stringify(ev.json, null, 2));
const events = ev.json.data || [];
console.log("events returned:", events.length);

for (const e of events) {
  const teams = e.teams ? `${e.teams.away?.names?.short} @ ${e.teams.home?.names?.short}` : e.eventID;
  const odds = e.odds || {};
  const ids = Object.keys(odds);
  const byStat = {};
  for (const id of ids) {
    const o = odds[id];
    if (!o.playerID) continue;
    byStat[o.statID] = (byStat[o.statID] || 0) + 1;
  }
  const books = new Set();
  for (const id of ids) for (const b of Object.keys(odds[id].byBookmaker || {})) books.add(b);
  console.log(`\n${teams} | total odds: ${ids.length} | player-prop odds by stat:`, byStat);
  console.log("bookmakers:", [...books].sort().join(", "));
}
console.log("\nSaved sgo_events_raw.json. Paste the console output here (NOT the key).");
