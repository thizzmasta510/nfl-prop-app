// Does SportsGameOdds keep past NFL prop lines + final results? Run: set SGO_KEY=... then  node sgo_history.mjs
import fs from "node:fs";
const KEY = process.env.SGO_KEY;
if (!KEY) { console.error("Set SGO_KEY first."); process.exit(1); }
const BASE = "https://api.sportsgameodds.com/v2";
async function get(path) {
  const r = await fetch(BASE + path, { headers: { "x-api-key": KEY } });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Past window: Sept 24 - Sept 30 2026 (Week 4). Change if you want another week.
const q = "/events?leagueID=NFL&startsAfter=2026-09-24T00:00:00Z&startsBefore=2026-09-30T12:00:00Z&finalized=true&limit=3";
const ev = await get(q);
console.log("past events status:", ev.status);
if (!ev.json || !ev.json.data) { console.log(ev.text.slice(0, 600)); process.exit(1); }
fs.writeFileSync("sgo_history_raw.json", JSON.stringify(ev.json, null, 2));
const events = ev.json.data;
console.log("past events returned:", events.length);
if (!events.length) { console.log("No past events returned. History may need a paid tier, or params are wrong."); process.exit(0); }

for (const e of events) {
  const teams = e.teams ? `${e.teams.away?.names?.short} @ ${e.teams.home?.names?.short}` : e.eventID;
  console.log(`\n${teams} | startsAt: ${e.status?.startsAt} | completed: ${e.status?.completed} | finalized: ${e.status?.finalized}`);
  const odds = e.odds || {};
  const py = Object.values(odds).filter(o => o.playerID && o.statID === "passing_yards" && o.betTypeID === "ou");
  console.log("passing_yards O/U entries:", py.length);
  if (py.length) {
    const o = py[0];
    console.log("fields on one odd:", Object.keys(o).join(", "));
    console.log("sample:", JSON.stringify({ playerID: o.playerID, sideID: o.sideID, score: o.score, bookOverUnder: o.bookOverUnder, openBookOverUnder: o.openBookOverUnder, closeBookOverUnder: o.closeBookOverUnder, bookOdds: o.bookOdds, closeBookOdds: o.closeBookOdds }));
    const bk = Object.entries(o.byBookmaker || {})[0];
    if (bk) console.log("one bookmaker entry:", bk[0], JSON.stringify(bk[1]).slice(0, 400));
    const withScore = py.filter(x => x.score !== undefined && x.score !== null).length;
    const withClose = py.filter(x => x.closeBookOverUnder !== undefined || x.closeFairOverUnder !== undefined).length;
    console.log(`with final score: ${withScore}/${py.length} | with close line: ${withClose}/${py.length}`);
  }
  console.log("results block present:", !!e.results, e.results ? Object.keys(e.results).join(",") : "");
  await sleep(7000);
}
console.log("\nSaved sgo_history_raw.json. Paste this console output (NOT the key).");