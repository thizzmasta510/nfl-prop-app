// Per-account data. With Cloudflare Access on, each signed-in email gets its own
// saved props, tracker entries and NBA lines; shared files (game logs, injury
// reports, Kalshi price caches) stay shared. The storage key is a hash of the
// email, so emails are not written into object names.
//
// The owner (OWNER_EMAIL, set as a secret so it is not in the public repo) keeps
// the data saved before this change: until the owner's first save, reads fall back
// to the old shared files.

export const USER_KEYS = new Set(["props.json", "tracker.json", "nba-lines.json"]);

export async function userPrefix(email) {
  const bytes = new TextEncoder().encode(String(email || "").trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function isOwner(email, env) {
  const owner = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  return Boolean(owner && email && String(email).trim().toLowerCase() === owner);
}

/** A view of the R2 bucket where per-user files live under users/<hash>/. */
export function scopedBucket(bucket, prefix, { legacyFallback = false } = {}) {
  const map = (k) => (USER_KEYS.has(k) ? `users/${prefix}/${k}` : k);
  return {
    async get(key, opts) {
      const obj = await bucket.get(map(key), opts);
      if (obj === null && legacyFallback && USER_KEYS.has(key)) return bucket.get(key, opts);
      return obj;
    },
    put: (key, value, opts) => bucket.put(map(key), value, opts),
    delete: (key) => bucket.delete(map(key)),
    head: (key) => (bucket.head ? bucket.head(map(key)) : null),
    list: (opts) => bucket.list(opts),
  };
}
