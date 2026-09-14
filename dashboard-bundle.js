// ==== Bundled single-file Worker ====

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

const PROPS_KEY = "props.json";
const TRACKER_KEY = "tracker.json";
const STATS_KEY = "weekly-stats.json";
const PLAYER_STATS_KEY = "player-stats.json";
const MAX_BODY_BYTES = 20_000; // generous for one form submission, blocks payload abuse
const MAX_ARRAY_LEN = 2000; // hard ceiling on stored records, blocks storage-fill abuse
const MAX_STRING_LEN = 200;

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin || "null",
      "x-content-type-options": "nosniff",
    },
  });
}

function corsOrigin(request, env) {
  // If ALLOWED_ORIGIN is set, only that origin gets CORS access. Otherwise,
  // reflect the Worker's own origin so the bundled frontend always works,
  // but no arbitrary third-party site can call the API from a browser.
  const selfOrigin = new URL(request.url).origin;
  return env.ALLOWED_ORIGIN || selfOrigin;
}

async function readJson(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return fallback;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return fallback;
  }
}

async function writeJson(bucket, key, data) {
  await bucket.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
  });
}

function checkAuth(request, env) {
  // If no secret is configured, the app is open (fine for pure local/dev use,
  // NOT recommended once deployed live). Set one with `wrangler secret put APP_SECRET`.
  if (!env.APP_SECRET) return true;
  const provided = request.headers.get("x-app-secret") || "";
  return timingSafeEqual(provided, env.APP_SECRET);
}

// Avoids leaking secret length/content via response-time side channels.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Whitelist-based validation: only known fields survive, strings are length-
// capped, and free text can never contain executable markup. This is what
// actually stops stored-XSS and storage-abuse, not the frontend escaping alone.
function sanitizeRecord(body, allowedFields) {
  const clean = {};
  for (const key of allowedFields) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (typeof v === "string") {
      v = v.slice(0, MAX_STRING_LEN);
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
    } else {
      continue; // reject nested objects/arrays/booleans-as-non-string, etc.
    }
    clean[key] = v;
  }
  return clean;
}

const PROP_FIELDS = ["id","week","team","player","pos","propType","line","opponent",
  "oppDefRank","wind","precip","dome","coachVol","schemeFit","last3","seasonAvg",
  "usageTrend","injuryStatus","ocContinuity","priorYrBaseline","gamesPlayed","stdDev",
  "pressureRateAllowed","redZoneShare","schemeShift","oppDefEpaPerPlay",
  // v9 additions. coachVol/schemeFit and last3/seasonAvg are retained above so
  // props saved under v8 still score.
  "gameLog","roleVolumeScore","avgOppDefEpaFaced"];

// claimedProb records the probability the model asserted at pick time, which
// is what makes calibration measurable after the fact. Without it you can only
// ever compute a hit rate, which cannot tell you whether the probabilities mean
// anything.
const TRACKER_FIELDS = ["id","week","player","team","propType","lean","projection",
  "openingLine","closingLine","actual","confidence","notes","claimedProb",
  // v11: separates model accuracy from bet-selection judgment, and makes ROI
  // computable. Hit rate alone is misleading: 55% at -130 loses money.
  "played","odds","stake","opponent"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = corsOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-app-secret",
        },
      });
    }

    // ---- Static frontend ----
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(HTML, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        },
      });
    }

    // Body-size guard on every request that can carry one.
    if (["POST", "PUT"].includes(request.method)) {
      const len = Number(request.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413, origin);
    }

    // ---- Props CRUD ----
    if (pathname === "/api/props" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const props = await readJson(env.PROP_DATA, PROPS_KEY, []);
      return json(props, 200, origin);
    }

    if (pathname === "/api/props" && request.method === "POST") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, origin); }
      const clean = sanitizeRecord(body, PROP_FIELDS);
      if (!clean.player || clean.line === undefined) return json({ error: "player and line are required" }, 400, origin);
      const props = await readJson(env.PROP_DATA, PROPS_KEY, []);
      clean.id = clean.id || crypto.randomUUID();
      const idx = props.findIndex((p) => p.id === clean.id);
      if (idx >= 0) props[idx] = clean;
      else {
        if (props.length >= MAX_ARRAY_LEN) return json({ error: "storage limit reached" }, 507, origin);
        props.push(clean);
      }
      await writeJson(env.PROP_DATA, PROPS_KEY, props);
      return json(clean, 200, origin);
    }

    if (pathname.startsWith("/api/props/") && request.method === "DELETE") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const id = pathname.split("/").pop();
      let props = await readJson(env.PROP_DATA, PROPS_KEY, []);
      props = props.filter((p) => p.id !== id);
      await writeJson(env.PROP_DATA, PROPS_KEY, props);
      return json({ deleted: id }, 200, origin);
    }

    // ---- Scored / ranked output ----
    if (pathname === "/api/scored" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const props = await readJson(env.PROP_DATA, PROPS_KEY, []);
      const scored = annotateCorrelation(rankByTeam(props.map(scoreProp)));
      return json(scored, 200, origin);
    }

    if (pathname === "/api/top" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const n = Math.min(50, Math.max(1, Number(url.searchParams.get("n") || 15)));
      const props = await readJson(env.PROP_DATA, PROPS_KEY, []);
      const scored = annotateCorrelation(props.map(scoreProp));
      scored.sort((a, b) => (b.leanProb ?? Math.abs(b.edgePct || 0)) - (a.leanProb ?? Math.abs(a.edgePct || 0)));
      return json(scored.slice(0, n), 200, origin);
    }

    // ---- Validation tracker CRUD ----
    if (pathname === "/api/tracker" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      return json(entries, 200, origin);
    }

    if (pathname === "/api/tracker" && request.method === "POST") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, origin); }
      const clean = sanitizeRecord(body, TRACKER_FIELDS);
      if (!clean.player) return json({ error: "player is required" }, 400, origin);
      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      clean.id = clean.id || crypto.randomUUID();
      const idx = entries.findIndex((e) => e.id === clean.id);
      if (idx >= 0) entries[idx] = clean;
      else {
        if (entries.length >= MAX_ARRAY_LEN) return json({ error: "storage limit reached" }, 507, origin);
        entries.push(clean);
      }
      await writeJson(env.PROP_DATA, TRACKER_KEY, entries);
      return json(clean, 200, origin);
    }

    if (pathname.startsWith("/api/tracker/") && request.method === "DELETE") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const id = pathname.split("/").pop();
      let entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      entries = entries.filter((e) => e.id !== id);
      await writeJson(env.PROP_DATA, TRACKER_KEY, entries);
      return json({ deleted: id }, 200, origin);
    }

    // ---- Calibration: are the claimed probabilities honest? ----
    // Grades the tracker's logged picks server-side so the same scoring logic
    // is used everywhere, rather than reimplementing it in the browser.
    if (pathname === "/api/calibration" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      const graded = entries.map((e) => {
        const gradeLine = isFinite(Number(e.closingLine)) && Number(e.closingLine) !== 0
          ? Number(e.closingLine) : Number(e.openingLine);
        let result = "";
        if (e.actual !== undefined && e.actual !== "" && isFinite(gradeLine)) {
          const a = Number(e.actual);
          if (a === gradeLine) result = "PUSH";
          else if ((e.lean === "OVER" && a > gradeLine) || (e.lean === "UNDER" && a < gradeLine)) result = "HIT";
          else result = "MISS";
        }
        return { ...e, result };
      });
      return json({ ...calibration(graded), bets: betPerformance(graded) }, 200, origin);
    }

    // ---- Export everything, so the only copy is not sitting in one R2 bucket ----
    if (pathname === "/api/export" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const [props, tracker] = await Promise.all([
        readJson(env.PROP_DATA, PROPS_KEY, []),
        readJson(env.PROP_DATA, TRACKER_KEY, []),
      ]);
      const body = JSON.stringify({
        exportedAt: new Date().toISOString(),
        props, tracker,
      }, null, 2);
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="nfl-prop-backup-${new Date().toISOString().slice(0,10)}.json"`,
          "access-control-allow-origin": origin,
        },
      });
    }

    // ---- Auto-grade logged picks against published player stats ----
    // GET  = dry run, reports what it would do and changes nothing.
    // POST = applies the matched results.
    // Only fills entries whose `actual` is still blank, so a value you entered
    // or corrected by hand is never silently overwritten.
    if (pathname === "/api/autograde" && (request.method === "GET" || request.method === "POST")) {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);

      const statsDoc = await readJson(env.PROP_DATA, PLAYER_STATS_KEY, null);
      if (!statsDoc || !Array.isArray(statsDoc.players) || !statsDoc.players.length) {
        return json({
          error: "no player stats available",
          hint: "The GitHub Action publishes player-stats.json and the Worker's cron fetches it. " +
                "Set PLAYER_STATS_URL and either wait for the schedule or POST /api/refresh-stats.",
        }, 503, origin);
      }

      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      const rows = statsDoc.players;
      const applied = [], skipped = [], needsReview = [];

      for (const e of entries) {
        if (e.actual !== undefined && e.actual !== "" && e.actual !== null) {
          skipped.push({ id: e.id, player: e.player, reason: "already has a result" });
          continue;
        }
        const m = matchPlayerStat(e, rows);
        if (m.status === "matched") {
          applied.push({
            id: e.id, player: e.player, matchedName: m.matchedName,
            stat: m.statKey, value: m.value,
          });
          if (request.method === "POST") e.actual = m.value;
        } else {
          // Anything not cleanly matched is surfaced for manual entry rather
          // than resolved by a guess, because a wrong value corrupts the
          // calibration numbers with no visible symptom.
          needsReview.push({ id: e.id, player: e.player, status: m.status, reason: m.reason });
        }
      }

      if (request.method === "POST" && applied.length) {
        await writeJson(env.PROP_DATA, TRACKER_KEY, entries);
      }

      return json({
        mode: request.method === "POST" ? "applied" : "dry-run",
        statsGeneratedAt: statsDoc.generatedAt,
        weeksAvailable: statsDoc.weeksIncluded || [],
        appliedCount: applied.length,
        applied,
        needsReviewCount: needsReview.length,
        needsReview,
        skippedCount: skipped.length,
      }, 200, origin);
    }

    // ---- Manually trigger the stats refresh the cron does on schedule ----
    if (pathname === "/api/refresh-stats" && request.method === "POST") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const result = await refreshExternalStats(env);
      return json(result, result.ok ? 200 : 503, origin);
    }

    // ---- Read-only: latest pre-summarized external stats (pressure/red zone) ----
    if (pathname === "/api/weekly-stats" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const stats = await readJson(env.PROP_DATA, STATS_KEY, null);
      return json(stats, 200, origin);
    }

    return json({ error: "not found" }, 404, origin);
  },

  // Twice-weekly cron: pulls the small pre-summarized JSON your GitHub Action
  // publishes (see /github-action) and stores it in R2. Deliberately does NOT
  // fetch or parse raw play-by-play here, that would blow the Worker's free
  // CPU-time limit. The fetch target is a fixed constant from env, never
  // derived from user input, to avoid any SSRF-style risk.
  async scheduled(event, env, ctx) {
    await refreshExternalStats(env);
  },
};

// Fetches both published feeds and stores them in R2. Shared by the cron
// handler and the manual /api/refresh-stats endpoint so there is one code path.
//
// Both URLs come from configuration and are never derived from a request,
// which rules out server-side request forgery through this path. Each fetch is
// bounded by a timeout so a hung endpoint cannot stall the invocation.
async function refreshExternalStats(env) {
  const feeds = [
    { name: "weekly-stats", url: env.STATS_FEED_URL, key: STATS_KEY },
    { name: "player-stats", url: env.PLAYER_STATS_URL, key: PLAYER_STATS_KEY },
  ];
  const results = [];

  for (const feed of feeds) {
    if (!feed.url) {
      results.push({ feed: feed.name, ok: false, reason: "URL not configured" });
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(feed.url, { signal: controller.signal });
      if (!res.ok) {
        results.push({ feed: feed.name, ok: false, reason: `HTTP ${res.status}` });
        continue;
      }
      const data = await res.json();
      // Shape check before trusting external data, so a malformed or
      // unexpected payload cannot replace good stored data with garbage.
      if (data && typeof data === "object" && Array.isArray(data.players)) {
        await writeJson(env.PROP_DATA, feed.key, data);
        results.push({
          feed: feed.name, ok: true,
          records: data.players.length,
          generatedAt: data.generatedAt || null,
        });
      } else {
        results.push({ feed: feed.name, ok: false, reason: "unexpected payload shape" });
      }
    } catch (err) {
      results.push({ feed: feed.name, ok: false, reason: String(err && err.name || err) });
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: results.some((r) => r.ok), results };
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NFL Player Prop Model</title>
<style>
  :root { --navy:#1F4E78; --bg:#F2F6FA; --line:#BFBFBF; --green:#2E7D32; --red:#B7472A; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin:0; background:#fff; color:#222; }
  header { background: var(--navy); color:#fff; padding:16px 20px; }
  header h1 { margin:0; font-size:20px; }
  header p { margin:4px 0 0; font-size:13px; opacity:.85; }
  nav { display:flex; gap:8px; padding:10px 20px; background:#eef2f6; flex-wrap:wrap; }
  nav button { background:#fff; border:1px solid var(--line); border-radius:6px; padding:8px 14px;
    cursor:pointer; font-size:13px; }
  nav button.active { background: var(--navy); color:#fff; border-color:var(--navy); }
  main { padding: 16px 20px 60px; max-width:1100px; margin:0 auto; }
  section { display:none; }
  section.active { display:block; }
  table { border-collapse: collapse; width:100%; font-size:12.5px; margin-top:10px; }
  th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; }
  th { background: var(--navy); color:#fff; position:sticky; top:0; }
  tr:nth-child(even) { background: var(--bg); }
  .over { color: var(--green); font-weight:bold; }
  .under { color: var(--red); font-weight:bold; }
  form.grid { display:grid; grid-template-columns: repeat(auto-fill,minmax(160px,1fr)); gap:8px; margin-top:10px; }
  form.grid label { font-size:11px; color:#555; display:block; }
  form.grid input, form.grid select { width:100%; padding:5px; font-size:12.5px; border:1px solid var(--line); border-radius:4px; }
  .row-actions button { font-size:11px; padding:3px 8px; margin-right:4px; cursor:pointer; }
  .submit-btn { margin-top:12px; background:var(--navy); color:#fff; border:none; padding:9px 18px;
    border-radius:6px; cursor:pointer; font-size:13px; }
  .hint { font-size:12px; color:#666; margin-top:6px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; color:#fff; }
  .pill.High { background:#2E7D32; }
  .pill.Medium { background:#B7950B; }
  .pill.Low { background:#888; }
  .stat-card { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 14px;
    min-width:130px; text-align:center; }
  .stat-card .num { font-size:20px; font-weight:bold; color:var(--navy); }
  .stat-card .label { font-size:11px; color:#555; margin-top:2px; }
  .stat-card.warn .num { color:var(--red); }
  .stat-card.good .num { color:var(--green); }
  #loginScreen { position:fixed; inset:0; background:#fff; z-index:999; display:flex;
    align-items:center; justify-content:center; flex-direction:column; gap:12px; padding:20px; }
  #loginScreen input { padding:10px; font-size:15px; border:1px solid var(--line); border-radius:6px; width:240px; }
  #loginScreen button { padding:10px 20px; background:var(--navy); color:#fff; border:none;
    border-radius:6px; font-size:15px; cursor:pointer; }
  #loginError { color:var(--red); font-size:13px; min-height:18px; }
  #appRoot { display:none; }
</style>
</head>
<body>
<div id="loginScreen">
  <h2 style="margin:0; color:#1F4E78;">NFL Player Prop Model</h2>
  <p style="margin:0; color:#555; font-size:13px;">Enter password to continue (leave blank if none was set)</p>
  <input type="password" id="loginInput" placeholder="Password">
  <button id="loginBtn">Enter</button>
  <div id="loginError"></div>
</div>
<div id="appRoot">
<header>
  <h1>NFL Player Prop Model</h1>
  <p>Weighted projections, probability of Over/Under, and a live results tracker. Backed by Cloudflare R2.</p>
</header>
<nav>
  <button data-tab="input" class="active">Add / Edit Prop</button>
  <button data-tab="scored">All Scored Props</button>
  <button data-tab="top">Top Picks</button>
  <button data-tab="tracker">Validation Tracker</button>
</nav>
<main>

  <section id="input" class="active">
    <h2>Weekly Input</h2>
    <p class="hint">Fill in what you know. Leave Games Played / Est. Std Dev blank if unsure; the model falls back gracefully.</p>
    <form class="grid" id="propForm">
      <div><label>Week</label><input name="week" type="number" value="1" required></div>
      <div><label>Team</label><input name="team" placeholder="KC" required></div>
      <div><label>Player</label><input name="player" placeholder="Travis Kelce" required></div>
      <div><label>Pos</label><input name="pos" placeholder="TE"></div>
      <div><label>Prop Type</label><input name="propType" placeholder="Receptions"></div>
      <div><label>Sportsbook Line</label><input name="line" type="number" step="0.5" required></div>
      <div><label>Opponent</label><input name="opponent" placeholder="DEN"></div>
      <div><label>Opp Def Rank vs Pos (1-32)</label><input name="oppDefRank" type="number" min="1" max="32"></div>
      <div><label>Wind (mph)</label><input name="wind" type="number" value="0"></div>
      <div><label>Precip (Y/N)</label><select name="precip"><option>N</option><option>Y</option></select></div>
      <div><label>Dome (Y/N)</label><select name="dome"><option>N</option><option>Y</option></select></div>
      <div style="grid-column:1/-1"><label><b>Game Log</b> (BEST INPUT) &mdash; this stat, most recent game first, comma separated</label><input name="gameLog" placeholder="e.g. 84, 41, 112, 67, 55, 93"></div>
      <div><label>Role/Scheme Volume (1-10)</label><input name="roleVolumeScore" type="number" min="1" max="10" value="5"></div>
      <div><label>Last 3 Games Avg (fallback if no log)</label><input name="last3" type="number" step="0.1"></div>
      <div><label>Season Avg (fallback if no log)</label><input name="seasonAvg" type="number" step="0.1"></div>
      <div><label>Usage Trend (max &plusmn;0.07) &mdash; only what the log can't show</label><input name="usageTrend" type="number" step="0.01" value="0"></div>
      <div><label>Avg Opp Def EPA Faced (schedule normalization)</label><input name="avgOppDefEpaFaced" type="number" step="0.01" placeholder="0.0 = neutral schedule"></div>
      <div><label>Injury Status</label>
        <select name="injuryStatus"><option>Healthy</option><option>Questionable</option><option>Doubtful</option><option>Out</option></select>
      </div>
      <div><label>OC/Play-Caller Continuity (Y/N)</label><select name="ocContinuity"><option>Y</option><option>N</option></select></div>
      <div><label>Prior-Yr Role Baseline</label><input name="priorYrBaseline" type="number" step="0.1"></div>
      <div><label>Games Played This Season</label><input name="gamesPlayed" type="number" min="0"></div>
      <div><label>Std Dev OVERRIDE (leave blank &mdash; derived from log)</label><input name="stdDev" type="number" step="0.1"></div>
      <div><label>Play-Caller Scheme Shift (pts, blank if no OC change)</label><input name="schemeShift" type="number" step="0.1" placeholder="e.g. 12.8 or -20.2"></div>
      <div><label>Opp Def EPA/Play Allowed (overrides rank)</label><input name="oppDefEpaPerPlay" type="number" step="0.01" placeholder="0.0 = league avg"></div>
      <div><label>Pressure Rate Allowed (0-1, pass props only)</label><input name="pressureRateAllowed" type="number" step="0.01" min="0" max="1" placeholder="0.25 = league avg"></div>
      <div><label>Red Zone Usage Share (0-1, TD props only)</label><input name="redZoneShare" type="number" step="0.01" min="0" max="1" placeholder="0.20 = typical lead role"></div>
    </form>
    <button class="submit-btn" id="saveProp">Save Prop</button>
    <div id="saveMsg" class="hint"></div>
  </section>

  <section id="scored">
    <h2>All Scored Props</h2>
    <button id="refreshScored">Refresh</button>
    <div id="scoredTableWrap"></div>
  </section>

  <section id="top">
    <h2>Top Picks (ranked by probability)</h2>
    <label class="hint">Show top: <input id="topN" type="number" value="15" style="width:60px"></label>
    <button id="refreshTop">Refresh</button>
    <div id="topTableWrap"></div>
  </section>

  <section id="tracker">
    <h2>Validation Tracker</h2>
    <p class="hint">Log every pick you actually make. This is how you find out if the model has real edge (closing line value + hit rate) over time.</p>
    <form class="grid" id="trackerForm">
      <div><label>Week</label><input name="week" type="number" value="1"></div>
      <div><label>Player</label><input name="player" required></div>
      <div><label>Team</label><input name="team"></div>
      <div><label>Prop Type</label><input name="propType"></div>
      <div><label>My Lean</label><select name="lean"><option>OVER</option><option>UNDER</option></select></div>
      <div><label>My Projection</label><input name="projection" type="number" step="0.1"></div>
      <div><label>Opening Line</label><input name="openingLine" type="number" step="0.5"></div>
      <div><label>Closing Line</label><input name="closingLine" type="number" step="0.5"></div>
      <div><label>Actual Result</label><input name="actual" type="number" step="0.1"></div>
      <div><label>Confidence (from model)</label>
        <select name="confidence"><option>High</option><option>Medium</option><option>Low</option></select>
      </div>
      <div><label>Claimed Prob (0-1, from model at pick time)</label><input name="claimedProb" type="number" step="0.001" min="0" max="1" placeholder="e.g. 0.642"></div>
      <div><label>Actually Played?</label><select name="played"><option value="">-</option><option>Y</option><option>N</option></select></div>
      <div><label>Odds (American, e.g. -115)</label><input name="odds" type="number" step="1" placeholder="-110"></div>
      <div><label>Stake (units)</label><input name="stake" type="number" step="0.1" placeholder="1"></div>
      <div><label>Notes</label><input name="notes"></div>
    </form>
    <button class="submit-btn" id="saveTracker">Log Pick</button>
    <div style="margin:14px 0; padding:12px; background:var(--bg); border:1px solid var(--line); border-radius:8px;">
      <b style="font-size:13px">Auto-grade results</b>
      <p class="hint" style="margin:4px 0 8px">Fills in actual results from published NFL stats for picks that don't have one yet. Preview first &mdash; anything it can't match cleanly is listed for manual entry rather than guessed at.</p>
      <button id="autogradeDry" style="padding:7px 14px; margin-right:6px; cursor:pointer;">Preview</button>
      <button id="autogradeApply" style="padding:7px 14px; margin-right:6px; cursor:pointer; background:var(--navy); color:#fff; border:none; border-radius:5px;">Apply</button>
      <button id="refreshStats" style="padding:7px 14px; cursor:pointer;">Refresh stat feed</button>
      <button id="exportData" style="padding:7px 14px; margin-left:6px; cursor:pointer;">Export backup</button>
      <div id="autogradeOut" style="margin-top:10px; font-size:12.5px;"></div>
    </div>
    <div id="hitRateCards" style="display:flex; gap:10px; flex-wrap:wrap; margin:14px 0;"></div>
    <div id="trackerTableWrap"></div>
    <div id="trackerSummary" class="hint"></div>
    <div id="calibrationWrap" style="margin-top:18px"></div>
  </section>

</main>
</div>

<script>
const API = "";
let SECRET = localStorage.getItem("appSecret") || "";

function authHeaders(extra) {
  return Object.assign({ "x-app-secret": SECRET }, extra || {});
}
// Escapes any value before it's placed into innerHTML, prevents stored XSS
// from a player name, note, or any other free-text field.
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;"
  }[c]));
}

async function tryLogin(secretToTry) {
  const res = await fetch(API + "/api/props", { headers: { "x-app-secret": secretToTry } });
  return res.ok;
}

async function showApp() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("appRoot").style.display = "block";
  loadScored();
}

async function attemptLogin(secretToTry, showErrorOnFail) {
  const ok = await tryLogin(secretToTry);
  if (ok) {
    SECRET = secretToTry;
    localStorage.setItem("appSecret", secretToTry);
    showApp();
  } else if (showErrorOnFail) {
    document.getElementById("loginError").textContent = "Incorrect password, try again.";
  }
  return ok;
}

document.getElementById("loginBtn").addEventListener("click", () => {
  const val = document.getElementById("loginInput").value || "";
  attemptLogin(val, true);
});
document.getElementById("loginInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("loginBtn").click();
});

// On page load, try whatever secret (possibly blank) is already stored.
// If that fails or nothing is stored yet, the login screen just stays visible
// for the user to type into, no auto-firing popups that mobile browsers block.
attemptLogin(SECRET, false);

document.querySelectorAll("nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll("section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "scored") loadScored();
    if (btn.dataset.tab === "top") loadTop();
    if (btn.dataset.tab === "tracker") loadTracker();
  });
});

function formToObj(form) {
  const data = {};
  new FormData(form).forEach((v, k) => data[k] = v);
  return data;
}

document.getElementById("saveProp").addEventListener("click", async () => {
  const data = formToObj(document.getElementById("propForm"));
  const res = await fetch(API + "/api/props", {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(data)
  });
  document.getElementById("saveMsg").textContent = res.ok ? "Saved." : "Error saving: " + (await res.text());
});

async function loadScored() {
  const res = await fetch(API + "/api/scored", { headers: authHeaders() });
  if (!res.ok) { document.getElementById("scoredTableWrap").innerHTML = "<p class='hint'>Could not load (check password).</p>"; return; }
  const rows = await res.json();
  document.getElementById("scoredTableWrap").innerHTML = renderScoredTable(rows, true);
  attachDeleteHandlers();
}
document.getElementById("refreshScored").addEventListener("click", loadScored);

async function loadTop() {
  const n = document.getElementById("topN").value || 15;
  const res = await fetch(API + "/api/top?n=" + n, { headers: authHeaders() });
  if (!res.ok) { document.getElementById("topTableWrap").innerHTML = "<p class='hint'>Could not load (check password).</p>"; return; }
  const rows = await res.json();
  document.getElementById("topTableWrap").innerHTML = renderScoredTable(rows, false);
}
document.getElementById("refreshTop").addEventListener("click", loadTop);

function renderScoredTable(rows, showActions) {
  if (!rows.length) return "<p class='hint'>No props saved yet.</p>";
  let html = "<table><tr><th>Team</th><th>Player</th><th>Prop</th><th>Line</th><th>Proj</th>" +
    "<th>SD</th><th>Dist</th><th>P(play)</th><th>P(Lean)</th><th>Push</th><th>Lean</th>" +
    "<th>Confidence</th>" + (showActions ? "<th></th>" : "") + "</tr>";
  for (const r of rows) {
    const prob = r.leanProb !== null && r.leanProb !== undefined ? (r.leanProb * 100).toFixed(1) + "%" : "n/a";
    const push = r.pPush ? (r.pPush * 100).toFixed(1) + "%" : "";
    const pplay = r.playProbability !== undefined ? (r.playProbability * 100).toFixed(0) + "%" : "";
    const distLabel = { yardage: "norm", count: "negbin", td: "pois" }[r.kind] || "";
    html += "<tr><td>" + esc(r.team) + "</td><td>" + esc(r.player) + "</td><td>" + esc(r.propType) +
      "</td><td>" + esc(r.line) + "</td><td>" + esc(r.finalProjection ?? "") +
      "</td><td title='" + esc(r.varianceSource || "") + "'>" + esc(r.sd ?? "") +
      "</td><td>" + esc(distLabel) + "</td><td>" + esc(pplay) +
      "</td><td>" + esc(prob) + "</td><td>" + esc(push) +
      "</td><td class='" + (r.lean==="OVER"?"over":"under") + "'>" + esc(r.lean) +
      "</td><td><span class='pill " + esc(r.confidence) + "'>" + esc(r.confidence) + "</span></td>";
    if (showActions) html += "<td class='row-actions'><button data-id='" + esc(r.id) + "' class='delBtn'>Delete</button>" +
      " <button data-row='" + esc(JSON.stringify({week:r.week,player:r.player,team:r.team,propType:r.propType,lean:r.lean,projection:r.finalProjection,line:r.line,confidence:r.confidence,claimedProb:r.leanProb})) + "' class='logBtn'>Log</button></td>";
    html += "</tr>";
  }
  // Same-game picks are not independent. Surfacing this matters for two
  // reasons: correlated misses cluster and make calibration look worse than
  // the model deserves, and parlay math across same-game legs is badly wrong
  // under an independence assumption.
  const grouped = {};
  for (const r of rows) if (r.gameKey) (grouped[r.gameKey] = grouped[r.gameKey] || []).push(r);
  const multi = Object.entries(grouped).filter(([,v]) => v.length > 1);
  if (multi.length) {
    html += "</table><div style='margin-top:10px;padding:10px;background:#FFF8E1;border:1px solid #E6C34A;border-radius:6px;font-size:12.5px'>";
    html += "<b>Correlated exposure</b><br>";
    for (const [k, v] of multi) {
      const dirs = v[0].correlatedWith ? v[0].correlatedWith.map(c=>c.direction) : [];
      const pos = dirs.filter(d=>d==="positive").length;
      const neg = dirs.filter(d=>d==="negative").length;
      html += esc(k) + ": " + v.length + " picks (" + v.map(x=>esc(x.player)).join(", ") + ")";
      if (pos||neg) html += " &mdash; " + pos + " positively, " + neg + " negatively correlated with the first";
      html += "<br>";
    }
    html += "<span class='hint'>These outcomes move together. One blowout can resolve several at once, " +
      "so treat them as fewer independent data points than the count suggests, and do not multiply " +
      "their probabilities for a same-game parlay.</span></div><p class='hint'>Dist: norm = normal (yardage)";
  } else {
    html += "</table><p class='hint'>Dist: norm = normal (yardage)";
  }
  return html + ", negbin = negative binomial (counts), pois = Poisson (touchdowns). Hover SD to see how it was derived. The Log button copies a pick into the Validation Tracker with its claimed probability, which is what makes calibration measurable later.</p>";
}

function attachDeleteHandlers() {
  document.querySelectorAll(".delBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(API + "/api/props/" + encodeURIComponent(btn.dataset.id), { method: "DELETE", headers: authHeaders() });
      loadScored();
    });
  });
  // Copies a scored pick into the tracker, carrying the claimed probability
  // across automatically. Typing that by hand is the step people skip, and
  // without it calibration can never be computed.
  document.querySelectorAll(".logBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      let payload;
      try { payload = JSON.parse(btn.dataset.row); } catch { return; }
      payload.openingLine = payload.line;
      delete payload.line;
      await fetch(API + "/api/tracker", {
        method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload)
      });
      btn.textContent = "Logged";
      btn.disabled = true;
    });
  });
}

document.getElementById("saveTracker").addEventListener("click", async () => {
  const data = formToObj(document.getElementById("trackerForm"));
  await fetch(API + "/api/tracker", {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(data)
  });
  loadTracker();
});

// Auto-grading. Preview is a dry run that changes nothing; Apply writes the
// matched values. Unmatched picks are always listed rather than resolved, since
// a wrong result silently corrupts the calibration numbers.
async function runAutograde(apply) {
  const out = document.getElementById("autogradeOut");
  out.innerHTML = "<span class='hint'>Working...</span>";
  const res = await fetch(API + "/api/autograde", {
    method: apply ? "POST" : "GET", headers: authHeaders()
  });
  const d = await res.json();
  if (!res.ok) {
    out.innerHTML = "<span style='color:var(--red)'>" + esc(d.error || "failed") + "</span>" +
      (d.hint ? "<br><span class='hint'>" + esc(d.hint) + "</span>" : "");
    return;
  }
  let html = "<b>" + (d.mode === "applied" ? "Applied" : "Preview") + "</b> &mdash; " +
    "matched " + d.appliedCount + ", needs review " + d.needsReviewCount +
    ", skipped (already graded) " + d.skippedCount;
  if (d.weeksAvailable && d.weeksAvailable.length) {
    html += "<br><span class='hint'>Stats available for weeks: " + esc(d.weeksAvailable.join(", ")) +
      (d.statsGeneratedAt ? " &middot; feed generated " + esc(String(d.statsGeneratedAt).slice(0,10)) : "") + "</span>";
  }
  if (d.applied.length) {
    html += "<table style='margin-top:8px'><tr><th>Pick</th><th>Matched to</th><th>Stat</th><th>Value</th></tr>";
    for (const a of d.applied) {
      html += "<tr><td>" + esc(a.player) + "</td><td>" + esc(a.matchedName) +
        "</td><td>" + esc(a.stat) + "</td><td>" + esc(a.value) + "</td></tr>";
    }
    html += "</table>";
  }
  if (d.needsReview.length) {
    html += "<p style='margin:8px 0 4px'><b>Needs manual entry:</b></p><table><tr><th>Pick</th><th>Why</th></tr>";
    for (const n of d.needsReview) {
      html += "<tr><td>" + esc(n.player) + "</td><td>" + esc(n.reason) + "</td></tr>";
    }
    html += "</table>";
  }
  out.innerHTML = html;
  if (apply) loadTracker();
}

// Everything lives in a single R2 bucket, so a local copy is the only real
// backup. Fetched with auth then handed to the browser as a download.
document.getElementById("exportData").addEventListener("click", async () => {
  const res = await fetch(API + "/api/export", { headers: authHeaders() });
  if (!res.ok) { document.getElementById("autogradeOut").innerHTML =
    "<span style='color:var(--red)'>Export failed</span>"; return; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "nfl-prop-backup-" + new Date().toISOString().slice(0,10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("autogradeDry").addEventListener("click", () => runAutograde(false));
document.getElementById("autogradeApply").addEventListener("click", () => runAutograde(true));
document.getElementById("refreshStats").addEventListener("click", async () => {
  const out = document.getElementById("autogradeOut");
  out.innerHTML = "<span class='hint'>Refreshing feeds...</span>";
  const res = await fetch(API + "/api/refresh-stats", { method: "POST", headers: authHeaders() });
  const d = await res.json();
  out.innerHTML = "<b>Feed refresh</b><table style='margin-top:6px'><tr><th>Feed</th><th>Status</th><th>Detail</th></tr>" +
    (d.results || []).map(r => "<tr><td>" + esc(r.feed) + "</td><td>" + (r.ok ? "ok" : "failed") +
      "</td><td>" + esc(r.ok ? (r.records + " records") : r.reason) + "</td></tr>").join("") +
    "</table>";
});

async function loadTracker() {
  const res = await fetch(API + "/api/tracker", { headers: authHeaders() });
  if (!res.ok) { document.getElementById("trackerTableWrap").innerHTML = "<p class='hint'>Could not load (check password).</p>"; return; }
  const rows = await res.json();

  // Grade every row with a result + CLV direction, same rules as before.
  const graded = rows.map(r => {
    let result = "", clv = "";
    if (r.actual !== undefined && r.actual !== "") {
      const gradeLine = r.closingLine || r.openingLine;
      const actual = Number(r.actual), line = Number(gradeLine);
      if (actual === line) result = "PUSH";
      else if ((r.lean === "OVER" && actual > line) || (r.lean === "UNDER" && actual < line)) result = "HIT";
      else result = "MISS";
    }
    if (r.openingLine && r.closingLine && r.openingLine != r.closingLine) {
      const moved = Number(r.closingLine) - Number(r.openingLine);
      const withMe = (r.lean === "OVER" && moved > 0) || (r.lean === "UNDER" && moved < 0);
      clv = withMe ? "+CLV" : "-CLV";
    }
    return { ...r, result, clv };
  });

  // Table
  let html = "<table><tr><th>Wk</th><th>Player</th><th>Prop</th><th>Lean</th><th>Conf.</th><th>Proj</th>" +
    "<th>Open</th><th>Close</th><th>Actual</th><th>Result</th><th>CLV</th><th></th></tr>";
  for (const r of graded) {
    html += "<tr><td>" + esc(r.week) + "</td><td>" + esc(r.player) + "</td><td>" + esc(r.propType) +
      "</td><td>" + esc(r.lean) + "</td><td>" + esc(r.confidence) + "</td><td>" + esc(r.projection) +
      "</td><td>" + esc(r.openingLine) + "</td><td>" + esc(r.closingLine) + "</td><td>" + esc(r.actual) +
      "</td><td>" + esc(r.result) + "</td><td>" + esc(r.clv) +
      "</td><td><button data-id='" + esc(r.id) + "' class='delTrackBtn'>Delete</button></td></tr>";
  }
  html += "</table>";
  document.getElementById("trackerTableWrap").innerHTML = html;

  // Helper: hit rate (excludes pushes and ungraded rows) for an arbitrary filter
  function hitRate(filterFn) {
    const subset = graded.filter(r => filterFn(r) && (r.result === "HIT" || r.result === "MISS"));
    const hits = subset.filter(r => r.result === "HIT").length;
    const total = subset.length;
    return { hits, total, pct: total ? (hits/total*100) : null };
  }

  const overall = hitRate(() => true);
  const byTier = ["High","Medium","Low"].map(tier => ({ tier, ...hitRate(r => r.confidence === tier) }));
  const byLean = ["OVER","UNDER"].map(lean => ({ lean, ...hitRate(r => r.lean === lean) }));

  const clvGraded = graded.filter(r => r.clv);
  const clvPos = clvGraded.filter(r => r.clv === "+CLV").length;
  const clvRate = clvGraded.length ? (clvPos/clvGraded.length*100) : null;

  function card(label, rate, count, cls) {
    const pctStr = rate === null ? "n/a" : rate.toFixed(1) + "%";
    return "<div class='stat-card " + (cls||"") + "'><div class='num'>" + pctStr + "</div>" +
      "<div class='label'>" + label + (count !== undefined ? " (n=" + count + ")" : "") + "</div></div>";
  }

  let cardsHtml = card("Overall Hit Rate", overall.pct, overall.total, overall.pct !== null && overall.pct >= 55 ? "good" : "warn");
  for (const t of byTier) {
    if (t.total > 0) cardsHtml += card(t.tier + " Confidence", t.pct, t.total);
  }
  for (const l of byLean) {
    if (l.total > 0) cardsHtml += card(l.lean + " Picks", l.pct, l.total);
  }
  cardsHtml += card("CLV Rate", clvRate, clvGraded.length);
  document.getElementById("hitRateCards").innerHTML = cardsHtml;

  document.getElementById("trackerSummary").innerHTML =
    "Logged picks: " + rows.length + " total. A tier's hit rate only means something once it has a " +
    "meaningful sample, treat anything under about 20 logged picks per tier as too small to draw " +
    "conclusions from.";

  loadCalibration();
}

// Calibration is the measure that actually validates the model. Hit rate tells
// you whether you won; calibration tells you whether the numbers mean anything.
// A model can win 58% of its picks while claiming 75%, which makes it useless
// for sizing even though the record looks fine.
async function loadCalibration() {
  const el = document.getElementById("calibrationWrap");
  if (!el) return;
  const res = await fetch(API + "/api/calibration", { headers: authHeaders() });
  if (!res.ok) { el.innerHTML = ""; return; }
  const c = await res.json();
  if (!c || !c.n) {
    el.innerHTML = "<p class='hint'><b>Calibration:</b> no graded picks with a recorded " +
      "probability yet. Use the Log button on the All Scored Props tab so the claimed " +
      "probability is captured, then fill in the actual result after the game.</p>";
    return;
  }
  let html = "<h3 style='margin-bottom:4px'>Calibration</h3>";
  const verdict = c.brier < 0.20 ? "good" : c.brier < 0.25 ? "" : "warn";
  html += "<div style='display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px'>";
  html += "<div class='stat-card " + verdict + "'><div class='num'>" + c.brier.toFixed(3) +
    "</div><div class='label'>Brier score (n=" + c.n + ")</div></div>";
  html += "<div class='stat-card'><div class='num'>" + c.baseline.toFixed(2) +
    "</div><div class='label'>Coin-flip baseline</div></div>";
  html += "</div>";
  html += "<table><tr><th>Claimed band</th><th>n</th><th>Avg claimed</th><th>Actual hit rate</th><th>Gap</th></tr>";
  for (const b of c.buckets) {
    const gapPct = (b.gap * 100).toFixed(1);
    const cls = Math.abs(b.gap) <= 0.05 ? "" : (b.gap < 0 ? "under" : "over");
    html += "<tr><td>" + esc(b.label) + "</td><td>" + b.n + "</td><td>" +
      (b.claimed*100).toFixed(1) + "%</td><td>" + (b.actual*100).toFixed(1) +
      "%</td><td class='" + cls + "'>" + (b.gap>=0?"+":"") + gapPct + "%</td></tr>";
  }
  html += "</table>";
  // Realized money performance, separate from model accuracy. Only picks
  // marked as actually played are included, which is what lets bet-selection
  // judgment be told apart from model skill.
  if (c.bets && c.bets.gradedCount > 0) {
    const b = c.bets;
    html += "<h3 style='margin:14px 0 4px'>Realized performance (played picks only)</h3>";
    html += "<div style='display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px'>";
    const roiCls = b.roi === null ? "" : (b.roi > 0 ? "good" : "warn");
    html += "<div class='stat-card " + roiCls + "'><div class='num'>" +
      (b.roi === null ? "n/a" : (b.roi*100).toFixed(1) + "%") +
      "</div><div class='label'>ROI (n=" + b.gradedCount + ")</div></div>";
    html += "<div class='stat-card'><div class='num'>" + (b.unitsProfit>=0?"+":"") + b.unitsProfit +
      "</div><div class='label'>Units, on " + b.unitsStaked + " staked</div></div>";
    html += "<div class='stat-card'><div class='num'>" +
      (b.hitRate===null?"n/a":(b.hitRate*100).toFixed(1)+"%") +
      "</div><div class='label'>Hit rate, played</div></div>";
    if (b.avgBreakEvenRate !== null) {
      html += "<div class='stat-card'><div class='num'>" + (b.avgBreakEvenRate*100).toFixed(1) +
        "%</div><div class='label'>Break-even needed</div></div>";
    }
    html += "</div>";
    if (b.avgBreakEvenRate !== null && b.hitRate !== null) {
      const beat = b.hitRate - b.avgBreakEvenRate;
      html += "<p class='hint'>Hit rate is " + (beat>=0?"above":"below") + " the break-even rate " +
        "implied by the prices paid, by " + Math.abs(beat*100).toFixed(1) + " points. This, not " +
        "hit rate on its own, is the test of whether the process makes money: 55% at -130 loses " +
        "while 52% at +100 wins.</p>";
    }
    if (b.pricedCount < b.gradedCount) {
      html += "<p class='hint'>" + (b.gradedCount - b.pricedCount) + " played pick(s) have no odds " +
        "recorded and are excluded from ROI.</p>";
    }
  }
  html += "<p class='hint'>Brier score: lower is better, and 0.25 is what you would score by " +
    "always saying 50%. Anything above 0.25 means the probabilities are actively misleading. " +
    "A negative gap means the model is overconfident in that band. Per published guidance on " +
    "prop modeling, treat fewer than roughly 50 to 100 graded picks as too small to act on.</p>";
  el.innerHTML = html;

  document.querySelectorAll(".delTrackBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(API + "/api/tracker/" + encodeURIComponent(btn.dataset.id), { method: "DELETE", headers: authHeaders() });
      loadTracker();
    });
  });
}

</script>
</body>
</html>`;