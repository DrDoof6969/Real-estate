// lib/turnstile.js
//
// Server-side verification for Cloudflare Turnstile (their free CAPTCHA
// alternative — unlimited challenges, no usage cap, just a widget-count
// limit way above what this site needs). This is the actual answer to
// "someone is scripting thousands of lookups against my API budget" —
// rate limiting slows a scripted abuser down, Turnstile is what stops a
// script from completing the request at all.
//
// Optional. If TURNSTILE_SECRET_KEY isn't set, verifyTurnstile() always
// passes — the site works without it, you just have no bot defense
// beyond the rate limiter. See README "Scaling to real traffic" for
// setup (Cloudflare dashboard, free, ~5 minutes).

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const turnstileEnabled = !!process.env.TURNSTILE_SECRET_KEY;

// token = the value the Turnstile widget puts in the frontend form; ip =
// the visitor's IP (optional but recommended by Cloudflare's docs).
export async function verifyTurnstile(token, ip) {
  if (!turnstileEnabled) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: "missing verification token" };

  try {
    const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set("remoteip", ip);
    const r = await fetch(VERIFY_URL, { method: "POST", body });
    const data = await r.json().catch(() => null);
    if (!data) return { ok: false, error: "verification service unavailable" };
    if (!data.success) return { ok: false, error: (data["error-codes"] || []).join(", ") || "verification failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
