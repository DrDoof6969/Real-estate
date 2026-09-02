// api/autocomplete.js
//
// Proxies the address-suggestion dropdown to Mapbox's Search Box API.
// Kept server-side for the same reason as lookup.js: the token never
// reaches the browser, so it can't be lifted out of view-source and used
// elsewhere against your quota.
//
// Set MAPBOX_TOKEN in your hosting provider's environment variables. Get
// one free at https://account.mapbox.com/access-tokens/ (no card required
// for the free tier: 50,000 non-session Search Box requests/month, which
// is what this uses — plenty for a personal or small-audience site).
//
// This only calls Mapbox's Suggest endpoint, never Retrieve — the tool
// only needs the typed address as TEXT to hand to /api/lookup, not
// coordinates, so there's no reason to spend a second API call per
// keystroke selection. That also means this stays in Mapbox's cheaper
// "non-session request" pricing tier rather than the paired
// suggest+retrieve "session" tier.
//
// Per docs.mapbox.com/api/search/search-box/ (Sept 2026 research):
//   GET /search/searchbox/v1/suggest?q=...&access_token=...&session_token=...
//   Response: { suggestions: [{ name, place_formatted, full_address, mapbox_id, ... }] }
// Rate-limit/error response shapes weren't published anywhere we could
// verify, so errors here are handled defensively (any non-200 or
// unparseable body just becomes "no suggestions") rather than matched
// against a guessed schema.

import { checkDailyLimit } from "../lib/limiter.js";

const PER_IP_LIMIT = parseInt(process.env.AUTOCOMPLETE_DAILY_LIMIT_PER_IP || "500", 10);

export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  const session = (req.query.session || "default").toString().slice(0, 100);

  if (q.length < 3) {
    res.status(200).json({ suggestions: [] });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();
  const rl = await checkDailyLimit("autocomplete-ip", ip, PER_IP_LIMIT);
  if (rl.limited) {
    // Fail quiet, not loud — losing the dropdown for the rest of the day
    // shouldn't block someone from typing a full address and hitting
    // Look up.
    res.status(200).json({ suggestions: [] });
    return;
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    res.status(200).json({ suggestions: [], error: "MAPBOX_TOKEN not configured on the server — address autocomplete is off, but you can still type a full address and hit Look up." });
    return;
  }

  const url = "https://api.mapbox.com/search/searchbox/v1/suggest"
    + `?q=${encodeURIComponent(q)}`
    + `&access_token=${encodeURIComponent(token)}`
    + `&session_token=${encodeURIComponent(session)}`
    + "&country=us&types=address&limit=6";

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { /* fall through */ }

    if (!r.ok || !body) {
      res.status(200).json({ suggestions: [] });
      return;
    }

    const suggestions = (body.suggestions || []).map(s => ({
      id: s.mapbox_id,
      label: s.full_address || [s.name, s.place_formatted].filter(Boolean).join(", ")
    })).filter(s => s.label);

    res.status(200).json({ suggestions });
  } catch (e) {
    res.status(200).json({ suggestions: [] });
  }
}
