// lib/observability.js
//
// Structured logging plus optional alerting. There is deliberately no npm
// dependency here: Vercel captures stdout from every function invocation,
// so a single JSON line per event is already queryable in the Vercel
// dashboard and forwardable to any log drain (Datadog, Better Stack,
// Axiom) without changing this code.
//
// Optional: set ALERT_WEBHOOK_URL to a Slack or Discord incoming-webhook
// URL and the events that actually need a human — budget exhausted,
// provider outage, cache gone dark — get pushed to you instead of sitting
// in a log nobody reads. Everything else stays a log line.

const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL;
const SERVICE = process.env.VERCEL_ENV || "development";

// Never log a full IP — it's personal data under GDPR/CCPA and you have no
// reason to retain it. A short prefix is enough to correlate abuse from
// one source within a single log window.
export function redactIp(ip) {
  if (!ip || ip === "unknown") return "unknown";
  if (ip.includes(":")) return ip.split(":").slice(0, 2).join(":") + "::";
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "unknown";
}

export function log(level, event, fields = {}) {
  const line = JSON.stringify({
    level,
    event,
    env: SERVICE,
    ts: new Date().toISOString(),
    ...fields
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Fire-and-forget: an alert that fails must never fail the request that
// triggered it. Deduped per instance so one bad hour doesn't send five
// hundred identical messages.
const recentAlerts = new Map();
const ALERT_DEDUPE_MS = 15 * 60 * 1000;

export async function alert(event, message, fields = {}) {
  log("error", event, fields);
  if (!ALERT_WEBHOOK) return;

  const now = Date.now();
  const last = recentAlerts.get(event);
  if (last && now - last < ALERT_DEDUPE_MS) return;
  recentAlerts.set(event, now);
  if (recentAlerts.size > 100) recentAlerts.clear();

  const text = `[deal-qualifier/${SERVICE}] ${event}: ${message}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    // Slack expects {text}, Discord expects {content} — sending both keys
    // means one webhook URL works for either without configuration.
    await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
  } catch (e) {
    // Swallowed on purpose.
  }
}
