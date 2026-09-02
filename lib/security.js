// lib/security.js
//
// The request-level guardrails every public endpoint needs before it is
// allowed to spend money: who is calling, are they allowed to call from
// there, and what headers does the response need so a browser treats this
// site safely.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim().replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);

// Client IP, taken from the headers the platform sets rather than the one
// the client controls.
//
// `x-forwarded-for` is attacker-controllable on most platforms: a script
// can send `X-Forwarded-For: 1.2.3.4` and, if the proxy appends rather
// than replaces, reading the LEFTMOST entry hands the abuser a fresh
// rate-limit bucket on every request just by changing that header. That
// makes per-IP limiting decorative. Vercel sets `x-vercel-forwarded-for`
// and `x-real-ip` itself and they cannot be spoofed from outside, so
// those come first; the last (right-most) entry of `x-forwarded-for` is
// the last fallback, because the proxy nearest us appends there.
export function clientIp(req) {
  const vercel = req.headers["x-vercel-forwarded-for"];
  if (vercel) return String(vercel).split(",")[0].trim();

  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }

  return (req.socket?.remoteAddress || "unknown").toString();
}

// Blocks another site from pointing its frontend at your /api/lookup and
// spending your RentCast budget. Set ALLOWED_ORIGINS to your own domains
// (comma-separated, e.g. "https://dealqualifier.com,https://www.dealqualifier.com").
//
// Requests with no Origin/Referer at all are allowed through: that covers
// direct navigation, curl during debugging, and uptime monitors. It is not
// a bot defense on its own — Turnstile is — it just closes the "someone
// else embeds my API" hole, which is otherwise free budget theft.
export function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return { ok: true, unconfigured: true };

  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const candidate = origin || referer;
  if (!candidate) return { ok: true, noOrigin: true };

  let host;
  try {
    const u = new URL(candidate);
    host = `${u.protocol}//${u.host}`.toLowerCase();
  } catch (e) {
    return { ok: false, error: "malformed origin" };
  }

  // Vercel preview deployments get a generated hostname per deploy, so
  // allow the project's own preview domains without having to list each.
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(host)) return { ok: true, preview: true };

  return ALLOWED_ORIGINS.includes(host)
    ? { ok: true }
    : { ok: false, error: "origin not allowed" };
}

export function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

// Same-origin only — the frontend and the functions live on one domain,
// so there is no legitimate cross-origin caller to allow.
export function handlePreflight(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.setHeader("Allow", "GET, OPTIONS");
  res.status(204).end();
  return true;
}

export function methodNotAllowed(req, res, allowed = ["GET"]) {
  if (allowed.includes(req.method)) return false;
  res.setHeader("Allow", allowed.join(", "));
  res.status(405).json({ error: `Method ${req.method} not allowed` });
  return true;
}

// A US street address, loosely. This exists to reject junk BEFORE it
// costs a provider call — a 2KB string or "aaaaaaa" is never going to
// resolve, and paying RentCast to tell you that is the most avoidable
// line on the bill.
export function validateAddress(raw) {
  const address = String(raw || "").trim().replace(/\s+/g, " ");

  if (!address) return { ok: false, error: "Missing ?address= (a full US street address, e.g. '214 Maple St, Columbia, SC 29201')" };
  if (address.length < 8) return { ok: false, error: "That address is too short to look up — include the street, city and state." };
  if (address.length > 200) return { ok: false, error: "That address is too long — paste just the street address, city, state and zip." };
  if (!/\d/.test(address)) return { ok: false, error: "That doesn't look like a street address — it needs a street number." };
  if (!/[a-z]/i.test(address)) return { ok: false, error: "That doesn't look like a street address — it needs a street name." };
  if (/[<>{}\\^`]/.test(address)) return { ok: false, error: "That address contains characters no street address has." };

  return { ok: true, address };
}
