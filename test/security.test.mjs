// node test/security.test.mjs : access gate, lockout, Cloudflare Access JWT checks, headers.
import assert from "node:assert/strict";
import { authorize, verifyAccessJwt, _resetLockouts } from "../src/security.js";
import worker from "../src/index.js";

const req = (headers = {}, url = "http://x/api/props") => new Request(url, { headers });
const bucket = { async get() { return null; }, async put() {} };

// 1) Fail closed: nothing configured -> 503; ALLOW_OPEN only for local dev.
assert.equal((await authorize(req(), {})).status, 503);
assert.equal((await authorize(req(), { ALLOW_OPEN: "true" })).ok, true);
assert.equal((await worker.fetch(req(), { PROP_DATA: bucket })).status, 503);

// 2) Password: right/wrong, empty probe not counted, lockout after 10 failures per IP.
_resetLockouts();
const env = { APP_SECRET: "s3cret-pass" };
assert.equal((await authorize(req({ "x-app-secret": "s3cret-pass" }), env)).ok, true);
for (let i = 0; i < 20; i++) await authorize(req({ "cf-connecting-ip": "1.1.1.1" }), env); // empty: not counted
assert.equal((await authorize(req({ "x-app-secret": "s3cret-pass", "cf-connecting-ip": "1.1.1.1" }), env)).ok, true);
for (let i = 0; i < 10; i++) assert.equal((await authorize(req({ "x-app-secret": "guess" + i, "cf-connecting-ip": "2.2.2.2" }), env)).status, 401);
assert.equal((await authorize(req({ "x-app-secret": "s3cret-pass", "cf-connecting-ip": "2.2.2.2" }), env)).status, 429, "locked out even with the right password");
assert.equal((await authorize(req({ "x-app-secret": "s3cret-pass", "cf-connecting-ip": "2.2.2.2" }), env, { now: Date.now() + 11 * 60 * 1000 })).ok, true, "lockout expires");
assert.equal((await authorize(req({ "x-app-secret": "s3cret-pass", "cf-connecting-ip": "3.3.3.3" }), env)).ok, true, "other IPs unaffected");

// 3) Cloudflare Access JWT: sign with a real RSA key, serve its JWK from a mocked certs URL.
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256" };
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const team = "myteam.cloudflareaccess.com", AUD = "aud-123";
const sign = async (payload, kid = "k1", key = privateKey) => {
  const h = b64u(JSON.stringify({ alg: "RS256", kid })), p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64u(new Uint8Array(sig));
};
let certFetches = 0;
const fakeFetch = async (url) => { certFetches++; assert.equal(url, `https://${team}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
const aenv = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD };
const now = Math.floor(Date.now() / 1000);
const good = await sign({ aud: [AUD], iss: `https://${team}`, exp: now + 600, email: "me@example.com" });
assert.equal((await verifyAccessJwt(req({ "cf-access-jwt-assertion": good }), aenv, fakeFetch)).ok, true);
assert.equal((await verifyAccessJwt(req({ cookie: "a=b; CF_Authorization=" + good }), aenv, fakeFetch)).ok, true, "cookie form");
assert.equal(certFetches, 1, "certs cached");
const cases = {
  "wrong audience": await sign({ aud: ["other"], iss: `https://${team}`, exp: now + 600 }),
  "wrong issuer": await sign({ aud: [AUD], iss: "https://evil.cloudflareaccess.com", exp: now + 600 }),
  "expired": await sign({ aud: [AUD], iss: `https://${team}`, exp: now - 3600 }),
  "unknown key id": await sign({ aud: [AUD], iss: `https://${team}`, exp: now + 600 }, "k2"),
};
for (const [reason, tok] of Object.entries(cases)) assert.equal((await verifyAccessJwt(req({ "cf-access-jwt-assertion": tok }), aenv, fakeFetch)).reason, reason);
const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])).privateKey;
assert.equal((await verifyAccessJwt(req({ "cf-access-jwt-assertion": await sign({ aud: [AUD], iss: `https://${team}`, exp: now + 600 }, "k1", other) }), aenv, fakeFetch)).reason, "bad signature");
const [h, p, s] = good.split(".");
const tampered = h + "." + b64u(JSON.stringify({ aud: [AUD], iss: `https://${team}`, exp: now + 99999, email: "attacker@x" })) + "." + s;
assert.equal((await verifyAccessJwt(req({ "cf-access-jwt-assertion": tampered }), aenv, fakeFetch)).reason, "bad signature");
assert.equal((await verifyAccessJwt(req(), aenv, fakeFetch)).ok, false, "no token");
assert.equal((await authorize(req({ "cf-access-jwt-assertion": good }), aenv, { fetch: fakeFetch })).ok, true, "Access alone is enough");
assert.equal((await authorize(req({ "cf-access-jwt-assertion": good }), { ...aenv, APP_SECRET: "pw" }, { fetch: fakeFetch })).status, 401, "Access + password requires both");

// 4) Headers: every response has the security headers; the page's CSP pins the script by hash.
const page = await worker.fetch(new Request("http://x/"), { PROP_DATA: bucket, ALLOW_OPEN: "true" });
const csp = page.headers.get("content-security-policy");
assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "no unsafe-inline scripts");
for (const hName of ["strict-transport-security", "referrer-policy", "permissions-policy", "x-frame-options", "x-content-type-options"]) assert.ok(page.headers.get(hName), hName);
const html = await page.text();
const body = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64");
assert.ok(csp.includes(`'sha256-${digest}'`), "hash matches the served script");
assert.ok(!/ on[a-z]+="/.test(html), "no inline event handlers (they would be blocked)");
const api = await worker.fetch(req(), { PROP_DATA: bucket });
assert.equal(api.headers.get("x-frame-options"), "DENY");
console.log("security tests passed");
