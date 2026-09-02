// api/health.js
//
// What an uptime monitor (or you, at 2am) hits to find out whether this
// site is actually working, and if not, which dependency broke. Point
// UptimeRobot / Better Stack / Vercel's own monitoring at this path.
//
// Deliberately does NOT call RentCast or Mapbox — a health check that
// spends a metered API call every 60 seconds costs 43,200 calls a month
// and would drain the very budget it's meant to protect. It reports
// whether each key is CONFIGURED, and pings Upstash (unmetered, and the
// dependency most likely to be the actual problem).
//
// Returns 200 when the site can serve lookups, 503 when it can't, so a
// monitor can alert on the status code alone.

import { upstashEnabled, ping } from "../lib/upstash.js";
import { turnstileEnabled, turnstileRequired } from "../lib/turnstile.js";
import { applySecurityHeaders, methodNotAllowed } from "../lib/security.js";

export default async function handler(req, res) {
  applySecurityHeaders(res);
  if (methodNotAllowed(req, res, ["GET", "HEAD"])) return;
  res.setHeader("Cache-Control", "no-store");

  const redis = upstashEnabled ? await ping() : { ok: false, skipped: true };

  const checks = {
    rentcastKey: !!process.env.RENTCAST_API_KEY,
    mapboxToken: !!process.env.MAPBOX_TOKEN,
    rentometerKey: !!process.env.RENTOMETER_API_KEY,
    turnstile: turnstileEnabled,
    upstash: upstashEnabled ? redis.ok : false
  };

  // Lookups are impossible without RentCast, and impossible with the bot
  // check required but unconfigured. Everything else degrades rather than
  // breaks, so it's reported but doesn't fail the check.
  const fatal = [];
  if (!checks.rentcastKey) fatal.push("RENTCAST_API_KEY is not set");
  if (turnstileRequired && !turnstileEnabled) fatal.push("TURNSTILE_SECRET_KEY is required in production but not set");

  const degraded = [];
  if (!upstashEnabled) degraded.push("Upstash not configured — no shared cache, no spend cap, per-instance rate limiting only");
  else if (!redis.ok) degraded.push("Upstash configured but not responding — running without cache or spend cap");
  if (!checks.mapboxToken) degraded.push("MAPBOX_TOKEN not set — address autocomplete is off");
  if (!checks.rentometerKey) degraded.push("RENTOMETER_API_KEY not set — no rent cross-check");

  const status = fatal.length ? "down" : degraded.length ? "degraded" : "ok";

  res.status(fatal.length ? 503 : 200).json({
    status,
    env: process.env.VERCEL_ENV || "development",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    checks,
    redisLatencyMs: redis.latencyMs ?? null,
    fatal,
    degraded,
    ts: new Date().toISOString()
  });
}
