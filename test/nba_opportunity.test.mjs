// node test/nba_opportunity.test.mjs
import assert from "node:assert/strict";
import { scoringCorrection, currentCorrection, opportunityMean, CORRECTION, FLAG_RULES, opportunityLogs, opportunityProjection, regressedEfficiency, volumeVsResults, nbQuantile, efficiencyIndex,
  oppProbAtLeast, LEAGUE, PRIOR_K, FT_WEIGHT } from "../src/nba_opportunity.js";
import { probAtLeast } from "../src/nba_model.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const day = (i) => new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
// newest first: game 0 is the most recent
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ date: day(60 - i), team: "AAA", minutes: 34, ...f(i) }));

// --- opportunityLogs: shot fields required, preseason and future games dropped, newest first
{
  const rows = [
    { name: "Ann Shooter", team: "AAA", date: "2026-10-25", stats: { minutes: 30, points: 20, threes: 2, fga: 15, fta: 4, fg3a: 6 } },
    { name: "Ann Shooter", team: "BBB", date: "2026-10-28", stats: { minutes: 32, points: 25, threes: 3, fga: 18, fta: 6, fg3a: 7 } },
    { name: "Ann Shooter", team: "BBB", date: "2026-10-29", stats: { minutes: 32, points: 25, threes: 3, fga: 18, fta: 6, fg3a: 7 } },  // on/after cut
    { name: "Ann Shooter", team: "AAA", date: "2026-10-10", seasonType: "Preseason", stats: { minutes: 30, points: 9, threes: 1, fga: 9, fta: 0, fg3a: 3 } },
    { name: "Old Log", team: "CCC", date: "2026-10-20", stats: { minutes: 30, points: 20, threes: 2 } },   // no fga: skipped
  ];
  const logs = opportunityLogs(rows, { beforeDate: "2026-10-29" });
  assert.equal(logs.size, 1);
  const p = logs.get("ann shooter");
  assert.deepEqual(p.games.map((g) => g.date), ["2026-10-28", "2026-10-25"]);
  assert.equal(p.team, "BBB");
}

// --- efficiency regresses toward the league with the stated prior weight
{
  const g = mk(10, () => ({ points: 30, threes: 5, fga: 20, fta: 0, fg3a: 10 }));
  const e = regressedEfficiency(g, "points");
  close(e.raw, 1.5); close(e.value, (300 + PRIOR_K.pps * LEAGUE.pps) / (200 + PRIOR_K.pps));
  const t = regressedEfficiency(g, "threes");
  close(t.raw, 0.5); close(t.value, (50 + PRIOR_K.fg3pct * LEAGUE.fg3pct) / (100 + PRIOR_K.fg3pct));
  // season totals win when they cover more shots
  const tot = { pts: 1200, fga: 900, fta: 200, fg3m: 100, fg3a: 300 };
  close(regressedEfficiency(g, "points", LEAGUE, { totals: tot }).value, (1200 + PRIOR_K.pps * LEAGUE.pps) / (900 + FT_WEIGHT * 200 + PRIOR_K.pps));
}

// --- the projection: minutes x volume x regressed efficiency; same volume, hot vs cold shooting
{
  const steady = (pts) => mk(20, () => ({ points: pts, threes: 2, fga: 18, fta: 5, fg3a: 7 }));
  const hot = opportunityProjection(steady(32), "points"), cold = opportunityProjection(steady(14), "points");
  const sp = 18 + FT_WEIGHT * 5;
  close(hot.mean, 34 * (sp / 34) * hot.efficiency, 1e-9);
  // same shots: the regressed means are far closer than the raw 32 vs 14
  assert.ok(hot.mean - cold.mean < 0.8 * (32 - 14), `${hot.mean} ${cold.mean}`);
  assert.ok(hot.mean < hot.baseMean && cold.mean > cold.baseMean);   // both pulled toward the league
  assert.ok(hot.floor <= hot.median && hot.median <= hot.ceiling);
  close(oppProbAtLeast(25, hot), probAtLeast(25, hot.mean, hot.dispersion));
  assert.equal(opportunityProjection(steady(20).slice(0, 4), "points"), null);
  assert.equal(opportunityProjection(steady(20), "rebounds"), null);
}

// --- quantiles match the CDF
{
  const m = 22, d = 2.5;
  for (const q of [0.1, 0.5, 0.9]) {
    const k = nbQuantile(q, m, d);
    assert.ok(1 - probAtLeast(k + 1, m, d, { clamp: false }) >= q);
    assert.ok(k === 0 || 1 - probAtLeast(k, m, d, { clamp: false }) < q);
  }
}

// --- volume vs results flags
{
  const base = (i) => ({ points: 22, threes: 2, fga: 18, fta: 5, fg3a: 7 });
  const coldG = mk(20, (i) => (i < 5 ? { ...base(i), points: 12 } : base(i)));
  const eff = regressedEfficiency(coldG, "points").value;
  assert.equal(volumeVsResults(coldG, "points", eff).flag, "below");
  // the same bad results with shots falling (last 5 below 0.95 x games 6-20) is not "below": the shots aren't there
  const fewerShots = mk(20, (i) => (i < 5 ? { ...base(i), points: 12, fga: 16 } : base(i)));
  const fv = volumeVsResults(fewerShots, "points", eff);
  assert.ok(fv.volumeTrend < 0.95 && fv.volumeTrend > 0.8, String(fv.volumeTrend)); assert.equal(fv.flag, null);
  // fixed fixture -> fixed numbers (guards against silent threshold edits)
  const cv = volumeVsResults(coldG, "points", eff);
  close(cv.ratio, 60 / (5 * (18 + FT_WEIGHT * 5) * eff)); close(cv.volumeTrend, 1);
  const hotG = mk(20, (i) => (i < 5 ? { ...base(i), points: 34 } : base(i)));
  assert.equal(volumeVsResults(hotG, "points", regressedEfficiency(hotG, "points").value).flag, "above");
  const roleUp = mk(20, (i) => (i < 5 ? { points: 28, threes: 2, fga: 24, fta: 6, fg3a: 8 } : base(i)));
  const vr = volumeVsResults(roleUp, "points", 28 / (24 + FT_WEIGHT * 6));   // results match volume
  assert.equal(vr.flag, "role-up"); assert.ok(vr.volumeTrend > 1.25);
  assert.equal(volumeVsResults(mk(8, base), "points", 1.1).flag, null);   // too few games
}

// --- efficiencyIndex normalizes names and drops incomplete totals
{
  const idx = efficiencyIndex({ efficiency: { "Luka Dončić": { games: 30, pts: 900, fga: 600, fta: 250, fg3m: 100, fg3a: 290 }, "Bad Row": { pts: 1 } } });
  assert.equal(idx.size, 1); assert.ok(idx.get("luka doncic"));
}
// --- scoring correction: actual vs projected over the last 14 days, shrunk by 600 games x 11 points
{
  // 30 players, 25 games each, one every 2 days ending 2026-11-02; steady volume and efficiency,
  // then the last 7 games (14 days) score 20% below what the shots were worth
  const logs = new Map();
  for (let p = 0; p < 30; p++) {
    const games = Array.from({ length: 25 }, (_, i) => {
      const date = new Date(Date.parse("2026-11-02T00:00:00Z") - i * 2 * 864e5).toISOString().slice(0, 10);
      return { date, minutes: 30, fga: 15, fta: 4, fg3a: 6, threes: 2, points: i < 7 ? 16 : 20 };
    });
    logs.set("p" + p, { games });
  }
  const c = scoringCorrection(logs, "points", "2026-11-03");
  // by hand: games inside [Oct 20, Nov 3) with 10+ earlier games
  let y = 0, m = 0, n = 0;
  for (const { games } of logs.values()) games.forEach((g, i) => {
    if (g.date >= "2026-10-20" && g.date < "2026-11-03" && games.length - i - 1 >= 10) { y += g.points; m += opportunityMean(games.slice(i + 1, i + 21), "points"); n++; }
  });
  const K = CORRECTION.priorGames * CORRECTION.typicalMean.points;
  assert.equal(c.games, n); close(c.factor, (y + K) / (m + K));
  assert.ok(c.factor < 1 && c.factor > 0.8, String(c.factor));
  assert.equal(scoringCorrection(logs, "threes", "2026-11-03").factor, 1);          // points only
  assert.equal(scoringCorrection(logs, "points", "2026-06-01").factor, 1);          // nothing in the window
  // no same-day leakage: games on the as-of date (an earlier tip that night) never count
  const sameDay = new Map([...logs].map(([k, v]) => [k, { games: [{ ...v.games[0], date: "2026-11-03", points: 99 }, ...v.games] }]));
  const cs = scoringCorrection(sameDay, "points", "2026-11-03");
  assert.equal(cs.games, c.games); close(cs.factor, c.factor);
  // parameters pinned: changing them must change this test
  assert.deepEqual(CORRECTION, { stats: ["points"], windowDays: 14, minPrior: 10, priorGames: 600, typicalMean: { points: 11, threes: 1.2 } });
  const cur = currentCorrection(logs, "points");
  assert.equal(cur.asOf, "2026-11-03"); close(cur.factor, c.factor);
  // applied to the mean, nothing else
  const g = logs.get("p0").games;
  const a = opportunityProjection(g, "points"), b = opportunityProjection(g, "points", 1, { scoringAdj: c.factor });
  close(b.mean, a.mean * c.factor); assert.equal(b.minutes, a.minutes);
}

// --- flag blend option: off by default; when set, keeps that share of last-5 efficiency
{
  const base = () => ({ points: 22, threes: 2, fga: 18, fta: 5, fg3a: 7 });
  const coldG = mk(20, (i) => (i < 5 ? { ...base(), points: 12 } : base()));
  const off = opportunityProjection(coldG, "points"), on = opportunityProjection(coldG, "points", 1, { flagBlend: { below: 0.25 } });
  assert.equal(off.volume.flag, "below");
  const recent = 12 / (18 + FT_WEIGHT * 5);
  close(on.efficiency, 0.25 * recent + 0.75 * off.efficiency); assert.ok(on.mean < off.mean);
}

assert.deepEqual([FLAG_RULES.below, FLAG_RULES.above, FLAG_RULES.steadyVolume, FLAG_RULES.roleUp, FLAG_RULES.roleDown], [0.85, 1.15, 0.95, 1.25, 0.8]);
console.log("nba opportunity tests passed");
