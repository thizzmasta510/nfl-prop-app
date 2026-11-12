// node test/nfl_opportunity.test.mjs
import assert from "node:assert/strict";
import { VOL_SIZE, gammaQ, nbPmf, nflRole, nflOpportunityProjection, nflProbAtLeast, nflOppIndex, decorateNflOpportunity, prevTotalsFromAverages,
  NFL_PRIORS, NFL_OPP_CFG, NFL_FLAG_RULES } from "../src/nfl_opportunity.js";
import { normalizeName } from "../src/model.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// --- gamma tail: Q(1, x) = e^-x, Q(2, x) = (1 + x) e^-x
close(gammaQ(1, 0.7), Math.exp(-0.7), 1e-9); close(gammaQ(2, 3), 4 * Math.exp(-3), 1e-9); close(gammaQ(10, 15), 0.06985366069940167, 1e-7);
assert.equal(gammaQ(3, 0), 1);

// --- negative binomial pmf: sums to 1, right mean and variance
{
  const p = nbPmf(8, 12); let s = 0, m = 0, v = 0;
  p.forEach((q, x) => { s += q; m += x * q; }); p.forEach((q, x) => { v += (x - m) ** 2 * q; });
  close(s, 1, 1e-6); close(m, 8, 1e-4); close(v, 8 + 64 / 12, 1e-3);
}

// --- role from volume
const wr = (o = {}) => ({ targets: 8, receptions: 5, receiving_yards: 60, carries: 0, rushing_yards: 0, attempts: 0, completions: 0, passing_yards: 0, ...o });
const rb = (o = {}) => ({ targets: 3, receptions: 2, receiving_yards: 12, carries: 16, rushing_yards: 70, attempts: 0, completions: 0, passing_yards: 0, ...o });
const qb = (o = {}) => ({ targets: 0, receptions: 0, receiving_yards: 0, carries: 4, rushing_yards: 20, attempts: 34, completions: 22, passing_yards: 240, ...o });
assert.equal(nflRole([wr()]), "REC"); assert.equal(nflRole([rb()]), "RB"); assert.equal(nflRole([qb()]), "QB");

// --- volume and regressed rate
{
  const g = [wr({ targets: 10, receiving_yards: 120 }), wr({ targets: 6, receiving_yards: 40 })];   // newest first
  const o = nflOpportunityProjection(g, "receiving_yards");
  close(o.volume, (10 + 0.85 * 6) / 1.85);
  const pr = NFL_PRIORS.REC.targets.receiving_yards;
  close(o.rate, (160 + pr.k * pr.rate) / (16 + pr.k));
  close(o.mean, o.volume * o.rate);
  // last season counts: 2 games of volume, 70% of its efficiency sample
  const prev = { games: 17, targets: 17 * 5, receptions: 50, receiving_yards: 17 * 5 * 9, carries: 0, rushing_yards: 0, attempts: 0, completions: 0, passing_yards: 0 };
  const o2 = nflOpportunityProjection(g, "receiving_yards", prev);
  close(o2.volume, (10 + 0.85 * 6 + NFL_OPP_CFG.prevVolGames * 5) / (1.85 + NFL_OPP_CFG.prevVolGames));
  close(o2.rate, (160 + 0.7 * 765 + pr.k * pr.rate) / (16 + 0.7 * 85 + pr.k));
  assert.equal(nflOpportunityProjection(g, "receiving_yards", { ...prev, games: 3 }).volume, o.volume);   // under 4 games: ignored
  assert.equal(nflOpportunityProjection([], "receptions"), null);
  assert.equal(nflOpportunityProjection(g, "passing_tds"), null);
}

// --- distributions: probabilities fall as the rung rises; the mixture mean matches; quantiles ordered
for (const [stat, games] of [["receptions", [wr(), wr(), wr()]], ["receiving_yards", [wr(), wr(), wr()]], ["carries", [rb(), rb()]],
  ["rushing_yards", [rb(), rb(), rb()]], ["passing_yards", [qb(), qb(), qb()]]]) {
  const o = nflOpportunityProjection(games, stat);
  assert.equal(nflProbAtLeast(0, o), 1);
  let prev = 1;
  for (let k = 1; k < o.mean * 3; k += Math.max(1, Math.round(o.mean / 20))) { const p = nflProbAtLeast(k, o); assert.ok(p <= prev + 1e-9, `${stat} ${k}`); prev = p; }
  assert.ok(o.floor <= o.median && o.median <= o.ceiling, stat);
  if (stat === "receptions" || stat === "carries") {   // discrete: E[X] = sum P(X >= k)
    let e = 0; for (let k = 1; k < 80; k++) e += nflProbAtLeast(k, o);
    close(e, o.mean, 0.02);
  }
  const pMed = nflProbAtLeast(o.median + 1, o);
  assert.ok(pMed <= 0.5 + 1e-9, `${stat} median`);
}

// --- hot / cold: last 3 games well below / above what the volume is worth, with volume steady
{
  const base = Array.from({ length: 6 }, () => wr());
  const cold = [wr({ receiving_yards: 20 }), wr({ receiving_yards: 25 }), wr({ receiving_yards: 30 }), ...base];
  assert.equal(nflOpportunityProjection(cold, "receiving_yards").flag, "below");
  const hot = [wr({ receiving_yards: 130 }), wr({ receiving_yards: 110 }), wr({ receiving_yards: 100 }), ...base];
  assert.equal(nflOpportunityProjection(hot, "receiving_yards").flag, "above");
  // same bad results but targets fell: not "cold" (the volume left, not the luck)
  const lessVol = [wr({ targets: 4, receiving_yards: 20 }), wr({ targets: 4, receiving_yards: 25 }), wr({ targets: 4, receiving_yards: 30 }), ...base];
  assert.equal(nflOpportunityProjection(lessVol, "receiving_yards").flag, null);
  assert.equal(nflOpportunityProjection(cold, "carries"), null);   // no carries at all: no projection
  assert.equal(nflOpportunityProjection([rb({ carries: 30 }), rb(), rb(), rb(), rb(), rb()], "carries").flag, null);   // no flags on volume-only markets
  assert.deepEqual([NFL_FLAG_RULES.games, NFL_FLAG_RULES.below, NFL_FLAG_RULES.above, NFL_FLAG_RULES.steadyVolume], [3, 0.75, 1.3, 0.9]);
}

// --- app wiring: trend logs index and the Matrix decorator
{
  const trend = { season: 2026, priorSeason: { "ann catcher": { games: 10, targets: 6, receptions: 4, receiving_yards: 50 } },
    players: [1, 2, 3].map((w) => ({ name: "Ann Catcher", team: "AAA", season: 2026, week: w, stats: wr({ receiving_yards: 50 + w }) }))
      .concat([{ name: "Ann Catcher", team: "AAA", season: 2025, week: 5, stats: wr() }]) };
  const idx = nflOppIndex(trend, normalizeName);
  const p = idx.get("ann catcher");
  assert.deepEqual(p.games.map((g) => g.week), [3, 2, 1]);
  assert.deepEqual(p.prev, prevTotalsFromAverages(trend.priorSeason["ann catcher"]));
  close(p.prev.receiving_yards, 500);
  const grid = { rows: [{ norm: "ann catcher", line: 55.5 }, { norm: "nobody", line: null }] };
  decorateNflOpportunity(grid, trend, { stat: "receiving_yards", normalize: normalizeName });
  const o = grid.rows[0].opportunity;
  close(o.pOver + o.pUnder, 1, 1e-9); assert.equal(o.volLabel, "targets"); assert.equal(grid.rows[1].opportunity, null);
  const g2 = { rows: [{ norm: "ann catcher", line: 5.5 }] };
  decorateNflOpportunity(g2, trend, { stat: "targets", normalize: normalizeName });
  assert.equal(g2.rows[0].opportunity, undefined);   // targets market: not projected
}
// --- parameters pinned (measured on 2021-2024; changing them must change this test)
assert.deepEqual(NFL_OPP_CFG, { decay: 0.85, prevVolGames: 2, prevMinGames: 4, prevEffWeight: 0.7, volPseudo: 8 });
assert.deepEqual(VOL_SIZE, { QB: { attempts: 12, carries: 6 }, RB: { carries: 4, targets: 6 }, REC: { targets: 12, carries: 2, attempts: 1 } });
assert.deepEqual(Object.fromEntries(Object.entries(NFL_PRIORS).map(([role, v]) => [role, Object.fromEntries(Object.entries(v).map(([vol, e]) =>
  [vol, Object.fromEntries(Object.entries(e).map(([k, x]) => [k, [x.rate, x.k]]))]))])), {
  QB: { carries: { rushing_yards: [4.56, 26] }, attempts: { passing_yards: [7.10, 200] } },
  RB: { carries: { rushing_yards: [4.31, 115] }, targets: { receptions: [0.780, 121], receiving_yards: [5.76, 78] } },
  REC: { carries: { rushing_yards: [4.89, 27] }, targets: { receptions: [0.656, 55], receiving_yards: [7.78, 87] }, attempts: { passing_yards: [6.0, 16] } } });
console.log("nfl opportunity tests passed");
