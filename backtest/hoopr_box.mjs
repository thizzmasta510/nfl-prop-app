// Build the box score file for nba_opportunity_backtest.mjs from hoopR's public
// player box scores (github.com/sportsdataverse/hoopR-nba-data, player_box parquet).
//
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/sportsdataverse/hoopR-nba-data
//   cd hoopR-nba-data && git sparse-checkout set nba/player_box/parquet && cd ..
//   node backtest/hoopr_box.mjs hoopR-nba-data/nba/player_box/parquet/player_box_2026.parquet \
//        hoopR-nba-data/nba/player_box/parquet/player_box_2027.parquet --out backtest/nba_box.json
//
// (hoopR names seasons by the year they end: 2026 = 2025-26.) Needs Node 22+ for zstd.
import fs from "node:fs";
import { readParquet } from "./parquet_lite.mjs";
const args = process.argv.slice(2);
const oi = args.indexOf("--out"); const out = oi >= 0 ? args[oi + 1] : "backtest/nba_box.json";
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--out"));
const COLS = ["game_id", "season", "season_type", "game_date", "athlete_id", "athlete_display_name", "team_abbreviation",
  "opponent_team_abbreviation", "minutes", "field_goals_made", "field_goals_attempted", "three_point_field_goals_made",
  "three_point_field_goals_attempted", "free_throws_made", "free_throws_attempted", "offensive_rebounds", "defensive_rebounds",
  "rebounds", "assists", "turnovers", "points", "starter", "did_not_play", "athlete_position_abbreviation", "home_away"];
const rows = [];
for (const f of files) {
  const { numRows, cols } = readParquet(f, COLS);
  for (const c of COLS) if ((cols[c] || []).length !== numRows) throw new Error(`${f} ${c}: ${(cols[c] || []).length} vs ${numRows}`);
  for (let i = 0; i < numRows; i++) { const r = {}; for (const c of COLS) r[c] = cols[c][i]; r.date = new Date(r.game_date * 86400000).toISOString().slice(0, 10); rows.push(r); }
}
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} rows -> ${out}`);
