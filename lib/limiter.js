// lib/limiter.js
//
// Rate limiting and spend budgets, shared by every endpoint. Uses Upstash
// Redis when it's configured (a real counter shared across every
// serverless instance handling your traffic); falls back to an in-memory
// Map scoped to one instance when it isn't.
//
// The in-memory fallback is honest best-effort only — it resets on cold
// starts/redeploys and isn't shared across instances or regions, so at
// real multi-instance traffic it slows down a naive single-IP abuser and
// nothing more. Anything that protects MONEY (the daily and monthly spend
// caps) refuses to enforce off the local fallback at all and says so,
// because a "budget" that each instance counts separately isn't a budget.
// See README "Running this for real traffic."

import { upstashEnabled, incrWithExpiry, decr } from "./upstash.js";

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * 60;
const MONTH_SECONDS = 31 * DAY_SECONDS;

// Bounded so a long-lived instance under sustained traffic can't grow the
// map without limit. Oldest windows are dropped first — they're the ones
// closest to expiring anyway.
const MAX_LOCAL_KEYS = 5000;
const localCounts = new Map();

function localIncr(key, windowSeconds) {
  const now = Date.now();
  const entry = localCounts.get(key);

  if (!entry || now - entry.windowStart > windowSeconds * 1000) {
    if (localCounts.size >= MAX_LOCAL_KEYS) {
      const oldest = localCounts.keys().next().value;
      localCounts.delete(oldest);
    }
    localCounts.set(key, { windowStart: now, count: 1 });
    return 1;
  }

  entry.count += 1;
  return entry.count;
}

function localDecr(key) {
  const entry = localCounts.get(key);
  if (entry && entry.count > 0) entry.count -= 1;
}

function windowKey(scope, id, window) {
  const now = new Date();
  let stamp;
  if (window === "minute") stamp = now.toISOString().slice(0, 16);      // YYYY-MM-DDTHH:MM
  else if (window === "month") stamp = now.toISOString().slice(0, 7);   // YYYY-MM
  else stamp = now.toISOString().slice(0, 10);                          // YYYY-MM-DD
  return `ratelimit:${scope}:${id}:${stamp}`;
}

function windowSeconds(window) {
  if (window === "minute") return MINUTE_SECONDS * 2;        // pad past the boundary
  if (window === "month") return MONTH_SECONDS + DAY_SECONDS;
  return DAY_SECONDS + 3600;                                  // pad past midnight UTC
}

// Consume one slot. Returns { limited, remaining, count, distributed, key }.
// `distributed` tells you whether this check was backed by Upstash
// (trustworthy under real concurrent traffic) or the in-memory fallback
// (advisory only).
export async function consume(scope, id, limit, window = "day") {
  const key = windowKey(scope, id, window);
  const ttl = windowSeconds(window);

  let count = await incrWithExpiry(key, ttl);
  const distributed = count != null;
  if (count == null) count = localIncr(key, ttl);

  return {
    limited: count > limit,
    remaining: Math.max(0, limit - count),
    count,
    distributed,
    key
  };
}

// Backwards-compatible name used by the existing endpoints.
export async function checkDailyLimit(scope, id, limit) {
  return consume(scope, id, limit, "day");
}

// Hand a reserved slot back when the work it was reserved for never
// happened — a provider 404 or outage shouldn't burn a slot of the daily
// spend cap, because it didn't cost a billable call.
export async function refund(result) {
  if (!result || !result.key) return;
  if (result.distributed) await decr(result.key);
  else localDecr(result.key);
}

// Everything a request needs to know about its own limits, in one call.
// Burst limiting matters as much as the daily cap at real traffic: 20
// lookups/day per visitor still allows all 20 inside two seconds, which
// is exactly the shape of a script probing the endpoint.
export async function checkVisitorLimits(scope, ip, { perMinute, perDay }) {
  const minute = await consume(`${scope}-burst`, ip, perMinute, "minute");
  if (minute.limited) {
    return {
      limited: true,
      window: "minute",
      retryAfterSeconds: 60,
      message: `Too many requests — wait a minute and try again. (Limit: ${perMinute}/minute per visitor.)`,
      detail: minute
    };
  }

  const day = await consume(scope, ip, perDay, "day");
  if (day.limited) {
    return {
      limited: true,
      window: "day",
      retryAfterSeconds: secondsUntilUtcMidnight(),
      message: `You've used this site's daily limit of ${perDay} lookups. It resets at midnight UTC.`,
      detail: day
    };
  }

  return { limited: false, day, minute };
}

export function secondsUntilUtcMidnight() {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000));
}

// Site-wide spend caps. Only ever enforced against a real shared counter:
// enforcing a "global" budget off per-instance memory would randomly block
// some visitors and not others depending which instance they hit, which is
// worse than not enforcing it at all. Without Upstash this reports
// `enforceable: false` so the caller can surface that honestly instead of
// pretending there's a ceiling.
export async function checkSpendBudget({ dailyLimit, monthlyLimit }) {
  if (!upstashEnabled) {
    return { limited: false, enforceable: false, daily: null, monthly: null };
  }

  const daily = await consume("global-lookups", "all", dailyLimit, "day");
  if (!daily.distributed) {
    return { limited: false, enforceable: false, daily, monthly: null };
  }

  const monthly = await consume("global-lookups-month", "all", monthlyLimit, "month");

  if (monthly.limited) {
    return {
      limited: true,
      enforceable: true,
      window: "month",
      message: "This site's monthly data budget is used up — it resets on the 1st.",
      daily,
      monthly
    };
  }

  if (daily.limited) {
    return {
      limited: true,
      enforceable: true,
      window: "day",
      retryAfterSeconds: secondsUntilUtcMidnight(),
      message: "This site's shared daily lookup budget is used up — it resets at midnight UTC.",
      daily,
      monthly
    };
  }

  return { limited: false, enforceable: true, daily, monthly };
}

export async function refundSpendBudget(budget) {
  if (!budget || !budget.enforceable) return;
  await refund(budget.daily);
  await refund(budget.monthly);
}
