// lib/upstash.js
//
// Thin wrapper around Upstash Redis's REST API (no persistent socket, so
// it works fine from a stateless serverless function — that's the whole
// point of Upstash existing). This is what makes rate limiting and
// caching actually SHARED across every serverless instance handling your
// traffic, instead of the per-instance in-memory counters that reset on
// every cold start.
//
// Commands are sent as a POST with a JSON body array (["SET", key, value,
// "EX", ttl]) rather than encoded into the URL path. The path form works
// for short values but silently fails once a value is more than a couple
// of KB — a URL-encoded lookup payload is 4-8KB, well past what Upstash's
// edge will accept in a path segment — and because errors here return
// null, that failure looks exactly like a cache miss. Caching is the
// single biggest cost lever at real traffic, so it can't be allowed to
// fail invisibly.
//
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (copy both
// verbatim from your Upstash console — the URL is a full generated
// hostname, don't try to construct it yourself) to turn this on. Every
// function below no-ops safely (returns null / does nothing) when those
// aren't set, so the site keeps working without Upstash — it just falls
// back to weaker, per-instance-only guardrails. See README "Running this
// for real traffic."

import { log } from "./observability.js";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TIMEOUT_MS = parseInt(process.env.UPSTASH_TIMEOUT_MS || "2000", 10);

export const upstashEnabled = !!(BASE && TOKEN);

// Redis has to be fast or not in the request path at all. A 2s cap means
// a degraded Upstash region costs every visitor 2 seconds instead of
// hanging the function until Vercel kills it at the platform timeout.
async function post(path, body) {
  if (!upstashEnabled) return { ok: false, offline: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const parsed = await r.json().catch(() => null);
    if (!r.ok || !parsed) {
      log("warn", "upstash_http_error", { status: r.status });
      return { ok: false };
    }
    if (parsed.error) {
      log("warn", "upstash_command_error", { error: String(parsed.error).slice(0, 200) });
      return { ok: false };
    }
    return { ok: true, result: parsed.result };
  } catch (e) {
    log("warn", "upstash_unreachable", { error: e.name === "AbortError" ? "timeout" : e.message });
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Single command. Returns the raw result, or null on any failure /
// when Upstash isn't configured.
async function cmd(...args) {
  const out = await post("", args.map(String));
  return out.ok ? out.result : null;
}

// Several commands in one round trip. Returns an array of results in the
// same order, or null if the whole pipeline failed. At thousands of
// requests/day the difference between four sequential Upstash round trips
// and one pipelined trip is most of the latency this layer adds.
export async function pipeline(commands) {
  if (!commands.length) return [];
  const out = await post("/pipeline", commands.map(c => c.map(String)));
  if (!out.ok || !Array.isArray(out.result)) return null;
  return out.result.map(entry => (entry && entry.error ? null : entry?.result ?? null));
}

// JSON-value cache with a TTL. Returns null on a miss OR when Upstash
// isn't configured — callers can't tell the difference and shouldn't
// need to; either way, go fetch it fresh.
export async function cacheGet(key) {
  const raw = await cmd("GET", key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Returns true only when the write actually landed, so callers can log a
// cache that has quietly stopped working instead of paying for every
// lookup twice forever.
export async function cacheSet(key, value, ttlSeconds) {
  const out = await post("", ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
  return out.ok;
}

// Atomic increment of a counter that expires after ttlSeconds from its
// FIRST increment in the window (the expiry is only set when the counter
// is freshly created, i.e. INCR just returned 1 — setting it every call
// would keep pushing the window out and it would never actually reset).
// Pipelined so the INCR and its EXPIRE are one round trip.
// Returns null when Upstash isn't configured, so callers can fall back
// to a local counter instead of silently treating "no limit info" as
// "under the limit."
export async function incrWithExpiry(key, ttlSeconds) {
  const n = await cmd("INCR", key);
  if (typeof n !== "number") return null;
  // Only the increment that CREATED the counter sets the expiry. Doing it
  // on every call would keep pushing the window out and the counter would
  // never reset. Kept as a separate round trip rather than a pipelined
  // `EXPIRE ... NX` so this works on any Redis version, and it only costs
  // the extra trip once per window.
  if (n === 1) await cmd("EXPIRE", key, String(ttlSeconds));
  return n;
}

// Give a counted slot back. Used when a lookup reserved budget but the
// provider call failed — a RentCast 404 shouldn't permanently consume a
// slot of the daily spend cap, because it didn't cost a billable call
// worth protecting.
export async function decr(key) {
  await cmd("DECR", key);
}

// Single-flight lock. When fifty people hit the same address in the same
// second (one listing going viral is exactly what "thousands of users"
// looks like in practice), only the request that wins this lock spends
// provider calls; the rest wait briefly and read the cache the winner
// writes. Without it, a popular address costs one paid API call per
// concurrent visitor, which is the specific way an API bill goes from
// fine to four figures overnight.
export async function acquireLock(key, ttlSeconds) {
  const res = await cmd("SET", key, "1", "NX", "EX", String(ttlSeconds));
  return res === "OK";
}

export async function releaseLock(key) {
  await cmd("DEL", key);
}

// Read several counters at once for the stats endpoint.
export async function mget(keys) {
  if (!keys.length) return [];
  const res = await cmd("MGET", ...keys);
  return Array.isArray(res) ? res : keys.map(() => null);
}

export async function ping() {
  const started = Date.now();
  const res = await cmd("PING");
  return { ok: res === "PONG", latencyMs: Date.now() - started };
}
