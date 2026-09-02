// api/autocomplete.js
//
// Proxies the address-suggestion dropdown to Mapbox's Search Box API.
// Kept server-side for the same reason as lookup.js: the token never
// reaches the browser, so it can't be lifted out of view-source and used
// elsewhere against your quota.
//
// This fires on nearly every keystroke, so it's the highest-volume
// endpoint on the site by an order of magnitude — at a thousand visitors
// a day it's the one that decides whether you stay inside Mapbox's free
// tier. Three things keep it there: a 3-character minimum, a shared cache
// on the normalized query (people type the same street prefixes), and a
// CDN cache header so Vercel's edge answers repeats without ever invoking
// this function.
//
// Set MAPBOX_TOKEN in your hosting provider's environment variables. Get
// one free at https://account.mapbox.com/access-tokens/ (free tier:
// 50,000 non-session Search Box requests/month).
//
// This only calls Mapbox's Suggest endpoint, never Retrieve — the tool
// only needs the typed address as TEXT to hand to /api/lookup, not
// coordinates, so there's no reason to spend a second API call per
// keystroke selection. That also keeps it in Mapbox's cheaper
// "non-session request" pricing tier.

import { upstashEnabled, cacheGet, cacheSet } from "../lib/upstash.js";
import { consume } from "../lib/limiter.js";
import { fetchJson } from "../lib/http.js";
import { clientIp, originAllowed, applySecurityHeaders, handlePreflight, methodNotAllowed } from "../lib/security.js";
import { log, redactIp } from "../lib/observability.js";

const PER_MINUTE_LIMIT = parseInt(process.env.AUTOCOMPLETE_LIMIT_PER_IP_PER_MINUTE || "60", 10);
const PER_IP_LIMIT = parseInt(process.env.AUTOCOMPLETE_DAILY_LIMIT_PER_IP || "500", 10);
const CACHE_TTL = parseInt(process.env.AUTOCOMPLETE_CACHE_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);
const EDGE_TTL = parseInt(process.env.AUTOCOMPLETE_EDGE_TTL_SECONDS || "3600", 10);

// Suggestions for a query prefix are identical for everyone, so they can
// be cached publicly — including at Vercel's CDN edge, which is free and
// never invokes this function at all.
const empty = (res, extra = {}) => {
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
  res.status(200).json({ suggestions: [], ...extra });
};

export default async function handler(req, res) {
  applySecurityHeaders(res);
  if (handlePreflight(req, res)) return;
  if (methodNotAllowed(req, res, ["GET"])) return;

  const q = (req.query.q || "").toString().trim().slice(0, 120);
  const session = (req.query.session || "default").toString().slice(0, 100);

  if (q.length < 3) {
    empty(res);
    return;
  }

  const origin = originAllowed(req);
  if (!origin.ok) {
    res.setHeader("Cache-Control", "private, no-store");
    res.status(403).json({ suggestions: [], error: "This API only serves this site's own frontend." });
    return;
  }

  const ip = clientIp(req);

  // Fail quiet, not loud, on every failure path below — losing the
  // dropdown shouldn't stop someone typing a full address and hitting
  // Look up. A visible error here would be worse than no dropdown.
  const burst = await consume("autocomplete-burst", ip, PER_MINUTE_LIMIT, "minute");
  if (burst.limited) {
    log("warn", "autocomplete_burst_limited", { ip: redactIp(ip) });
    empty(res);
    return;
  }

  const daily = await consume("autocomplete-ip", ip, PER_IP_LIMIT, "day");
  if (daily.limited) {
    empty(res);
    return;
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    empty(res, { error: "MAPBOX_TOKEN not configured on the server — address autocomplete is off, but you can still type a full address and hit Look up." });
    return;
  }

  const normalized = q.toLowerCase().replace(/\s+/g, " ");
  const cacheKey = "autocomplete:v2:" + normalized;

  if (upstashEnabled) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=86400`);
      res.status(200).json({ suggestions: cached, cached: true });
      return;
    }
  }

  const url = "https://api.mapbox.com/search/searchbox/v1/suggest"
    + `?q=${encodeURIComponent(q)}`
    + `&access_token=${encodeURIComponent(token)}`
    + `&session_token=${encodeURIComponent(session)}`
    + "&country=us&types=address&limit=6";

  // Short timeout and no retries: this runs on a keystroke. A suggestion
  // that arrives after the user has typed three more characters is worse
  // than no suggestion, and retrying a keystroke request multiplies the
  // highest-volume call on the site against a metered quota.
  const r = await fetchJson(url, { timeoutMs: 2500, maxAttempts: 1, label: "mapbox-suggest" });
  if (!r.ok || !r.data) {
    log("warn", "autocomplete_provider_error", { status: r.status });
    empty(res);
    return;
  }

  const suggestions = (r.data.suggestions || []).map(s => ({
    id: s.mapbox_id,
    label: s.full_address || [s.name, s.place_formatted].filter(Boolean).join(", ")
  })).filter(s => s.label);

  if (upstashEnabled && suggestions.length) {
    await cacheSet(cacheKey, suggestions, CACHE_TTL);
  }

  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=86400`);
  res.status(200).json({ suggestions });
}
