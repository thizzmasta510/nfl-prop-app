// Daily price snapshot: Kalshi player-prop prices and SportsGameOdds sportsbook prices, saved side by side.
// It only saves data. It changes no picks and nothing on the site.
//
//   SGO_KEY=your_key node snapshot/snapshot.mjs [--leagues NBA,NFL] [--out snapshots] [--max-events 30]
//
// Kalshi needs no key. SportsGameOdds is skipped (and says so) when SGO_KEY is not set.
// Files: <out>/<YYYY-MM-DD>/<HHMM>Z/kalshi_<SERIES>.json and sgo_<LEAGUE>.json, plus manifest.json.
// Raw fields are kept as the APIs return them, so nothing is lost if a field name is not what was expected.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
export const SGO = "https://api.sportsgameodds.com/v2";
export const SERIES = {
  NBA: ["KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT"],
  NFL: ["KXNFLPASSYDS", "KXNFLRSHYDS", "KXNFLRECYDS", "KXNFLREC", "KXNFLRSHATT"],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every open market of one Kalshi series, all pages, raw. */
export async function fetchKalshiSeries(series, fetchFn = fetch, wait = 250) {
  const markets = []; let cursor = "", pages = 0;
  do {
    const url = `${KALSHI}/markets?series_ticker=${series}&status=open&limit=1000` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`Kalshi ${series} page ${pages + 1}: HTTP ${r.status}`);
    const j = await r.json();
    markets.push(...(j.markets || []));
    cursor = j.cursor || ""; pages++;
    if (cursor) await sleep(wait);
  } while (cursor && pages < 50);
  return { series, pages, count: markets.length, markets };
}

/** Player-prop odds of one SportsGameOdds event, trimmed to the fields that matter but otherwise raw. */
export function trimEvent(e) {
  const props = [];
  for (const [oddID, o] of Object.entries(e.odds || {})) {
    if (!o.playerID) continue;
    props.push({ oddID, playerID: o.playerID, statID: o.statID, betTypeID: o.betTypeID, periodID: o.periodID, sideID: o.sideID,
      bookOdds: o.bookOdds, bookOverUnder: o.bookOverUnder, fairOdds: o.fairOdds, fairOverUnder: o.fairOverUnder, byBookmaker: o.byBookmaker || {} });
  }
  return { eventID: e.eventID, startsAt: e.status && e.status.startsAt, teams: e.teams && { away: e.teams.away && e.teams.away.names, home: e.teams.home && e.teams.home.names },
    players: e.players || {}, props };
}

/** Upcoming events with odds for one league, following the cursor, never more than maxEvents. */
export async function fetchSgoLeague(league, key, { fetchFn = fetch, maxEvents = 30, wait = 7000, hoursAhead = 48 } = {}) {
  const events = []; let cursor = "", calls = 0;
  const now = new Date(), until = new Date(now.getTime() + hoursAhead * 3600e3);
  do {
    const url = `${SGO}/events?leagueID=${league}&oddsAvailable=true&startsAfter=${now.toISOString()}&startsBefore=${until.toISOString()}&limit=${Math.min(10, maxEvents - events.length)}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetchFn(url, { headers: { "x-api-key": key } });
    calls++;
    if (r.status === 429) { await sleep(65000); continue; }
    if (!r.ok) throw new Error(`SportsGameOdds ${league}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const e of j.data || []) events.push(trimEvent(e));
    cursor = j.nextCursor || "";
    if (cursor && events.length < maxEvents) await sleep(wait);
  } while (cursor && events.length < maxEvents && calls < 20);
  return { league, calls, count: events.length, events };
}

export async function sgoUsage(key, fetchFn = fetch) {
  try { const r = await fetchFn(`${SGO}/account/usage`, { headers: { "x-api-key": key } }); return { status: r.status, body: (await r.text()).slice(0, 800) }; }
  catch (e) { return { error: String(e) }; }
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const leagues = arg("--leagues", "NBA,NFL").split(",").map((s) => s.trim().toUpperCase()).filter((l) => SERIES[l]);
  const outRoot = arg("--out", "snapshots"), maxEvents = Number(arg("--max-events", 30));
  const t = new Date(), dir = path.join(outRoot, t.toISOString().slice(0, 10), t.toISOString().slice(11, 16).replace(":", "") + "Z");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { takenAt: t.toISOString(), kalshi: {}, sgo: {}, errors: [] };
  for (const league of leagues) for (const s of SERIES[league]) {
    try { const k = await fetchKalshiSeries(s, fetchFn); fs.writeFileSync(path.join(dir, `kalshi_${s}.json`), JSON.stringify(k)); manifest.kalshi[s] = { markets: k.count, pages: k.pages }; }
    catch (e) { manifest.errors.push(String(e.message || e)); }
  }
  const key = env.SGO_KEY;
  if (!key) manifest.sgo = { skipped: "SGO_KEY not set" };
  else {
    manifest.sgo.usageBefore = await sgoUsage(key, fetchFn);
    for (const league of leagues) {
      try { const g = await fetchSgoLeague(league, key, { fetchFn, maxEvents }); fs.writeFileSync(path.join(dir, `sgo_${league}.json`), JSON.stringify(g));
        manifest.sgo[league] = { events: g.count, calls: g.calls, propOdds: g.events.reduce((a, e) => a + e.props.length, 0) }; }
      catch (e) { manifest.errors.push(String(e.message || e)); }
    }
    manifest.sgo.usageAfter = await sgoUsage(key, fetchFn);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify(manifest, null, 1));
  return { dir, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(({ manifest }) => process.exit(manifest.errors.length ? 1 : 0));
