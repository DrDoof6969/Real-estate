// api/lookup.js
//
// Vercel serverless function. Runs on Vercel's servers, never in the
// visitor's browser — this is the ONLY place your API keys live. The
// frontend calls GET /api/lookup?address=... and never talks to RentCast
// or Rentometer directly.
//
// Required env var:
//   RENTCAST_API_KEY    https://app.rentcast.io/app/api (free: 50/mo)
//
// Optional env vars (each feature below quietly turns itself off without
// its var set — nothing breaks, you just don't get that guardrail):
//   RENTOMETER_API_KEY          second rent-comp source, see README
//   UPSTASH_REDIS_REST_URL      \
//   UPSTASH_REDIS_REST_TOKEN    / shared cache + real distributed rate
//                                 limiting + a global daily spend cap —
//                                 see README "Scaling to real traffic"
//                                 before this goes in front of real
//                                 public traffic, not just for you
//   TURNSTILE_SECRET_KEY        bot-check before a lookup is allowed to
//                                 spend an API call, see README
//   LOOKUP_DAILY_LIMIT_PER_IP   default 20 — per-visitor daily cap
//   DAILY_GLOBAL_LOOKUP_LIMIT   default 200 — site-wide daily cap across
//                                 ALL visitors combined, sized to protect
//                                 your RentCast bill; only enforced when
//                                 Upstash is configured (see below)
//   LOOKUP_CACHE_TTL_SECONDS    default 259200 (3 days) — how long a
//                                 looked-up address's result is reused
//                                 for the NEXT visitor who looks up that
//                                 same address, instead of spending a
//                                 fresh API call. This is the single
//                                 biggest lever for real traffic: at
//                                 thousands of users, the same popular
//                                 listings get looked up repeatedly.
//
// RentCast endpoints used here (per developers.rentcast.io research,
// Sept 2026):
//   GET /v1/properties            property records (search-style — takes
//                                  the first match for the address)
//   GET /v1/avm/value              automated value estimate
//   GET /v1/avm/rent/long-term     automated rent estimate — scoped with
//                                  an estimated per-unit square footage
//                                  and bedroom count (building totals ÷
//                                  unit count) so a multi-unit property
//                                  gets a comp search sized to one unit,
//                                  not the whole building.
//
// Rentometer endpoint used here:
//   GET /api/v1/summary?api_key=...&address=...&bedrooms=...
//
// If a field below comes back null when it shouldn't, call this endpoint
// with &debug=1 to see the raw provider responses and fix the field name
// here — these are third-party APIs, not something this file controls.

import { upstashEnabled, cacheGet, cacheSet } from "../lib/upstash.js";
import { checkDailyLimit } from "../lib/limiter.js";
import { verifyTurnstile } from "../lib/turnstile.js";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const RENTOMETER_BASE = "https://www.rentometer.com/api/v1";

const PER_IP_LIMIT = parseInt(process.env.LOOKUP_DAILY_LIMIT_PER_IP || "20", 10);
const GLOBAL_LIMIT = parseInt(process.env.DAILY_GLOBAL_LOOKUP_LIMIT || "200", 10);
const CACHE_TTL = parseInt(process.env.LOOKUP_CACHE_TTL_SECONDS || String(3 * 24 * 60 * 60), 10);

async function safeFetch(url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
    if (!r.ok) {
      return { ok: false, status: r.status, error: (body && (body.message || body.error)) || text || r.statusText };
    }
    return { ok: true, status: r.status, data: body };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

function latestByYear(obj) {
  if (!obj || typeof obj !== "object") return null;
  const years = Object.keys(obj).filter(k => /^\d{4}$/.test(k)).sort();
  return years.length ? obj[years[years.length - 1]] : null;
}

function normalizeAddress(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

async function runProviderLookups(address) {
  const rentcastKey = process.env.RENTCAST_API_KEY;
  if (!rentcastKey) {
    return { error: "Server is missing RENTCAST_API_KEY. Set it in your hosting provider's environment variables and redeploy — see the README." };
  }

  const rcHeaders = { "X-Api-Key": rentcastKey, "Accept": "application/json" };
  const q = "address=" + encodeURIComponent(address);

  const records = await safeFetch(`${RENTCAST_BASE}/properties?${q}`, rcHeaders);
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
    safeFetch(`${RENTCAST_BASE}/avm/value?${q}`, rcHeaders),
    safeFetch(`${RENTCAST_BASE}/avm/rent/long-term?${rentcastRentQ}`, rcHeaders),
    rentometerUrl ? safeFetch(rentometerUrl, { Accept: "application/json" }) : Promise.resolve({ ok: false, error: "RENTOMETER_API_KEY not configured" })
  ]);

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

  return { payload };
}

export default async function handler(req, res) {
  const address = (req.query.address || "").toString().trim();
  const debug = req.query.debug === "1";

  if (!address) {
    res.status(400).json({ error: "Missing ?address= (a full US street address, e.g. '214 Maple St, Columbia, SC 29201')" });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();

  // Bot check first — no point spending a rate-limit slot OR a cache
  // lookup on a request that fails this.
  const turnstile = await verifyTurnstile((req.query.turnstileToken || "").toString(), ip);
  if (!turnstile.ok) {
    res.status(403).json({ error: "Bot check failed: " + turnstile.error });
    return;
  }

  const perIp = await checkDailyLimit("ip", ip, PER_IP_LIMIT);
  if (perIp.limited) {
    res.status(429).json({ error: `This server's daily lookup limit (${PER_IP_LIMIT}/visitor) is used up for now. Raise LOOKUP_DAILY_LIMIT_PER_IP if this is your own traffic, or come back tomorrow.` });
    return;
  }

  // Cache hit skips provider calls (and the global budget check below)
  // entirely — a cached lookup costs nothing and doesn't compete with
  // the site-wide daily budget, which exists to protect against fresh
  // provider calls, not repeat views of the same address.
  const cacheKey = "lookup:v2:" + normalizeAddress(address);
  if (upstashEnabled) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const out = { ...cached, cached: true, rateLimit: { remaining: perIp.remaining, limitPerDay: PER_IP_LIMIT, distributed: perIp.distributed } };
      if (!debug) delete out._debugRaw;
      res.status(200).json(out);
      return;
    }
  }

  const globalBudget = await checkDailyLimit("global-lookups", "all", GLOBAL_LIMIT);
  if (globalBudget.limited && globalBudget.distributed) {
    // Only a hard stop when this is a REAL shared count (Upstash
    // configured) — enforcing a "global" budget off a per-instance
    // in-memory counter would just randomly block some visitors and not
    // others depending which instance they hit, which is worse than not
    // enforcing it at all.
    res.status(503).json({ error: "This site's shared daily lookup budget is used up — it resets at midnight UTC. Raise DAILY_GLOBAL_LOOKUP_LIMIT if you've upgraded your RentCast plan to cover more volume." });
    return;
  }

  const result = await runProviderLookups(address);
  if (result.error) {
    res.status(500).json({ error: result.error });
    return;
  }

  const payload = result.payload;
  payload.cached = false;
  payload.rateLimit = { remaining: perIp.remaining, limitPerDay: PER_IP_LIMIT, distributed: perIp.distributed };

  if (upstashEnabled) {
    // Cache the clean payload, not the debug-only raw provider bodies.
    const { _debugRaw, ...toCache } = payload;
    await cacheSet(cacheKey, toCache, CACHE_TTL);
  }

  if (debug) {
    payload.raw = payload._debugRaw;
  }
  delete payload._debugRaw;

  res.status(200).json(payload);
}
