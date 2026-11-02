import { trackerDupeKey, gradeResult, autogradeEntries, picksSummary, closeFromCandles, needsClose } from "./tracker.js";
import { scoreProp, rankByTeam, calibration, matchPlayerStat,
         annotateCorrelation, betPerformance, breakEvenRate, propTypeToStatKey } from "./model.js";
import { authorize, verifyAccessJwt, withSecurityHeaders, scriptHashFor, htmlCsp } from "./security.js";
import { buildTrendGrid, linesFromProps, linesFromList, linesFromKalshi, parseLinesText, MARKETS, SPORTS } from "./trends.js";
import { teamContext, decorateNbaGrid } from "./nba_model.js";
import { KALSHI_NBA_SERIES, parseKalshiMarket, eventDate, buildNbaBoard } from "./nba_board.js";
import { injuryIndex } from "./nba_injuries.js";
import { KALSHI_NFL_SERIES, buildNflBoard } from "./nfl_board.js";
import { userPrefix, isOwner, scopedBucket } from "./users.js";

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
// Kalshi markets for one stat series on one game day. Lists the series' events
// (one per game), keeps that day's games, then reads each game's markets. Done per
// stat so one request stays small (Workers' CPU and subrequest limits). Cached in
// R2 for 5 minutes; a forced refresh is still limited to once a minute.
// Events are listed without a status filter: Kalshi has reported upcoming games'
// events as not "open" while their markets were already trading, so the day is
// chosen by the date in the event ticker instead.
async function kalshiMarkets(env, { series, stat, key, date, force, minEvents = 1, maxEvents = 16 }) {
  const cached = await readJson(env.PROP_DATA, key, null);
  const age = cached ? (Date.now() - Date.parse(cached.fetchedAt)) / 1000 : Infinity;
  const sameDay = cached && (!date || cached.date === date);
  if (cached && sameDay && (age < KALSHI_CACHE_SECONDS && !force || age < 60)) return { ...cached, cached: true };

  const today = easternDate();
  const events = [];
  let cursor = "";
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ series_ticker: series, limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const data = await kalshiGet(env, "/events?" + q.toString());
    for (const e of data.events || []) if (e && e.event_ticker && (eventDate(e.event_ticker) || "") >= today) events.push(e.event_ticker);
    cursor = data.cursor || "";
    if (!cursor) break;
  }
  const counts = {};
  for (const e of events) { const d = eventDate(e); counts[d] = (counts[d] || 0) + 1; }
  const dates = Object.keys(counts).sort();
  // Default: the first day with a full slate (e.g. Sunday rather than one Thursday game).
  const day = date || dates.find((d) => counts[d] >= minEvents) || dates[0] || today;
  const todays = [...new Set(events.filter((e) => eventDate(e) === day))].slice(0, maxEvents);
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
// Closing fair price (bid-ask mid) of each tracked pick's side at kickoff, from Kalshi's public
// candlesticks (1-minute candles over the 3 hours before kickoff; hourly over the day
// before if those are empty; the historical endpoint for long-settled markets).
const CLOSE_PER_REQUEST = 12;
async function kalshiCandles(env, ticker, startTs, endTs, interval) {
  const series = String(ticker).split("-")[0];
  const q = new URLSearchParams({ start_ts: String(startTs), end_ts: String(endTs), period_interval: String(interval) }).toString();
  try {
    const d = await kalshiGet(env, `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?` + q);
    if (d && Array.isArray(d.candlesticks) && d.candlesticks.length) return d.candlesticks;
  } catch (e) { /* try the historical endpoint */ }
  try {
    const d = await kalshiGet(env, `/historical/markets/${encodeURIComponent(ticker)}/candlesticks?` + q);
    return d && Array.isArray(d.candlesticks) ? d.candlesticks : [];
  } catch (e) { return []; }
}
async function captureCloses(env, entries, nowMs = Date.now()) {
  const todo = entries.filter((e) => needsClose(e, nowMs)).slice(0, CLOSE_PER_REQUEST);
  let added = 0; const failed = [];
  for (const e of todo) {
    const k = Math.floor(Date.parse(e.kickoff) / 1000);
    let c = closeFromCandles(await kalshiCandles(env, e.ticker, k - 3 * 3600, k, 1), e.lean, k * 1000);
    if (!c) c = closeFromCandles(await kalshiCandles(env, e.ticker, k - 24 * 3600, k, 60), e.lean, k * 1000);
    if (c) { e.closePrice = c.price; e.closeAt = c.at; e.closeSpread = c.spread; added++; }
    else { e.closeTries = (Number(e.closeTries) || 0) + 1; failed.push({ id: e.id, player: e.player, ticker: e.ticker }); }
  }
  return { added, tried: todo.length, failed };
}
const kalshiNbaMarkets = (env, stat, date, force) =>
  kalshiMarkets(env, { series: KALSHI_NBA_SERIES[stat], stat, key: `kalshi-nba-${stat}.json`, date, force });
const kalshiNflMarkets = (env, stat, date, force) =>
  kalshiMarkets(env, { series: KALSHI_NFL_SERIES[stat], stat, key: `kalshi-nfl-${stat}.json`, date, force, minEvents: 4 });

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
  "played","odds","stake","opponent",
  // v14: picks tracked from the Boards (My Picks). sport nfl|nba, gameDate for NBA
  // grading, marketProb = price paid, source = where it was tracked from.
  "sport","gameDate","marketProb","source","stat","createdAt",
  // v15: closing line value. ticker + kickoff come from the Board; closePrice (the
  // same side's buy price at kickoff) is read from Kalshi's candlesticks afterwards.
  "ticker","kickoff","closePrice","closeAt","closeSpread","closeTries",
  // v16: execution. pickMid / pickSpread = the side's mid and spread when tracked (splits CLV
  // into execution and market movement); limitPrice = the suggested limit; orderType
  // taker|maker sets the fee (maker = a resting limit order, no fee on most markets).
  "pickMid","pickSpread","limitPrice","orderType"];

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
      const dupeKey = trackerDupeKey;
      const existing = new Set(entries.map(dupeKey));

      const added = [], skipped = [];
      for (const raw of items) {
        const clean = sanitizeRecord(raw, TRACKER_FIELDS);
        if (!clean.player) { skipped.push({ player: raw?.player, reason: "missing player" }); continue; }
        const key = dupeKey(clean);
        if (existing.has(key)) { skipped.push({ player: clean.player, reason: "already tracked" }); continue; }
        if (entries.length >= MAX_ARRAY_LEN) { skipped.push({ player: clean.player, reason: "storage limit reached" }); continue; }
        clean.id = crypto.randomUUID();
        if (!clean.createdAt) clean.createdAt = new Date().toISOString();
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
        const result = gradeResult(e);
        return { ...e, result: result === "VOID" ? "" : result };
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
      const [statsDoc, nbaDoc, entries] = await Promise.all([
        readJson(env.PROP_DATA, PLAYER_STATS_KEY, null),
        readJson(env.PROP_DATA, NBA_TREND_LOGS_KEY, null),
        readJson(env.PROP_DATA, TRACKER_KEY, []),
      ]);
      const nflRows = statsDoc && Array.isArray(statsDoc.players) ? statsDoc.players : [];
      const nbaRows = nbaDoc && Array.isArray(nbaDoc.players) ? nbaDoc.players : [];
      const apply = request.method === "POST";
      // Only blank results are filled, so a value entered or corrected by hand is
      // never overwritten; anything not cleanly matched is listed for manual entry.
      const r = autogradeEntries(entries, { nflRows, nbaRows, apply });
      // Closing prices for picks whose game has started (a few per request: subrequest limits).
      const closes = apply ? await captureCloses(env, entries) : { added: 0, tried: 0, failed: [] };
      if (apply && (r.applied.length || closes.tried)) await writeJson(env.PROP_DATA, TRACKER_KEY, entries);
      return json({
        mode: apply ? "applied" : "dry-run",
        statsGeneratedAt: statsDoc ? statsDoc.generatedAt : null,
        weeksAvailable: statsDoc ? statsDoc.weeksIncluded || [] : [],
        nbaLatestGame: nbaDoc ? nbaDoc.latestGameDate || null : null,
        appliedCount: r.applied.length, applied: r.applied,
        needsReviewCount: r.needsReview.length, needsReview: r.needsReview,
        pendingCount: r.pending.length, pending: r.pending,
        closesAdded: closes.added, closesTried: closes.tried, closesFailed: closes.failed,
      }, 200, origin);
    }

    // ---- My Picks: every tracked pick with its result, plus the running record ----
    if (pathname === "/api/picks" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const entries = await readJson(env.PROP_DATA, TRACKER_KEY, []);
      return json(picksSummary(entries), 200, origin);
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
      // Kalshi lines fill in every player Kalshi lists for the next slate (the rung closest
      // to 50/50). Lines you entered yourself take priority. Skipped for past dates/weeks,
      // with kalshi=0, or when Kalshi can't be reached (the grid still works without them).
      const userLines = { ...lines };
      let kalshiLines = {}, kalshiMeta = null;
      const series = sport === "nba" ? KALSHI_NBA_SERIES[stat] : KALSHI_NFL_SERIES[stat];
      const pastView = (sport === "nba" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) || (sport === "nfl" && q.get("week"));
      if (series && q.get("kalshi") !== "0" && !pastView) {
        try {
          const km = sport === "nba" ? await kalshiNbaMarkets(env, stat, null, false) : await kalshiNflMarkets(env, stat, null, false);
          kalshiLines = linesFromKalshi(km.markets);
          kalshiMeta = { date: km.date, fetchedAt: km.fetchedAt, players: Object.keys(kalshiLines).length };
        } catch (e) { kalshiMeta = { error: "Kalshi lines unavailable right now" }; }
        for (const [norm, k] of Object.entries(kalshiLines)) {
          if (!Number.isFinite(lines[norm])) lines[norm] = k.line;
          slatePlayers.push(k.player);
        }
      }
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
      for (const r of grid.rows || []) {
        if (r.line === null || r.line === undefined) continue;
        if (Number.isFinite(userLines[r.norm])) r.lineSource = "you";
        else if (kalshiLines[r.norm]) { r.lineSource = "kalshi"; r.linePrice = kalshiLines[r.norm].price; }
      }
      return json({ ...grid, source, kalshiLines: kalshiMeta, generatedAt: doc.generatedAt || null, latestGameDate: doc.latestGameDate || null,
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
      if (!(lo >= 0.15 && hi <= 0.97 && lo < hi)) { lo = 0.66; hi = 0.75; }
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
      // Coin-flip and plus-money bands (low edge under 55%): keep only sides where the model is 5+
      // points above the price, and set aside 15+ point gaps as likely data errors.
      const coinFlip = lo < 0.55;
      const board = buildNbaBoard({ markets: km.markets, doc, ctx: nbaContextFor(doc), season, band: [lo, hi], limit: limitN,
        minGap: coinFlip ? 0.05 : undefined, errorGap: coinFlip ? 0.15 : undefined,
        injuries: await nbaInjuries(env), sortBy: ["model", "edge"].includes(q.get("sort")) ? q.get("sort") : "market",
        onePerPlayer: q.get("allRungs") !== "1", dnpRule: String(env.KALSHI_DNP_RULE || "no").trim() === "void" ? "void" : "no" });
      return json({ ...board, stat, date: km.date, availableDates: km.availableDates, games: km.games, marketsSeen: km.markets.length,
        pricesFetchedAt: km.fetchedAt, pricesCached: km.cached, logsGeneratedAt: doc.generatedAt || null,
        scheduleIncluded: Array.isArray(doc.upcoming) && doc.upcoming.length > 0, source: "Kalshi public market data" }, 200, origin);
    }

    // ---- NFL Board: Kalshi NFL prop ladders in a price band, scored with the NFL model ----
    // GET /api/nfl-board?stat=rushing_yards&band=66-75&limit=25&date=2026-10-25&refresh=1&sort=model|market
    if (pathname === "/api/nfl-board" && request.method === "GET") {
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401, origin);
      const q = url.searchParams;
      const stat = q.get("stat") || "receptions";
      if (!KALSHI_NFL_SERIES[stat]) return json({ error: "unknown stat", stats: Object.keys(KALSHI_NFL_SERIES) }, 400, origin);
      const bandM = String(q.get("band") || "66-75").match(/^(\d{2})-(\d{2})$/);
      let lo = bandM ? Number(bandM[1]) / 100 : 0.66, hi = bandM ? Number(bandM[2]) / 100 : 0.75;
      if (!(lo >= 0.15 && hi <= 0.97 && lo < hi)) { lo = 0.66; hi = 0.75; }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "") ? q.get("date") : null;
      const limitN = Math.min(100, Math.max(1, parseInt(q.get("limit"), 10) || 25));
      const trend = await readJsonCached(env.PROP_DATA, TREND_LOGS_KEY, null);
      if (!trend || !Array.isArray(trend.players) || !trend.players.length) {
        return json({ error: "no NFL game logs yet", hint: "Run the weekly GitHub Action, then Data > Refresh stat feeds." }, 503, origin);
      }
      const weekly = await readJson(env.PROP_DATA, STATS_KEY, null);
      let km;
      try { km = await kalshiNflMarkets(env, stat, date, q.get("refresh") === "1"); }
      catch (err) { return json({ error: "could not reach Kalshi", detail: String(err && err.message || err).slice(0, 120) }, 502, origin); }
      const board = buildNflBoard({ markets: km.markets, trend, weekly, band: [lo, hi], limit: limitN, minGap: lo < 0.55 ? 0.05 : undefined,
        sortBy: ["market", "edge"].includes(q.get("sort")) ? q.get("sort") : "model", onePerPlayer: q.get("allRungs") !== "1" });
      return json({ ...board, stat, date: km.date, availableDates: km.availableDates, games: km.games, marketsSeen: km.markets.length,
        pricesFetchedAt: km.fetchedAt, pricesCached: km.cached, logsGeneratedAt: trend.generatedAt || null, source: "Kalshi public market data" }, 200, origin);
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
        // Per-account data: with an Access login, saved props, tracker and NBA lines
        // are stored under that email; the owner also sees the data saved before.
        const owner = auth.email ? isOwner(auth.email, env) : false;
        if (pathname === "/api/me") {
          return withSecurityHeaders(json({ email: auth.email, owner, perAccount: Boolean(auth.email) }, 200, corsOrigin(request, env)));
        }
        if (auth.email) {
          // Only the owner may re-pull the shared stat feeds (when OWNER_EMAIL is set).
          if (pathname === "/api/refresh-stats" && env.OWNER_EMAIL && !owner) {
            return withSecurityHeaders(json({ error: "only the owner can refresh the shared stat feeds" }, 403, corsOrigin(request, env)));
          }
          const prefix = await userPrefix(auth.email);
          env = { ...env, PROP_DATA: scopedBucket(env.PROP_DATA, prefix, { legacyFallback: owner }) };
        }
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
<script>
  // Apply the saved theme before the page draws, so there's no white flash in dark mode.
  try { const t = localStorage.getItem("theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch (e) {}
</script>
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
  /* Theme: follows the device unless the moon/sun button picked one (data-theme on <html>). */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0B0F17; --surface:#121826; --surface-2:#0F1522; --ink:#E5E9F0; --ink-2:#AAB4C3; --muted:#8792A3;
      --line:#222B3B; --line-2:#2E3A4F; --accent:#5B8CFF; --accent-ink:#0B0F17; --accent-soft:#18233A;
      --green:#4ADE80; --green-soft:#12301F; --red:#F87171; --red-soft:#3A1717; --amber:#FBBF24; --amber-soft:#33270C;
      --heat0:#5A2323; --heat1:#3A2024; --heat2:#1A2130; --heat3:#1D3A2A; --heat4:#24553A; --bar:#5B8CFF; --bar-track:#2A3446;
      --shadow:0 1px 2px rgba(0,0,0,.4); color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
      --bg:#0B0F17; --surface:#121826; --surface-2:#0F1522; --ink:#E5E9F0; --ink-2:#AAB4C3; --muted:#8792A3;
      --line:#222B3B; --line-2:#2E3A4F; --accent:#5B8CFF; --accent-ink:#0B0F17; --accent-soft:#18233A;
      --green:#4ADE80; --green-soft:#12301F; --red:#F87171; --red-soft:#3A1717; --amber:#FBBF24; --amber-soft:#33270C;
      --heat0:#5A2323; --heat1:#3A2024; --heat2:#1A2130; --heat3:#1D3A2A; --heat4:#24553A; --bar:#5B8CFF; --bar-track:#2A3446;
      --shadow:0 1px 2px rgba(0,0,0,.4); color-scheme: dark;
  }
  #themeBtn { font-size:15px; line-height:1; padding:6px 9px; }
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
  table.tg td.vals { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:normal; min-width:150px; max-width:220px; }
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
  label.chk { display:inline-flex; align-items:center; gap:5px; font-weight:500; margin:2px 12px 2px 0; color:var(--ink); }
  details.opts, details.how { margin:8px 0; }
  details.opts > summary, details.how > summary { font-size:12.5px; color:var(--muted); font-weight:600; padding:4px 0; }
  details.opts > .tg-controls { margin-top:8px; }
  details.how p { max-width:900px; }
  .src { font-size:10px; font-weight:700; padding:0 4px; border-radius:4px; background:var(--accent-soft); color:var(--accent); vertical-align:1px; }
  .src.you { background:var(--amber-soft); color:var(--amber); }
  .lim { font-size:11.5px; color:var(--accent); font-weight:600; }
  .trackBtn { font-size:12px; padding:4px 12px; border-radius:8px; background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  .trackBtn.done { background:var(--surface-2); color:var(--muted); border-color:var(--line); }
  .delBtn { font-size:13px; padding:2px 8px; border-radius:8px; margin-left:4px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0 6px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:12px 14px; background:var(--surface-2); }
  .card span { display:block; font-size:11.5px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .card b { display:block; font-size:24px; margin:4px 0 2px; }
  .card small { color:var(--muted); font-size:12px; }
  .res { font-weight:800; font-size:12px; padding:2px 8px; border-radius:7px; }
  .res.HIT { color:var(--green); background:var(--green-soft); } .res.MISS { color:var(--red); background:#fde2e2; background:color-mix(in srgb, var(--red) 14%, transparent); }
  .res.PUSH, .res.VOID { color:var(--muted); background:var(--surface-2); }
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
    <span id="whoami" class="hint" style="font-size:12.5px"></span>
    <button id="themeBtn" title="Switch light / dark" aria-label="Switch light or dark mode"></button>
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
    <button data-tab="nflboard" class="active">Board</button>
    <button data-tab="trends">Tendency Matrix</button>
    <span class="group">NBA</span>
    <button data-tab="nbaboard">Board</button>
    <button data-tab="nbatrends">Tendency Matrix</button>
    <span class="group">Tracking</span>
    <button data-tab="picks">My Picks</button>
    <span class="group">Manual</span>
    <button data-tab="input">Add Prop</button>
    <button data-tab="scored">Scored Props</button>
    <span class="group">Info</span>
    <button data-tab="about">About</button>
  </nav>
</div>
<main>

  <section id="nflboard" class="active">
    <h2>NFL Board</h2>
    <p class="hint">Kalshi player props in your price band, ranked by the model. Tap <b>Track</b> to add one to My Picks; it is graded automatically after the game.</p>
    <div class="tg-controls">
      <div><label>Markets</label>
        <label class="chk"><input type="checkbox" class="nflbStat" value="receptions" checked> Receptions</label>
        <label class="chk"><input type="checkbox" class="nflbStat" value="receiving_yards" checked> Rec yds</label>
        <label class="chk"><input type="checkbox" class="nflbStat" value="rushing_yards" checked> Rush yds</label>
        <label class="chk"><input type="checkbox" class="nflbStat" value="carries" checked> Rush att</label>
        <label class="chk"><input type="checkbox" class="nflbStat" value="passing_yards" checked> Pass yds</label></div>
      <div><label>Price band</label><select id="nflbBand">
        <option value="17-25">17&ndash;25% (+500 to +300), model 5+ above</option>
        <option value="25-35">25&ndash;35% (+300 to +185), model 5+ above</option>
        <option value="35-45">35&ndash;45% (+185 to +120), model 5+ above</option>
        <option value="48-53">48&ndash;53% (+110 to &minus;115), model 5+ above</option>
        <option value="55-65">55&ndash;65% (&minus;120 to &minus;185)</option>
        <option value="60-70">60&ndash;70% (&minus;150 to &minus;235)</option>
        <option value="66-75" selected>66&ndash;75% (&minus;195 to &minus;300)</option>
        <option value="70-80">70&ndash;80% (&minus;235 to &minus;400)</option>
        <option value="75-85">75&ndash;85% (&minus;300 to &minus;565)</option></select></div>
      <div><button id="nflbRefresh" class="btn-primary">Refresh</button></div>
    </div>
    <details class="opts"><summary>More options</summary>
      <div class="tg-controls">
        <div><label>Game day (blank = next slate)</label><input id="nflbDate" type="date" style="width:150px"></div>
        <div><label>Sort by</label><select id="nflbSort"><option value="model" selected>Model estimate</option><option value="market">Market price</option><option value="edge">Edge (model &divide; price)</option></select></div>
        <div><label>Rows</label><input id="nflbLimit" type="number" value="15" style="width:60px"></div>
        <div><label class="chk"><input type="checkbox" id="nflbForce"> Fresh prices</label></div>
        <div><label class="chk" title="Track records the suggested limit price as what you paid, with no fee (maker)"><input type="checkbox" id="nflbLimitMode"> I use limit orders</label></div>
      </div>
    </details>
    <div id="nflbMeta"></div>
    <div id="nflbWrap" class="tablewrap"></div>
    <details class="how"><summary>How this list is built</summary>
      <p class="hint">Each row is a Kalshi &ldquo;X or more&rdquo; rung (Over = X&minus;0.5; Under is the other side). A side is kept when its buy price is inside the band (in plus-money and coin-flip bands, only when the model is 5+ points above the price), the bid&ndash;ask spread is 14&cent; or less, the game has not kicked off and the model is not 10+ points below the market. One rung per player, stat and side. Sides where the model is 15+ points <i>above</i> the market are set aside as likely data errors. The model has not been shown to beat the market, so read these as most probable, not mispriced. NFL injuries are not loaded automatically: check Friday reports and inactives.</p>
      <div id="nflbNotes"></div>
    </details>
  </section>

  <section id="nbaboard">
    <h2>NBA Board</h2>
    <p class="hint">Kalshi NBA props for the next game day in your price band. Players listed Out or Doubtful are removed. Tap <b>Track</b> to add one to My Picks.</p>
    <div class="tg-controls">
      <div><label>Markets</label>
        <label class="chk"><input type="checkbox" class="nbbStat" value="points" checked> Points</label>
        <label class="chk"><input type="checkbox" class="nbbStat" value="rebounds" checked> Rebounds</label>
        <label class="chk"><input type="checkbox" class="nbbStat" value="assists" checked> Assists</label>
        <label class="chk"><input type="checkbox" class="nbbStat" value="threes" checked> 3-Pointers</label></div>
      <div><label>Price band</label><select id="nbbBand">
        <option value="17-25">17&ndash;25% (+500 to +300), model 5+ above</option>
        <option value="25-35">25&ndash;35% (+300 to +185), model 5+ above</option>
        <option value="35-45">35&ndash;45% (+185 to +120), model 5+ above</option>
        <option value="48-53">48&ndash;53% (+110 to &minus;115), model 5+ above</option>
        <option value="55-65">55&ndash;65% (&minus;120 to &minus;185)</option>
        <option value="60-70">60&ndash;70% (&minus;150 to &minus;235)</option>
        <option value="66-75" selected>66&ndash;75% (&minus;195 to &minus;300)</option>
        <option value="70-80">70&ndash;80% (&minus;235 to &minus;400)</option>
        <option value="75-85">75&ndash;85% (&minus;300 to &minus;565)</option></select></div>
      <div><button id="nbbRefresh" class="btn-primary">Refresh</button></div>
    </div>
    <details class="opts"><summary>More options</summary>
      <div class="tg-controls">
        <div><label>Game day (blank = next)</label><input id="nbbDate" type="date" style="width:150px"></div>
        <div><label>Sort by</label><select id="nbbSort">
          <option value="market" selected>Market price (model as a veto)</option>
          <option value="model">Model estimate</option>
          <option value="edge">Edge (model &divide; price)</option></select></div>
        <div><label>Rows</label><input id="nbbLimit" type="number" value="15" style="width:60px"></div>
        <div><label class="chk"><input type="checkbox" id="nbbAllRungs"> Every rung</label></div>
        <div><label class="chk"><input type="checkbox" id="nbbForce"> Fresh prices</label></div>
        <div><label class="chk" title="Track records the suggested limit price as what you paid, with no fee (maker)"><input type="checkbox" id="nbbLimitMode"> I use limit orders</label></div>
      </div>
    </details>
    <div id="nbbMeta"></div>
    <div id="nbbWrap" class="tablewrap"></div>
    <details class="how"><summary>How this list is built</summary>
      <p class="hint">A side is kept when its buy price is inside the band, the game has not started, the player is not Out or Doubtful, he has recent games and the model is not 10+ points below the market. One rung per player, stat and side. Sorted by market price by default, with the model as a check. In the 48&ndash;53% band (about +110 to &minus;115) a side is kept only if the model is 5+ points above the price; 15+ points above is set aside as a likely data error. Matchup ranks: pace (1 = fastest), defensive rating (1 = best defense) and what the opponent allows to his position (1 = least). Check lineups before tip-off.</p>
      <div id="nbbNotes"></div>
    </details>
  </section>

  <section id="picks">
    <h2>My Picks</h2>
    <p class="hint">Everything you tracked from the Boards or Scored Props. Results fill in on their own once stats are published (NFL after the Tuesday update, NBA the next morning).</p>
    <div id="picksSummary" class="cards"></div>
    <div class="toolbar">
      <select id="pkSport"><option value="">NFL and NBA</option><option value="nfl">NFL</option><option value="nba">NBA</option></select>
      <select id="pkShow"><option value="">All picks</option><option value="pending">Waiting for result</option><option value="graded">Graded</option></select>
      <button id="pkRefresh" class="btn-primary">Check for results</button>
      <span id="pkMsg" class="hint"></span>
    </div>
    <div id="picksWrap" class="tablewrap"></div>
  </section>

  <section id="trends">
    <h2>NFL Tendency Matrix</h2>
    <p class="hint">How often each player reached each number in his last N games. A look at the past, not a forecast.</p>
    <div class="tg-controls">
      <div><label>Market</label><select id="tgStat">
        <option value="receptions">Receptions</option><option value="receiving_yards">Receiving Yards</option>
        <option value="targets">Targets</option><option value="rushing_yards">Rushing Yards</option>
        <option value="carries">Carries</option><option value="rush_rec_yards">Rush + Rec Yards</option>
        <option value="passing_yards">Passing Yards</option><option value="completions">Completions</option>
        <option value="attempts">Pass Attempts</option><option value="passing_tds">Passing TDs</option>
      </select></div>
      <div><label>Games</label><select id="tgGames"><option>3</option><option selected>5</option><option>10</option></select></div>
      <div><button id="tgRefresh" class="btn-primary">Refresh</button></div>
    </div>
    <details class="opts"><summary>More options</summary>
      <div class="tg-controls">
        <div><label>Positions (blank = market default, ALL = all)</label><input id="tgPos" placeholder="WR,TE" style="width:110px"></div>
        <div><label>Min games</label><input id="tgMin" type="number" min="1" max="10" placeholder="auto" style="width:70px"></div>
        <div><label>Sort by cutoff</label><input id="tgSort" placeholder="e.g. 5" style="width:90px"></div>
        <div><label class="chk"><input type="checkbox" id="tgSortGrade"> Sort by tendency grade</label></div>
        <div><label>Rows</label><input id="tgLimit" type="number" value="25" style="width:60px"></div>
        <div><label class="chk"><input type="checkbox" id="tgSlate"> Only players with a line</label></div>
        <div><label class="chk" title="Fill the Line column from Kalshi (the rung priced closest to 50/50). Lines you enter yourself win."><input type="checkbox" id="tgKalshi" checked> Kalshi lines</label></div>
      </div>
    </details>
    <div id="tgWrap" class="tablewrap"></div>
  </section>

  <section id="nbatrends">
    <h2>NBA Tendency Matrix</h2>
    <p class="hint">How often each player reached each number in his last N games, with tonight's matchup. A look at the past, not a forecast.</p>
    <div class="tg-controls">
      <div><label>Market</label><select id="nbStat">
        <option value="points">Points</option><option value="rebounds">Rebounds</option><option value="assists">Assists</option>
        <option value="threes">3-Pointers Made</option><option value="pra">Pts + Reb + Ast</option><option value="pr">Pts + Reb</option>
        <option value="pa">Pts + Ast</option><option value="ra">Reb + Ast</option><option value="steals">Steals</option>
        <option value="blocks">Blocks</option><option value="stocks">Steals + Blocks</option><option value="turnovers">Turnovers</option>
      </select></div>
      <div><label>Games</label><select id="nbGames"><option>5</option><option selected>10</option><option>15</option><option>20</option></select></div>
      <div><button id="nbRefresh" class="btn-primary">Refresh</button></div>
    </div>
    <details class="opts"><summary>More options</summary>
      <div class="tg-controls">
        <div><label>Positions (G, F, C; blank = all)</label><input id="nbPos" placeholder="G,F,C" style="width:90px"></div>
        <div><label>Min games</label><input id="nbMin" type="number" min="1" max="20" placeholder="auto" style="width:70px"></div>
        <div><label>Sort by cutoff</label><input id="nbSort" placeholder="e.g. 20" style="width:90px"></div>
        <div><label class="chk"><input type="checkbox" id="nbSortGrade"> Sort by tendency grade</label></div>
        <div><label>Rows</label><input id="nbLimit" type="number" value="25" style="width:60px"></div>
        <div><label class="chk"><input type="checkbox" id="nbSlate"> Only players with a line</label></div>
        <div><label class="chk" title="Fill the Line column from Kalshi (the rung priced closest to 50/50). Lines you enter yourself win."><input type="checkbox" id="nbKalshi" checked> Kalshi lines</label></div>
      </div>
      <p class="hint" style="margin-top:10px">My NBA lines (optional: Kalshi lines fill in automatically; a line typed here replaces Kalshi's for that player). One per line: <code>Player, stat, line</code>, e.g. <code>Jalen Brunson, points, 26.5</code>. Saving replaces the list.</p>
      <textarea id="nbLines" rows="5" style="width:100%; font-family:monospace; font-size:12px"></textarea>
      <button id="nbSaveLines" style="margin-top:6px">Save lines</button> <span id="nbLinesOut" class="hint"></span>
    </details>
    <div id="nbWrap" class="tablewrap"></div>
  </section>

  <section id="input">
    <h2>Add a prop</h2>
    <p class="hint">For props that aren't on Kalshi, or when you know something the Board can't see (an injury, a role change, weather). The game log matters most; leave anything else blank if unsure.</p>
    <form class="grid" id="propForm">
      <div><label>Week</label><input name="week" type="number" value="1" required></div>
      <div><label>Player</label><input name="player" placeholder="Travis Kelce" required></div>
      <div><label>Team</label><input name="team" placeholder="KC" required></div>
      <div><label>Prop type</label><input name="propType" list="propTypes" placeholder="Receptions"></div>
      <div><label>Line</label><input name="line" type="number" step="0.5" required></div>
      <div><label>Opponent</label><input name="opponent" placeholder="DEN"></div>
      <div><label>Opp defense rank (1 = best)</label><input name="oppDefRank" type="number" min="1" max="32"></div>
      <div><label>Injury status</label>
        <select name="injuryStatus"><option>Healthy</option><option>Questionable</option><option>Doubtful</option><option>Out</option></select></div>
      <div style="grid-column:1/-1"><label><b>Game log</b>: this stat, most recent game first, comma separated</label><input name="gameLog" placeholder="e.g. 84, 41, 112, 67, 55, 93"></div>
      <div><label>Role / volume (1&ndash;10, 5 = normal)</label><input name="roleVolumeScore" type="number" min="1" max="10" value="5"></div>
      <div><label>Last season per-game average</label><input name="priorYrBaseline" type="number" step="0.1"></div>
    </form>
    <datalist id="propTypes">
      <option value="Receptions"><option value="Receiving Yards"><option value="Rushing Yards"><option value="Rush Attempts">
      <option value="Passing Yards"><option value="Pass Completions"><option value="Pass Attempts"><option value="Passing TDs"><option value="Rush + Rec Yards">
    </datalist>
    <details class="opts"><summary>More inputs (weather, usage, efficiency, overrides)</summary>
      <form class="grid" id="propFormMore">
        <div><label>Position</label><input name="pos" placeholder="TE"></div>
        <div><label>Wind (mph)</label><input name="wind" type="number" value="0"></div>
        <div><label>Rain or snow</label><select name="precip"><option value="N">No</option><option value="Y">Yes</option></select></div>
        <div><label>Dome</label><select name="dome"><option value="N">No</option><option value="Y">Yes</option></select></div>
        <div><label>Games played this season</label><input name="gamesPlayed" type="number" min="0"></div>
        <div><label>Last 3 games avg (if no log)</label><input name="last3" type="number" step="0.1"></div>
        <div><label>Season avg (if no log)</label><input name="seasonAvg" type="number" step="0.1"></div>
        <div><label>Usage trend (&plusmn;0.07)</label><input name="usageTrend" type="number" step="0.01" value="0"></div>
        <div><label>Recent WOPR</label><input name="recentWopr" type="number" step="0.01" placeholder="e.g. 0.62"></div>
        <div><label>Baseline WOPR</label><input name="baselineWopr" type="number" step="0.01" placeholder="e.g. 0.50"></div>
        <div><label>Receiving EPA</label><input name="receivingEpa" type="number" step="0.01" placeholder="0 = average"></div>
        <div><label>Rushing EPA</label><input name="rushingEpa" type="number" step="0.01" placeholder="0 = average"></div>
        <div><label>Passing EPA</label><input name="passingEpa" type="number" step="0.01" placeholder="0 = average"></div>
        <div><label>Avg opp defense EPA faced</label><input name="avgOppDefEpaFaced" type="number" step="0.01" placeholder="0 = neutral"></div>
        <div><label>Opp defense EPA/play (overrides rank)</label><input name="oppDefEpaPerPlay" type="number" step="0.01" placeholder="0 = average"></div>
        <div><label>Pressure rate allowed (pass props)</label><input name="pressureRateAllowed" type="number" step="0.01" min="0" max="1" placeholder="0.25 = average"></div>
        <div><label>Red zone share (TD props)</label><input name="redZoneShare" type="number" step="0.01" min="0" max="1" placeholder="0.20 = lead role"></div>
        <div><label>Same play-caller as last year</label><select name="ocContinuity"><option value="Y">Yes</option><option value="N">No</option></select></div>
        <div><label>Scheme shift (pts)</label><input name="schemeShift" type="number" step="0.1"></div>
        <div><label>Std dev override</label><input name="stdDev" type="number" step="0.1"></div>
      </form>
    </details>
    <button class="submit-btn" id="saveProp">Save prop</button>
    <div id="saveMsg" class="hint"></div>
  </section>

  <section id="scored">
    <h2>Scored props</h2>
    <p class="hint">Props you added, ranked by the model's probability. Tap <b>Track</b> to follow one in My Picks.</p>
    <div class="toolbar"><button id="refreshScored" class="btn-primary">Refresh</button></div>
    <div id="scoredTableWrap" class="tablewrap"></div>
  </section>

  <section id="about" class="about">
    <h2>About</h2>
    <p><b>Prop Model is a research tool.</b> It does not sell or recommend picks, and nothing here is betting, financial or legal advice.</p>
    <h3>How to use it</h3>
    <ol>
      <li><b>Board</b> (NFL or NBA): Kalshi props in your price band, scored by the model. Tap <b>Track</b> on the ones you take.</li>
      <li><b>My Picks</b>: your record, graded automatically, with the hit rate the prices implied beside it. Beating that implied rate over many picks is the only real sign of an edge.</li>
      <li><b>Tendency Matrix</b>: how often players have cleared each number lately, for context.</li>
      <li><b>Add Prop</b>: for props not on Kalshi or when you know about an injury or role change the Board can't see.</li>
    </ol>
    <h3>How well it works</h3>
    <p>In testing on thousands of props with closing lines, the model's probabilities did not beat the market, and a player's recent record against a line added nothing beyond the line itself. Treat model numbers as estimates and the market price as the benchmark.</p>
    <h3>Data</h3>
    <p>Prices from Kalshi's public market data. NFL statistics and betting lines from nflverse; NBA statistics from the NBA's public stats and ESPN; NBA injury reports from the league's official report. Defensive ratings may come from third parties such as FTN (DVOA). For personal, non-commercial use.</p>
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
  loadTrackedKeys().then(loadNflBoard);
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
// "Signed in as ..." with a sign-out link when Cloudflare Access is on.
fetch(API + "/api/me", { headers: authHeaders() }).then(r => r.ok ? r.json() : null).then(me => {
  if (!me || !me.email) return;
  document.getElementById("whoami").innerHTML = "Signed in as <b>" + esc(me.email) + "</b>" + (me.owner ? " (owner)" : "") +
    " &middot; <a href='/cdn-cgi/access/logout'>Sign out</a>";
}).catch(() => {});

document.querySelectorAll("nav button[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button[data-tab]").forEach(b => b.classList.remove("active"));
    document.querySelectorAll("section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "scored") loadScored();
    if (btn.dataset.tab === "picks") loadPicks(true);
    if (btn.dataset.tab === "trends") loadTrends();
    if (btn.dataset.tab === "nbatrends") { loadNbaLines(); loadNbaTrends(); }
    if (btn.dataset.tab === "nbaboard") loadNbaBoard();
    if (btn.dataset.tab === "nflboard") loadNflBoard();
    window.scrollTo(0, 0);
  });
});

function formToObj(form) {
  const data = {};
  new FormData(form).forEach((v, k) => data[k] = v);
  return data;
}

document.getElementById("saveProp").addEventListener("click", async () => {
  const data = Object.assign(formToObj(document.getElementById("propFormMore")), formToObj(document.getElementById("propForm")));
  const res = await fetch(API + "/api/props", {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(data)
  });
  document.getElementById("saveMsg").textContent = res.ok ? "Saved. See it on the Scored Props tab." : "Error saving: " + (await res.text());
});

async function loadScored() {
  const res = await fetch(API + "/api/scored", { headers: authHeaders() });
  if (!res.ok) { document.getElementById("scoredTableWrap").innerHTML = "<p class='hint'>Could not load (check password).</p>"; return; }
  const rows = await res.json();
  document.getElementById("scoredTableWrap").innerHTML = renderScoredTable(rows);
  attachDeleteHandlers();
}
document.getElementById("refreshScored").addEventListener("click", loadScored);



function renderScoredTable(rows) {
  if (!rows.length) return "<p class='hint' style='margin:12px'>No props saved yet. Add one on the Add Prop tab.</p>";
  const ranked = rows.slice().sort((a,b) => (b.leanProb ?? -1) - (a.leanProb ?? -1));
  BOARD.scored = ranked;
  let html = "<table><tr><th></th><th>Player</th><th>Prop</th><th>Line</th><th>Proj</th><th>Model</th><th>Side</th><th>Tier</th><th></th></tr>";
  ranked.forEach((r, i) => {
    const prob = r.leanProb !== null && r.leanProb !== undefined ? (r.leanProb * 100).toFixed(1) + "%" : "n/a";
    const pplay = r.playProbability !== undefined && r.playProbability < 1 ? " <span class='hint'>(" + (r.playProbability * 100).toFixed(0) + "% to play)</span>" : "";
    html += "<tr>" + trackCell("scored", i) + "<td><b>" + esc(r.player) + "</b> <span class='hint'>" + esc(r.team) + "</span></td><td>" + esc(r.propType) +
      "</td><td>" + esc(r.line) + "</td><td title='" + esc("SD " + (r.sd ?? "") + "; " + (r.varianceSource || "")) + "'>" + esc(r.finalProjection ?? "") +
      "</td><td>" + esc(prob) + pplay + "</td><td class='" + (r.lean==="OVER"?"over":"under") + "'>" + esc(r.lean) +
      "</td><td><span class='pill " + esc(r.confidence) + "'>" + esc(r.confidence) + "</span></td>" +
      "<td class='row-actions'><button data-id='" + esc(r.id) + "' class='delBtn' title='Delete this prop'>&times;</button></td></tr>";
  });
  html += "</table>";
  const grouped = {};
  for (const r of rows) if (r.gameKey) (grouped[r.gameKey] = grouped[r.gameKey] || []).push(r);
  const multi = Object.entries(grouped).filter(([,v]) => v.length > 1);
  if (multi.length) {
    html += "<p class='hint' style='margin:10px 12px'><b>Same game:</b> " + multi.map(([k, v]) => esc(k) + " (" + v.map(x => esc(x.player)).join(", ") + ")").join("; ") +
      ". These results move together, so count them as fewer independent picks and don't parlay them as if they were separate.</p>";
  }
  return html;
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
  if (!document.getElementById("tgKalshi").checked) q.set("kalshi", "0");
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
    h += "<td>" + (r.line === null ? "-" : esc(r.line) + (r.lineSource === "kalshi"
        ? " <span class='src' title='Kalshi line: the rung priced closest to 50/50 (" + Math.round(r.linePrice * 100) + "c for the Over)'>K</span>"
        : r.lineSource === "you" ? " <span class='src you' title='Your line'>you</span>" : "")) + "</td>";
    h += r.grade
      ? "<td title='" + esc(r.grade.basis + " (" + r.grade.percentile + "th percentile of graded lines). " + (g.gradeNote || "")) + "'><span class='grade g-" + esc(r.grade.letter.charAt(0)) + "'>" + esc(r.grade.letter) + "</span> <span class='hint'>" + (r.grade.direction === "above" ? "&#8593; above" : "&#8595; below") + "</span></td>"
      : "<td class='hint'>" + (r.line === null ? "no line" : "-") + "</td>";
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
  h += "</table><details class='how' style='margin:10px 12px'><summary>About this table</summary><p class='hint'>" + esc(g.note) + " Data: " + esc(g.source) + (g.generatedAt ? ", generated " + esc(String(g.generatedAt).slice(0, 16).replace("T", " ")) + " UTC" : "") +
    (g.latestGameDate ? ". Latest game " + esc(g.latestGameDate) : "") +
    ". Lines: Kalshi (marked K, the rung closest to 50/50" + (g.kalshiLines && g.kalshiLines.date ? ", games on " + esc(g.kalshiLines.date) : "") + (g.kalshiLines && g.kalshiLines.error ? "; " + esc(g.kalshiLines.error) : "") + ") unless you entered your own (" + (g.sport === "nba" ? "your NBA lines" : "props on Add Prop") + "). Sorted by " + esc(g.sortBy) + "+." +
    (g.windowSeasonFallback ? " No games yet this season, so the window uses last season." : "") +
    (g.sport === "nba" ? " " + esc(injMeta(g.injuries)) : "") +
    " <b>Tendency grades</b> describe how one-sided each player's record against the entered line has been, ranked within this market. They are not predictions or picks; in testing, recent records against the line did not predict the next result.</p></details>";
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
function failNotes(results, labels) {
  return results.filter(r => !r.ok).map(f => "<p class='hint'>" + esc(labels[f.stat] || f.stat) + ": " + esc(f.data.error || "failed") + (f.data.detail ? " (" + esc(f.data.detail) + ")" : "") + (f.data.hint ? ". " + esc(f.data.hint) : "") + "</p>").join("");
}
function dayLine(d, extra) {
  return "<p class='hint' style='margin:10px 2px 0'>Game day <b>" + esc(d.date) + "</b> &middot; " + esc(d.games) + " games &middot; prices " + esc(String(d.pricesFetchedAt || "").slice(11, 16)) + " UTC" +
    (d.availableDates && d.availableDates.length > 1 ? " &middot; other days: " + d.availableDates.filter(x => x !== d.date).map(esc).join(", ") : "") + (extra || "") + "</p>";
}
// Same order as the server: "edge" = model / price (return per dollar), best for plus-money bands.
function boardOrder(s) {
  if (s === "edge") return (a, b) => b.model / b.market - a.model / a.market || b.model - a.model;
  if (s === "model") return (a, b) => b.model - a.model || b.market - a.market;
  return (a, b) => b.market - a.market || b.model - a.model;
}
// Picking a plus-money band switches the sort to Edge (ranking longshots by model just lists the shortest prices).
for (const [band, sort] of [["nbbBand", "nbbSort"], ["nflbBand", "nflbSort"]]) {
  document.getElementById(band).addEventListener("change", (ev) => {
    if (Number(ev.target.value.split("-")[0]) < 45) document.getElementById(sort).value = "edge";
  });
}
async function loadNbaBoard() {
  const wrap = document.getElementById("nbbWrap"), notes = document.getElementById("nbbNotes");
  const stats = [...document.querySelectorAll(".nbbStat")].filter(x => x.checked).map(x => x.value);
  if (!stats.length) { wrap.innerHTML = "<p class='hint' style='margin:12px'>Pick at least one market.</p>"; return; }
  const band = document.getElementById("nbbBand").value, date = document.getElementById("nbbDate").value;
  const limit = Math.max(1, Math.min(100, Number(document.getElementById("nbbLimit").value) || 15));
  wrap.innerHTML = "<p class='hint' style='margin:12px'>Loading Kalshi prices...</p>";
  const results = await Promise.all(stats.map(async st => {
    const q = new URLSearchParams({ stat: st, band, limit: "100" });
    if (date) q.set("date", date);
    if (document.getElementById("nbbForce").checked) q.set("refresh", "1");
    q.set("sort", document.getElementById("nbbSort").value);
    if (document.getElementById("nbbAllRungs").checked) q.set("allRungs", "1");
    const res = await fetch(API + "/api/nba-board?" + q.toString(), { headers: authHeaders() });
    return { stat: st, ok: res.ok, data: await res.json().catch(() => ({})) };
  }));
  const rows = results.filter(r => r.ok).flatMap(r => r.data.rows || [])
    .sort(boardOrder(document.getElementById("nbbSort").value)).slice(0, limit);
  BOARD.nba = rows;
  const ok = results.find(r => r.ok);
  const meta = document.getElementById("nbbMeta");
  let h = "";
  meta.innerHTML = failNotes(results, NBB_LABEL);
  if (!ok) { wrap.innerHTML = ""; notes.innerHTML = ""; return; }
  const d = ok.data;
  meta.innerHTML += dayLine(d, d.injuries ? "" : " &middot; injury report not loaded");
  if (!rows.length) {
    h += "<p class='hint' style='margin:12px'>Nothing in this band right now. Lines usually post the morning of the game; try another band or day.</p>";
  } else {
    h += "<table class='tg'><tr><th></th><th>Player</th><th>Pick</th><th title='Buy price for this side'>Price</th><th title='Model estimate, including his chance of playing. Not a pick.'>Model</th><th>Game</th><th title='Opponent ranks: pace (1 = fastest), defensive rating (1 = best), allowed to his position (1 = least)'>Matchup</th><th>Last 10 at this number</th></tr>";
    rows.forEach((r, i) => {
      const c = r.context || {}, gm = r.game || {};
      const tm = (r.teammatesOut || []).map(t => esc(t.name) + (t.status === "Doubtful" ? " (D)" : ""));
      h += "<tr>" + trackCell("nba", i) + "<td><b>" + esc(r.player) + "</b> <span class='hint'>" + esc(r.team || "") + "</span>" + injBadge(r.injury) +
        (r.reportPending ? " <span class='inj ok' title='This team has not submitted its injury report yet'>report pending</span>" : "") +
        (r.flags && r.flags.backToBack ? " <span class='inj ok' title='His team played the day before'>B2B</span>" : "") +
        (r.flags && r.flags.returning ? " <span class='inj' title='First game in " + esc(r.flags.returning) + " days'>back after " + esc(r.flags.returning) + "d</span>" : "") +
        (tm.length ? "<span class='tmout'>Teammates out: " + tm.join(", ") + "</span>" : "") + "</td>";
      h += "<td>" + esc(r.side) + " " + esc(r.line) + " " + esc(NBB_LABEL[r.stat] || r.stat) + "</td>";
      h += priceCell(r);
      h += "<td><b>" + Math.round(r.model * 100) + "%</b>" + (r.pPlays < 1 ? " <span class='hint' title='" + esc(Math.round(r.modelIfPlays * 100) + "% if he plays, times about " + Math.round(r.pPlays * 100) + "% chance he plays") + "'>(Q)</span>" : "") + (r.caution ? " <span title='" + esc(r.caution) + "'>&#9888;</span>" : "") + "</td>";
      h += "<td>" + (gm.opp ? (gm.home ? "vs " : "@ ") + esc(gm.opp) + " <span class='hint'>" + esc(tipEt(gm.tip)) + "</span>" : esc(gm.date || "")) + "</td>";
      h += "<td class='hint'>" + [c.paceRank ? "pace #" + esc(c.paceRank) : "", c.drtgRank ? "D #" + esc(c.drtgRank) : "", c.dvp ? "vs pos #" + esc(c.dvp.rank) : ""].filter(Boolean).join(" &middot; ") + "</td>";
      h += "<td class='vals'>" + esc(r.last10Record) + ": " + r.last10.map(esc).join(", ") + "</td></tr>";
    });
    h += "</table>";
  }
  wrap.innerHTML = h;
  const ex = {};
  results.filter(r => r.ok).forEach(r => Object.entries(r.data.excluded || {}).forEach(([k, v]) => { ex[k] = (ex[k] || 0) + v; }));
  const hurt = [...new Map(results.filter(r => r.ok).flatMap(r => r.data.injuredSkipped || []).map(x => [x.name, x])).values()];
  notes.innerHTML = "<p class='hint'><b>Left out this time:</b> " + esc(ex.injured || 0) + " lines for players Out or Doubtful" +
    (hurt.length ? " (" + hurt.slice(0, 10).map(x => esc(x.name)).join(", ") + (hurt.length > 10 ? ", ..." : "") + ")" : "") + ", " +
    esc(ex.started || 0) + " already started, " + esc(ex.wideSpread || 0) + " wide spreads, " + esc(ex.modelDisagrees || 0) + " where the model is 10+ below the market, " +
    esc(ex.duplicateRung || 0) + " extra rungs, " + esc(ex.unknownPlayer || 0) + " players not in the game logs" +
    (ex.belowMinGap ? ", " + esc(ex.belowMinGap) + " where the model is less than 5 points above the price" : "") +
    (ex.likelyDataError ? ", " + esc(ex.likelyDataError) + " set aside as likely data errors (model 15+ above)" : "") + ". " + esc(injMeta(d.injuries)) + "</p>";
}
document.getElementById("nbbRefresh").addEventListener("click", loadNbaBoard);

const NFLB_LABEL = { receptions: "receptions", receiving_yards: "receiving yards", rushing_yards: "rushing yards", carries: "rush attempts", passing_yards: "passing yards" };
async function loadNflBoard() {
  const wrap = document.getElementById("nflbWrap"), notes = document.getElementById("nflbNotes");
  const stats = [...document.querySelectorAll(".nflbStat")].filter(x => x.checked).map(x => x.value);
  if (!stats.length) { wrap.innerHTML = "<p class='hint' style='margin:12px'>Pick at least one market.</p>"; return; }
  const band = document.getElementById("nflbBand").value, date = document.getElementById("nflbDate").value;
  const sort = document.getElementById("nflbSort").value;
  const limit = Math.max(1, Math.min(100, Number(document.getElementById("nflbLimit").value) || 15));
  wrap.innerHTML = "<p class='hint' style='margin:12px'>Loading Kalshi prices...</p>";
  const results = await Promise.all(stats.map(async st => {
    const q = new URLSearchParams({ stat: st, band, sort, limit: "100" });
    if (date) q.set("date", date);
    if (document.getElementById("nflbForce").checked) q.set("refresh", "1");
    const res = await fetch(API + "/api/nfl-board?" + q.toString(), { headers: authHeaders() });
    return { stat: st, ok: res.ok, data: await res.json().catch(() => ({})) };
  }));
  const ok = results.filter(r => r.ok);
  const meta = document.getElementById("nflbMeta");
  let h = "";
  meta.innerHTML = failNotes(results, NFLB_LABEL);
  if (!ok.length) { wrap.innerHTML = ""; notes.innerHTML = ""; return; }
  const rows = ok.flatMap(r => r.data.rows || []).sort(boardOrder(sort)).slice(0, limit);
  BOARD.nfl = rows;
  const d = ok[0].data;
  meta.innerHTML += dayLine(d, d.scheduleIncluded ? "" : " &middot; <b>no schedule loaded, so kickoffs can't be checked</b>");
  if (!rows.length) h += "<p class='hint' style='margin:12px'>Nothing in this band right now. Boards fill in during the week; try another band or day.</p>";
  else {
    h += "<table class='tg'><tr><th></th><th>Player</th><th>Pick</th><th title='Buy price for this side'>Price</th><th title='Model estimate. Not a pick.'>Model</th><th>Game</th><th title='Opponent defensive rank, 1 = best'>Opp D</th><th title='His team&#39;s spread / game total, and how much that moved the projection'>Line</th><th>This season at this number</th></tr>";
    rows.forEach((r, i) => {
      const g = r.game || {};
      h += "<tr>" + trackCell("nfl", i) + "<td><b>" + esc(r.player) + "</b> <span class='hint'>" + esc(r.team || "") + " " + esc(r.position || "") + "</span></td>";
      h += "<td>" + esc(r.side) + " " + esc(r.line) + " " + esc(r.unit) + "</td>";
      h += priceCell(r);
      h += "<td><b>" + Math.round(r.model * 100) + "%</b>" + (r.caution ? " <span title='" + esc(r.caution) + "'>&#9888;</span>" : "") + "</td>";
      h += "<td>" + (g.opp ? (g.home ? "vs " : "@ ") + esc(g.opp) + " <span class='hint'>" + esc(tipEt(g.kickoff)) + "</span>" : esc(g.date || "")) + "</td>";
      h += "<td>" + (r.oppDefRank ? "#" + esc(r.oppDefRank) : "<span class='hint'>-</span>") + "</td>";
      h += "<td>" + (r.teamSpread !== null && r.teamSpread !== undefined
        ? esc((r.teamSpread > 0 ? "-" : r.teamSpread < 0 ? "+" : "") + Math.abs(r.teamSpread)) + " / " + esc(r.gameTotal) +
          (r.gameScriptAdj ? " <span class='hint'>" + (r.gameScriptAdj > 0 ? "+" : "") + Math.round(r.gameScriptAdj * 100) + "%</span>" : "")
        : "<span class='hint'>-</span>") + "</td>";
      h += "<td class='vals'>" + esc(r.logRecord) + ": " + r.log.map(esc).join(", ") + "</td></tr>";
    });
    h += "</table>";
  }
  wrap.innerHTML = h;
  const ex = {}; ok.forEach(r => Object.entries(r.data.excluded || {}).forEach(([k, v]) => { ex[k] = (ex[k] || 0) + v; }));
  const errs = ok.flatMap(r => r.data.dataErrors || []).sort((a, b) => (b.model - b.market) - (a.model - a.market)).slice(0, 8);
  notes.innerHTML = (errs.length ? "<p class='hint'><b>Set aside as likely data errors</b> (model 15+ points above the market): " + errs.map(e => esc(e.player) + " " + esc(e.side) + " " + esc(e.line) + " " + esc(e.unit) + " (" + Math.round(e.model * 100) + "% vs " + Math.round(e.market * 100) + "%)").join(", ") + ".</p>" : "") +
    "<p class='hint'><b>Left out this time:</b> " + esc(ex.started || 0) + " kicked off, " + esc(ex.wideSpread || 0) + " wide spreads, " + esc(ex.modelDisagrees || 0) + " where the model is 10+ below the market, " +
    esc(ex.duplicateRung || 0) + " extra rungs, " + esc(ex.unknownPlayer || 0) + " players not in the logs, " + esc(ex.wrongGame || 0) + " team mismatches (trades)" +
    (ex.belowMinGap ? ", " + esc(ex.belowMinGap) + " where the model is less than 5 points above the price" : "") + ".</p>";
}
document.getElementById("nflbRefresh").addEventListener("click", loadNflBoard);
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
  if (!document.getElementById("nbKalshi").checked) q.set("kalshi", "0");
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

// ---- Light / dark: the button flips between the two and remembers the choice on this device ----
(function () {
  const btn = document.getElementById("themeBtn"), root = document.documentElement;
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const paint = () => { btn.textContent = isDark() ? "\u2600\uFE0F" : "\uD83C\uDF19"; btn.title = isDark() ? "Switch to light mode" : "Switch to dark mode"; };
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* not remembered */ }
    paint();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  paint();
})();

// ---- Tracking: Track buttons on the Boards and Scored Props, and the My Picks tab ----
const NFL_PT = { receptions: "Receptions", receiving_yards: "Receiving Yards", rushing_yards: "Rushing Yards", carries: "Rush Attempts", passing_yards: "Passing Yards" };
const NBA_PT = { points: "Points", rebounds: "Rebounds", assists: "Assists", threes: "3-Pointers" };
const BOARD = { nfl: [], nba: [], scored: [] };
let TRACKED = new Set();
function priceToOdds(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) return null;
  return x >= 0.5 ? -Math.round(100 * x / (1 - x)) : Math.round(100 * (1 - x) / x);
}
function pickKey(e) {
  const s = v => String(v === undefined || v === null ? "" : v).toLowerCase().trim();
  return [s(e.sport || "nfl"), s(e.week), s(e.gameDate), s(e.player), s(e.propType), s(e.lean), s(e.openingLine)].join("|");
}
async function loadTrackedKeys() {
  try {
    const r = await fetch(API + "/api/tracker", { headers: authHeaders() });
    if (r.ok) TRACKED = new Set((await r.json()).map(pickKey));
  } catch (e) { /* the Track buttons still work; they just won't show earlier picks */ }
}
const r3 = v => Math.round(Number(v) * 1000) / 1000;
// "I use limit orders": Track records the suggested limit as the price paid (maker, no fee)
// instead of the ask (taker). Remembered in this browser only.
let LIMIT_MODE = false;
try { LIMIT_MODE = localStorage.getItem("limitMode") === "1"; } catch (e) { /* storage blocked: default off */ }
function execFields(r) {
  const useLimit = LIMIT_MODE && r.limit > 0 && r.limit < 1;
  const paid = useLimit ? r.limit : r.market;
  return { marketProb: r3(paid), odds: priceToOdds(paid), orderType: useLimit ? "maker" : "taker",
    pickMid: r.mid > 0 && r.mid < 1 ? r3(r.mid) : "", pickSpread: r.spread !== null && r.spread !== undefined ? r3(r.spread) : "", limitPrice: r.limit || "" };
}
for (const id of ["nflbLimitMode", "nbbLimitMode"]) {
  const el = document.getElementById(id);
  el.checked = LIMIT_MODE;
  el.addEventListener("change", () => {
    LIMIT_MODE = el.checked;
    for (const o of ["nflbLimitMode", "nbbLimitMode"]) document.getElementById(o).checked = LIMIT_MODE;
    try { localStorage.setItem("limitMode", LIMIT_MODE ? "1" : "0"); } catch (e) { /* not remembered */ }
  });
}
// Price cell: buy price and odds, the suggested limit, and a flag on wide markets.
const WIDE_SPREAD = 0.05;
function priceCell(r) {
  const wide = r.spread !== null && r.spread !== undefined && r.spread > WIDE_SPREAD;
  return "<td>" + Math.round(r.market * 100) + "&cent; <span class='hint'>" + esc(amOdds(r.market)) + "</span>" +
    (r.limit && r.limit < r.market - 0.004 ? "<br><span class='lim' title='Rest a limit order here instead of paying the ask: no fee as a maker on most markets, and you skip most of the spread'>limit " + Math.round(r.limit * 100) + "&cent;</span>" : "") +
    (wide ? " <span class='inj' title='Bid-ask spread " + Math.round(r.spread * 100) + "c: paying the ask here costs a lot; use a limit order or skip'>wide " + Math.round(r.spread * 100) + "&cent;</span>" : "") + "</td>";
}
function boardItem(kind, r) {
  if (kind === "nfl") {
    const g = r.game || {};
    return { sport: "nfl", week: r.week, gameDate: g.date || "", player: r.player, team: r.team, opponent: r.opp || g.opp || "",
      propType: NFL_PT[r.stat] || r.stat, stat: r.stat, lean: String(r.side).toUpperCase(), openingLine: r.line,
      claimedProb: r3(r.model), projection: r.projection, stake: 1, played: "Y", source: "NFL Board",
      ticker: r.ticker || "", kickoff: g.kickoff || "", ...execFields(r) };
  }
  if (kind === "nba") {
    const g = r.game || {};
    return { sport: "nba", gameDate: g.date || "", player: r.player, team: r.team, opponent: g.opp || "",
      propType: NBA_PT[r.stat] || r.stat, stat: r.stat, lean: String(r.side).toUpperCase(), openingLine: r.line,
      claimedProb: r3(r.model), projection: r.projection, stake: 1, played: "Y", source: "NBA Board",
      ticker: r.ticker || "", kickoff: g.tip || "", ...execFields(r) };
  }
  return { sport: "nfl", week: Number(r.week) || r.week, player: r.player, team: r.team, opponent: r.opponent || "", propType: r.propType,
    lean: r.lean, openingLine: Number(r.line), claimedProb: r.leanProb, projection: r.finalProjection, stake: 1, played: "Y", source: "Scored Props" };
}
function trackCell(kind, i) {
  const done = TRACKED.has(pickKey(boardItem(kind, BOARD[kind][i])));
  return "<td><button class='trackBtn" + (done ? " done" : "") + "' data-kind='" + kind + "' data-i='" + i + "'" + (done ? " disabled" : "") + ">" + (done ? "Tracked" : "Track") + "</button></td>";
}
document.addEventListener("click", async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest(".trackBtn") : null;
  if (!btn || btn.disabled) return;
  const item = boardItem(btn.dataset.kind, BOARD[btn.dataset.kind][Number(btn.dataset.i)]);
  btn.disabled = true; btn.textContent = "Saving...";
  const res = await fetch(API + "/api/tracker/bulk", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ items: [item] }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { TRACKED.add(pickKey(item)); btn.textContent = "Tracked"; btn.classList.add("done"); }
  else { btn.disabled = false; btn.textContent = "Track"; btn.title = out.error || "Could not save"; }
});

const pct = v => v === null || v === undefined ? "-" : Math.round(v * 100) + "%";
const cents = v => (v > 0 ? "+" : "") + (Math.round(v * 1000) / 10) + "&cent;";
function summaryCards(s) {
  if (!s || !s.picks) return "<p class='hint'>No tracked picks yet. Tap <b>Track</b> on a Board row to start.</p>";
  const u = s.units;
  const vs = s.hitRate !== null && s.impliedRate !== null ? (s.hitRate - s.impliedRate) : null;
  return "<div class='card'><span>Record</span><b>" + esc(s.record) + "</b><small>" + esc(s.pending) + " waiting" + (s.voids ? ", " + esc(s.voids) + " did not play" : "") + "</small></div>" +
    "<div class='card'><span>Hit rate</span><b>" + pct(s.hitRate) + "</b><small>" + (s.hits + s.misses) + " graded</small></div>" +
    "<div class='card'><span>Prices implied</span><b>" + pct(s.impliedRate) + "</b><small>" + (vs === null ? "track picks from a Board to see this" : (vs >= 0 ? "you're " + Math.round(vs * 100) + " pts above" : "you're " + Math.round(-vs * 100) + " pts below")) + "</small></div>" +
    "<div class='card' title='Profit at 1 unit per priced pick. After fees subtracts Kalshi&#39;s taker fee on picks bought at the ask (limit orders: none).'><span>Units</span><b class='" + (u > 0 ? "over" : u < 0 ? "under" : "") + "'>" + (u > 0 ? "+" : "") + esc(u) + "</b><small>" +
      (s.fees ? "after est. fees " + (s.unitsAfterFees > 0 ? "+" : "") + esc(s.unitsAfterFees) : "1 unit per priced pick") + (s.roi !== null ? ", ROI " + (s.roi >= 0 ? "+" : "") + Math.round(s.roi * 100) + "%" : "") + "</small></div>" +
    "<div class='card' title='Closing line value: the fair price of your side at kickoff (bid-ask mid) minus what you paid. Positive means you bought below where the market closed. Over many picks this is the clearest sign of a real edge.'><span>Beat the close</span>" +
      (s.clv && s.clv.n ? "<b class='" + (s.clv.avg > 0 ? "over" : s.clv.avg < 0 ? "under" : "") + "'>" + cents(s.clv.avg) + "</b><small>avg CLV; " + esc(s.clv.beat) + " of " + esc(s.clv.n) + " beat the close" + (s.clv.same ? ", " + esc(s.clv.same) + " even" : "") +
          (s.clv.execution !== null || s.clv.movement !== null ? "<br>execution " + (s.clv.execution !== null ? cents(s.clv.execution) : "-") + " &middot; market move " + (s.clv.movement !== null ? cents(s.clv.movement) : "-") : "") +
          (s.clv.stale ? "<br>" + esc(s.clv.stale) + " stale close" + (s.clv.stale > 1 ? "s" : "") + " left out" : "") + "</small>"
        : "<b>-</b><small>shows once a tracked game starts</small>") + "</div>";
}
function closeCell(e) {
  if (e.clv !== null && e.clv !== undefined) {
    const c = Math.round(e.clv * 100), pp = e.clvParts || {};
    const tip = "CLV " + c + "c" + (pp.execution !== null && pp.execution !== undefined ? " = execution " + Math.round(pp.execution * 100) + "c (mid when tracked minus paid)" : "") +
      (pp.movement !== null && pp.movement !== undefined ? " + market move " + Math.round(pp.movement * 100) + "c (close minus mid when tracked)" : "") +
      (e.closeSpread ? "; closing spread " + Math.round(e.closeSpread * 100) + "c" : "") + (e.closeStale ? "; STALE: last price was 30+ min before kickoff, not counted" : "");
    return "<span title='" + esc(tip) + "'>" + Math.round(e.closePrice * 100) + "&cent; <span class='" + (e.closeStale ? "hint" : c > 0 ? "over" : c < 0 ? "under" : "hint") + "'>" + (c > 0 ? "+" : "") + c + "</span>" + (e.closeStale ? " <span class='hint'>stale</span>" : "") + "</span>";
  }
  if (!e.ticker) return "<span class='hint' title='Only picks tracked from a Board have a Kalshi market to check'>-</span>";
  return "<span class='hint'>" + (e.kickoff && Date.parse(e.kickoff) > Date.now() ? "at kickoff" : "checking") + "</span>";
}
let PICKS = null;
function renderPicks() {
  if (!PICKS) return;
  const sport = document.getElementById("pkSport").value, show = document.getElementById("pkShow").value;
  document.getElementById("picksSummary").innerHTML = summaryCards(PICKS.summary[sport || "all"]);
  const rows = PICKS.entries.filter(e => (!sport || String(e.sport || "nfl") === sport) && (!show || (show === "pending" ? !e.result : !!e.result)));
  const wrap = document.getElementById("picksWrap");
  if (!rows.length) { wrap.innerHTML = "<p class='hint' style='margin:12px'>Nothing to show.</p>"; return; }
  let h = "<table><tr><th>Game</th><th>Player</th><th>Pick</th><th>Paid</th><th title='Fair price of your side at kickoff (bid-ask mid), and the difference from what you paid'>Close</th><th title='Model estimate when tracked'>Model</th><th>Result</th><th></th></tr>";
  for (const e of rows) {
    const when = e.gameDate ? esc(e.gameDate) : (e.week ? "Week " + esc(e.week) : "");
    const paid = e.marketProb ? Math.round(e.marketProb * 100) + "&cent; <span class='hint'>" + esc(e.odds || "") + (e.orderType === "maker" ? " limit" : "") + "</span>" : (e.odds ? esc(e.odds) : "<span class='hint'>-</span>");
    let res;
    if (e.result) {
      res = "<span class='res " + esc(e.result) + "'>" + esc(e.result === "VOID" ? "DNP" : e.result) + "</span>" + (e.result !== "VOID" ? " <span class='hint'>" + esc(e.actual) + "</span>" : "");
    } else {
      res = "<span class='hint'>waiting</span> <input class='pkActual' data-id='" + esc(e.id) + "' placeholder='result' style='width:64px;padding:3px 6px'>" +
        (e.odds ? "" : " <input class='pkOdds' data-id='" + esc(e.id) + "' placeholder='odds' style='width:58px;padding:3px 6px'>") +
        " <button class='pkSave' data-id='" + esc(e.id) + "'>Save</button>";
    }
    h += "<tr><td>" + when + " <span class='hint'>" + esc(String(e.sport || "nfl").toUpperCase()) + "</span></td><td><b>" + esc(e.player) + "</b> <span class='hint'>" + esc(e.team || "") + (e.opponent ? " vs " + esc(e.opponent) : "") + "</span></td>" +
      "<td>" + esc(e.lean === "OVER" ? "Over" : e.lean === "UNDER" ? "Under" : e.lean) + " " + esc(e.openingLine) + " " + esc(e.propType) + "</td>" +
      "<td>" + paid + "</td><td>" + closeCell(e) + "</td><td>" + (e.claimedProb ? Math.round(e.claimedProb * 100) + "%" : "-") + "</td><td>" + res + "</td>" +
      "<td class='row-actions'><button class='pkDel' data-id='" + esc(e.id) + "' title='Remove this pick'>&times;</button></td></tr>";
  }
  wrap.innerHTML = h + "</table><p class='hint' style='margin:10px 12px'>Results fill in automatically. Type a result by hand if one is missing (or DNP if he didn't play). Units assume 1 unit per pick at the price paid; picks without a price count toward the record only. <b>Close</b> is the market's fair price for your side at kickoff (the bid&ndash;ask mid): beating it regularly is the clearest early sign of a real edge, well before the win-loss record can show one.</p>";
}
async function loadPicks(grade) {
  const msg = document.getElementById("pkMsg");
  if (grade) {
    msg.textContent = "Checking for results...";
    const g = await fetch(API + "/api/autograde", { method: "POST", headers: authHeaders() }).then(r => r.json()).catch(() => null);
    msg.textContent = g ? (g.appliedCount ? g.appliedCount + " result" + (g.appliedCount > 1 ? "s" : "") + " added." : "No new results yet.") + (g.needsReviewCount ? " " + g.needsReviewCount + " need a result typed in." : "") +
      (g.closesAdded ? " " + g.closesAdded + " closing price" + (g.closesAdded > 1 ? "s" : "") + " added." : "") : "";
  }
  const res = await fetch(API + "/api/picks", { headers: authHeaders() });
  if (!res.ok) { document.getElementById("picksWrap").innerHTML = "<p class='hint' style='margin:12px'>Could not load picks.</p>"; return; }
  PICKS = await res.json();
  TRACKED = new Set(PICKS.entries.map(pickKey));
  renderPicks();
}
document.getElementById("pkRefresh").addEventListener("click", () => loadPicks(true));
document.getElementById("pkSport").addEventListener("change", renderPicks);
document.getElementById("pkShow").addEventListener("change", renderPicks);
document.getElementById("picksWrap").addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.classList.contains("pkDel")) {
    await fetch(API + "/api/tracker/" + encodeURIComponent(t.dataset.id), { method: "DELETE", headers: authHeaders() });
    return loadPicks(false);
  }
  if (t.classList.contains("pkSave")) {
    const e = PICKS.entries.find(x => x.id === t.dataset.id); if (!e) return;
    const row = t.closest("tr");
    const a = row.querySelector(".pkActual"), o = row.querySelector(".pkOdds");
    const upd = Object.assign({}, e); delete upd.result;
    const av = a ? a.value.trim() : "";
    if (av) upd.actual = av.toUpperCase() === "DNP" ? "DNP" : Number(av);
    if (o && o.value.trim()) upd.odds = Number(o.value.trim());
    if (upd.actual !== undefined && upd.actual !== "DNP" && !Number.isFinite(upd.actual)) { document.getElementById("pkMsg").textContent = "Result must be a number or DNP."; return; }
    await fetch(API + "/api/tracker", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(upd) });
    loadPicks(false);
  }
});

</script>
</body>
</html>`;
