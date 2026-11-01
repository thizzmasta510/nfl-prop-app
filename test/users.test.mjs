// node test/users.test.mjs : per-account storage through the real Worker entry point.
import assert from "node:assert/strict";
import { userPrefix, isOwner, scopedBucket } from "../src/users.js";
import worker from "../src/index.js";

const a = await userPrefix("Me@Example.com "), b = await userPrefix("me@example.com");
assert.equal(a, b, "case and spaces ignored"); assert.equal(a.length, 32); assert.ok(!a.includes("@"));
assert.equal(isOwner("ME@example.com", { OWNER_EMAIL: "me@example.com" }), true);
assert.equal(isOwner("x@y.com", { OWNER_EMAIL: "me@example.com" }), false);
assert.equal(isOwner("x@y.com", {}), false);

// In-memory R2
const store = new Map();
const bucket = { async get(k) { return store.has(k) ? { body: {}, etag: "e", text: async () => store.get(k) } : null; },
  async put(k, v) { store.set(k, String(v)); }, async delete(k) { store.delete(k); } };
store.set("props.json", JSON.stringify([{ id: "old", player: "Legacy Prop" }]));
const sb = scopedBucket(bucket, "abc", { legacyFallback: true });
assert.equal(JSON.parse(await (await sb.get("props.json")).text())[0].id, "old", "owner sees legacy data before first save");
await sb.put("props.json", "[]");
assert.ok(store.has("users/abc/props.json") && store.get("props.json").includes("old"), "writes go to the user's file; legacy untouched");
await sb.put("trend-logs.json", "{}"); assert.ok(store.has("trend-logs.json"), "shared files are not scoped");
const other = scopedBucket(bucket, "zzz");
assert.equal(await other.get("props.json"), null, "other users don't see legacy or owner data");

// Through the Worker: mock Access by stubbing crypto verification is heavy, so use the
// unit pieces above plus a password-mode check that nothing changes without Access.
store.clear(); store.set("props.json", JSON.stringify([{ id: "p1", player: "A" }]));
const env = { PROP_DATA: bucket, ALLOW_OPEN: "true" };
const me = await (await worker.fetch(new Request("http://x/api/me"), env)).json();
assert.deepEqual(me, { email: null, owner: false, perAccount: false });
const props = await (await worker.fetch(new Request("http://x/api/props"), env)).json();
assert.equal(props[0].id, "p1", "without Access the shared file is used as before");
console.log("per-account storage tests passed");

// End to end with a real signed Access token (certs served by a stubbed fetch).
{
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "u1", alg: "RS256" };
  const b64u = (x) => Buffer.from(x).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const team = "userteam.cloudflareaccess.com", AUD = "aud-users";
  const tok = async (email) => {
    const h = b64u(JSON.stringify({ alg: "RS256", kid: "u1" })), p = b64u(JSON.stringify({ aud: [AUD], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + 600, email }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(h + "." + p));
    return h + "." + p + "." + b64u(new Uint8Array(sig));
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/cdn-cgi/access/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(url);
  store.clear(); store.set("props.json", JSON.stringify([{ id: "legacy", player: "Owner Old Prop" }]));
  const env2 = { PROP_DATA: bucket, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, OWNER_EMAIL: "owner@example.com" };
  const call = async (email, path, init = {}) => worker.fetch(new Request("http://x" + path, { ...init, headers: { ...(init.headers || {}), "cf-access-jwt-assertion": await tok(email) } }), env2);
  const ownerMe = await (await call("owner@example.com", "/api/me")).json();
  assert.deepEqual(ownerMe, { email: "owner@example.com", owner: true, perAccount: true });
  assert.equal((await (await call("owner@example.com", "/api/props")).json())[0].id, "legacy", "owner keeps the old shared props");
  assert.deepEqual(await (await call("friend@example.com", "/api/props")).json(), [], "a new account starts empty");
  assert.equal((await call("friend@example.com", "/api/refresh-stats", { method: "POST" })).status, 403, "only the owner refreshes feeds");
  // The friend's NBA lines are theirs alone.
  const save = await call("friend@example.com", "/api/nba-lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Jalen Brunson, points, 26.5" }) });
  assert.equal(save.status, 200);
  assert.equal((await (await call("friend@example.com", "/api/nba-lines")).json()).length, 1);
  assert.deepEqual(await (await call("owner@example.com", "/api/nba-lines")).json(), [], "owner doesn't see the friend's lines");
  assert.ok([...store.keys()].some((k) => k.startsWith("users/") && k.endsWith("/nba-lines.json")) && !store.has("nba-lines.json"));
  assert.ok(![...store.keys()].some((k) => k.includes("@")), "no emails in storage keys");
  globalThis.fetch = realFetch;
  console.log("per-account end-to-end tests passed");
}
