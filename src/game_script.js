// Game script: how a player's output moves with his team's point spread and
// implied team total, relative to the games already in his log.
//
// Fitted (backtest/fit_game_script.py) on 2021-2025 regular-season player games
// with nflverse closing lines. Setup mirrors live use: baseline = mean of the
// player's previous games that season (3+), and spread / implied total are
// measured against the average over those same games, because the game log
// already reflects the scripts he has played in.
//
//   factor = 1 + spread * dSpread + implied * dImplied      (capped at +/-10%)
//   dSpread  = this game's spread - log average   (spread > 0 = his team favored)
//   dImplied = this game's implied team total - log average
//   implied team total = (game total + spread) / 2
//
// Out-of-sample (fit 2021-2024, scored on 2025), squared projection error fell
// 1.6% for passing yards, 0.5% for rushing yards and receptions, 0.2% for
// receiving yards. Rush attempts got WORSE out of sample, so carries get no
// adjustment. These are small, real effects: game script moves a projection a
// few percent, not a lot.
export const GAME_SCRIPT = {
  passing_yards:   { spread: -0.0090, implied: 0.0276 },
  rushing_yards:   { spread:  0.0098, implied: 0.0028 },
  receptions:      { spread: -0.0085, implied: 0.0166 },
  receiving_yards: { spread: -0.0093, implied: 0.0233 },
  carries:         { spread: 0, implied: 0 },
};
export const GAME_SCRIPT_CAP = 0.10;

const PROP_TO_STAT = [
  [/rush.*rec|rec.*rush|combined/i, null],   // rush + rec yards: not fitted
  [/pass/i, "passing_yards"],
  [/rush.*(att|carr)|carries/i, "carries"],
  [/rush/i, "rushing_yards"],
  [/recep|catches/i, "receptions"],
  [/rec/i, "receiving_yards"],
];
export function statForPropType(propType) {
  const s = String(propType || "");
  for (const [re, stat] of PROP_TO_STAT) if (re.test(s)) return stat;
  return null;
}

/** Implied team total from the game total and the team's spread (positive = favored). */
export const impliedTotal = (total, spread) => (Number(total) + Number(spread)) / 2;

/**
 * Returns { adj, dSpread, dImplied, source } or null when the lines are missing.
 * input: { spread, total, avgSpread, avgImplied } (spread from the player's team's
 * side, positive = favored). Missing log averages fall back to neutral (0 spread,
 * league-average implied total 22.5), which is less accurate for teams that are
 * always big favorites or big underdogs.
 */
export function gameScriptAdj(stat, input) {
  const c = GAME_SCRIPT[stat];
  if (!c || !input) return null;
  const spread = Number(input.spread), total = Number(input.total);
  if (!Number.isFinite(spread) || !Number.isFinite(total) || total <= 0) return null;
  const implied = impliedTotal(total, spread);
  const haveLog = Number.isFinite(Number(input.avgSpread)) && Number.isFinite(Number(input.avgImplied));
  const dSpread = spread - (haveLog ? Number(input.avgSpread) : 0);
  const dImplied = implied - (haveLog ? Number(input.avgImplied) : 22.5);
  const raw = c.spread * dSpread + c.implied * dImplied;
  const adj = Math.max(-GAME_SCRIPT_CAP, Math.min(GAME_SCRIPT_CAP, raw));
  return { adj, dSpread, dImplied, implied, source: haveLog ? "vs his games so far" : "vs league average" };
}
