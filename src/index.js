import { scoreProp, rankByTeam, calibration, matchPlayerStat,
         annotateCorrelation, betPerformance, breakEvenRate, propTypeToStatKey } from "./model.js";
import { authorize, verifyAccessJwt, withSecurityHeaders, scriptHashFor, htmlCsp } from "./security.js";
import { buildTrendGrid, linesFromProps, linesFromList, parseLinesText, MARKETS, SPORTS } from "./trends.js";
import { teamContext, decorateNbaGrid } from "./nba_model.js";
import { KALSHI_NBA_SERIES, parseKalshiMarket, eventDate, buildNbaBoard } from "./nba_board.js";
import { injuryIndex } from "./nba_injuries.js";

const PROPS_KEY = "props.json";
const TRACKER_KEY = "tracker.json";
const STATS_KEY = "weekly-stats.json";
const PLAYER_STATS_KEY = "player-stats.json";
const TREND_LOGS_KEY = "trend-logs.json";
const NBA_TREND_LOGS_KEY = "nba-trend-logs.json";
const NBA_LINES_KEY = "nba-lines.json";
const NBA_INJURIES_KEY = "nba-injuries.json";
const INJURY_REFRESH_SECONDS = 1200; // re-pull the published injury file at most every 20 minutes
const MAX_NBA_LINES = 300;
const KALSHI_CACHE_SECONDS = 300;   // NBA Board: re-pull Kalshi prices at most every 5 minutes per market
const KALSHI_BASES = ["https://api.elections.kalshi.com/trade-api/v2", "https://external-api.kalshi.com/trade-api/v2"];
const NBA_DAILY_CRON = "30 14 * * *"; // 10:30 AM ET, after the NBA GitHub Action (14:10 UTC)
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

// Parsed-JSON cache for the large, rarely-changing trend files. A Worker isolate
// is reused across requests, so this skips re-downloading and re-parsing a
// multi-megabyte file on every Tendency Matrix load (JSON.parse of ~3 MB can exceed the
// free plan's 10 ms CPU budget). One conditional R2 read per request: when the
// stored etag still matches, R2 returns the object metadata without a body, so the
// etag and the data always come from the same read (review C3: no head/get race).
const JSON_CACHE = new Map();
async function readJsonCached(bucket, key, fallback) {
  const hit = JSON_CACHE.get(key);
  const obj = hit ? await bucket.get(key, { onlyIf: { etagDoesNotMatch: hit.etag } }) : await bucket.get(key);
  if (!obj) return fallback;                 // object does not exist
  // Precondition failed (etag unchanged): R2 returns an R2Object with `body` undefined
  // (docs: "get() returns an R2Object with body undefined"). null means the key is missing.
  if (hit && (obj.body === undefined || typeof obj.text !== "function")) return hit.data;
  let data;
  try { data = JSON.parse(await obj.text()); } catch { return fallback; }
  if (obj.etag) JSON_CACHE.set(key, { etag: obj.etag, data });
  return data;
}

// Reads a request body as text, stopping once it exceeds `limit` bytes, so a
// request without a content-length header can't make the Worker buffer an
// arbitrarily large body (review C24). Returns null when too large.
async function readBodyLimited(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function writeJson(bucket, key, data) {
  await bucket.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
  });
}

// Today's date in US Eastern time (NBA and Kalshi game days are Eastern dates).
function easternDate(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Published injury file. NBA_INJURIES_URL, or the same folder as NBA_TREND_LOGS_URL.
function nbaInjuriesUrl(env) {
  const explicit = String(env.NBA_INJURIES_URL || "").trim();
  if (explicit) return explicit;
  const logs = String(env.NBA_TREND_LOGS_URL || "").trim();
  return logs ? logs.replace(/nba-trend-logs\.json$/, "nba-injuries.json") : "";
}

// The injury report changes through the day, so unlike the other feeds it is
// re-pulled on demand when the stored copy is older than 20 minutes. A failed
// pull keeps the stored copy. Returns an injuryIndex or null.
async function nbaInjuries(env) {
  let doc = await readJson(env.PROP_DATA, NBA_INJURIES_KEY, null);
  const age = doc && doc._pulledAt ? (Date.now() - Date.parse(doc._pulledAt)) / 1000 : Infinity;
  const url = nbaInjuriesUrl(env);
  if (url && age > INJURY_REFRESH_SECONDS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && Array.isArray(fresh.players)) {
          doc = { ...fresh, _pulledAt: new Date().toISOString() };
          await writeJson(env.PROP_DATA, NBA_INJURIES_KEY, doc);
        }
      }
    } catch { /* keep the stored copy */ } finally { clearTimeout(timer); }
  }
  return injuryIndex(doc);
}

// Team context is the same for every request until the data or the day changes.
let NBA_CTX = { key: null, ctx: null };
function nbaContextFor(doc) {
  const key = `${doc.generatedAt || ""}|${easternDate()}`;
  if (NBA_CTX.key !== key) NBA_CTX = { key, ctx: teamContext(doc, null) };
  return NBA_CTX.ctx;
}

// Kalshi public market data (no account or key needed). The base URL is fixed in
// code (or KALSHI_API_BASE in wrangler.toml), never taken from a request.
async function kalshiGet(env, path) {
  const bases = env.KALSHI_API_BASE ? [String(env.KALSHI_API_BASE).trim()] : KALSHI_BASES;
  let last = "no Kalshi base URL";
  for (const base of bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(base + path, { headers: { accept: "application/json" }, signal: controller.signal });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status} from ${new URL(base).host}`;
      if (res.status === 429) break; // rate limited: don't hammer the second host
    } catch (err) {
      last = `${err && err.name ? err.name : "Error"} from ${new URL(base).host}`;
    } finally { clearTimeout(timer); }
  }
  throw new Error(last);
}

// Open Kalshi markets for one stat on one game day. Lists the series' open events
// (one per game), keeps that day's games, then reads each game's markets. Done per
// stat so one request stays small (Workers' CPU and subrequest limits). Cached in
// R2 for 5 minutes; a forced refresh is still limited to once a minute.
async function kalshiNbaMarkets(env, stat, date, force) {
  const series = KALSHI_NBA_SERIES[stat];
  const key = `kalshi-nba-${stat}.json`;
  const cached = await readJson(env.PROP_DATA, key, null);
  const age = cached ? (Date.now() - Date.parse(cached.fetchedAt)) / 1000 : Infinity;
  const sameDay = cached && (!date || cached.date === date);
  if (cached && sameDay && (age < KALSHI_CACHE_SECONDS && !force || age < 60)) return { ...cached, cached: true };

  const events = [];
  let cursor = "";
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ series_ticker: series, status: "open", limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const data = await kalshiGet(env, "/events?" + q.toString());
    for (const e of data.events || []) if (e && e.event_ticker) events.push(e.event_ticker);
    cursor = data.cursor || "";
    if (!cursor) break;
  }
  const today = easternDate();
  const dates = [...new Set(events.map(eventDate).filter((d) => d && d >= today))].sort();
  const day = date || dates[0] || today;
  const todays = events.filter((e) => eventDate(e) === day).slice(0, 16);
  const markets = [];
  for (let i = 0; i < todays.length; i += 4) {
    const batch = await Promise.all(todays.slice(i, i + 4).map((ev) =>
      kalshiGet(env, "/markets?" + new URLSearchParams({ event_ticker: ev, limit: "1000" }).toString())
        .then((d) => d.markets || []).catch(() => [])));
    for (const list of batch) for (const m of list) { const pm = parseKalshiMarket(m, stat); if (pm) markets.push(pm); }
  }
  const out = { fetchedAt: new Date().toISOString(), date: day, availableDates: dates.slice(0, 7), games: todays.length, stat, markets };
  await writeJson(env.PROP_DATA, key, out);
  return { ...out, cached: false };
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

const app = {
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
          "content-security-policy": htmlCsp(await scriptHashFor(HTML)),
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

    // ---- Tendency Matrix: hit rate by cutoff over each player's last N games ----
    // NFL: GET /api/trends?stat=receptions&games=5&pos=WR,TE&min=5&sort=5&limit=25&week=6&slate=1
    // NBA: GET /api/trends?sport=nba&stat=points&games=10&pos=G&date=2026-11-02&slate=1
    // Describes what happened; it is not a forecast (see backtest/trend_backtest.mjs).
    if (pathname === "/api/trends" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const q = url.searchParams;
      const sport = q.get("sport") === "nba" ? "nba" : "nfl";
      const markets = SPORTS[sport].markets;
      const stat = q.get("stat") || (sport === "nba" ? "points" : "receptions");
      if (!markets[stat]) return json({ error: "unknown stat", stats: Object.keys(markets) }, 400, origin);
      let doc, source;
      if (sport === "nba") {
        doc = await readJsonCached(env.PROP_DATA, NBA_TREND_LOGS_KEY, null);
        source = "nba-trend-logs.json";
      } else {
        // Prefer the cross-season trend file; fall back to this season's player stats.
        doc = await readJsonCached(env.PROP_DATA, TREND_LOGS_KEY, null);
        source = "trend-logs.json";
        if (!doc || !Array.isArray(doc.players) || !doc.players.length) {
          doc = await readJsonCached(env.PROP_DATA, PLAYER_STATS_KEY, null);
          source = "player-stats.json (current season only)";
        }
      }
      if (!doc || !Array.isArray(doc.players) || !doc.players.length) {
        return json({ error: "no player stats available",
          hint: sport === "nba" ? "Set NBA_TREND_LOGS_URL and POST /api/refresh-stats." : "Set TREND_LOGS_URL (or PLAYER_STATS_URL) and POST /api/refresh-stats." }, 503, origin);
      }
      // "2025-26" style seasons are accepted too (review C11).
      const season = Number(doc.season) || Number(String(doc.season || "").split("-")[0]) || new Date().getUTCFullYear();
      const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const maxGames = sport === "nba" ? 20 : 10;
      const games = clampInt(q.get("games"), 1, maxGames, SPORTS[sport].defaultGames);
      const posParam = q.get("pos");
      const positions = posParam === "ALL" ? [] : posParam ? posParam.toUpperCase().split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6) : undefined;
      let lines = {}, slatePlayers = [];
      if (sport === "nba") {
        const list = await readJson(env.PROP_DATA, NBA_LINES_KEY, []);
        lines = linesFromList(list, stat);
        slatePlayers = list.map((l) => l.player);
      } else {
        const props = await readJson(env.PROP_DATA, PROPS_KEY, []);
        lines = linesFromProps(props, stat, propTypeToStatKey);
        slatePlayers = props.map((p) => p.player);
      }
      const dateParam = q.get("date");
      const cutoffs = markets[stat].cutoffs;
      const sortParam = Number(q.get("sort"));
      const grid = buildTrendGrid(doc.players, {
        sport, stat, season, games,
        minGames: clampInt(q.get("min"), 1, games, games),
        beforeWeek: sport === "nfl" && q.get("week") ? clampInt(q.get("week"), 1, 22, 99) : undefined,
        beforeDate: sport === "nba" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam || "") ? dateParam : undefined,
        positions,
        sortBy: q.get("sort") === "grade" ? "grade" : cutoffs.includes(sortParam) ? sortParam : undefined,
        limit: clampInt(q.get("limit"), 1, 100, 25),
        lines,
        // slate=1 restricts rows to players you have lines/props entered for.
        players: q.get("slate") === "1" ? slatePlayers : null,
      });
      // NBA: next opponent, pace / DRtg / defense-vs-position ranks and Model % (skipped for past dates).
      if (sport === "nba" && !grid.asOf.beforeDate) decorateNbaGrid(grid, doc, { stat, season, ctx: nbaContextFor(doc), injuries: await nbaInjuries(env) });
      return json({ ...grid, source, generatedAt: doc.generatedAt || null, latestGameDate: doc.latestGameDate || null,
        markets: Object.fromEntries(Object.entries(markets).map(([k, v]) => [k, v.label])) }, 200, origin);
    }

    // ---- NBA Board: Kalshi NBA prop ladders in a price band, ranked by the model ----
    // GET /api/nba-board?stat=points&band=66-75&limit=25&date=2026-10-22&refresh=1&sort=market|model&allRungs=1
    // One stat per request (the page asks for each market in parallel and merges).
    if (pathname === "/api/nba-board" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const q = url.searchParams;
      const stat = q.get("stat") || "points";
      if (!KALSHI_NBA_SERIES[stat]) return json({ error: "unknown stat", stats: Object.keys(KALSHI_NBA_SERIES) }, 400, origin);
      const bandM = String(q.get("band") || "66-75").match(/^(\d{2})-(\d{2})$/);
      let lo = bandM ? Number(bandM[1]) / 100 : 0.66, hi = bandM ? Number(bandM[2]) / 100 : 0.75;
      if (!(lo >= 0.5 && hi <= 0.97 && lo < hi)) { lo = 0.66; hi = 0.75; }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "") ? q.get("date") : null;
      const limitN = Math.min(100, Math.max(1, parseInt(q.get("limit"), 10) || 25));
      const doc = await readJsonCached(env.PROP_DATA, NBA_TREND_LOGS_KEY, null);
      if (!doc || !Array.isArray(doc.players) || !doc.players.length) {
        return json({ error: "no NBA game logs yet", hint: "Run the 'Compute NBA trend logs' GitHub Action, then Data > Refresh stat feeds." }, 503, origin);
      }
      let km;
      try { km = await kalshiNbaMarkets(env, stat, date, q.get("refresh") === "1"); }
      catch (err) { return json({ error: "could not reach Kalshi", detail: String(err && err.message || err).slice(0, 120) }, 502, origin); }
      const season = Number(doc.season) || Number(String(doc.season || "").split("-")[0]) || new Date().getUTCFullYear();
      const board = buildNbaBoard({ markets: km.markets, doc, ctx: nbaContextFor(doc), season, band: [lo, hi], limit: limitN,
        injuries: await nbaInjuries(env), sortBy: q.get("sort") === "model" ? "model" : "market",
        onePerPlayer: q.get("allRungs") !== "1", dnpRule: String(env.KALSHI_DNP_RULE || "no").trim() === "void" ? "void" : "no" });
      return json({ ...board, stat, date: km.date, availableDates: km.availableDates, games: km.games, marketsSeen: km.markets.length,
        pricesFetchedAt: km.fetchedAt, pricesCached: km.cached, logsGeneratedAt: doc.generatedAt || null,
        scheduleIncluded: Array.isArray(doc.upcoming) && doc.upcoming.length > 0, source: "Kalshi public market data" }, 200, origin);
    }

    // ---- NBA lines for the NBA Tendency Matrix (Line column and "my slate") ----
    // GET returns the list. POST { text: "Player, stat, line\n..." } replaces it.
    if (pathname === "/api/nba-lines" && (request.method === "GET" || request.method === "POST")) {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      if (request.method === "GET") return json(await readJson(env.PROP_DATA, NBA_LINES_KEY, []), 200, origin);
      const raw = await readBodyLimited(request, MAX_BODY_BYTES);
      if (raw === null) return json({ error: `paste too large: max ${MAX_NBA_LINES} lines (20 KB)` }, 413, origin);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400, origin); }
      const text = typeof body?.text === "string" ? body.text : "";
      const { ok, bad } = parseLinesText(text, "nba");
      if (ok.length > MAX_NBA_LINES) return json({ error: `too many lines (max ${MAX_NBA_LINES})` }, 400, origin);
      await writeJson(env.PROP_DATA, NBA_LINES_KEY, ok);
      return json({ saved: ok.length, rejected: bad.slice(0, 50) }, 200, origin);
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
    // The daily trigger only pulls the NBA file; the weekly ones pull everything.
    await refreshExternalStats(env, event && event.cron === NBA_DAILY_CRON ? ["nba-trend-logs", "nba-injuries"] : null);
  },
};

// Entry point. Every API request passes the security gate first (Cloudflare Access
// and/or password, with lockout; fail closed when neither is configured), and every
// response gets the security headers. See src/security.js.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method !== "OPTIONS") {
      if (pathname.startsWith("/api/")) {
        const auth = await authorize(request, env);
        if (!auth.ok) return withSecurityHeaders(json({ error: auth.error }, auth.status, corsOrigin(request, env)));
      } else if (env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
        // With Access on, the page itself also requires a valid Access session,
        // so the workers.dev URL can't be used to skip the login.
        const v = await verifyAccessJwt(request, env);
        if (!v.ok) return withSecurityHeaders(new Response("Cloudflare Access login required", { status: 403 }));
      }
    }
    return withSecurityHeaders(await app.fetch(request, env, ctx));
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  },
};

// Fetches both published feeds and stores them in R2. Shared by the cron
// handler and the manual /api/refresh-stats endpoint so there is one code path.
//
// Both URLs come from configuration and are never derived from a request,
// which rules out server-side request forgery through this path. Each fetch is
// bounded by a timeout so a hung endpoint cannot stall the invocation.
async function refreshExternalStats(env, only = null) {
  const feeds = [
    // Trimmed because a URL pasted into a prompt commonly carries a trailing
    // newline or space, which makes fetch() throw a bare TypeError rather than
    // anything descriptive.
    { name: "weekly-stats", url: String(env.STATS_FEED_URL || "").trim(), key: STATS_KEY },
    { name: "player-stats", url: String(env.PLAYER_STATS_URL || "").trim(), key: PLAYER_STATS_KEY },
    { name: "trend-logs", url: String(env.TREND_LOGS_URL || "").trim(), key: TREND_LOGS_KEY },
    { name: "nba-trend-logs", url: String(env.NBA_TREND_LOGS_URL || "").trim(), key: NBA_TREND_LOGS_KEY },
    { name: "nba-injuries", url: nbaInjuriesUrl(env), key: NBA_INJURIES_KEY },
  ];
  const results = [];

  for (const feed of feeds) {
    if (only && !only.includes(feed.name)) continue;
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
        if (feed.key === NBA_INJURIES_KEY) data._pulledAt = new Date().toISOString();
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
  :root {
    --bg:#F5F6F8; --surface:#FFFFFF; --surface-2:#F8FAFC; --ink:#0F172A; --ink-2:#475569; --muted:#64748B;
    --line:#E2E8F0; --line-2:#CBD5E1; --accent:#2563EB; --accent-ink:#FFFFFF; --accent-soft:#EFF4FF;
    --green:#15803D; --green-soft:#DCFCE7; --red:#B91C1C; --red-soft:#FEE2E2; --amber:#B45309; --amber-soft:#FEF3C7;
    --heat0:#F9C9C4; --heat1:#FCE4E1; --heat2:#F1F5F9; --heat3:#D9F2E1; --heat4:#B4E3C3; --bar:#2563EB; --bar-track:#E2E8F0;
    --shadow:0 1px 2px rgba(15,23,42,.06), 0 4px 16px rgba(15,23,42,.04); --radius:14px;
    --navy: var(--accent); /* legacy name used by inline styles */
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0B0F17; --surface:#121826; --surface-2:#0F1522; --ink:#E5E9F0; --ink-2:#AAB4C3; --muted:#8792A3;
      --line:#222B3B; --line-2:#2E3A4F; --accent:#5B8CFF; --accent-ink:#0B0F17; --accent-soft:#18233A;
      --green:#4ADE80; --green-soft:#12301F; --red:#F87171; --red-soft:#3A1717; --amber:#FBBF24; --amber-soft:#33270C;
      --heat0:#5A2323; --heat1:#3A2024; --heat2:#1A2130; --heat3:#1D3A2A; --heat4:#24553A; --bar:#5B8CFF; --bar-track:#2A3446;
      --shadow:0 1px 2px rgba(0,0,0,.4); color-scheme: dark;
    }
  }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--bg); color:var(--ink); }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  .topbar { position:sticky; top:0; z-index:20; background:var(--surface); background:color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(10px); border-bottom:1px solid var(--line); }
  .topbar-inner { max-width:1240px; margin:0 auto; padding:12px 20px; display:flex; align-items:center; gap:14px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:-.01em; font-size:16px; }
  .brand .mark { width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg,var(--accent),#7C3AED);
    color:#fff; display:grid; place-items:center; font-size:13px; font-weight:800; }
  .brand small { font-weight:600; color:var(--muted); font-size:12px; border:1px solid var(--line); border-radius:999px; padding:1px 8px; margin-left:4px; }
  .spacer { flex:1; }
  nav { max-width:1240px; margin:0 auto; padding:0 20px 10px; display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; }
  nav::-webkit-scrollbar { display:none; }
  nav .group { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; align-self:center; padding:0 4px 0 10px; }
  nav .group:first-child { padding-left:0; }
  nav button { background:transparent; border:1px solid transparent; color:var(--ink-2); border-radius:999px; padding:7px 14px;
    font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
  nav button:hover { background:var(--surface-2); color:var(--ink); }
  nav button.active { background:var(--accent-soft); color:var(--accent); border-color:var(--line-2); border-color:color-mix(in srgb, var(--accent) 25%, transparent); }
  main { max-width:1240px; margin:0 auto; padding:22px 20px 80px; }
  section { display:none; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:22px 22px 26px; }
  section.active { display:block; animation: fade .18s ease-out; }
  @keyframes fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  h2 { margin:0 0 4px; font-size:20px; letter-spacing:-.015em; }
  .hint { font-size:12.5px; color:var(--muted); margin:6px 0; }
  code { background:var(--surface-2); border:1px solid var(--line); border-radius:6px; padding:0 5px; font-size:12px; }
  button { font:inherit; font-size:13px; font-weight:600; border-radius:10px; border:1px solid var(--line-2); background:var(--surface);
    color:var(--ink); padding:7px 14px; cursor:pointer; transition: background .12s, border-color .12s; }
  button:hover { background:var(--surface-2); }
  button:disabled { opacity:.55; cursor:default; }
  .btn-primary, .submit-btn, #tgRefresh, #nbRefresh, #refreshScored, #refreshTop, #loginBtn, #nbSaveLines {
    background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  .btn-primary:hover, .submit-btn:hover, #tgRefresh:hover, #nbRefresh:hover, #refreshScored:hover, #refreshTop:hover, #loginBtn:hover, #nbSaveLines:hover {
    background:var(--accent); filter:brightness(.92); }
  .submit-btn { margin-top:16px; padding:10px 20px; }
  input, select, textarea { font:inherit; font-size:13px; color:var(--ink); background:var(--surface); border:1px solid var(--line-2);
    border-radius:9px; padding:7px 9px; outline:none; transition: border-color .12s, box-shadow .12s; }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  input[type=checkbox] { width:15px; height:15px; accent-color:var(--accent); vertical-align:-2px; }
  form.grid { display:grid; grid-template-columns: repeat(auto-fill,minmax(190px,1fr)); gap:12px 14px; margin-top:16px; }
  form.grid label { font-size:11.5px; font-weight:600; color:var(--ink-2); display:block; margin-bottom:4px; }
  form.grid input, form.grid select { width:100%; }
  .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:14px 0 6px; }
  .tg-controls { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin:16px 0 10px; padding:12px;
    background:var(--surface-2); border:1px solid var(--line); border-radius:12px; }
  .tg-controls label { font-size:11.5px; font-weight:600; color:var(--ink-2); display:block; margin-bottom:4px; }
  .tablewrap { overflow-x:auto; margin-top:12px; border:1px solid var(--line); border-radius:12px; }
  table { border-collapse:separate; border-spacing:0; width:100%; font-size:13px; }
  .tablewrap table { margin:0; }
  th, td { padding:9px 10px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { position:sticky; top:0; background:var(--surface-2); color:var(--ink-2); font-size:11.5px; font-weight:700;
    text-transform:uppercase; letter-spacing:.05em; z-index:1; }
  tr:last-child td { border-bottom:none; }
  @supports (color: color-mix(in srgb, red 50%, blue)) { table tr:hover td { background:color-mix(in srgb, var(--accent) 4%, transparent); } }
  .over { color:var(--green); font-weight:700; }
  .under { color:var(--red); font-weight:700; }
  .row-actions button { font-size:12px; padding:4px 10px; border-radius:8px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11.5px; font-weight:700; }
  .pill.High { background:var(--green-soft); color:var(--green); }
  .pill.Medium { background:var(--amber-soft); color:var(--amber); }
  .pill.Low { background:var(--surface-2); color:var(--muted); border:1px solid var(--line); }
  /* Tendency Matrix: colors rank each column among the players shown (not a forecast). */
  table.tg td.cell { text-align:center; font-weight:700; min-width:68px; font-variant-numeric:tabular-nums; }
  table.tg td.c0 { background:var(--heat0); } table.tg td.c1 { background:var(--heat1); } table.tg td.c2 { background:var(--heat2); }
  table.tg td.c3 { background:var(--heat3); } table.tg td.c4 { background:var(--heat4); }
  table.tg tr:hover td.cell { filter:brightness(.97); }
  table.tg .bar { height:4px; background:var(--bar-track); border-radius:3px; margin-top:5px; overflow:hidden; }
  table.tg .bar > i { display:block; height:4px; background:var(--bar); border-radius:3px; }
  table.tg th.sorted { color:var(--accent); }
  table.tg td.vals { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .inj { display:inline-block; font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:999px; margin-left:4px; vertical-align:1px;
    color:#9a5b00; background:#fdf0d5; background:color-mix(in srgb, #e8a317 22%, transparent); }
  .inj.out { color:var(--red); background:#fde2e2; background:color-mix(in srgb, var(--red) 16%, transparent); }
  .inj.ok { color:var(--muted); background:var(--surface-2); }
  .tmout { display:block; font-size:11.5px; color:var(--muted); margin-top:2px; }
  .grade { display:inline-block; min-width:30px; text-align:center; padding:2px 7px; border-radius:7px; font-weight:800; font-size:12px; }
  .grade.g-A { background:var(--heat4); color:var(--ink); } .grade.g-B { background:var(--heat2); color:var(--ink); border:1px solid var(--line); }
  .grade.g-C { background:var(--heat1); color:var(--ink); }
  footer.disclaimer { max-width:1240px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:12px; }
  .about p, .about li { max-width:860px; }
  details summary { cursor:pointer; }
  .menu { position:relative; }
  .menu-panel { display:none; position:absolute; right:0; top:calc(100% + 8px); width:300px; background:var(--surface);
    border:1px solid var(--line); border-radius:12px; box-shadow:0 12px 32px rgba(15,23,42,.16); padding:10px; z-index:30; }
  .menu.open .menu-panel { display:block; }
  .menu-panel button { width:100%; text-align:left; margin:2px 0; border-color:transparent; }
  .menu-panel button:hover { border-color:var(--line); }
  #dataOut { font-size:12.5px; margin-top:6px; max-height:260px; overflow:auto; }
  #dataOut table th, #dataOut table td { padding:5px 6px; white-space:normal; }
  #loginScreen { position:fixed; inset:0; background:var(--bg); z-index:999; display:flex; align-items:center; justify-content:center; padding:20px; }
  .login-card { width:100%; max-width:360px; background:var(--surface); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow);
    padding:28px; display:flex; flex-direction:column; gap:12px; }
  .login-card h2 { display:flex; align-items:center; gap:10px; }
  .login-card input { width:100%; padding:10px 12px; font-size:15px; }
  .login-card button { padding:10px; font-size:14px; }
  #loginError { color:var(--red); font-size:13px; min-height:18px; }
  #appRoot { display:none; }
  @media (max-width: 640px) { section { padding:16px; border-radius:12px; } main { padding:14px 12px 60px; } .topbar-inner, nav { padding-left:12px; padding-right:12px; } }
</style>
</head>
<body>
<div id="loginScreen">
  <div class="login-card">
    <h2><span class="brand"><span class="mark">PM</span></span>Prop Model</h2>
    <p class="hint" style="margin:0">Enter your password (leave blank if none was set).</p>
    <input type="password" id="loginInput" placeholder="Password" autocomplete="current-password">
    <button id="loginBtn">Enter</button>
    <div id="loginError"></div>
  </div>
</div>
<div id="appRoot">
<div class="topbar">
  <div class="topbar-inner">
    <div class="brand"><span class="mark">PM</span>Prop Model <small>NFL &middot; NBA</small></div>
    <div class="spacer"></div>
    <div class="menu" id="dataMenu">
      <button id="dataMenuBtn" aria-haspopup="true" aria-expanded="false">Data &#9662;</button>
      <div class="menu-panel" role="menu">
        <button id="refreshStats" role="menuitem">Refresh stat feeds</button>
        <button id="exportData" role="menuitem">Export backup</button>
        <div id="dataOut"></div>
      </div>
    </div>
  </div>
  <nav>
    <span class="group">NFL</span>
    <button data-tab="input" class="active">Add Prop</button>
    <button data-tab="scored">Scored Props</button>
    <button data-tab="top">Model Leaders</button>
    <button data-tab="trends">Tendency Matrix</button>
    <span class="group">NBA</span>
    <button data-tab="nbatrends">Tendency Matrix</button>
    <button data-tab="nbaboard">Board</button>
    <span class="group">Info</span>
    <button data-tab="about">About</button>
  </nav>
</div>
<main>

  <section id="input" class="active">
    <h2>Add a prop</h2>
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
    <h2>Scored props</h2>
    <p class="hint">Every saved prop with the model's projection, spread and side, ranked by the model's probability.</p>
    <div class="toolbar"><button id="refreshScored">Refresh</button></div>
    <div id="scoredTableWrap" class="tablewrap"></div>
  </section>

  <section id="top">
    <h2>Model leaders</h2>
    <p class="hint">Props you entered, ordered by the model's own probability. This is a research view, not picks: in testing the model did not beat closing lines.</p>
    <div class="toolbar"><label class="hint" style="margin:0">Show top <input id="topN" type="number" value="15" style="width:64px"></label><button id="refreshTop">Refresh</button></div>
    <div id="topTableWrap" class="tablewrap"></div>
  </section>

  <section id="trends">
    <h2>NFL Tendency Matrix</h2>
    <p class="hint">How often each player reached each number in his last N regular-season games. Colors rank each column among the players shown. <b>Not a forecast:</b> in the backtest, a player's recent hit rate added nothing to the closing line, and Overs on 5-for-5 streaks did worse than average.</p>
    <div class="tg-controls">
      <div><label>Market</label><select id="tgStat">
        <option value="receptions">Receptions</option><option value="receiving_yards">Receiving Yards</option>
        <option value="targets">Targets</option><option value="rushing_yards">Rushing Yards</option>
        <option value="carries">Carries</option><option value="rush_rec_yards">Rush + Rec Yards</option>
        <option value="passing_yards">Passing Yards</option><option value="completions">Completions</option>
        <option value="attempts">Pass Attempts</option><option value="passing_tds">Passing TDs</option>
      </select></div>
      <div><label>Games</label><select id="tgGames"><option>3</option><option selected>5</option><option>10</option></select></div>
      <div><label>Positions (blank = market default, ALL = all)</label><input id="tgPos" placeholder="WR,TE" style="width:110px"></div>
      <div><label>Min games</label><input id="tgMin" type="number" min="1" max="10" placeholder="auto" style="width:70px"></div>
      <div><label>Sort by</label><input id="tgSort" placeholder="cutoff, e.g. 5" style="width:110px"></div>
      <div><label><input type="checkbox" id="tgSortGrade"> Sort by tendency grade</label></div>
      <div><label>Rows</label><input id="tgLimit" type="number" value="25" style="width:60px"></div>
      <div><label><input type="checkbox" id="tgSlate"> Only players in my props</label></div>
      <div><button id="tgRefresh">Refresh</button></div>
    </div>
    <div id="tgWrap" class="tablewrap"></div>
  </section>

  <section id="nbatrends">
    <h2>NBA Tendency Matrix</h2>
    <p class="hint">How often each player reached each number in his last N regular-season games (default 10). Colors rank each column among the players shown. <b>Not a forecast.</b> Before the new season has games, the window uses last season.</p>
    <div class="tg-controls">
      <div><label>Market</label><select id="nbStat">
        <option value="points">Points</option><option value="rebounds">Rebounds</option><option value="assists">Assists</option>
        <option value="threes">3-Pointers Made</option><option value="pra">Pts + Reb + Ast</option><option value="pr">Pts + Reb</option>
        <option value="pa">Pts + Ast</option><option value="ra">Reb + Ast</option><option value="steals">Steals</option>
        <option value="blocks">Blocks</option><option value="stocks">Steals + Blocks</option><option value="turnovers">Turnovers</option>
      </select></div>
      <div><label>Games</label><select id="nbGames"><option>5</option><option selected>10</option><option>15</option><option>20</option></select></div>
      <div><label>Positions (G, F, C; blank = all)</label><input id="nbPos" placeholder="G,F,C" style="width:90px"></div>
      <div><label>Min games</label><input id="nbMin" type="number" min="1" max="20" placeholder="auto" style="width:70px"></div>
      <div><label>Sort by</label><input id="nbSort" placeholder="cutoff, e.g. 5" style="width:110px"></div>
      <div><label><input type="checkbox" id="nbSortGrade"> Sort by tendency grade</label></div>
      <div><label>Rows</label><input id="nbLimit" type="number" value="25" style="width:60px"></div>
      <div><label><input type="checkbox" id="nbSlate"> Only players in my lines</label></div>
      <div><button id="nbRefresh">Refresh</button></div>
    </div>
    <details style="margin:6px 0 10px">
      <summary class="hint" style="cursor:pointer">My NBA lines (fills the Line column)</summary>
      <p class="hint">One per line: <code>Player, stat, line</code>, e.g. <code>Jalen Brunson, points, 26.5</code>. Stats: points, rebounds, assists, threes, pra, pr, pa, ra, steals, blocks, stocks, turnovers. Saving replaces the list.</p>
      <textarea id="nbLines" rows="6" style="width:100%; font-family:monospace; font-size:12px"></textarea>
      <button id="nbSaveLines" style="margin-top:6px">Save lines</button> <span id="nbLinesOut" class="hint"></span>
    </details>
    <div id="nbWrap" class="tablewrap"></div>
  </section>

  <section id="nbaboard">
    <h2>NBA Board</h2>
    <p class="hint">Kalshi NBA player-prop ladders for the next game day. A side is kept when its <b>buy price</b> is inside the band (66&ndash;75% is roughly &minus;195 to &minus;300), the game has not started, the player is not listed Out or Doubtful, he has recent games and the model is not 10+ points below the market. One rung per player, stat and side. Sorted by <b>market price</b>, with the model as a check: the model has not been shown to beat the market, so ranking by it mostly ranks its own errors. <b>Research tool, not picks.</b> Check lineups before tip-off.</p>
    <div class="tg-controls">
      <div><label>Markets</label>
        <label style="display:inline"><input type="checkbox" class="nbbStat" value="points" checked> Points</label>
        <label style="display:inline"><input type="checkbox" class="nbbStat" value="rebounds" checked> Rebounds</label>
        <label style="display:inline"><input type="checkbox" class="nbbStat" value="assists" checked> Assists</label>
        <label style="display:inline"><input type="checkbox" class="nbbStat" value="threes" checked> 3-Pointers</label></div>
      <div><label>Market price band</label><select id="nbbBand">
        <option value="55-65">55&ndash;65% (about &minus;120 to &minus;185)</option>
        <option value="60-70">60&ndash;70% (about &minus;150 to &minus;235)</option>
        <option value="66-75" selected>66&ndash;75% (about &minus;195 to &minus;300)</option>
        <option value="70-80">70&ndash;80% (about &minus;235 to &minus;400)</option>
        <option value="75-85">75&ndash;85% (about &minus;300 to &minus;565)</option></select></div>
      <div><label>Game day (blank = next)</label><input id="nbbDate" type="date" style="width:150px"></div>
      <div><label>Sort by</label><select id="nbbSort">
        <option value="market" selected>Market price (model as a veto)</option>
        <option value="model">Model estimate (research view)</option></select></div>
      <div><label>Rows</label><input id="nbbLimit" type="number" value="15" style="width:60px"></div>
      <div><label><input type="checkbox" id="nbbAllRungs"> Every rung</label></div>
      <div><label><input type="checkbox" id="nbbForce"> Fresh prices</label></div>
      <div><button id="nbbRefresh">Refresh</button></div>
    </div>
    <div id="nbbWrap" class="tablewrap"></div>
  </section>

  <section id="about" class="about">
    <h2>About this tool</h2>
    <p><b>Prop Model is a research tool.</b> It shows how players have performed recently (Tendency Matrices), what a statistical model projects for props you enter, and how one-sided each player's record has been against a line (tendency grades). It does not sell, offer or recommend picks, and nothing here is betting, financial or legal advice.</p>
    <h3>What the numbers mean</h3>
    <ul>
      <li><b>Tendency Matrix:</b> the share of a player's last N regular-season games in which he reached each number. Colors rank each column among the players shown.</li>
      <li><b>Tendency grade (A+ to C):</b> how consistently and by how much a player finished above or below the line you entered, ranked against the other lines in that market. Fewer than 5 games caps the grade at B+, and a record within one game of even caps it at B. It describes the past only.</li>
      <li><b>Model probability:</b> the model's estimate for a prop you entered. It is an estimate, not a forecast you should rely on.</li>
    </ul>
    <h3>How well it works</h3>
    <p>Tested on 8,913 NFL props with closing lines (2025 season and 2026 weeks 1&ndash;4): a player's recent record against the line added no reliable information beyond the closing line itself, and the model's probabilities did not beat the market. Grades and projections are shown for research, not because they predict results.</p>
    <h3>Data</h3>
    <p>NFL statistics from nflverse; NBA statistics from the NBA's public stats site via nba_api; defensive ratings you enter may come from third parties such as FTN (DVOA). Each source has its own terms of use. This tool is for personal, non-commercial use.</p>
    <h3>Responsible gambling</h3>
    <p>If you choose to bet, you must be of legal age where you live (21+ in most U.S. states). If you or someone you know has a gambling problem, call or text <b>1-800-GAMBLER</b>.</p>
  </section>

</main>
<footer class="disclaimer">Research and entertainment only. No picks are sold or offered; tendency grades and model numbers describe data and do not predict results. 21+. Gambling problem? Call 1-800-GAMBLER.</footer>
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

document.querySelectorAll("nav button[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button[data-tab]").forEach(b => b.classList.remove("active"));
    document.querySelectorAll("section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "scored") loadScored();
    if (btn.dataset.tab === "top") loadTop();
    if (btn.dataset.tab === "trends") loadTrends();
    if (btn.dataset.tab === "nbatrends") { loadNbaLines(); loadNbaTrends(); }
    if (btn.dataset.tab === "nbaboard") loadNbaBoard();
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
  // Rank once by probability, matching how Model Leaders and team rank already
  // sort, so "select top N" here means the same thing it means everywhere
  // else in the app rather than the order props happened to be entered.
  const ranked = rows.slice().sort((a,b) => (b.leanProb ?? -1) - (a.leanProb ?? -1));
  const rankOf = new Map(ranked.map((r,i) => [r.id, i+1]));

  let html = "<table><tr>" +
    "<th>#</th><th>Team</th><th>Player</th><th>Prop</th><th>Line</th><th>Proj</th>" +
    "<th>SD</th><th>Dist</th><th>P(play)</th><th>Model prob</th><th>Push</th><th>Model side</th>" +
    "<th>Tier</th>" + (showActions ? "<th></th>" : "") + "</tr>";
  for (const r of ranked) {
    const prob = r.leanProb !== null && r.leanProb !== undefined ? (r.leanProb * 100).toFixed(1) + "%" : "n/a";
    const push = r.pPush ? (r.pPush * 100).toFixed(1) + "%" : "";
    const pplay = r.playProbability !== undefined ? (r.playProbability * 100).toFixed(0) + "%" : "";
    const distLabel = { yardage: "norm", count: "negbin", td: "pois" }[r.kind] || "";
    html += "<tr>" +
      "<td>" + rankOf.get(r.id) + "</td><td>" + esc(r.team) + "</td><td>" + esc(r.player) + "</td><td>" + esc(r.propType) +
      "</td><td>" + esc(r.line) + "</td><td>" + esc(r.finalProjection ?? "") +
      "</td><td title='" + esc(r.varianceSource || "") + "'>" + esc(r.sd ?? "") +
      "</td><td>" + esc(distLabel) + "</td><td>" + esc(pplay) +
      "</td><td>" + esc(prob) + "</td><td>" + esc(push) +
      "</td><td class='" + (r.lean==="OVER"?"over":"under") + "'>" + esc(r.lean) +
      "</td><td><span class='pill " + esc(r.confidence) + "'>" + esc(r.confidence) + "</span></td>";
    if (showActions) html += "<td class='row-actions'><button data-id='" + esc(r.id) + "' class='delBtn'>Delete</button></td>";
    html += "</tr>";
  }
  // Same-game props are not independent. Surfacing this matters for two
  // reasons: correlated misses cluster and make calibration look worse than
  // the model deserves, and parlay math across same-game legs is badly wrong
  // under an independence assumption.
  const grouped = {};
  for (const r of rows) if (r.gameKey) (grouped[r.gameKey] = grouped[r.gameKey] || []).push(r);
  const multi = Object.entries(grouped).filter(([,v]) => v.length > 1);
  if (multi.length) {
    html += "</table><div style='margin:12px;padding:12px;background:var(--amber-soft);border:1px solid var(--amber);border-radius:10px;font-size:12.5px'>";
    html += "<b>Correlated exposure</b><br>";
    for (const [k, v] of multi) {
      const dirs = v[0].correlatedWith ? v[0].correlatedWith.map(c=>c.direction) : [];
      const pos = dirs.filter(d=>d==="positive").length;
      const neg = dirs.filter(d=>d==="negative").length;
      html += esc(k) + ": " + v.length + " props (" + v.map(x=>esc(x.player)).join(", ") + ")";
      if (pos||neg) html += " &mdash; " + pos + " positively, " + neg + " negatively correlated with the first";
      html += "<br>";
    }
    html += "<span class='hint'>These outcomes move together. One blowout can resolve several at once, " +
      "so treat them as fewer independent data points than the count suggests, and do not multiply " +
      "their probabilities for a same-game parlay.</span></div><p class='hint'>Dist: norm = normal (yardage)";
  } else {
    html += "</table><p class='hint'>Dist: norm = normal (yardage)";
  }
  return html + ", negbin = negative binomial (counts), pois = Poisson (touchdowns). Hover SD to see how it was derived.</p>";
}

function attachDeleteHandlers() {
  document.querySelectorAll(".delBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(API + "/api/props/" + encodeURIComponent(btn.dataset.id), { method: "DELETE", headers: authHeaders() });
      loadScored();
    });
  });
}

// Data menu: refresh the published stat feeds, download a backup.
const dataMenu = document.getElementById("dataMenu");
document.getElementById("dataMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = dataMenu.classList.toggle("open");
  document.getElementById("dataMenuBtn").setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => { if (!dataMenu.contains(e.target)) dataMenu.classList.remove("open"); });
document.getElementById("exportData").addEventListener("click", async () => {
  const out = document.getElementById("dataOut");
  const res = await fetch(API + "/api/export", { headers: authHeaders() });
  if (!res.ok) { out.innerHTML = "<span style='color:var(--red)'>Export failed</span>"; return; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "nfl-prop-backup-" + new Date().toISOString().slice(0,10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  out.innerHTML = "<span class='hint'>Backup downloaded.</span>";
});
document.getElementById("refreshStats").addEventListener("click", async () => {
  const out = document.getElementById("dataOut");
  out.innerHTML = "<span class='hint'>Refreshing feeds...</span>";
  const res = await fetch(API + "/api/refresh-stats", { method: "POST", headers: authHeaders() });
  const d = await res.json().catch(() => ({}));
  out.innerHTML = "<table><tr><th>Feed</th><th>Status</th></tr>" +
    (d.results || []).map(r => "<tr><td>" + esc(r.feed) + "</td><td>" + (r.ok ? "<span class='over'>ok</span> " + esc(r.records) + " records" :
      "<span class='under'>failed</span> " + esc(r.reason)) + "</td></tr>").join("") + "</table>";
});

async function loadTrends() {
  const wrap = document.getElementById("tgWrap");
  const q = new URLSearchParams();
  q.set("stat", document.getElementById("tgStat").value);
  q.set("games", document.getElementById("tgGames").value);
  const pos = document.getElementById("tgPos").value.trim();
  if (pos) q.set("pos", pos);
  const min = document.getElementById("tgMin").value; if (min) q.set("min", min);
  const sort = document.getElementById("tgSort").value; if (sort) q.set("sort", sort);
  if (document.getElementById("tgSortGrade").checked) q.set("sort", "grade");
  q.set("limit", document.getElementById("tgLimit").value || 25);
  if (document.getElementById("tgSlate").checked) q.set("slate", "1");
  wrap.innerHTML = "<p class='hint'>Loading...</p>";
  const res = await fetch(API + "/api/trends?" + q.toString(), { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { wrap.innerHTML = "<p class='hint'>" + esc(data.error || "Could not load") + ". " + esc(data.hint || "") + "</p>"; return; }
  wrap.innerHTML = renderTrendGrid(data);
}
function renderTrendGrid(g) {
  if (!g.rows || !g.rows.length) return "<p class='hint'>No players meet the filters (try fewer games or min games).</p>";
  const fmt = (v) => (Math.round(v * 10) / 10).toString();
  let h = "<table class='tg'><tr><th>Player</th><th>Pos</th><th>Line</th><th title='" + esc(g.gradeNote || "") + "'>Tendency grade &#9432;</th>";
  g.cutoffs.forEach(c => { h += "<th class='" + (c === g.sortBy ? "sorted" : "") + "'>" + esc(c) + "+</th>"; });
  const showMin = g.rows.some(r => r.avgMinutes !== null && r.avgMinutes !== undefined);
  const nbaCtx = g.sport === "nba" && g.rows.some(r => r.matchup || r.model);
  h += "<th>Above line</th><th>Avg</th>" + (showMin ? "<th>Min</th>" : "");
  if (nbaCtx) h += "<th title='" + esc(g.context ? g.context.note : "") + "'>Next opp &#9432;</th><th title='Opponent pace rank, 1 = fastest'>Pace</th><th title='Opponent defensive rating rank, 1 = best defense'>DRtg</th><th title='What the opponent allows to this position, 1 = least, 30 = most'>DvP</th><th title='Model estimate for the entered line (or the projected average when no line is entered). Not a pick.'>Model</th>";
  h += "<th>Last " + esc(g.games) + " (newest first)</th></tr>";
  g.rows.forEach(r => {
    h += "<tr><td><b>" + esc(r.player) + "</b> <span class='hint'>" + esc(r.team || "") + "</span>" + injBadge(r.injury) +
      (r.teammatesOut && r.teammatesOut.length ? "<span class='tmout'>Teammates out: " + r.teammatesOut.map(esc).join(", ") + "</span>" : "") +
      "</td><td>" + esc(r.position || "") + "</td>";
    h += "<td>" + (r.line === null ? "-" : esc(r.line)) + "</td>";
    h += r.grade
      ? "<td title='" + esc(r.grade.basis + " (" + r.grade.percentile + "th percentile of graded lines). " + (g.gradeNote || "")) + "'><span class='grade g-" + esc(r.grade.letter.charAt(0)) + "'>" + esc(r.grade.letter) + "</span> <span class='hint'>" + (r.grade.direction === "above" ? "&#8593; above" : "&#8595; below") + "</span></td>"
      : "<td class='hint'>enter a line</td>";
    g.cutoffs.forEach(c => {
      const v = r.hits[c], b = r.bucket ? r.bucket[c] : null;
      h += "<td class='cell c" + (b === null || b === undefined ? 2 : b) + "'>" + Math.round(v * 100) + "%<div class='bar'><i style='width:" + Math.round(v * 100) + "%'></i></div></td>";
    });
    h += "<td>" + (r.overLineRate === null ? "-" : Math.round(r.overLineRate * 100) + "%") + "</td>";
    h += "<td>" + fmt(r.avg) + "</td>" + (showMin ? "<td>" + (r.avgMinutes === null ? "-" : fmt(r.avgMinutes)) + "</td>" : "");
    if (nbaCtx) {
      const m = r.matchup, md = r.model;
      h += m ? "<td>" + (m.home ? "vs " : "@ ") + esc(m.opp) + " <span class='hint'>" + esc(tipEt(m.tip)) + "</span></td>" : "<td class='hint'>-</td>";
      h += "<td>" + rankCell(m && m.paceRank, "fast", "slow") + "</td><td>" + rankCell(m && m.drtgRank, "tough", "soft") + "</td>";
      h += "<td>" + (m && m.dvp ? rankCell(m.dvp.rank, "tough", "soft", m.dvp.of) + " <span class='hint'>vs " + esc(m.dvp.group) + "</span>" : "<span class='hint'>-</span>") + "</td>";
      h += "<td>" + (!md ? "-" : md.pOver !== null && md.pOver !== undefined
        ? (md.pOver >= md.pUnder ? Math.round(md.pOver * 100) + "% over" : Math.round(md.pUnder * 100) + "% under") + " <span class='hint'>proj " + fmt(md.mean) + (md.pPlays < 1 ? ", if he plays (~" + Math.round(md.pPlays * 100) + "% chance)" : "") + "</span>"
        : "<span class='hint'>proj " + fmt(md.mean) + "</span>") + "</td>";
    }
    h += "<td class='vals' title='" + esc((r.weeks || []).join(", ")) + "'>" + r.values.map(fmt).map(esc).join(", ") + "</td></tr>";
  });
  h += "</table><p class='hint'>" + esc(g.note) + " Data: " + esc(g.source) + (g.generatedAt ? ", generated " + esc(String(g.generatedAt).slice(0, 16).replace("T", " ")) + " UTC" : "") +
    (g.latestGameDate ? ". Latest game " + esc(g.latestGameDate) : "") +
    ". Lines come from " + (g.sport === "nba" ? "your NBA lines" : "props you have entered") + ". Sorted by " + esc(g.sortBy) + "+." +
    (g.windowSeasonFallback ? " No games yet this season, so the window uses last season." : "") +
    (g.sport === "nba" ? " " + esc(injMeta(g.injuries)) : "") +
    " <b>Tendency grades</b> describe how one-sided each player's record against the entered line has been, ranked within this market. They are not predictions or picks; in testing, recent records against the line did not predict the next result.</p>";
  return h;
}
function injBadge(inj) {
  if (!inj) return "";
  const cls = inj.status === "Out" || inj.status === "Doubtful" ? "inj out" : inj.status === "Questionable" ? "inj" : "inj ok";
  return "<span class='" + cls + "' title='" + esc(inj.status + (inj.reason ? ": " + inj.reason : "")) + "'>" + esc(inj.status) + "</span>";
}
function injMeta(m) {
  if (!m) return "Injury report: not loaded yet (run the 'NBA injury report' GitHub Action).";
  const t = m.reportTime ? new Date(m.reportTime).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "";
  return "Injury report: " + (m.source || "") + (t ? ", " + t : "") + (m.stale ? " (over 18 hours old)" : "") + ".";
}
function tipEt(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET"; }
  catch (e) { return ""; }
}
function rankCell(rank, lowWord, highWord, of) {
  if (!rank) return "<span class='hint'>-</span>";
  const n = of || 30, word = rank <= Math.round(n / 3) ? lowWord : rank > n - Math.round(n / 3) ? highWord : "";
  return "#" + esc(rank) + (word ? " <span class='hint'>" + esc(word) + "</span>" : "");
}
function amOdds(p) {
  if (!(p > 0 && p < 1)) return "";
  return p >= 0.5 ? "-" + Math.round(100 * p / (1 - p)) : "+" + Math.round(100 * (1 - p) / p);
}
const NBB_LABEL = { points: "points", rebounds: "rebounds", assists: "assists", threes: "3-pointers" };
async function loadNbaBoard() {
  const wrap = document.getElementById("nbbWrap");
  const stats = [...document.querySelectorAll(".nbbStat")].filter(x => x.checked).map(x => x.value);
  if (!stats.length) { wrap.innerHTML = "<p class='hint'>Pick at least one market.</p>"; return; }
  const band = document.getElementById("nbbBand").value, date = document.getElementById("nbbDate").value;
  const limit = Math.max(1, Math.min(100, Number(document.getElementById("nbbLimit").value) || 15));
  wrap.innerHTML = "<p class='hint'>Loading Kalshi prices...</p>";
  const results = await Promise.all(stats.map(async st => {
    const q = new URLSearchParams({ stat: st, band, limit: "100" });
    if (date) q.set("date", date);
    if (document.getElementById("nbbForce").checked) q.set("refresh", "1");
    q.set("sort", document.getElementById("nbbSort").value);
    if (document.getElementById("nbbAllRungs").checked) q.set("allRungs", "1");
    const res = await fetch(API + "/api/nba-board?" + q.toString(), { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { stat: st, ok: res.ok, data };
  }));
  const failed = results.filter(r => !r.ok);
  const byModel = document.getElementById("nbbSort").value === "model";
  const rows = results.filter(r => r.ok).flatMap(r => r.data.rows || [])
    .sort(byModel ? (a, b) => b.model - a.model || b.market - a.market : (a, b) => b.market - a.market || b.model - a.model).slice(0, limit);
  const ok = results.find(r => r.ok);
  let h = "";
  if (failed.length) h += "<p class='hint'>" + failed.map(f => esc(NBB_LABEL[f.stat]) + ": " + esc(f.data.error || "failed") + (f.data.detail ? " (" + esc(f.data.detail) + ")" : "") + (f.data.hint ? ". " + esc(f.data.hint) : "")).join("<br>") + "</p>";
  if (!ok) { wrap.innerHTML = h; return; }
  const d = ok.data;
  h += "<p class='hint'>" + esc(injMeta(d.injuries)) + "</p>";
  h += "<p class='hint'>Game day <b>" + esc(d.date) + "</b> &middot; " + esc(d.games) + " games &middot; prices " + esc(String(d.pricesFetchedAt || "").slice(11, 16)) + " UTC" +
    (d.availableDates && d.availableDates.length > 1 ? " &middot; other days: " + d.availableDates.filter(x => x !== d.date).map(esc).join(", ") : "") + "</p>";
  if (!rows.length) {
    h += "<p class='hint'>Nothing in this band right now. Try another band or game day; lines usually post the morning of the game.</p>";
  } else {
    h += "<table class='tg'><tr><th>#</th><th>Player</th><th>Side</th><th title='Buy price for this side (the ask; mid when there is no quote)'>Market</th><th title='Model estimate, including his chance of playing when he is on the injury report. Not a pick.'>Model</th><th title='Model minus market. The model has not been shown to beat the market; large gaps are more often model error.'>Gap</th><th>Game</th><th title='Opponent pace rank (1 = fastest)'>Pace</th><th title='Opponent defensive rating rank (1 = best)'>DRtg</th><th title='What the opponent allows to this position (1 = least)'>DvP</th><th>Proj</th><th>Last 10 at this number</th></tr>";
    rows.forEach((r, i) => {
      const c = r.context || {}, gm = r.game || {};
      const tm = (r.teammatesOut || []).map(t => esc(t.name) + (t.status === "Doubtful" ? " (D)" : "") + (t.minutes ? " " + esc(t.minutes) + "m" : ""));
      h += "<tr><td>" + (i + 1) + "</td><td><b>" + esc(r.player) + "</b> <span class='hint'>" + esc(r.team || "") + " " + esc(r.position || "") + "</span>" + injBadge(r.injury) +
        (r.reportPending ? " <span class='inj ok' title='This team has not submitted its injury report yet'>report pending</span>" : "") +
        (r.flags && r.flags.backToBack ? " <span class='inj ok' title='His team played the day before (shown, not modeled)'>B2B</span>" : "") +
        (r.flags && r.flags.returning ? " <span class='inj' title='First game in " + esc(r.flags.returning) + " days: minutes may be limited (shown, not modeled)'>back after " + esc(r.flags.returning) + "d</span>" : "") +
        (r.otherRungs ? " <span class='hint' title='Other rungs of this market also qualified; the market favorite is shown'>+" + esc(r.otherRungs) + " rung" + (r.otherRungs > 1 ? "s" : "") + "</span>" : "") +
        (r.sameGameRows ? " <span class='hint' title='He also appears in another market on this list; those results move together'>&#8635; " + esc(r.sameGameRows) + " more</span>" : "") +
        (tm.length ? "<span class='tmout'>Teammates out: " + tm.join(", ") + "</span>" : "") + "</td>";
      h += "<td>" + esc(r.side) + " " + esc(r.line) + " " + esc(NBB_LABEL[r.stat] || r.stat) + " <span class='hint'>(" + esc(r.rung) + ")</span></td>";
      h += "<td>" + Math.round(r.market * 100) + "&cent; <span class='hint'>" + esc(amOdds(r.market)) + (r.priceBasis === "mid" ? " mid" : "") + "</span></td>";
      h += "<td><b>" + Math.round(r.model * 100) + "%</b>" + (r.pPlays < 1 ? " <span class='hint' title='" + esc(Math.round(r.modelIfPlays * 100) + "% if he plays, times a rough " + Math.round(r.pPlays * 100) + "% chance he plays") + "'>(" + Math.round(r.modelIfPlays * 100) + "% if plays)</span>" : "") + (r.caution ? " <span title='" + esc(r.caution) + "'>&#9888;</span>" : "") + "</td>";
      h += "<td>" + (r.gap >= 0 ? "+" : "") + Math.round(r.gap * 100) + "</td>";
      h += "<td>" + (gm.opp ? (gm.home ? "vs " : "@ ") + esc(gm.opp) + " <span class='hint'>" + esc(tipEt(gm.tip)) + "</span>" : esc(gm.date || "")) + "</td>";
      h += "<td>" + rankCell(c.paceRank, "fast", "slow") + "</td><td>" + rankCell(c.drtgRank, "tough", "soft") + "</td>";
      h += "<td>" + (c.dvp ? rankCell(c.dvp.rank, "tough", "soft", c.dvp.of) : "<span class='hint'>-</span>") + "</td>";
      h += "<td>" + (Math.round(r.projection * 10) / 10) + (r.minutes ? " <span class='hint'>" + Math.round(r.minutes) + " min</span>" : "") + "</td>";
      h += "<td class='vals'>" + esc(r.last10Record) + ": " + r.last10.map(esc).join(", ") + "</td></tr>";
    });
    h += "</table>";
  }
  const ex = {};
  results.filter(r => r.ok).forEach(r => Object.entries(r.data.excluded || {}).forEach(([k, v]) => { ex[k] = (ex[k] || 0) + v; }));
  const unk = results.filter(r => r.ok).flatMap(r => r.data.unknownPlayers || []);
  const hurt = [...new Map(results.filter(r => r.ok).flatMap(r => r.data.injuredSkipped || []).map(x => [x.name, x])).values()];
  h += "<p class='hint'>" + esc(d.note) + " Skipped: " + esc(ex.injured || 0) + " lines for players listed Out or Doubtful" +
    (hurt.length ? " (" + hurt.slice(0, 10).map(x => esc(x.name) + " " + esc(x.status)).join(", ") + (hurt.length > 10 ? ", ..." : "") + ")" : "") + ", " +
    esc(ex.started || 0) + " already tipped off, " + esc(ex.notOnSchedule || 0) + " not on the schedule" +
    (results.some(r => r.ok && (r.data.notOnSchedule || []).length) ? " (" + [...new Set(results.filter(r => r.ok).flatMap(r => r.data.notOnSchedule || []))].slice(0, 6).map(esc).join(", ") + ": postponed, moved or a stale schedule)" : "") + ", " +
    esc(ex.inactive || 0) + " no recent games, " + esc(ex.duplicateRung || 0) + " extra rungs, " +
    esc(ex.wideSpread || 0) + " wide spreads, " + esc(ex.modelDisagrees || 0) + " where the model disagrees by 10+ points, " + esc(ex.unknownPlayer || 0) + " players not in the game logs" +
    (unk.length ? " (" + unk.slice(0, 8).map(esc).join(", ") + (unk.length > 8 ? ", ..." : "") + ")" : "") + "." +
    (d.scheduleIncluded ? "" : " The NBA data has no schedule yet, so started games can't be detected: re-run the NBA GitHub Action and refresh stat feeds.") + "</p>";
  wrap.innerHTML = h;
}
document.getElementById("nbbRefresh").addEventListener("click", loadNbaBoard);
document.getElementById("tgRefresh").addEventListener("click", loadTrends);

async function loadNbaTrends() {
  const wrap = document.getElementById("nbWrap");
  const q = new URLSearchParams();
  q.set("sport", "nba");
  q.set("stat", document.getElementById("nbStat").value);
  q.set("games", document.getElementById("nbGames").value);
  const pos = document.getElementById("nbPos").value.trim(); if (pos) q.set("pos", pos);
  const min = document.getElementById("nbMin").value; if (min) q.set("min", min);
  const sort = document.getElementById("nbSort").value; if (sort) q.set("sort", sort);
  if (document.getElementById("nbSortGrade").checked) q.set("sort", "grade");
  q.set("limit", document.getElementById("nbLimit").value || 25);
  if (document.getElementById("nbSlate").checked) q.set("slate", "1");
  wrap.innerHTML = "<p class='hint'>Loading...</p>";
  const res = await fetch(API + "/api/trends?" + q.toString(), { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { wrap.innerHTML = "<p class='hint'>" + esc(data.error || "Could not load") + ". " + esc(data.hint || "") + "</p>"; return; }
  wrap.innerHTML = renderTrendGrid(data);
}
async function loadNbaLines() {
  const res = await fetch(API + "/api/nba-lines", { headers: authHeaders() });
  if (!res.ok) return;
  const list = await res.json().catch(() => []);
  document.getElementById("nbLines").value = list.map(l => l.player + ", " + l.stat + ", " + l.line).join("\\n");
}
document.getElementById("nbRefresh").addEventListener("click", loadNbaTrends);
document.getElementById("nbSaveLines").addEventListener("click", async () => {
  const res = await fetch(API + "/api/nba-lines", { method: "POST", headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ text: document.getElementById("nbLines").value }) });
  const out = await res.json().catch(() => ({}));
  document.getElementById("nbLinesOut").textContent = res.ok
    ? "Saved " + out.saved + (out.rejected && out.rejected.length ? "; skipped " + out.rejected.length + ": " + out.rejected.map(r => r.line + " (" + r.reason + ")").join("; ") : "")
    : (out.error || "Save failed");
  if (res.ok) loadNbaTrends();
});

</script>
</body>
</html>`;
