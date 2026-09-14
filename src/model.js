// ============================================================
// NFL Player Prop Model, v9 (accuracy overhaul)
//
// Changes from v8, and the reasoning for each:
//
// 1. DISTRIBUTION BRANCHING. v8 used a normal distribution for every prop.
//    That is defensible for 208.5 passing yards and wrong for 4.5 receptions
//    or 0.5 touchdowns, where outcomes are non-negative integers with real
//    skew. v9 uses a negative binomial for count props (receptions, carries,
//    completions), Poisson for touchdown props, and normal only for yardage.
//
// 2. INJURY AS A MIXTURE, NOT A HAIRCUT. v8 multiplied the projection by 0.95
//    for Questionable. No player produces 95% of normal; they either play
//    close to full or they do not play. v9 models P(plays) explicitly:
//    P(over) = P(plays) x P(over | plays). This barely moves the central
//    projection but substantially changes the probability, which is the
//    output that actually matters.
//
// 3. VARIANCE IS COMPUTED, NOT GUESSED. v8's probability output depended
//    entirely on a hand-typed standard deviation, making it the weakest link
//    in the model. v9 computes it from a supplied game log using exponentially
//    weighted variance, shrunk toward a stat-specific prior via empirical
//    Bayes. Falls back to stat-specific coefficients of variation rather than
//    one global "35-45%" rule.
//
// 4. BIAS REDUCTION. Two subjective 1-10 fields (Coach Volume, Scheme Fit)
//    collapsed into one, since in practice they moved together and inflated
//    the apparent rigor of a single signal. Usage Trend cut from +/-15% to
//    +/-7% and redefined to cover only information not already visible in the
//    stat line, because at +/-15% a subjective field carried the same weight
//    as the data-driven matchup adjustment and double-counted recent form.
//
// 5. SCHEDULE NORMALIZATION. v8 applied a matchup adjustment on top of a
//    baseline that already embedded whatever defenses the player happened to
//    face. v9 optionally removes that embedded effect first so the two do not
//    compound.
//
// 6. REMOVED: the scheme *direction* nudge from v8. The magnitude-based
//    confidence discount is retained because it is well-motivated, but a
//    +/-5% directional push off under-center rate is close to noise at the
//    individual player level. Cutting it is a deliberate reduction in
//    apparent sophistication in exchange for less unjustified movement.
//
// Every constant below is a judgment call, not a fitted parameter. The model
// is internally principled; whether it is *accurate* is an empirical question
// that only the calibration tracking can answer.
// ============================================================

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }
function isNum(v) { return v !== undefined && v !== null && v !== "" && !isNaN(Number(v)); }
function num(v, fallback) { return isNum(v) ? Number(v) : fallback; }

// ---------- distribution primitives ----------

// Abramowitz & Stegun 7.1.26 erf approximation, accurate to ~1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(x, mean, sd) {
  if (!(sd > 0)) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

// Lanczos approximation for log-gamma, needed for the negative binomial with
// non-integer dispersion parameter r.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7
];
function logGamma(z) {
  if (z < 0.5) {
    // reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function logFactorial(n) { return logGamma(n + 1); }

function poissonPmf(k, lambda) {
  if (!(lambda > 0)) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}
function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  if (!(lambda > 0)) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return clamp(sum, 0, 1);
}

// Negative binomial in mean/variance parameterization. Requires variance >
// mean (overdispersion); falls back to Poisson when the data are not
// overdispersed, since the negative binomial is undefined there.
function negBinomPmf(k, mean, variance) {
  if (!(mean > 0)) return k === 0 ? 1 : 0;
  if (!(variance > mean)) return poissonPmf(k, mean);
  const r = (mean * mean) / (variance - mean);
  const p = mean / variance;
  return Math.exp(
    logGamma(k + r) - logGamma(r) - logFactorial(k)
    + r * Math.log(p) + k * Math.log(1 - p)
  );
}
function negBinomCdf(k, mean, variance) {
  if (k < 0) return 0;
  if (!(variance > mean)) return poissonCdf(k, mean);
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += negBinomPmf(i, mean, variance);
  return clamp(sum, 0, 1);
}

// ---------- prop classification ----------

// Touchdown props are low-count and near-Poisson. Other counting props
// (receptions, carries, completions, attempts) are overdispersed counts.
// Yardage is continuous enough for a normal approximation.
function classifyProp(propType, line) {
  const t = String(propType || "").toLowerCase();
  // Matches "TD", "TDs", "touchdown", "touchdowns", "Anytime TD", etc.
  // Note the plural: a \btd\b pattern silently fails on "Rush TDs" because
  // the trailing s is a word character, which misroutes TD props to the
  // count branch.
  if (/\btds?\b|touchdowns?/.test(t)) return "td";
  if (/reception|catch|completion|attempt|carr|target|tackle|assist/.test(t)) return "count";
  if (/yd|yard/.test(t)) return "yardage";
  // Unlabeled: infer from the line. Small lines are almost always counts.
  return line >= 40 ? "yardage" : "count";
}

// Stat-specific coefficient of variation (std dev / mean) used as the prior
// when no game log is supplied. v8 used a single "35-45% of the mean" rule for
// everything, which overstates variance for high-volume QB stats and
// understates it for low-volume boom/bust receiving roles.
function priorCv(propType, kind) {
  const t = String(propType || "").toLowerCase();
  if (/pass/.test(t) && /yd|yard/.test(t)) return 0.25;
  if (/rush/.test(t) && /yd|yard/.test(t)) return 0.45;
  if (/rec/.test(t) && /yd|yard/.test(t)) return 0.50;
  if (/reception|catch|target/.test(t)) return 0.35;
  if (/carr|attempt/.test(t)) return 0.30;
  if (/completion/.test(t)) return 0.20;
  if (kind === "yardage") return 0.40;
  return 0.35;
}

// ---------- variance estimation ----------

// Exponentially weighted mean and variance over a game log, most recent first.
// Decay of 0.85 gives the most recent game roughly 3x the weight of a game
// five outings back, a smoother and better-motivated treatment of recency than
// v8's hard 60/40 split between "last 3" and "season average".
const DECAY = 0.85;
function weightedMoments(log) {
  let wSum = 0, wxSum = 0;
  for (let i = 0; i < log.length; i++) {
    const w = Math.pow(DECAY, i);
    wSum += w; wxSum += w * log[i];
  }
  const mean = wxSum / wSum;
  let wv = 0;
  for (let i = 0; i < log.length; i++) {
    const w = Math.pow(DECAY, i);
    wv += w * Math.pow(log[i] - mean, 2);
  }
  // Bias correction for weighted variance with effective sample size.
  const variance = log.length > 1 ? (wv / wSum) * (log.length / (log.length - 1)) : 0;
  return { mean, variance };
}

// Empirical Bayes shrinkage of an observed variance toward a prior variance.
// SHRINK_K is the number of "pseudo-observations" the prior is worth; at 5,
// a 5-game log splits weight evenly between observed and prior. Variance
// estimates are noisier than mean estimates, so this shrinks harder than a
// mean estimate would.
const SHRINK_K = 5;
function shrinkVariance(observedVar, priorVar, n) {
  if (!(n > 1)) return priorVar;
  return (n * observedVar + SHRINK_K * priorVar) / (n + SHRINK_K);
}

// ---------- probability of clearing the line ----------

// Returns { pOver, pUnder, pPush } for the conditional distribution (i.e.
// assuming the player takes the field). Handles integer lines, where a push
// is possible on count props, instead of silently treating them as half-lines.
function lineProbabilities(kind, line, mean, sd) {
  const variance = sd * sd;

  if (kind === "yardage") {
    const pUnder = normalCdf(line, mean, sd);
    return { pOver: 1 - pUnder, pUnder, pPush: 0 };
  }

  // Count and td props are integer-valued.
  const isHalfLine = Math.abs(line - Math.floor(line) - 0.5) < 1e-9;
  const cdfAt = (k) => kind === "td"
    ? poissonCdf(k, mean)
    : negBinomCdf(k, mean, variance);

  if (isHalfLine) {
    const k = Math.floor(line); // e.g. line 4.5 -> P(X <= 4)
    const pUnder = cdfAt(k);
    return { pOver: 1 - pUnder, pUnder, pPush: 0 };
  }

  // Integer line: push is possible.
  const k = Math.round(line);
  const pAtOrBelow = cdfAt(k);
  const pBelow = cdfAt(k - 1);
  const pPush = clamp(pAtOrBelow - pBelow, 0, 1);
  return { pOver: clamp(1 - pAtOrBelow, 0, 1), pUnder: clamp(pBelow, 0, 1), pPush };
}

// ---------- probability a player takes the field ----------

// A flat percentage haircut models an outcome that does not occur. A
// Questionable player does not produce 95% of normal; he plays close to full
// or not at all. These are rough base rates, held deliberately coarse rather
// than given false precision.
function playProbability(status) {
  switch (String(status || "Healthy")) {
    case "Out": return 0;
    case "Doubtful": return 0.25;
    case "Questionable": return 0.75;
    default: return 1;
  }
}

// ============================================================
// Main scoring function
// ============================================================

function scoreProp(p) {
  const week = num(p.week, 1);
  const line = num(p.line, NaN);
  const kind = classifyProp(p.propType, line);

  // ---- 1. Baseline central projection ----
  // Preferred: exponentially weighted game log. Fallback: the v8-style blend
  // of last-3 and season average, retained so existing saved props still score.
  const gameLog = parseGameLog(p.gameLog);
  let baseMean, observedVar = null, logN = 0;

  if (gameLog.length >= 2) {
    const m = weightedMoments(gameLog);
    baseMean = m.mean;
    observedVar = m.variance;
    logN = gameLog.length;
  } else if (isNum(p.last3) || isNum(p.seasonAvg)) {
    const last3 = num(p.last3, num(p.seasonAvg, 0));
    const seasonAvg = num(p.seasonAvg, last3);
    baseMean = 0.6 * last3 + 0.4 * seasonAvg;
  } else {
    // No player data at all: fall back to the market line as a neutral prior.
    baseMean = line;
  }

  // ---- 2. Prior-year scheme-role blend, fading through Week 5 ----
  const priorYrWeight = clamp(0.35 - (week - 1) * 0.09, 0, 0.35);
  const priorYrBaseline = isNum(p.priorYrBaseline) ? Number(p.priorYrBaseline) : null;
  let blendedMean = (priorYrBaseline !== null)
    ? (1 - priorYrWeight) * baseMean + priorYrWeight * priorYrBaseline
    : baseMean;

  // ---- 3. Schedule normalization ----
  // Strip out the matchup effect already embedded in the baseline, so that
  // applying this week's matchup adjustment does not compound with whatever
  // defenses the player happened to have faced.
  const avgOppFaced = isNum(p.avgOppDefEpaFaced) ? Number(p.avgOppDefEpaFaced) : null;
  let scheduleNormAdj = 0;
  if (avgOppFaced !== null) {
    scheduleNormAdj = -clamp((avgOppFaced / 0.15) * 0.15, -0.15, 0.15);
    blendedMean = blendedMean * (1 + scheduleNormAdj);
  }

  // ---- 4. Multiplicative adjustments ----
  const isRush = /rush/i.test(p.propType || "");

  // Matchup: prefer EPA allowed per play over a 1-32 rank, since a rank
  // discards magnitude (ranks 31 and 32 may be far apart or nearly identical).
  let matchupAdj = 0;
  if (isNum(p.oppDefEpaPerPlay)) {
    matchupAdj = clamp((Number(p.oppDefEpaPerPlay) / 0.15) * 0.15, -0.15, 0.15);
  } else if (isNum(p.oppDefRank)) {
    matchupAdj = ((Number(p.oppDefRank) - 16) / 16) * 0.15;
  }

  // Weather: dome neutralizes. Bad weather suppresses passing and receiving
  // and modestly favors rushing volume.
  let weatherAdj = 0;
  if (String(p.dome || "N").toUpperCase() !== "Y") {
    const bad = num(p.wind, 0) > 15 || String(p.precip || "N").toUpperCase() === "Y";
    if (bad) weatherAdj = isRush ? 0.03 : -0.08;
  }

  // Role/scheme: one subjective 1-10 field instead of v8's two correlated
  // fields. Discounted when the play caller changed, scaled by how large the
  // scheme shift was when a numeric shift is supplied.
  const roleVolume = num(p.roleVolumeScore, avgOfLegacyRoleFields(p));
  let roleAdj = (roleVolume / 10 - 0.5) * 0.2;
  const schemeShift = isNum(p.schemeShift) ? Number(p.schemeShift) : null;
  if (schemeShift !== null) {
    roleAdj *= 1 - Math.min(Math.abs(schemeShift) / 40, 0.5);
  } else if (String(p.ocContinuity || "Y").toUpperCase() === "N") {
    roleAdj *= 0.5;
  }

  // Usage trend: capped at +/-7% (was +/-15%). Intended only for information
  // not yet reflected in the game log, e.g. a teammate placed on IR this week.
  // Anything already visible in recent production is double-counted here.
  const usageAdj = clamp(num(p.usageTrend, 0), -0.07, 0.07);

  // Pressure rate allowed, passing props only. League average ~25%.
  let pressureAdj = 0;
  if (/pass/i.test(p.propType || "") && isNum(p.pressureRateAllowed)) {
    pressureAdj = clamp(-((Number(p.pressureRateAllowed) - 0.25) / 0.25) * 0.10, -0.10, 0.10);
  }

  // Red zone share, touchdown props only. ~20% is a typical lead role.
  let redZoneAdj = 0;
  if (kind === "td" && isNum(p.redZoneShare)) {
    redZoneAdj = clamp(((Number(p.redZoneShare) - 0.20) / 0.20) * 0.15, -0.15, 0.15);
  }

  const totalAdj = clamp(
    matchupAdj + weatherAdj + roleAdj + usageAdj + pressureAdj + redZoneAdj,
    -0.5, 0.5
  );

  // Conditional projection: what the player produces GIVEN he plays. Injury is
  // handled separately as a play probability, not folded in here.
  const conditionalProjection = Math.max(0, blendedMean * (1 + totalAdj));

  // ---- 5. Variance estimation ----
  const cv = priorCv(p.propType, kind);
  const priorVar = Math.pow(conditionalProjection * cv, 2);
  let variance;
  let varianceSource;

  if (isNum(p.stdDev)) {
    variance = Math.pow(Number(p.stdDev), 2);
    varianceSource = "manual override";
  } else if (observedVar !== null) {
    // Rescale observed variance to the adjusted mean so the coefficient of
    // variation is preserved, then shrink toward the stat-specific prior.
    const scale = baseMean > 0 ? conditionalProjection / baseMean : 1;
    const scaledObserved = observedVar * scale * scale;
    variance = shrinkVariance(scaledObserved, priorVar, logN);
    varianceSource = `game log (n=${logN}, shrunk toward prior`;
    varianceSource += `, CV prior ${cv})`;
  } else {
    variance = priorVar;
    varianceSource = `stat-type prior (CV ${cv})`;
  }

  // For count distributions, variance must exceed the mean for the negative
  // binomial to be defined. Nudge it up slightly rather than silently
  // collapsing to Poisson on a stat that is genuinely overdispersed.
  if (kind === "count" && variance <= conditionalProjection) {
    variance = conditionalProjection * 1.05;
  }
  let sd = Math.sqrt(Math.max(variance, 1e-9));

  // A Poisson distribution is fully determined by its mean, so the computed
  // standard deviation plays no part in a touchdown prop's probability.
  // Reporting one anyway would imply an input that is not being used, so the
  // reported value is replaced by the distribution's own sqrt(lambda).
  if (kind === "td") {
    sd = Math.sqrt(conditionalProjection);
    varianceSource = "unused: Poisson is determined by its mean (sd = sqrt of mean)";
  }

  // ---- 6. Probability ----
  const pPlays = playProbability(p.injuryStatus);
  const cond = isNaN(line)
    ? { pOver: NaN, pUnder: NaN, pPush: 0 }
    : lineProbabilities(kind, line, conditionalProjection, sd);

  // If the player does not play, the stat is 0, which is under any positive
  // line. So the unconditional over probability is scaled by P(plays), and the
  // leftover mass falls to the under.
  const pOver = pPlays * cond.pOver;
  const pPush = pPlays * cond.pPush;
  const pUnder = 1 - pOver - pPush;

  // Expected value accounting for the chance he does not play, reported
  // alongside the conditional projection rather than replacing it.
  const expectedValue = pPlays * conditionalProjection;

  const edge = conditionalProjection - line;
  const edgePct = line !== 0 && !isNaN(line) ? edge / line : null;
  const lean = pOver >= pUnder ? "OVER" : "UNDER";
  const leanProb = Math.max(pOver, pUnder);

  // ---- 7. Confidence ----
  // Probability-based, with a small-sample cap. Thresholds are judgment calls,
  // not fitted values; calibration tracking is what validates them.
  let confidence;
  if (isNaN(leanProb)) confidence = "";
  else if (leanProb >= 0.62) confidence = "High";
  else if (leanProb >= 0.56) confidence = "Medium";
  else confidence = "Low";

  const effectiveN = logN > 0 ? logN : num(p.gamesPlayed, 0);
  if (confidence === "High" && effectiveN < 3) confidence = "Medium";
  // A projection resting entirely on the market line carries no independent
  // information, so it should never present as a confident edge.
  if (gameLog.length < 2 && !isNum(p.last3) && !isNum(p.seasonAvg)) confidence = "Low";

  return {
    ...p,
    kind,
    baseMean: round1(baseMean),
    priorYrWeight: round3(priorYrWeight),
    blendedMean: round1(blendedMean),
    scheduleNormAdj: round3(scheduleNormAdj),
    matchupAdj: round3(matchupAdj),
    weatherAdj: round3(weatherAdj),
    roleAdj: round3(roleAdj),
    usageAdj: round3(usageAdj),
    pressureAdj: round3(pressureAdj),
    redZoneAdj: round3(redZoneAdj),
    totalAdj: round3(totalAdj),
    finalProjection: round1(conditionalProjection),
    expectedValue: round1(expectedValue),
    playProbability: round3(pPlays),
    sd: round1(sd),
    varianceSource,
    edge: round1(edge),
    edgePct: edgePct !== null ? round3(edgePct) : null,
    pOver: isNaN(pOver) ? null : round3(pOver),
    // Taken as the residual of the two rounded values so the three displayed
    // probabilities always sum to exactly 1. Rounding each independently can
    // produce a total of 1.001, which reads as a bug even though the
    // underlying math is exact.
    pUnder: isNaN(pUnder) ? null : round3(1 - round3(pOver) - round3(pPush)),
    pPush: round3(pPush),
    lean,
    leanProb: isNaN(leanProb) ? null : round3(leanProb),
    confidence,
  };
}

// Accepts "12, 45, 33" or [12,45,33]. Most recent game first.
function parseGameLog(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((x) => !isNaN(x));
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(/[,\s]+/).map(Number).filter((x) => !isNaN(x));
  }
  return [];
}

// Backward compatibility: v8 stored two correlated 1-10 fields. Average them
// if a v9 single score is absent, so previously saved props still score.
function avgOfLegacyRoleFields(p) {
  const a = isNum(p.coachVol) ? Number(p.coachVol) : null;
  const b = isNum(p.schemeFit) ? Number(p.schemeFit) : null;
  if (a !== null && b !== null) return (a + b) / 2;
  if (a !== null) return a;
  if (b !== null) return b;
  return 5;
}

// Rank within each team by probability of the leaned side. v8 ranked by
// absolute edge % here while the Top Picks list ranked by probability, so the
// two views could disagree. Both now use probability, which is the output that
// actually accounts for variance.
function rankByTeam(scored) {
  const byTeam = {};
  for (const p of scored) {
    if (!byTeam[p.team]) byTeam[p.team] = [];
    byTeam[p.team].push(p);
  }
  for (const team of Object.keys(byTeam)) {
    byTeam[team].sort((a, b) => (b.leanProb ?? 0) - (a.leanProb ?? 0));
    byTeam[team].forEach((p, i) => { p.teamRank = i + 1; });
  }
  return scored;
}

// ============================================================
// Calibration scoring for the validation tracker
//
// Hit rate alone cannot tell you whether the probabilities mean anything. A
// model can win 58% of its picks while claiming 75% confidence, which makes
// the numbers useless for sizing. Calibration compares claimed probability to
// observed frequency in buckets; Brier score summarizes it in one number
// (lower is better, 0.25 is what you get by always saying 50%).
// ============================================================

function calibration(entries) {
  const graded = entries.filter(
    (e) => isNum(e.claimedProb) && (e.result === "HIT" || e.result === "MISS")
  );
  if (!graded.length) return { n: 0, brier: null, buckets: [], baseline: 0.25 };

  let brierSum = 0;
  const buckets = [
    { lo: 0.50, hi: 0.56, label: "50-56%" },
    { lo: 0.56, hi: 0.62, label: "56-62%" },
    { lo: 0.62, hi: 0.70, label: "62-70%" },
    { lo: 0.70, hi: 1.01, label: "70%+" },
  ].map((b) => ({ ...b, n: 0, hits: 0, claimedSum: 0 }));

  for (const e of graded) {
    const q = Number(e.claimedProb);
    const outcome = e.result === "HIT" ? 1 : 0;
    brierSum += Math.pow(q - outcome, 2);
    const b = buckets.find((x) => q >= x.lo && q < x.hi);
    if (b) { b.n++; b.hits += outcome; b.claimedSum += q; }
  }

  return {
    n: graded.length,
    brier: round3(brierSum / graded.length),
    baseline: 0.25,
    buckets: buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        label: b.label,
        n: b.n,
        claimed: round3(b.claimedSum / b.n),
        actual: round3(b.hits / b.n),
        gap: round3(b.hits / b.n - b.claimedSum / b.n),
      })),
  };
}

// ============================================================
// Automatic result grading
//
// Maps a prop type to the stat key published by the GitHub Action, then
// matches a logged pick to a player-week row.
//
// The governing rule here is that a wrong match is far worse than no match.
// A silently mismatched name produces a plausible-looking `actual` value, which
// then corrupts both the hit rate and the calibration numbers without any
// visible symptom. So every ambiguous or unfound case is returned as an
// explicit flag for manual review rather than resolved by a best guess.
// ============================================================

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Must mirror normalize_name() in github-action/compute_player_stats.py.
// If these two drift apart, matching silently degrades.
function normalizeName(name) {
  if (typeof name !== "string") return "";
  let s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[.'\u2019`]/g, "");
  s = s.replace(/[-_]/g, " ");
  s = s.replace(/[^a-z0-9 ]/g, "");
  const parts = s.split(/\s+/).filter((p) => p && !SUFFIXES.has(p));
  return parts.join(" ");
}

function shortKey(name) {
  const n = normalizeName(name);
  const parts = n.split(" ");
  if (parts.length < 2) return n;
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

// Prop-type string to published stat key. Order matters: the combined
// rush+rec market must be tested before the individual yardage markets,
// since its label contains both words.
function propTypeToStatKey(propType) {
  const t = String(propType || "").toLowerCase();
  const isTd = /\btds?\b|touchdowns?/.test(t);

  if (/rush.*rec|rec.*rush|rush\s*\+\s*rec|scrimmage/.test(t) && /yd|yard/.test(t)) {
    return "rush_rec_yards";
  }
  if (/pass/.test(t)) {
    if (isTd) return "passing_tds";
    if (/yd|yard/.test(t)) return "passing_yards";
    if (/completion/.test(t)) return "completions";
    if (/attempt/.test(t)) return "attempts";
    if (/int/.test(t)) return "interceptions";
  }
  if (/rush/.test(t)) {
    if (isTd) return "rushing_tds";
    if (/yd|yard/.test(t)) return "rushing_yards";
    if (/carr|attempt/.test(t)) return "carries";
  }
  if (/rec/.test(t)) {
    if (isTd) return "receiving_tds";
    if (/yd|yard/.test(t)) return "receiving_yards";
    if (/reception|catch/.test(t)) return "receptions";
  }
  if (/reception|catch/.test(t)) return "receptions";
  if (/target/.test(t)) return "targets";
  if (/completion/.test(t)) return "completions";
  if (/carr/.test(t)) return "carries";
  // "Anytime TD" with no rush/rec/pass qualifier is ambiguous by nature; it
  // could be satisfied by either a rushing or receiving score, so it is not
  // auto-gradeable from a single stat column.
  return null;
}

// Attempts to resolve one tracker entry against the published stat rows.
// Returns { status, value?, matchedName?, reason? } where status is one of
// "matched" | "ambiguous" | "no_match" | "no_stat_key" | "missing_week".
function matchPlayerStat(entry, rows) {
  const statKey = propTypeToStatKey(entry.propType);
  if (!statKey) {
    return { status: "no_stat_key", reason: `prop type "${entry.propType || ""}" has no single stat column` };
  }
  if (!isNum(entry.week)) {
    return { status: "missing_week", reason: "no week recorded on this pick" };
  }

  const week = Number(entry.week);
  const norm = normalizeName(entry.player);
  const team = String(entry.team || "").toUpperCase();

  const inWeek = rows.filter((r) => Number(r.week) === week);
  if (!inWeek.length) {
    return { status: "missing_week", reason: `no published stats for week ${week} yet` };
  }

  // Tier 1: exact normalized name, and team when one was recorded. Team is
  // the guard against same-surname collisions.
  let hits = inWeek.filter((r) => r.norm === norm && (!team || r.team === team));

  // Tier 2: exact normalized name, ignoring team. Covers mid-season trades
  // where the logged team code is stale.
  if (!hits.length) hits = inWeek.filter((r) => r.norm === norm);

  // Tier 3: first initial plus surname, team required. Deliberately the last
  // resort, since this is where false positives come from.
  if (!hits.length && team) {
    const sk = shortKey(entry.player);
    hits = inWeek.filter((r) => r.short === sk && r.team === team);
  }

  if (!hits.length) {
    return { status: "no_match", reason: `no week ${week} row for "${entry.player}"` };
  }
  if (hits.length > 1) {
    return {
      status: "ambiguous",
      reason: `${hits.length} players matched "${entry.player}" in week ${week}: ` +
              hits.map((h) => `${h.name} (${h.team})`).join(", "),
    };
  }

  const row = hits[0];
  const value = row.stats ? row.stats[statKey] : undefined;
  if (value === undefined || value === null) {
    return { status: "no_match", reason: `${row.name} has no ${statKey} recorded for week ${week}` };
  }
  return { status: "matched", value, matchedName: row.name, statKey };
}

export {
  scoreProp, rankByTeam, calibration,
  normalCdf, poissonCdf, negBinomCdf, logGamma, classifyProp, lineProbabilities,
  normalizeName, shortKey, propTypeToStatKey, matchPlayerStat,
};

// ============================================================
// Game correlation
//
// Picks from the same game are not independent outcomes. A 34-3 blowout kills
// the losing side's rushing props and the winning side's passing props
// together. Two consequences worth surfacing rather than hiding:
//
//   1. Calibration will look worse than the model deserves, because
//      correlated misses arrive in clusters and inflate apparent variance.
//   2. Parlay math across same-game legs is badly wrong under an independence
//      assumption. Multiplying two 60% legs from one game does not give 36%;
//      for positively correlated legs the true figure is higher, for
//      negatively correlated legs lower, and either way it is not the product.
//
// This does not estimate a correlation matrix, which would need far more data
// than is available here. It identifies the exposure so it can be seen.
// ============================================================

// Order-independent game key, so BAL vs IND and IND vs BAL collapse to one id.
function gameKey(entry) {
  const team = String(entry.team || "").toUpperCase().trim();
  const opp = String(entry.opponent || "").toUpperCase().trim();
  const week = isNum(entry.week) ? Number(entry.week) : null;
  if (!team || !opp || week === null) return null;
  const [a, b] = [team, opp].sort();
  return `W${week}-${a}@${b}`;
}

function statFamily(propType) {
  const t = String(propType || "").toLowerCase();
  return /rush|carr/.test(t) ? "rush" : "pass";
}

// Groups scored props by game and labels the likely correlation direction
// between each pick and the others sharing its game.
//
// Same team and same stat family tends positive (two Ravens receivers both
// benefit from a pass-heavy script). Opposing teams in the same family, or
// rush against pass within a team, tend negative (a blowout pushes the leader
// to run and the trailer to pass).
function annotateCorrelation(scored) {
  const groups = {};
  for (const p of scored) {
    const k = gameKey(p);
    if (!k) continue;
    (groups[k] = groups[k] || []).push(p);
  }
  for (const [key, picks] of Object.entries(groups)) {
    if (picks.length < 2) continue;
    for (const p of picks) {
      p.gameKey = key;
      p.gameLegCount = picks.length;
      p.correlatedWith = picks
        .filter((o) => o !== p)
        .map((o) => {
          const sameTeam = String(o.team || "") === String(p.team || "");
          const sameFamily = statFamily(o.propType) === statFamily(p.propType);
          let direction;
          if (sameTeam && sameFamily) direction = "positive";
          else if (!sameTeam && sameFamily) direction = "negative";
          else direction = "mixed";
          return { player: o.player, propType: o.propType, direction };
        });
    }
  }
  return scored;
}

// ============================================================
// Bet economics
//
// Hit rate alone is misleading: 55% at -130 loses money while 52% at +100
// wins. Without price and stake there is no way to tell a profitable process
// from an unprofitable one.
// ============================================================

// American odds to profit on a winning stake of 1 unit.
function oddsToProfit(americanOdds) {
  const o = Number(americanOdds);
  if (!isFinite(o) || o === 0) return null;
  return o > 0 ? o / 100 : 100 / Math.abs(o);
}

// The win rate at which a given price breaks even. Comparing this to the
// observed hit rate is the actual test of whether picks are priced well.
function breakEvenRate(americanOdds) {
  const profit = oddsToProfit(americanOdds);
  if (profit === null) return null;
  return 1 / (1 + profit);
}

// Summarizes realized performance over graded, actually-played entries.
// Picks logged but not backed are excluded from ROI (they had no stake) while
// still counting toward model accuracy elsewhere, which is what lets model
// skill be separated from bet-selection judgment.
function betPerformance(entries) {
  const played = entries.filter(
    (e) => String(e.played || "").toUpperCase() === "Y" &&
           (e.result === "HIT" || e.result === "MISS" || e.result === "PUSH")
  );
  let staked = 0, profit = 0, graded = 0, hits = 0, priced = 0, beSum = 0;

  for (const e of played) {
    const stake = isNum(e.stake) ? Number(e.stake) : 1;
    const p = oddsToProfit(e.odds);
    if (e.result === "PUSH") { continue; } // stake returned, no effect
    graded++;
    if (e.result === "HIT") hits++;
    staked += stake;
    if (p === null) continue;             // unpriced: counts for record, not ROI
    priced++;
    const be = breakEvenRate(e.odds);
    if (be !== null) beSum += be;
    profit += e.result === "HIT" ? stake * p : -stake;
  }

  return {
    playedCount: played.length,
    gradedCount: graded,
    hitRate: graded ? round3(hits / graded) : null,
    unitsStaked: round1(staked),
    unitsProfit: round1(profit),
    roi: staked > 0 && priced > 0 ? round3(profit / staked) : null,
    pricedCount: priced,
    avgBreakEvenRate: priced ? round3(beSum / priced) : null,
  };
}

// Predictive CDF for a scored prop, exposed for backtesting. Returns
// P(outcome <= x) under the model's own distribution choice, which is what the
// probability integral transform needs.
function predictiveCdf(x, kind, mean, sd) {
  if (kind === "yardage") return normalCdf(x, mean, sd);
  if (kind === "td") return poissonCdf(Math.floor(x), mean);
  return negBinomCdf(Math.floor(x), mean, sd * sd);
}

export {
  gameKey, annotateCorrelation, statFamily,
  oddsToProfit, breakEvenRate, betPerformance, predictiveCdf,
};
