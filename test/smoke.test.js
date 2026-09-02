// test/smoke.test.js
//
// Runs every endpoint with no network and no API keys and asserts the
// behaviour that matters when things are missing or hostile: junk input
// is rejected before it could cost a provider call, limits actually
// trigger, secrets stay out of responses, and nothing throws an unhandled
// error at the client.
//
// Deliberately dependency-free (node --test would work too, but this runs
// anywhere Node 18+ does with no install step):
//   npm test

import assert from "node:assert/strict";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

// Minimal stand-ins for Vercel's req/res so handlers can be called
// directly in-process.
function mockReq(query = {}, headers = {}, method = "GET") {
  return { method, query, headers, socket: { remoteAddress: "203.0.113.9" } };
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

// Keys stay unset for the whole run: every provider path must fail
// closed, not hang or throw.
delete process.env.RENTCAST_API_KEY;
delete process.env.MAPBOX_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.TURNSTILE_SECRET_KEY;
process.env.TURNSTILE_REQUIRED = "false";

const { default: lookup } = await import("../api/lookup.js");
const { default: autocomplete } = await import("../api/autocomplete.js");
const { default: config } = await import("../api/config.js");
const { default: health } = await import("../api/health.js");
const { default: stats } = await import("../api/stats.js");
const { normalizeAddress } = await import("../lib/address.js");
const { validateAddress, clientIp, originAllowed } = await import("../lib/security.js");
const { consume } = await import("../lib/limiter.js");

// --- address normalization: the cache-hit-rate lever ---------------------

await test("normalizes equivalent address spellings to one cache key", () => {
  assert.equal(
    normalizeAddress("214 Maple St., Columbia, SC 29201-1234"),
    normalizeAddress("214  maple STREET  columbia sc 29201")
  );
  assert.equal(
    normalizeAddress("88 North Oak Avenue"),
    normalizeAddress("88 n oak ave")
  );
});

await test("does NOT collapse genuinely different addresses", () => {
  assert.notEqual(normalizeAddress("214 Maple St"), normalizeAddress("215 Maple St"));
  assert.notEqual(normalizeAddress("214 Maple St"), normalizeAddress("214 Maple Ave"));
  assert.notEqual(normalizeAddress("214 Maple St Apt 1"), normalizeAddress("214 Maple St Apt 2"));
});

// --- input validation: reject junk before it costs money -----------------

await test("rejects addresses that could never resolve", () => {
  assert.equal(validateAddress("").ok, false);
  assert.equal(validateAddress("abc").ok, false);
  assert.equal(validateAddress("aaaaaaaaaaaaaa").ok, false, "no street number");
  assert.equal(validateAddress("12345678").ok, false, "no street name");
  assert.equal(validateAddress("x".repeat(500)).ok, false, "too long");
  assert.equal(validateAddress("214 Maple St, Columbia, SC 29201").ok, true);
});

// --- IP extraction: the spoofable-header bug ------------------------------

await test("ignores a client-supplied X-Forwarded-For prefix", () => {
  // An abuser sending a fake leftmost entry must not get a fresh
  // rate-limit bucket. The proxy nearest us appends on the right.
  const ip = clientIp(mockReq({}, { "x-forwarded-for": "1.2.3.4, 198.51.100.7" }));
  assert.equal(ip, "198.51.100.7");
});

await test("prefers platform-set headers over X-Forwarded-For", () => {
  const ip = clientIp(mockReq({}, {
    "x-forwarded-for": "1.2.3.4",
    "x-vercel-forwarded-for": "198.51.100.22"
  }));
  assert.equal(ip, "198.51.100.22");
});

// --- origin lock ---------------------------------------------------------

await test("origin lock is off when unconfigured, enforced when set", async () => {
  assert.equal(originAllowed(mockReq({}, { origin: "https://evil.example" })).ok, true);

  process.env.ALLOWED_ORIGINS = "https://dealqualifier.com";
  const { originAllowed: guarded } = await import("../lib/security.js?reload=1");
  assert.equal(guarded(mockReq({}, { origin: "https://evil.example" })).ok, false);
  assert.equal(guarded(mockReq({}, { origin: "https://dealqualifier.com" })).ok, true);
  assert.equal(guarded(mockReq({}, {})).ok, true, "no origin header (curl, monitors) still allowed");
  delete process.env.ALLOWED_ORIGINS;
});

// --- lookup endpoint -----------------------------------------------------

await test("lookup rejects a bad address with 400 and no provider call", async () => {
  const res = mockRes();
  await lookup(mockReq({ address: "zzz" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /too short|street/i);
});

await test("lookup rejects a non-GET method", async () => {
  const res = mockRes();
  await lookup(mockReq({ address: "214 Maple St, Columbia SC" }, {}, "POST"), res);
  assert.equal(res.statusCode, 405);
});

await test("lookup fails loudly when RENTCAST_API_KEY is missing", async () => {
  const res = mockRes();
  await lookup(mockReq({ address: "214 Maple St, Columbia SC 29201" }, { "x-real-ip": "198.51.100.30" }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /RENTCAST_API_KEY/);
});

await test("lookup burst limit triggers and returns Retry-After", async () => {
  const ip = "198.51.100.44";
  let limited = null;
  // Default burst limit is 5/minute; the 6th must be refused.
  for (let i = 0; i < 8 && !limited; i++) {
    const res = mockRes();
    await lookup(mockReq({ address: "214 Maple St, Columbia SC 29201" }, { "x-real-ip": ip }), res);
    if (res.statusCode === 429) limited = res;
  }
  assert.ok(limited, "burst limit never triggered");
  assert.equal(limited.headers["retry-after"], "60");
  assert.match(limited.body.error, /minute/i);
});

await test("lookup never sets a cacheable header on per-visitor data", async () => {
  const res = mockRes();
  await lookup(mockReq({ address: "214 Maple St, Columbia SC 29201" }, { "x-real-ip": "198.51.100.55" }), res);
  assert.match(res.headers["cache-control"], /private|no-store/);
});

// --- autocomplete --------------------------------------------------------

await test("autocomplete returns empty (never an error) with no token", async () => {
  const res = mockRes();
  await autocomplete(mockReq({ q: "214 Maple" }, { "x-real-ip": "198.51.100.60" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.suggestions, []);
});

await test("autocomplete short-circuits under 3 characters", async () => {
  const res = mockRes();
  await autocomplete(mockReq({ q: "21" }, { "x-real-ip": "198.51.100.61" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.suggestions, []);
});

// --- config / health / stats ---------------------------------------------

await test("config leaks no secrets", async () => {
  process.env.RENTCAST_API_KEY = "secret-rentcast-key";
  process.env.TURNSTILE_SECRET_KEY = "secret-turnstile-key";
  const res = mockRes();
  await config(mockReq(), res);
  const serialized = JSON.stringify(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(!serialized.includes("secret-rentcast-key"), "RentCast key leaked to the browser");
  assert.ok(!serialized.includes("secret-turnstile-key"), "Turnstile SECRET leaked to the browser");
  assert.ok("turnstileSiteKey" in res.body);
  delete process.env.RENTCAST_API_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

await test("health reports down without RentCast, degraded without Upstash", async () => {
  const res = mockRes();
  await health(mockReq(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "down");
  assert.ok(res.body.fatal.some(f => /RENTCAST_API_KEY/.test(f)));

  process.env.RENTCAST_API_KEY = "k";
  const res2 = mockRes();
  await health(mockReq(), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.status, "degraded");
  assert.ok(res2.body.degraded.some(d => /Upstash/.test(d)));
  delete process.env.RENTCAST_API_KEY;
});

await test("stats refuses to serve without an admin token", async () => {
  delete process.env.ADMIN_TOKEN;
  const res = mockRes();
  await stats(mockReq({}), res);
  assert.equal(res.statusCode, 503);

  process.env.ADMIN_TOKEN = "admin-secret";
  const res2 = mockRes();
  await stats(mockReq({ token: "wrong" }), res2);
  assert.equal(res2.statusCode, 403);
  delete process.env.ADMIN_TOKEN;
});

// --- limiter fallback ----------------------------------------------------

await test("in-memory limiter counts and reports itself as non-distributed", async () => {
  const first = await consume("test-scope", "1.1.1.1", 2, "minute");
  assert.equal(first.count, 1);
  assert.equal(first.distributed, false);
  assert.equal(first.limited, false);

  await consume("test-scope", "1.1.1.1", 2, "minute");
  const third = await consume("test-scope", "1.1.1.1", 2, "minute");
  assert.equal(third.limited, true);
});

// --- report --------------------------------------------------------------

const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : "\n          " + r.error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
