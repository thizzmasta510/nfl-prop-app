// NBA injury report lookups (nba-injuries.json from github-action/compute_nba_injuries.py).
// Pure functions. Statuses follow the official report: Out, Doubtful, Questionable,
// Probable, Available.

import { normalizeName } from "./model.js";

export const SKIP_STATUSES = new Set(["Out", "Doubtful"]);
export const FLAG_STATUSES = new Set(["Questionable"]);
// Chance a player with this status plays. Rough and UNFITTED: compute_nba_injuries.py
// now keeps a status history (nba-injury-history.json) so these can be fitted
// against who actually played (backtest/nba_play_rates.mjs).
export const PLAY_PROBABILITY = { Available: 1, Probable: 0.97, Questionable: 0.75, Doubtful: 0.25, Out: 0 };
const shortKey = (norm) => { const p = String(norm || "").split(" "); return p.length < 2 ? norm : `${p[0][0]} ${p[p.length - 1]}`; };

/** Build lookups once per request. Returns null when there is no usable report. */
export function injuryIndex(doc, nowMs = Date.now()) {
  if (!doc || !Array.isArray(doc.players)) return null;
  const byNorm = new Map(), byShortTeam = new Map(), outByTeam = new Map(), normCount = new Map();
  for (const p of doc.players) {
    if (!p || !p.name || !p.status) continue;
    const norm = p.norm || normalizeName(p.name);
    const e = { name: p.name, norm, team: p.team || null, status: p.status, reason: p.reason || "", game: p.game || null };
    byNorm.set(norm, e);
    normCount.set(norm, (normCount.get(norm) || 0) + 1);
    if (e.team) byShortTeam.set(`${shortKey(norm)}|${e.team}`, e);
    if (e.team && SKIP_STATUSES.has(e.status)) {
      if (!outByTeam.has(e.team)) outByTeam.set(e.team, []);
      outByTeam.get(e.team).push(e);
    }
  }
  const t = Date.parse(doc.reportTime || doc.generatedAt || "");
  const ageHours = Number.isFinite(t) ? (nowMs - t) / 3600000 : null;
  return {
    byNorm, byShortTeam, outByTeam, normCount,
    notSubmitted: new Set((doc.notSubmitted || []).map((x) => x && x.team).filter(Boolean)),
    meta: { source: doc.source || null, reportTime: doc.reportTime || null, reportUrl: doc.reportUrl || null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10, players: doc.players.length,
      stale: ageHours !== null && ageHours > 18 },
  };
}

/** The report entry for a player (exact name first, then initial + last name on the same team). */
export function injuryFor(idx, norm, team) {
  if (!idx) return null;
  const e = idx.byNorm.get(norm);
  if (e && (!e.team || !team || e.team === team)) return e;
  const sameTeam = idx.byShortTeam.get(`${shortKey(norm)}|${team}`);
  if (sameTeam) return sameTeam;
  // Exact name on another team: most likely a trade the game logs haven't caught up
  // with. Accepted only when that exact name appears once in the report, so a
  // common name can't attach someone else's status.
  return e && idx.normCount.get(norm) === 1 ? e : null;
}

/** Teammates listed Out or Doubtful, most minutes first when a minutes lookup is given. */
export function teammatesOut(idx, team, selfNorm, minutesOf = null) {
  if (!idx || !team) return [];
  const list = (idx.outByTeam.get(team) || []).filter((e) => e.norm !== selfNorm)
    .map((e) => ({ name: e.name, status: e.status, minutes: minutesOf ? minutesOf(e.norm) : null }));
  list.sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1));
  return list;
}
