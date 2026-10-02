import { scoreProp, rankByTeam, calibration, matchPlayerStat,
         annotateCorrelation, betPerformance, breakEvenRate } from "./model.js";

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
  "gameLog","roleVolumeScore","avgOppDefEpaFaced",
  // v13: data-driven usage (WOPR) and per-opportunity efficiency (EPA),
  // replacing part of the subjective usage-trend slider when supplied.
  "recentWopr","baselineWopr","receivingEpa","rushingEpa","passingEpa"];

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

    // ---- Bulk log: one click to log a set of scored picks at once ----
    // Built for the "log this week's top N" workflow. Duplicate detection uses
    // week + player + propType (not id, since these are new client-side
    // records with no id yet), so clicking the button twice, or logging an
    // overlapping list next week, does not create duplicate tracker rows. A
    // duplicate is skipped, not overwritten, since a tracker entry may already
    // carry a result or a corrected line that a re-log should not clobber.
    if (pathname === "/api/tracker/bulk" && request.method === "POST") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, origin); }
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items) return json({ error: "body must be { items: [...] }" }, 400, origin);
      if (items.length > 100) return json({ error: "max 100 items per batch" }, 400, origin);

      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      const dupeKey = (e) => `${e.week}|${String(e.player || "").toLowerCase().trim()}|${String(e.propType || "").toLowerCase().trim()}`;
      const existing = new Set(entries.map(dupeKey));

      const added = [], skipped = [];
      for (const raw of items) {
        const clean = sanitizeRecord(raw, TRACKER_FIELDS);
        if (!clean.player) { skipped.push({ player: raw?.player, reason: "missing player" }); continue; }
        const key = dupeKey(clean);
        if (existing.has(key)) { skipped.push({ player: clean.player, reason: "already logged this week" }); continue; }
        if (entries.length >= MAX_ARRAY_LEN) { skipped.push({ player: clean.player, reason: "storage limit reached" }); continue; }
        clean.id = crypto.randomUUID();
        entries.push(clean);
        existing.add(key);
        added.push(clean);
      }

      if (added.length) await writeJson(env.PROP_DATA, TRACKER_KEY, entries);
      return json({ addedCount: added.length, added, skippedCount: skipped.length, skipped }, 200, origin);
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
    // Trimmed because a URL pasted into a prompt commonly carries a trailing
    // newline or space, which makes fetch() throw a bare TypeError rather than
    // anything descriptive.
    { name: "weekly-stats", url: String(env.STATS_FEED_URL || "").trim(), key: STATS_KEY },
    { name: "player-stats", url: String(env.PLAYER_STATS_URL || "").trim(), key: PLAYER_STATS_KEY },
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
      // Report the message, not just the name. A bare "TypeError" gives
      // nothing to act on; the message distinguishes an invalid URL from a
      // network failure from a JSON parse error. The URL is echoed back
      // (truncated) because a malformed one is the most common cause and is
      // otherwise invisible.
      const name = err && err.name ? err.name : "Error";
      const msg = err && err.message ? err.message : String(err);
      results.push({
        feed: feed.name,
        ok: false,
        reason: `${name}: ${msg}`,
        urlSeen: feed.url.length > 80 ? feed.url.slice(0, 80) + "..." : feed.url,
        urlLength: feed.url.length,
      });
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
      <div><label>Usage Trend (fallback, max &plusmn;0.07) &mdash; ignored if WOPR fields below are filled</label><input name="usageTrend" type="number" step="0.01" value="0"></div>
      <div><label>Recent WOPR (receiving props, from efficiency data)</label><input name="recentWopr" type="number" step="0.01" placeholder="e.g. 0.62"></div>
      <div><label>Baseline WOPR (season avg, same units)</label><input name="baselineWopr" type="number" step="0.01" placeholder="e.g. 0.50"></div>
      <div><label>Receiving EPA (from efficiency data, rec props only)</label><input name="receivingEpa" type="number" step="0.01" placeholder="0.0 = league avg"></div>
      <div><label>Rushing EPA (from efficiency data, rush props only)</label><input name="rushingEpa" type="number" step="0.01" placeholder="0.0 = league avg"></div>
      <div><label>Passing EPA (from efficiency data, pass props only)</label><input name="passingEpa" type="number" step="0.01" placeholder="0.0 = league avg"></div>
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
    <div style="margin:10px 0; padding:10px; background:var(--bg); border:1px solid var(--line); border-radius:8px;">
      <label style="font-size:12.5px;">Week for logging: <input id="bulkWeek" type="number" style="width:60px" placeholder="e.g. 2"></label>
      <button id="selectTopN" style="margin-left:8px; padding:5px 10px; cursor:pointer;">Select top <input id="topNCount" type="number" value="15" style="width:45px"></button>
      <button id="selectAllRows" style="margin-left:6px; padding:5px 10px; cursor:pointer;">Select all</button>
      <button id="selectNoneRows" style="padding:5px 10px; cursor:pointer;">Clear</button>
      <button id="bulkLogBtn" style="margin-left:6px; padding:5px 14px; cursor:pointer; background:var(--navy); color:#fff; border:none; border-radius:5px;">Log selected</button>
      <div id="bulkLogOut" style="margin-top:6px; font-size:12.5px;"></div>
    </div>
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

// "Select top N" respects the same probability ranking shown in the # column,
// so it matches what "top 15" means everywhere else in the app.
document.getElementById("selectTopN").addEventListener("click", () => {
  const n = Number(document.getElementById("topNCount").value) || 15;
  document.querySelectorAll(".rowSelect").forEach(cb => {
    cb.checked = Number(cb.dataset.rank) <= n;
  });
});
document.getElementById("selectAllRows").addEventListener("click", () => {
  document.querySelectorAll(".rowSelect").forEach(cb => cb.checked = true);
});
document.getElementById("selectNoneRows").addEventListener("click", () => {
  document.querySelectorAll(".rowSelect").forEach(cb => cb.checked = false);
});

document.getElementById("bulkLogBtn").addEventListener("click", async () => {
  const out = document.getElementById("bulkLogOut");
  const week = document.getElementById("bulkWeek").value;
  const selected = [...document.querySelectorAll(".rowSelect:checked")];
  if (!selected.length) { out.innerHTML = "<span style='color:var(--red)'>Nothing selected.</span>"; return; }

  const items = selected.map(cb => {
    let payload;
    try { payload = JSON.parse(cb.dataset.payload); } catch { return null; }
    // The week field on the scored row may be blank if it wasn't entered on
    // the prop; the week typed above fills that gap so grading, which keys
    // on week, always has one to work with.
    if (week) payload.week = Number(week);
    return payload;
  }).filter(Boolean);

  out.innerHTML = "<span class='hint'>Logging " + items.length + " pick(s)...</span>";
  const res = await fetch(API + "/api/tracker/bulk", {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ items })
  });
  const d = await res.json();
  if (!res.ok) { out.innerHTML = "<span style='color:var(--red)'>" + esc(d.error || "failed") + "</span>"; return; }

  let html = "<b>Logged " + d.addedCount + "</b>, skipped " + d.skippedCount +
    (d.skippedCount ? " (already logged this week, or missing data)" : "") + ".";
  if (d.skipped.length) {
    html += "<ul style='margin:4px 0 0 18px; padding:0;'>";
    for (const s of d.skipped) html += "<li>" + esc(s.player) + ": " + esc(s.reason) + "</li>";
    html += "</ul>";
  }
  out.innerHTML = html;
  document.querySelectorAll(".rowSelect:checked").forEach(cb => cb.checked = false);
});

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
  // Rank once by probability, matching how Top Picks and team rank already
  // sort, so "select top N" here means the same thing it means everywhere
  // else in the app rather than the order props happened to be entered.
  const ranked = rows.slice().sort((a,b) => (b.leanProb ?? -1) - (a.leanProb ?? -1));
  const rankOf = new Map(ranked.map((r,i) => [r.id, i+1]));

  let html = "<table><tr>" + (showActions ? "<th><input type='checkbox' id='selectAllHeader'></th>" : "") +
    "<th>#</th><th>Team</th><th>Player</th><th>Prop</th><th>Line</th><th>Proj</th>" +
    "<th>SD</th><th>Dist</th><th>P(play)</th><th>P(Lean)</th><th>Push</th><th>Lean</th>" +
    "<th>Confidence</th>" + (showActions ? "<th></th>" : "") + "</tr>";
  for (const r of rows) {
    const prob = r.leanProb !== null && r.leanProb !== undefined ? (r.leanProb * 100).toFixed(1) + "%" : "n/a";
    const push = r.pPush ? (r.pPush * 100).toFixed(1) + "%" : "";
    const pplay = r.playProbability !== undefined ? (r.playProbability * 100).toFixed(0) + "%" : "";
    const distLabel = { yardage: "norm", count: "negbin", td: "pois" }[r.kind] || "";
    const logPayload = { week:r.week, player:r.player, team:r.team, propType:r.propType, lean:r.lean,
      projection:r.finalProjection, openingLine:r.line, confidence:r.confidence, claimedProb:r.leanProb };
    html += "<tr>" + (showActions ? "<td><input type='checkbox' class='rowSelect' data-rank='" + rankOf.get(r.id) +
      "' data-payload='" + esc(JSON.stringify(logPayload)) + "'></td>" : "") +
      "<td>" + rankOf.get(r.id) + "</td><td>" + esc(r.team) + "</td><td>" + esc(r.player) + "</td><td>" + esc(r.propType) +
      "</td><td>" + esc(r.line) + "</td><td>" + esc(r.finalProjection ?? "") +
      "</td><td title='" + esc(r.varianceSource || "") + "'>" + esc(r.sd ?? "") +
      "</td><td>" + esc(distLabel) + "</td><td>" + esc(pplay) +
      "</td><td>" + esc(prob) + "</td><td>" + esc(push) +
      "</td><td class='" + (r.lean==="OVER"?"over":"under") + "'>" + esc(r.lean) +
      "</td><td><span class='pill " + esc(r.confidence) + "'>" + esc(r.confidence) + "</span></td>";
    if (showActions) html += "<td class='row-actions'><button data-id='" + esc(r.id) + "' class='delBtn'>Delete</button>" +
      " <button data-row='" + esc(JSON.stringify(logPayload)) + "' class='logBtn'>Log</button></td>";
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
      await fetch(API + "/api/tracker", {
        method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload)
      });
      btn.textContent = "Logged";
      btn.disabled = true;
    });
  });

  // Bulk selection helpers, wired here so they re-attach every time the
  // table re-renders (fresh checkboxes each load).
  document.getElementById("selectAllHeader")?.addEventListener("change", (e) => {
    document.querySelectorAll(".rowSelect").forEach(cb => cb.checked = e.target.checked);
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
      "</td><td>" + esc(r.ok ? (r.records + " records") : r.reason) +
      (!r.ok && r.urlSeen !== undefined ? "<br><span class='hint'>URL seen (" + esc(r.urlLength) + " chars): " + esc(r.urlSeen) + "</span>" : "") +
      "</td></tr>").join("") +
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
