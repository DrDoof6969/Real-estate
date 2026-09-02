// api/stats.js
//
// Your own usage dashboard, in JSON. Answers the question you need
// answered before you pick a RentCast plan and every month after: how
// many FRESH (billable) lookups is this site actually doing, and how much
// of that is the cache saving me?
//
// Admin-only. Set ADMIN_TOKEN in your environment and call:
//   /api/stats?token=YOUR_ADMIN_TOKEN
//
// Without ADMIN_TOKEN set, this endpoint refuses to serve at all rather
// than defaulting to public — usage numbers tell an abuser exactly how
// much budget is left today.

import { upstashEnabled, mget } from "../lib/upstash.js";
import { applySecurityHeaders, methodNotAllowed } from "../lib/security.js";

const GLOBAL_DAILY_LIMIT = parseInt(process.env.DAILY_GLOBAL_LOOKUP_LIMIT || "200", 10);
const GLOBAL_MONTHLY_LIMIT = parseInt(process.env.MONTHLY_GLOBAL_LOOKUP_LIMIT || String(GLOBAL_DAILY_LIMIT * 25), 10);

function dayKeys(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export default async function handler(req, res) {
  applySecurityHeaders(res);
  if (methodNotAllowed(req, res, ["GET"])) return;
  res.setHeader("Cache-Control", "no-store");

  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: "ADMIN_TOKEN is not set on this deployment — stats are disabled." });
    return;
  }
  if (req.query.token !== adminToken) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (!upstashEnabled) {
    res.status(503).json({ error: "Upstash is not configured, so there are no shared counters to report. Usage is only visible in your provider dashboards until you set it up." });
    return;
  }

  const days = Math.min(30, Math.max(1, parseInt(req.query.days || "14", 10)));
  const stamps = dayKeys(days);
  const month = new Date().toISOString().slice(0, 7);

  const keys = [
    ...stamps.map(d => `ratelimit:global-lookups:all:${d}`),
    `ratelimit:global-lookups-month:all:${month}`
  ];

  const values = await mget(keys);
  const daily = stamps.map((d, i) => ({ date: d, freshLookups: parseInt(values[i] || "0", 10) }));
  const monthToDate = parseInt(values[values.length - 1] || "0", 10);

  const total = daily.reduce((a, b) => a + b.freshLookups, 0);
  const busiest = daily.reduce((a, b) => (b.freshLookups > a.freshLookups ? b : a), daily[0]);

  res.status(200).json({
    // Every fresh lookup spends 3 RentCast calls (property records, value
    // AVM, rent AVM) plus 1 Rentometer call when that's configured. This
    // is the number to size your plan against, not the lookup count.
    rentcastCallsPerLookup: 3,
    today: daily[0],
    last14Days: daily,
    averagePerDay: Math.round((total / days) * 10) / 10,
    busiestDay: busiest,
    monthToDate: {
      freshLookups: monthToDate,
      estimatedRentcastCalls: monthToDate * 3,
      limit: GLOBAL_MONTHLY_LIMIT,
      percentUsed: Math.round((monthToDate / GLOBAL_MONTHLY_LIMIT) * 100)
    },
    limits: { daily: GLOBAL_DAILY_LIMIT, monthly: GLOBAL_MONTHLY_LIMIT },
    note: "Counts are FRESH lookups only — cache hits and coalesced duplicate requests are free and not counted here. The gap between these numbers and your real visitor count is what the cache is saving you."
  });
}
