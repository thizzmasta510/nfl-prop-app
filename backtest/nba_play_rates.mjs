// How often players with each injury-report status actually played.
//
//   node backtest/nba_play_rates.mjs nba-injury-history.json nba-history.json
//
// nba-injury-history.json: the last pre-tip status per player per game date
// (written by compute_nba_injuries.py). The second file is any NBA game-log file
// (nba-trend-logs.json works for recent dates; nba-history.json covers everything).
// A status counts only when that team's game is in the logs (teamGames), so a
// missing box score is not mistaken for "did not play".
// Use the rates printed here to replace PLAY_PROBABILITY in src/nba_injuries.js.
import fs from "node:fs";
import { normalizeName } from "../src/model.js";
import { PLAY_PROBABILITY } from "../src/nba_injuries.js";

const [histFile, logsFile] = process.argv.slice(2);
if (!histFile || !logsFile) { console.log("usage: node backtest/nba_play_rates.mjs nba-injury-history.json nba-history.json"); process.exit(1); }
const hist = JSON.parse(fs.readFileSync(histFile, "utf8"));
const logs = JSON.parse(fs.readFileSync(logsFile, "utf8"));
const played = new Set(), teamPlayed = new Set();
for (const r of logs.players || []) if (Number(r.stats && r.stats.minutes) > 0) played.add(`${r.date}|${r.norm || normalizeName(r.name)}`);
for (const g of logs.teamGames || []) teamPlayed.add(`${g.d}|${g.t}`);
const tally = {};
for (const [date, players] of Object.entries(hist.days || {})) {
  for (const [key, e] of Object.entries(players)) {
    const [norm, team] = key.split("|");
    if (!teamPlayed.has(`${date}|${team}`)) continue;          // game not in the logs
    const t = (tally[e.status] ||= { n: 0, played: 0 });
    t.n++; if (played.has(`${date}|${norm}`)) t.played++;
  }
}
console.log("status         n    played   rate    (now assumed)");
for (const s of ["Available", "Probable", "Questionable", "Doubtful", "Out"]) {
  const t = tally[s]; if (!t) continue;
  const rate = t.played / t.n, se = Math.sqrt(rate * (1 - rate) / t.n);
  console.log(`${s.padEnd(13)} ${String(t.n).padStart(5)} ${String(t.played).padStart(8)}   ${(100 * rate).toFixed(1).padStart(5)}%  +/-${(196 * se).toFixed(1)}  (${(100 * PLAY_PROBABILITY[s]).toFixed(0)}%)`);
}
if (!Object.keys(tally).length) console.log("No overlapping dates yet: the history needs a few game days of injury reports first.");
