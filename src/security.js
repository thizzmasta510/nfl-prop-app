// Security layer for the Worker: who may call the API, how hard they may try,
// and the headers every response carries.
//
// Access is decided in this order:
//   1. Cloudflare Access (recommended). When ACCESS_AUD and ACCESS_TEAM_DOMAIN are set,
//      every request must carry a valid Access JWT (Cf-Access-Jwt-Assertion header or
//      CF_Authorization cookie). The signature is checked against the team's public
//      keys, plus audience, issuer and expiry. This also covers requests that reach the
//      Worker without going through Access (for example the workers.dev URL).
//   2. APP_SECRET password (the existing x-app-secret header), with a per-IP lockout
//      after repeated failures.
//   3. Neither configured: the API refuses to run (fail closed) unless ALLOW_OPEN="true",
//      which is meant only for local development.

const enc = new TextEncoder();

// ---------- small helpers ----------
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function cookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ---------- Cloudflare Access JWT ----------
const JWKS_CACHE = { url: null, keys: null, at: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function accessKeys(teamDomain, fetchImpl) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (JWKS_CACHE.url === url && JWKS_CACHE.keys && Date.now() - JWKS_CACHE.at < JWKS_TTL_MS) return JWKS_CACHE.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
  const { keys } = await res.json();
  JWKS_CACHE.url = url; JWKS_CACHE.keys = keys || []; JWKS_CACHE.at = Date.now();
  return JWKS_CACHE.keys;
}

/**
 * Returns { ok: true, email } for a valid Access token, else { ok: false, reason }.
 * fetchImpl is injectable for tests.
 */
export async function verifyAccessJwt(request, env, fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  const token = request.headers.get("cf-access-jwt-assertion") || cookie(request, "CF_Authorization");
  if (!token) return { ok: false, reason: "no Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); } catch { return { ok: false, reason: "malformed token" }; }
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected alg" };
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let keys;
  try { keys = await accessKeys(team, fetchImpl); } catch (e) { return { ok: false, reason: String(e.message || e) }; }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown key id" };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!valid) return { ok: false, reason: "bad signature" };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, reason: "wrong audience" };
  if (payload.iss !== `https://${team}`) return { ok: false, reason: "wrong issuer" };
  if (typeof payload.exp !== "number" || payload.exp < nowSec - 30) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 30) return { ok: false, reason: "not yet valid" };
  return { ok: true, email: payload.email || null };
}

// ---------- password lockout (best effort, per isolate) ----------
// Isolates are short-lived and not shared, so this slows guessing rather than
// guaranteeing a hard limit. Pair it with a Cloudflare rate-limiting rule.
const FAILS = new Map();
const MAX_FAILS = 10, WINDOW_MS = 10 * 60 * 1000;
function clientIp(request) { return request.headers.get("cf-connecting-ip") || "unknown"; }
function lockedOut(ip, now) {
  const f = FAILS.get(ip);
  if (!f) return false;
  if (now - f.first > WINDOW_MS) { FAILS.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}
function recordFail(ip, now) {
  const f = FAILS.get(ip);
  if (!f || now - f.first > WINDOW_MS) FAILS.set(ip, { first: now, count: 1 });
  else f.count++;
  if (FAILS.size > 5000) FAILS.clear(); // bound memory
}
export function _resetLockouts() { FAILS.clear(); }

/**
 * Decide whether an API request may proceed.
 * Returns { ok: true } or { ok: false, status, error }.
 */
export async function authorize(request, env, deps = {}) {
  const now = deps.now ?? Date.now();
  const accessOn = Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN);
  if (accessOn) {
    const v = await verifyAccessJwt(request, env, deps.fetch || fetch, Math.floor(now / 1000));
    if (!v.ok) return { ok: false, status: 403, error: "Cloudflare Access login required" };
  }
  if (env.APP_SECRET) {
    const ip = clientIp(request);
    if (lockedOut(ip, now)) return { ok: false, status: 429, error: "too many failed attempts, try again later" };
    const provided = request.headers.get("x-app-secret") || "";
    // An empty password is the page's own "am I logged in?" probe on load; it is
    // refused but not counted, so reloading the login page can't lock a user out.
    if (!timingSafeEqual(provided, env.APP_SECRET)) { if (provided) recordFail(ip, now); return { ok: false, status: 401, error: "unauthorized" }; }
    FAILS.delete(ip);
    return { ok: true };
  }
  if (accessOn) return { ok: true };
  if (String(env.ALLOW_OPEN) === "true") return { ok: true };
  return { ok: false, status: 503, error: "server not configured: set APP_SECRET (wrangler secret put APP_SECRET) or Cloudflare Access" };
}

// ---------- response headers ----------
let SCRIPT_HASH = null;
export async function scriptHashFor(html) {
  if (SCRIPT_HASH) return SCRIPT_HASH;
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(m[1]));
  SCRIPT_HASH = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return SCRIPT_HASH;
}

export function htmlCsp(hash) {
  return [
    "default-src 'self'",
    hash ? `script-src 'sha256-${hash}'` : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // inline style attributes; no scripts can run from styles
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

const COMMON_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export function withSecurityHeaders(res, extra = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...COMMON_HEADERS, ...extra })) h.set(k, v);
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
