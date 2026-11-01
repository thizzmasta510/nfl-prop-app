// node test/game_script.test.mjs
import assert from "node:assert/strict";
import { gameScriptAdj, statForPropType, impliedTotal, GAME_SCRIPT_CAP } from "../src/game_script.js";
import { scoreProp } from "../src/model.js";

assert.equal(statForPropType("Rushing Yards"), "rushing_yards");
assert.equal(statForPropType("Rush Attempts"), "carries");
assert.equal(statForPropType("Receptions"), "receptions");
assert.equal(statForPropType("Receiving Yards"), "receiving_yards");
assert.equal(statForPropType("Passing Yards"), "passing_yards");
assert.equal(statForPropType("Rush + Rec Yards"), null);
assert.equal(impliedTotal(44, 4), 24);

// Favorite runs more, underdog throws more (same total, measured vs neutral).
const fav = gameScriptAdj("rushing_yards", { spread: 7, total: 44, avgSpread: 0, avgImplied: 22 });
const dog = gameScriptAdj("rushing_yards", { spread: -7, total: 44, avgSpread: 0, avgImplied: 22 });
assert.ok(fav.adj > 0 && dog.adj < 0, "rushing up as favorite, down as underdog");
const passDog = gameScriptAdj("passing_yards", { spread: -7, total: 44, avgSpread: 0, avgImplied: 22 });
const passHighTotal = gameScriptAdj("passing_yards", { spread: 0, total: 54, avgSpread: 0, avgImplied: 22 });
assert.ok(passHighTotal.adj > 0, "high team total adds passing");
assert.ok(Number.isFinite(passDog.adj));
// Relative to his own log: a team that is always -7 gets no bump for being -7 again.
const same = gameScriptAdj("rushing_yards", { spread: 7, total: 44, avgSpread: 7, avgImplied: 25.5 });
assert.ok(Math.abs(same.adj) < 1e-9);
// Cap and carries
assert.equal(gameScriptAdj("passing_yards", { spread: 0, total: 80, avgSpread: 0, avgImplied: 20 }).adj, GAME_SCRIPT_CAP);
assert.equal(gameScriptAdj("carries", { spread: 10, total: 44 }).adj, 0);
// Missing lines -> null, and scoreProp is unchanged.
assert.equal(gameScriptAdj("rushing_yards", { spread: undefined, total: 44 }), null);
const base = { week: 8, propType: "Rushing Yards", line: 59.5, gameLog: [70, 62, 80, 55, 66], injuryStatus: "Healthy", roleVolumeScore: 5 };
const a = scoreProp(base);
const b = scoreProp({ ...base, teamSpread: 9, gameTotal: 45, logAvgSpread: -1, logAvgImplied: 21 });
const c = scoreProp({ ...base, teamSpread: -9, gameTotal: 45, logAvgSpread: -1, logAvgImplied: 21 });
assert.equal(a.gameScriptAdj, 0); assert.equal(a.gameScriptSource, "no lines");
assert.ok(b.finalProjection > a.finalProjection && c.finalProjection < a.finalProjection);
assert.ok(b.pOver > a.pOver && c.pOver < a.pOver);
console.log("game script tests passed");
