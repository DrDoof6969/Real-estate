// lib/upstash.js
//
// Thin wrapper around Upstash Redis's REST API (no persistent socket, so
// it works fine from a stateless serverless function — that's the whole
// point of Upstash existing). This is what makes rate limiting and
// caching actually SHARED across every serverless instance handling your
// traffic, instead of the per-instance in-memory counters that reset on
// every cold start.
//
// Deliberately hand-rolled against Upstash's documented REST endpoints
// (upstash.com/docs/redis/features/restapi) rather than pulling in the
// @upstash/redis npm package — one fewer dependency to install/version,
// and it's ~30 lines either way.
//
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (copy both
// verbatim from your Upstash console — the URL is a full generated
// hostname, don't try to construct it yourself) to turn this on. Every
// function below no-ops safely (returns null / does nothing) when those
// aren't set, so the site keeps working without Upstash — it just falls
// back to weaker, per-instance-only guardrails. See README "Scaling to
// real traffic."

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const upstashEnabled = !!(BASE && TOKEN);

async function cmd(path) {
  if (!upstashEnabled) return null;
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.error) return null;
    return body.result;
  } catch (e) {
    return null;
  }
}

// JSON-value cache with a TTL. Returns null on a miss OR when Upstash
// isn't configured — callers can't tell the difference and shouldn't
// need to; either way, go fetch it fresh.
export async function cacheGet(key) {
  const raw = await cmd(`/get/${encodeURIComponent(key)}`);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function cacheSet(key, value, ttlSeconds) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  await cmd(`/set/${encodeURIComponent(key)}/${encoded}/EX/${ttlSeconds}`);
}

// Atomic increment of a counter that expires after ttlSeconds from its
// FIRST increment in the window (the expiry is only set when the counter
// is freshly created, i.e. INCR just returned 1 — setting it every call
// would keep pushing the window out and it would never actually reset).
// Returns null when Upstash isn't configured, so callers can fall back
// to a local counter instead of silently treating "no limit info" as
// "under the limit."
export async function incrWithExpiry(key, ttlSeconds) {
  const n = await cmd(`/incr/${encodeURIComponent(key)}`);
  if (n === 1) await cmd(`/expire/${encodeURIComponent(key)}/${ttlSeconds}`);
  return n;
}
