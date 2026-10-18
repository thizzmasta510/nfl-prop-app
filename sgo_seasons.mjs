// How far back does SportsGameOdds keep NFL prop lines? Run: set SGO_KEY=...  then  node sgo_seasons.mjs
const KEY = process.env.SGO_KEY;
if (!KEY) { console.error("Set SGO_KEY first."); process.exit(1); }
const BASE = "https://api.sportsgameodds.com/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  const r = await fetch(BASE + path, { headers: { "x-api-key": KEY } });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
// One week from each season (late Sept / early Oct).
const windows = [
  ["2025 wk4", "2025-09-25T00:00:00Z", "2025-09-30T12:00:00Z"],
  ["2024 wk4", "2024-09-26T00:00:00Z", "2024-10-01T12:00:00Z"],
  ["2023 wk4", "2023-09-28T00:00:00Z", "2023-10-03T12:00:00Z"],
  ["2022 wk4", "2022-09-29T00:00:00Z", "2022-10-04T12:00:00Z"],
];
const STATS = ["passing_yards", "rushing_yards", "receiving_yards", "receiving_receptions"];
for (const [label, a, b] of windows) {
  const r = await get(`/events?leagueID=NFL&startsAfter=${a}&startsBefore=${b}&finalized=true&limit=2`);
  console.log(`\n=== ${label} | status ${r.status}`);
  if (!r.json || !r.json.data) { console.log(r.text.slice(0, 300)); await sleep(7000); continue; }
  const evs = r.json.data;
  console.log("events returned:", evs.length);
  for (const e of evs) {
    const t = e.teams ? `${e.teams.away?.names?.short} @ ${e.teams.home?.names?.short}` : e.eventID;
    const odds = Object.values(e.odds || {}).filter(o => o.playerID && o.betTypeID === "ou" && o.periodID === "game" && o.sideID === "over" && Object.keys(o.byBookmaker || {}).length > 0);
    const line = [];
    for (const s of STATS) {
      const L = odds.filter(o => o.statID === s);
      const withClose = L.filter(o => o.closeBookOverUnder != null).length;
      const withOpen = L.filter(o => o.openBookOverUnder != null).length;
      line.push(`${s}: ${L.length} lines (open ${withOpen}, close ${withClose})`);
    }
    const nRes = Object.keys(e.results?.game || {}).length;
    console.log(`${t} | ${e.status?.startsAt?.slice(0, 10)} | players in results: ${nRes}`);
    console.log("  " + line.join(" | "));
  }
  await sleep(7000);
}
console.log("\nDone. Paste this output (NOT the key).");