// api/config.js
//
// Public, non-secret configuration the frontend needs at runtime.
//
// This exists so the Turnstile SITE key (public by design — it's rendered
// into the widget) can live in an environment variable like every other
// key, instead of being hand-edited into index.html before each deploy.
// Editing a source file to configure a deployment is how a key ends up
// committed to a repo, or how a redeploy silently drops it.
//
// Nothing secret goes in this response. It is served to every visitor.

import { applySecurityHeaders, handlePreflight, methodNotAllowed } from "../lib/security.js";

export default async function handler(req, res) {
  applySecurityHeaders(res);
  if (handlePreflight(req, res)) return;
  if (methodNotAllowed(req, res, ["GET"])) return;

  // Identical for every visitor, so let the CDN serve it.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");

  res.status(200).json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
    autocompleteEnabled: !!process.env.MAPBOX_TOKEN,
    rentometerEnabled: !!process.env.RENTOMETER_API_KEY,
    lookupLimitPerDay: parseInt(process.env.LOOKUP_DAILY_LIMIT_PER_IP || "20", 10)
  });
}
