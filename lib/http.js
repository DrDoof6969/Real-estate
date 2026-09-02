// lib/http.js
//
// One fetch helper for every outbound provider call, because the two
// things that break a serverless function under real traffic are both
// outbound-call problems: a provider that hangs (your function burns its
// full timeout and Vercel bills you for the wall clock) and a provider
// that rate-limits you (RentCast caps at 20 requests/second — trivially
// reachable when several visitors look up at once, and a 429 there is
// retryable, not fatal).

import { log } from "./observability.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PROVIDER_TIMEOUT_MS || "8000", 10);
const MAX_ATTEMPTS = parseInt(process.env.PROVIDER_MAX_ATTEMPTS || "3", 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries only on the failures that are actually transient: 429 (we hit
// the provider's per-second cap), 5xx (their problem, likely brief), and
// network errors/timeouts. A 400 or 404 is a real answer about this
// address — retrying it just spends the same money again for the same
// result.
function isRetryable(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

// Returns { ok, status, data, error, attempts }.
export async function fetchJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS, label = "provider" } = {}) {
  let lastError = "unknown error";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: controller.signal });
      const text = await r.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }

      if (r.ok) return { ok: true, status: r.status, data: body, attempts: attempt };

      lastStatus = r.status;
      lastError = (body && (body.message || body.error)) || text || r.statusText;

      if (!isRetryable(r.status) || attempt === maxAttempts) {
        return { ok: false, status: r.status, error: lastError, attempts: attempt };
      }
      log("warn", "provider_retry", { label, status: r.status, attempt });
    } catch (e) {
      lastStatus = 0;
      lastError = e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message;
      if (attempt === maxAttempts) {
        return { ok: false, status: 0, error: lastError, attempts: attempt };
      }
      log("warn", "provider_retry", { label, error: lastError, attempt });
    } finally {
      clearTimeout(timer);
    }

    // Exponential backoff with jitter. The jitter matters more than the
    // backoff: without it, every concurrent request that got 429'd retries
    // at exactly the same moment and gets 429'd again together.
    const backoff = Math.min(1000 * 2 ** (attempt - 1), 4000);
    await sleep(backoff + Math.random() * 250);
  }

  return { ok: false, status: lastStatus, error: lastError, attempts: maxAttempts };
}
