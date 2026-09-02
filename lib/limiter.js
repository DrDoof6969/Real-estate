// lib/limiter.js
//
// Per-IP daily rate limiting, shared by api/lookup.js and
// api/autocomplete.js. Uses Upstash Redis when it's configured (a real
// counter shared across every serverless instance handling your
// traffic); falls back to an in-memory Map scoped to one instance when
// it isn't. The in-memory fallback is honest best-effort only — it
// resets on cold starts/redeploys and isn't shared across instances or
// regions, so at real multi-instance traffic it slows down a naive
// single-IP abuser and nothing more. See README "Scaling to real
// traffic" before depending on this to hold under real public load.

import { upstashEnabled, incrWithExpiry } from "./upstash.js";

const localCounts = new Map();
const DAY_SECONDS = 24 * 60 * 60;

function localIncr(key) {
  const now = Date.now();
  const entry = localCounts.get(key);
  if (!entry || now - entry.windowStart > DAY_SECONDS * 1000) {
    localCounts.set(key, { windowStart: now, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

// Returns { limited: boolean, remaining: number, distributed: boolean }.
// `distributed` tells you whether this check was backed by Upstash
// (trustworthy under real concurrent traffic) or the in-memory fallback
// (advisory only).
export async function checkDailyLimit(scope, id, limit) {
  const key = `ratelimit:${scope}:${id}:${new Date().toISOString().slice(0, 10)}`;
  let count = await incrWithExpiry(key, DAY_SECONDS + 3600); // pad past midnight UTC
  const distributed = count != null;
  if (count == null) count = localIncr(key);
  return { limited: count > limit, remaining: Math.max(0, limit - count), distributed };
}
