#!/usr/bin/env node
/**
 * Prints each player's per-game averages for a chosen season, straight from
 * the historical file, so they can be used as the priorYrBaseline the model
 * regresses recent form toward.
 *
 * WHY THIS EXISTS
 * The model can only regress a small sample toward a stable prior if it HAS
 * one. Typing last season's average for every player by hand is the step
 * nobody keeps up, and without it projections rest on two or three games and
 * overshoot. This pulls the numbers from data already in the repo.
 *
 * USAGE
 *   node backtest/prior_baselines.mjs --data backtest/player-stats-history.json \
 *        --players "Chris Olave,Lamar Jackson,Josh Allen" [--season 2025]
 *
 * --season is the season to AVERAGE (default: the latest full season in the
 * file, which is the right choice for the current year's priors).
 *
 * LIMITS, stated plainly:
 * - Regular season only (weeks 1-18).
 * - The source has a row for a player-week only when he recorded some stat, so
 *   a game he played without recording anything is missing and the average is
 *   slightly high for low-volume players. Negligible for starters.
 * - Matching is by normalized name. Two players sharing a name are merged, and
 *   a player whose name changed would be missed. Games played is shown so an
 *   implausible count is easy to spot.
 */
import fs from "node:fs";
import { normalizeName } from "../src/model.js";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const DATA = arg("data");
const PLAYERS = arg("players");
if (!DATA || !PLAYERS) {
  console.error('Required: --data <history json> --players "Name One,Name Two"');
  console.error("Optional: --season <year>   --minGames <n>");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
const rows = raw.players || [];
if (!rows.length) { console.error("No player rows in that file."); process.exit(1); }

const seasons = [...new Set(rows.map((r) => r.season))].filter((s) => s !== undefined).sort((a, b) => a - b);
// Default: the latest season that has a full year of data (18 weeks present),
// so a season only a few weeks old is not mistaken for last year's baseline.
const weeksBySeason = new Map();
for (const r of rows) {
  if (!weeksBySeason.has(r.season)) weeksBySeason.set(r.season, new Set());
  weeksBySeason.get(r.season).add(Number(r.week));
}
const fullSeasons = seasons.filter((s) => (weeksBySeason.get(s) || new Set()).size >= 17);
const SEASON = Number(arg("season", fullSeasons[fullSeasons.length - 1]));
const MIN_GAMES = Number(arg("minGames", 6));

console.log(`Averaging season ${SEASON} (seasons in file: ${seasons.join(", ")}; full seasons: ${fullSeasons.join(", ")})`);

const STATS = [
  ["passing_yards", "PassYds"], ["passing_tds", "PassTD"],
  ["rushing_yards", "RushYds"], ["carries", "Carries"],
  ["receiving_yards", "RecYds"], ["receptions", "Rec"], ["targets", "Tgts"],
];

const wanted = PLAYERS.split(",").map((s) => s.trim()).filter(Boolean);
const header = ["Player".padEnd(22), "Team".padEnd(5), "G".padStart(3), ...STATS.map(([, l]) => l.padStart(8))].join(" ");
console.log("\n" + header);
console.log("-".repeat(header.length));

for (const name of wanted) {
  const norm = normalizeName(name);
  const games = rows.filter((r) => r.season === SEASON && Number(r.week) <= 18 && (r.norm || normalizeName(r.name)) === norm);
  if (!games.length) {
    console.log(`${name.padEnd(22)} NOT FOUND for ${SEASON} (rookie, name mismatch, or missed the season)`);
    continue;
  }
  const team = games[games.length - 1].team || "";
  const cells = STATS.map(([key]) => {
    const vals = games.map((g) => g.stats[key]).filter((v) => v !== undefined);
    if (!vals.length) return "-".padStart(8);
    return (vals.reduce((a, b) => a + b, 0) / games.length).toFixed(1).padStart(8);
  });
  const flag = games.length < MIN_GAMES ? "  <-- few games, weak baseline" : "";
  console.log([name.padEnd(22), team.padEnd(5), String(games.length).padStart(3), ...cells].join(" ") + flag);
}
console.log("\nUse the matching stat column as priorYrBaseline for that prop type.");
