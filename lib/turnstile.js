// lib/turnstile.js
//
// Server-side verification for Cloudflare Turnstile (their free CAPTCHA
// alternative — unlimited challenges, no usage cap, just a widget-count
// limit way above what this site needs). This is the actual answer to
// "someone is scripting thousands of lookups against my API budget" —
// rate limiting slows a scripted abuser down, Turnstile is what stops a
// script from completing the request at all.
//
// Optional in development. In production it is REQUIRED by default: a
// public site that spends money per request cannot ship with its only
// real bot defense switched off by an unset environment variable. Set
// TURNSTILE_REQUIRED=false to deploy without it anyway (you'll get a
// startup warning in the logs on every lookup), or leave it alone and set
// TURNSTILE_SECRET_KEY like the README says.

import { log } from "./observability.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = parseInt(process.env.TURNSTILE_TIMEOUT_MS || "4000", 10);

export const turnstileEnabled = !!process.env.TURNSTILE_SECRET_KEY;

// In production, absent config is a misconfiguration, not a feature flag.
const isProduction = process.env.VERCEL_ENV === "production";
export const turnstileRequired = process.env.TURNSTILE_REQUIRED
  ? process.env.TURNSTILE_REQUIRED !== "false"
  : isProduction;

// token = the value the Turnstile widget puts in the frontend form; ip =
// the visitor's IP (optional but recommended by Cloudflare's docs).
export async function verifyTurnstile(token, ip) {
  if (!turnstileEnabled) {
    if (turnstileRequired) {
      return {
        ok: false,
        misconfigured: true,
        error: "this site's bot check isn't configured — set TURNSTILE_SECRET_KEY (see README)"
      };
    }
    return { ok: true, skipped: true };
  }

  if (!token) return { ok: false, error: "missing verification token" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);

    const r = await fetch(VERIFY_URL, { method: "POST", body, signal: controller.signal });
    const data = await r.json().catch(() => null);
    if (!data) return { ok: false, error: "verification service unavailable" };

    if (!data.success) {
      const codes = data["error-codes"] || [];
      // An expired or already-spent token is the normal result of a
      // visitor sitting on the page a while, not an attack — the frontend
      // resets the widget and they retry. Worth separating so it doesn't
      // pollute the signal when you're actually looking for abuse.
      const benign = codes.some(c => ["timeout-or-duplicate", "invalid-input-response"].includes(c));
      if (!benign) log("warn", "turnstile_rejected", { codes });
      return {
        ok: false,
        benign,
        error: benign
          ? "verification expired — hit Look up again"
          : (codes.join(", ") || "verification failed")
      };
    }

    return { ok: true };
  } catch (e) {
    const reason = e.name === "AbortError" ? "verification timed out" : e.message;
    log("warn", "turnstile_unreachable", { error: reason });
    // Cloudflare being down must not take the whole site down with it.
    // Failing open here is a deliberate trade: the rate limiter and the
    // spend budget are still in front of every provider call, so the
    // worst case is a bounded amount of unverified traffic, not an
    // unbounded bill.
    return { ok: true, degraded: true, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
