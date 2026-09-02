// api/lookup.js
//
// Vercel serverless function. Runs on Vercel's servers, never in the
// visitor's browser — this is the ONLY place your API keys live. The
// frontend calls GET /api/lookup?address=... and never talks to RentCast
// or Rentometer directly.
//
// Every guardrail in here exists because this endpoint SPENDS MONEY per
// call. The order of operations below is the whole design: each check is
// placed so the cheapest way to reject a request happens first, and a
// provider call is the last thing that happens, not the first.
//
//   1. validate the address         (free — rejects junk before anything)
//   2. origin check                 (free — stops other sites using your budget)
//   3. per-visitor burst limit      (Redis — stops a script mid-flood)
//   4. CACHE                        (Redis — a hit costs nothing and returns here)
//   5. bot check                    (Cloudflare — only for requests about to spend)
//   6. per-visitor daily limit      (Redis — only consumed on a cache MISS)
//   7. site-wide spend budget       (Redis — refunded if the call fails)
//   8. single-flight lock           (Redis — one paid call per address, not per visitor)
//   9. provider calls               (the only step that costs money)
//
// Required env var:
//   RENTCAST_API_KEY    https://app.rentcast.io/app/api
//
// See .env.example and the README for everything optional.
//
// RentCast endpoints used here:
//   GET /v1/properties            property records (takes the first match)
//   GET /v1/avm/value             automated value estimate
//   GET /v1/avm/rent/long-term    automated rent estimate — scoped with an
//                                 estimated per-unit square footage and
//                                 bedroom count (building totals / unit
//                                 count) so a multi-unit property gets a
//                                 comp search sized to one unit.
//
// Rentometer endpoint used here:
//   GET /api/v1/summary?api_key=...&address=...&bedrooms=...

import { upstashEnabled, cacheGet, cacheSet, acquireLock, releaseLock } from "../lib/upstash.js";
import { consume, checkSpendBudget, refundSpendBudget, refund, secondsUntilUtcMidnight } from "../lib/limiter.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { fetchJson } from "../lib/http.js";
import { clientIp, originAllowed, applySecurityHeaders, handlePreflight, methodNotAllowed, validateAddress } from "../lib/security.js";
import { normalizeAddress } from "../lib/address.js";
import { log, alert, redactIp } from "../lib/observability.js";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const RENTOMETER_BASE = "https://www.rentometer.com/api/v1";

const PER_IP_PER_MINUTE = parseInt(process.env.LOOKUP_LIMIT_PER_IP_PER_MINUTE || "5", 10);
const PER_IP_LIMIT = parseInt(process.env.LOOKUP_DAILY_LIMIT_PER_IP || "20", 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.DAILY_GLOBAL_LOOKUP_LIMIT || "200", 10);
const GLOBAL_MONTHLY_LIMIT = parseInt(process.env.MONTHLY_GLOBAL_LOOKUP_LIMIT || String(GLOBAL_DAILY_LIMIT * 25), 10);

const CACHE_TTL = parseInt(process.env.LOOKUP_CACHE_TTL_SECONDS || String(3 * 24 * 60 * 60), 10);
// "This address has no data" is a real, stable answer worth caching too —
// otherwise every visitor who tries the same unindexed new-construction
// address pays for the same three empty provider calls.
const NEGATIVE_CACHE_TTL = parseInt(process.env.LOOKUP_NEGATIVE_CACHE_TTL_SECONDS || String(24 * 60 * 60), 10);
const LOCK_TTL = 15;
const LOCK_WAIT_MS = 4000;

const CACHE_VERSION = "v3";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function latestByYear(obj) {
  if (!obj || typeof obj !== "object") return null;
  const years = Object.keys(obj).filter(k => /^\d{4}$/.test(k)).sort();
  return years.length ? obj[years[years.length - 1]] : null;
}

async function runProviderLookups(address) {
  const rentcastKey = process.env.RENTCAST_API_KEY;
  if (!rentcastKey) {
    return { error: "Server is missing RENTCAST_API_KEY. Set it in your hosting provider's environment variables and redeploy — see the README.", fatal: true };
  }

  const rcHeaders = { "X-Api-Key": rentcastKey };
  const q = "address=" + encodeURIComponent(address);

  const records = await fetchJson(`${RENTCAST_BASE}/properties?${q}`, { headers: rcHeaders, label: "rentcast-properties" });
  const rec = records.ok
    ? (Array.isArray(records.data) ? records.data[0] : records.data)
    : null;

  const unitCount =
    rec?.features?.unitCount ??
    rec?.unitCount ??
    (rec?.propertyType && /multi|apartment/i.test(rec.propertyType) ? 2 : 1);

  const perUnitSqft = rec?.squareFootage && unitCount > 0
    ? Math.round(rec.squareFootage / unitCount)
    : null;
  const perUnitBedroomsRaw = rec?.bedrooms && unitCount > 0
    ? Math.round(rec.bedrooms / unitCount)
    : null;
  const perUnitBedrooms = perUnitBedroomsRaw ? Math.min(4, Math.max(1, perUnitBedroomsRaw)) : null;

  const rentcastRentQ = q
    + (perUnitSqft ? `&squareFootage=${perUnitSqft}` : "")
    + (perUnitBedrooms ? `&bedrooms=${perUnitBedrooms}` : "");

  const rentometerKey = process.env.RENTOMETER_API_KEY;
  const rentometerUrl = rentometerKey
    ? `${RENTOMETER_BASE}/summary?api_key=${encodeURIComponent(rentometerKey)}&address=${encodeURIComponent(address)}`
      + (perUnitBedrooms ? `&bedrooms=${perUnitBedrooms}` : "")
    : null;

  const [value, rcRent, rmRent] = await Promise.all([
    fetchJson(`${RENTCAST_BASE}/avm/value?${q}`, { headers: rcHeaders, label: "rentcast-value" }),
    fetchJson(`${RENTCAST_BASE}/avm/rent/long-term?${rentcastRentQ}`, { headers: rcHeaders, label: "rentcast-rent" }),
    rentometerUrl
      ? fetchJson(rentometerUrl, { label: "rentometer" })
      : Promise.resolve({ ok: false, error: "RENTOMETER_API_KEY not configured" })
  ]);

  // A provider that is DOWN is a different situation from a provider that
  // answered "no data for this address". The first must not be cached and
  // is worth an alert; the second is a legitimate, cacheable answer.
  const providerOutage = [records, value, rcRent].some(r => !r.ok && (r.status === 0 || r.status >= 500));

  const latestTax = latestByYear(rec?.propertyTaxes);
  const latestAssessment = latestByYear(rec?.taxAssessments);
  const rmHasEstimate = rmRent.ok && (rmRent.data?.median != null || rmRent.data?.mean != null);

  const payload = {
    query: address,
    resolvedAddress: rec?.formattedAddress || rec?.addressLine1 || address,
    records: {
      ok: records.ok && !!rec,
      error: records.ok ? (rec ? null : "no property found for this address") : records.error,
      bedrooms: rec?.bedrooms ?? null,
      bathrooms: rec?.bathrooms ?? null,
      squareFootage: rec?.squareFootage ?? null,
      propertyType: rec?.propertyType ?? null,
      unitCount,
      yearBuilt: rec?.yearBuilt ?? null,
      annualPropertyTax: latestTax?.total ?? null,
      taxAssessmentValue: latestAssessment?.value ?? null
    },
    value: {
      ok: value.ok && value.data?.price != null,
      error: value.ok ? (value.data?.price != null ? null : "no value estimate for this address") : value.error,
      estimate: value.data?.price ?? null,
      rangeLow: value.data?.priceRangeLow ?? null,
      rangeHigh: value.data?.priceRangeHigh ?? null
    },
    rentPerUnit: {
      perUnitBedroomsUsed: perUnitBedrooms,
      perUnitSquareFootageUsed: perUnitSqft,
      rentcast: {
        ok: rcRent.ok && rcRent.data?.rent != null,
        error: rcRent.ok ? (rcRent.data?.rent != null ? null : "no rent estimate for this address") : rcRent.error,
        estimate: rcRent.data?.rent ?? null,
        rangeLow: rcRent.data?.rentRangeLow ?? null,
        rangeHigh: rcRent.data?.rentRangeHigh ?? null
      },
      rentometer: {
        ok: rmHasEstimate,
        error: rentometerKey ? (rmHasEstimate ? null : (rmRent.error || "no comps returned")) : "RENTOMETER_API_KEY not set — this cross-check is optional, see README",
        estimate: rmRent.data?.median ?? rmRent.data?.mean ?? null,
        rangeLow: rmRent.data?.percentile_25 ?? rmRent.data?.min ?? null,
        rangeHigh: rmRent.data?.percentile_75 ?? rmRent.data?.max ?? null,
        sampleSize: rmRent.data?.samples ?? null
      }
    },
    _debugRaw: { records: records.data, value: value.data, rentcastRent: rcRent.data, rentometer: rmRent.data }
  };

  const anythingUseful = payload.records.ok || payload.value.ok || payload.rentPerUnit.rentcast.ok || payload.rentPerUnit.rentometer.ok;

  return { payload, providerOutage, anythingUseful };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  applySecurityHeaders(res);
  if (handlePreflight(req, res)) return;
  if (methodNotAllowed(req, res, ["GET"])) return;

  // Per-visitor data — never let a CDN or browser hand one visitor's
  // rate-limit state or result to another.
  res.setHeader("Cache-Control", "private, no-store");

  // --- 1. Validate before anything else costs anything -----------------
  const validation = validateAddress(req.query.address);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const address = validation.address;

  // Raw provider bodies can carry account details and error text you don't
  // want public. On a site anyone can hit, debug output is admin-only.
  const adminToken = process.env.ADMIN_TOKEN;
  const debug = req.query.debug === "1" && (
    (!!adminToken && req.query.adminToken === adminToken)
    || process.env.VERCEL_ENV !== "production"
  );

  const ip = clientIp(req);

  // --- 2. Origin check -------------------------------------------------
  const origin = originAllowed(req);
  if (!origin.ok) {
    log("warn", "origin_rejected", { ip: redactIp(ip), origin: req.headers.origin || req.headers.referer || null });
    res.status(403).json({ error: "This API only serves this site's own frontend." });
    return;
  }

  // --- 3. Burst limit: applies to EVERY request, cached or not ---------
  const burst = await consume("lookup-burst", ip, PER_IP_PER_MINUTE, "minute");
  if (burst.limited) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error: `Too many lookups at once — wait a minute and try again. (Limit: ${PER_IP_PER_MINUTE}/minute.)`,
      retryAfterSeconds: 60
    });
    return;
  }

  // --- 4. Cache: a hit costs nothing and returns immediately -----------
  const cacheKey = `lookup:${CACHE_VERSION}:` + normalizeAddress(address);
  if (upstashEnabled) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      log("info", "lookup_cache_hit", { ms: Date.now() - startedAt });
      sendPayload(res, { ...cached, cached: true }, { debug, remaining: null });
      return;
    }
  }

  // --- 5. Bot check: only for requests that are about to spend money ---
  const turnstile = await verifyTurnstile((req.query.turnstileToken || "").toString(), ip);
  if (!turnstile.ok) {
    if (turnstile.misconfigured) {
      await alert("turnstile_misconfigured", "TURNSTILE_SECRET_KEY is unset in production and TURNSTILE_REQUIRED is on — every lookup is being rejected.");
      res.status(503).json({ error: "This site's bot check isn't configured yet. If this is your site, set TURNSTILE_SECRET_KEY (see README) or set TURNSTILE_REQUIRED=false." });
      return;
    }
    res.status(403).json({ error: "Bot check failed: " + turnstile.error, retryable: !!turnstile.benign });
    return;
  }

  // --- 6. Per-visitor daily limit: only consumed on a cache MISS -------
  // Reading a cached address is free, so it shouldn't count against a
  // visitor's allowance; only a lookup that will actually spend a provider
  // call does.
  const daily = await consume("lookup-paid", ip, PER_IP_LIMIT, "day");
  if (daily.limited) {
    const retryAfter = secondsUntilUtcMidnight();
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `You've used this site's daily limit of ${PER_IP_LIMIT} fresh lookups. It resets at midnight UTC. (Addresses someone already looked up recently don't count against this.)`,
      retryAfterSeconds: retryAfter
    });
    return;
  }

  // --- 7. Site-wide spend budget --------------------------------------
  const budget = await checkSpendBudget({ dailyLimit: GLOBAL_DAILY_LIMIT, monthlyLimit: GLOBAL_MONTHLY_LIMIT });
  if (budget.limited) {
    await refund(daily);
    await alert("spend_budget_exhausted", `${budget.window} lookup budget hit. Raise the cap or upgrade the RentCast plan.`, { window: budget.window });
    res.setHeader("Retry-After", String(budget.retryAfterSeconds || secondsUntilUtcMidnight()));
    res.status(503).json({ error: budget.message + " If this is your site, raise DAILY_GLOBAL_LOOKUP_LIMIT / MONTHLY_GLOBAL_LOOKUP_LIMIT to match your RentCast plan." });
    return;
  }

  // --- 8. Single-flight: one paid call per address, not per visitor ----
  const lockKey = `lock:${cacheKey}`;
  let holdsLock = false;
  if (upstashEnabled) {
    holdsLock = await acquireLock(lockKey, LOCK_TTL);
    if (!holdsLock) {
      // Someone else is already paying for this exact address right now.
      // Wait briefly for their result rather than buying a second copy.
      const waited = await waitForCache(cacheKey, LOCK_WAIT_MS);
      if (waited) {
        await refund(daily);
        await refundSpendBudget(budget);
        log("info", "lookup_coalesced", { ms: Date.now() - startedAt });
        sendPayload(res, { ...waited, cached: true, coalesced: true }, { debug, remaining: null });
        return;
      }
      // The holder is slow or died. Fall through and do the work.
    }
  }

  // --- 9. The only step that costs money -------------------------------
  try {
    const result = await runProviderLookups(address);

    if (result.error) {
      await refund(daily);
      await refundSpendBudget(budget);
      if (result.fatal) await alert("rentcast_key_missing", "RENTCAST_API_KEY is not set — every lookup is failing.");
      res.status(500).json({ error: result.error });
      return;
    }

    const payload = result.payload;
    payload.cached = false;

    if (result.providerOutage) {
      // Don't cache an outage as if it were an answer, and don't charge
      // the visitor's allowance for a result they couldn't use.
      await refund(daily);
      await refundSpendBudget(budget);
      await alert("provider_outage", "RentCast returned 5xx/timeouts — lookups are degraded.");
    } else if (upstashEnabled) {
      const { _debugRaw, ...toCache } = payload;
      const ttl = result.anythingUseful ? CACHE_TTL : NEGATIVE_CACHE_TTL;
      const wrote = await cacheSet(cacheKey, toCache, ttl);
      if (!wrote) {
        await alert("cache_write_failed", "Upstash cache writes are failing — every lookup is now a paid provider call.");
      }
    }

    log("info", "lookup_fresh", {
      ms: Date.now() - startedAt,
      useful: result.anythingUseful,
      outage: result.providerOutage,
      globalDaily: budget.daily?.count ?? null
    });

    sendPayload(res, payload, { debug, remaining: daily.remaining ?? null });
  } catch (e) {
    await refund(daily);
    await refundSpendBudget(budget);
    log("error", "lookup_unhandled", { error: e.message });
    res.status(500).json({ error: "Lookup failed unexpectedly. Try again in a moment." });
  } finally {
    if (holdsLock) await releaseLock(lockKey);
  }
}

// Polls for the cache entry the lock-holder is about to write. Short
// intervals, hard ceiling — a visitor waiting on someone else's lookup
// must never wait longer than they'd have waited doing it themselves.
async function waitForCache(cacheKey, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const hit = await cacheGet(cacheKey);
    if (hit) return hit;
  }
  return null;
}

function sendPayload(res, payload, { debug, remaining }) {
  const out = { ...payload };
  out.rateLimit = {
    remaining,
    limitPerDay: PER_IP_LIMIT,
    limitPerMinute: PER_IP_PER_MINUTE,
    distributed: upstashEnabled
  };

  if (remaining != null) {
    res.setHeader("X-RateLimit-Limit", String(PER_IP_LIMIT));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
  }

  if (debug) out.raw = out._debugRaw;
  delete out._debugRaw;

  res.status(200).json(out);
}
