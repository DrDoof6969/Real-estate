# Deal Qualifier

A self-hosted version of your rental deal qualifier. Same tool as the Claude
artifact — FHA / conventional owner-occ / conventional investor / DSCR,
portfolio-aware reserves, loan recommendations — plus three things the
artifact couldn't do: an address-autocomplete dropdown, an address lookup
that auto-fills price/tax/unit count/rent from two independent data
providers, and a real domain.

What's here:

| File | What it is |
|---|---|
| `index.html` | the whole site. Static HTML/CSS/JS, no build step |
| `api/lookup.js` | the address lookup. Holds your RentCast + Rentometer keys, runs every guardrail, does the property-data calls |
| `api/autocomplete.js` | holds your Mapbox token, powers the address dropdown as you type |
| `api/config.js` | public, non-secret config the frontend reads at load (the Turnstile *site* key) |
| `api/health.js` | uptime-monitor target. 503 when the site can't serve lookups. Never spends a metered API call |
| `api/stats.js` | admin-only usage dashboard — how many billable lookups you're actually doing |
| `lib/upstash.js` | Redis over REST: cache, counters, locks |
| `lib/limiter.js` | rate limits and spend budgets |
| `lib/turnstile.js` | bot-check verification |
| `lib/http.js` | outbound calls with timeouts and retries |
| `lib/security.js` | IP extraction, origin lock, input validation, headers |
| `lib/address.js` | address normalization for cache keys |
| `lib/observability.js` | structured logs and alerting |
| `vercel.json` | security headers, CSP, function limits, caching |
| `test/smoke.test.js` | `npm test` — runs every endpoint with no keys and no network |

None of your keys ever reach the browser — the frontend only ever calls
`/api/*` on your own domain.

**Endpoints:**

```
GET /api/lookup?address=...      the lookup (rate limited, cached, budgeted)
GET /api/autocomplete?q=...      address suggestions
GET /api/config                  public config for the frontend
GET /api/health                  uptime check — 200 ok / 503 down
GET /api/stats?token=ADMIN_TOKEN your usage numbers
```

## 1. Get your API keys

| Provider | What it's for | Cost | Sign up |
|---|---|---|---|
| **RentCast** | property records, value estimate, rent estimate — required | Free: 50 lookups/mo, no card | [app.rentcast.io/app/api](https://app.rentcast.io/app/api) |
| **Mapbox** | address-autocomplete dropdown — optional, site works without it, you just type the full address instead | Free: 50,000 requests/mo | [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/) |
| **Rentometer** | second, independent rent estimate to cross-check RentCast's — optional | Pro plan $29/mo (includes 200 API credits, more purchasable) | [rentometer.com/pricing/individual](https://www.rentometer.com/pricing/individual) |

Only RentCast is required to run the site at all. Leave `MAPBOX_TOKEN` or
`RENTOMETER_API_KEY` unset and those features quietly turn themselves off
— autocomplete becomes a plain text box, and the rent estimate falls back
to RentCast alone.

**For a public site this table is not enough** — see section 2 for the
three additional accounts (Upstash, Turnstile, Vercel Pro) you need before
real traffic touches this, and why skipping the first one is the
difference between a $74 bill and a four-figure one.

## 2. What you have to sign up for before this serves real traffic

The code is now built to handle thousands of visitors a day. It cannot do
that on its own, because four of the things it needs are accounts, not
code. Each row fills a specific environment variable, and the site tells
you at `/api/health` which ones are still missing.

| Service | Why it's needed | Cost | Env var it fills | Sign up |
|---|---|---|---|---|
| **RentCast** | property records, value + rent estimates. Nothing works without it | see the plan math below | `RENTCAST_API_KEY` | [app.rentcast.io/app/api](https://app.rentcast.io/app/api) |
| **Upstash Redis** | the shared cache, the spend caps, and rate limiting that actually holds across instances. **This is the difference between a $74 bill and a $2,000 one** | Free tier: 500K commands/mo, enough for this | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | [upstash.com](https://upstash.com) |
| **Cloudflare Turnstile** | the only thing that stops a script from draining your API budget. Rate limiting slows an abuser; this stops them | Free, no usage cap | `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | [dash.cloudflare.com](https://dash.cloudflare.com/) → Turnstile → Add site |
| **Vercel Pro** | Hobby is licensed for personal, non-commercial use only, and its limits aren't sized for this | $20/mo | — | Vercel dashboard → Settings → Plans |
| **A domain** | Turnstile site keys are bound to a hostname and `ALLOWED_ORIGINS` needs a stable origin to lock against — on a rotating `*.vercel.app` preview URL neither the bot check nor the origin lock can be configured properly | ~$10-15/yr | `ALLOWED_ORIGINS` | Namecheap, Cloudflare, Porkbun |

Strongly recommended, all free:

| Service | Why | Env var |
|---|---|---|
| **Slack or Discord webhook** | you get a message when the budget is exhausted, a provider goes down, or cache writes start failing — instead of finding out from an invoice | `ALERT_WEBHOOK_URL` |
| **Better Stack** or **UptimeRobot** | **this site fails invisibly.** `index.html` is static and the calculator runs in the browser, so if the functions die the page still loads, still looks right, and the math still works — only the lookup silently stops filling fields. Nobody reports that. And the webhook alerts above can't catch it, because they fire from inside a running request: if the deployment is down or a function errors on startup, no request runs, so nothing alerts. A monitor on `/api/health` is the only thing in the stack that notices *nothing is running* rather than *a request went wrong*. Point it there every 5 minutes (it spends no metered API calls) and alert on non-200 | — |
| **Cloudflare** (proxy the domain) | DDoS protection and a caching layer in front of Vercel, so a flood never reaches your functions | — |
| **Vercel log drain** → Better Stack / Axiom / Datadog | every request emits one structured JSON line. A drain makes them searchable | — |
| **Rentometer** | second, independent rent estimate to cross-check RentCast | `RENTOMETER_API_KEY` |

Also set `ADMIN_TOKEN` to any random string — it gates `/api/stats` (your
usage dashboard) and the `&debug=1` raw provider output, which is
admin-only now because those responses can carry account details.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 2a. What "thousands of users a day" actually costs

This is the part worth reading before you pay for anything, because the
answer is decided by the cache, not by the code.

**Every fresh lookup spends 3 RentCast calls** (property records, value
AVM, rent AVM) — plus 1 Rentometer call if that's configured. So the
number that matters is calls, not lookups.

RentCast's self-serve tiers: Free 50/mo · Foundation $74/mo (1,000) ·
Growth $199/mo (5,000) · Scale $449/mo (25,000). Above that it's a custom
enterprise deal, and every tier bills overage past the cap.

Take 2,000 visitors/day, of whom 30% actually run a lookup — 600
lookups/day, 18,000/month:

| Cache hit rate | Fresh lookups/mo | RentCast calls/mo | Plan needed |
|---|---|---|---|
| 0% (no Upstash) | 18,000 | 54,000 | enterprise — call them |
| 50% | 9,000 | 27,000 | Scale $449 + overage |
| 80% | 3,600 | 10,800 | Scale $449 |
| 95% | 900 | 2,700 | Foundation $74 |

That 0% row is what you get today if you deploy without Upstash. The
difference between the top row and the bottom row is one free account and
two environment variables.

Hit rate depends on how much your traffic overlaps. If everyone looks up
a different address, caching does nothing and this is expensive at any
scale. If your visitors are looking at the same market — the same few
hundred listings in one metro — 80-95% is realistic, and it's the single
thing to watch. `/api/stats?token=...` reports fresh lookups per day so
you can see your real number instead of guessing, and size the plan
against that.

**Set your caps to match your plan on day one.** The defaults
(`DAILY_GLOBAL_LOOKUP_LIMIT=200`, `MONTHLY_GLOBAL_LOOKUP_LIMIT=5000`)
assume a paid plan. On the free tier, 200/day would spend your entire
monthly quota in the first afternoon — set `DAILY_GLOBAL_LOOKUP_LIMIT=1`
and `MONTHLY_GLOBAL_LOOKUP_LIMIT=16` until you're paying.

**One honest warning about the business shape**, since you asked for this
to be a real public site: there is no revenue mechanism in here, and the
unit economics are negative — every visitor costs you money and none of
them pay you. That's fine for a portfolio piece or a lead magnet. It is
not fine as a free public utility at thousands of users a day, because
the better it does, the more it costs you. If this is meant to earn,
decide what converts (an email gate, a paid tier above N lookups, or
using it as a funnel into something else) before you buy the RentCast
plan, not after.

## 2b. What the code does to protect the budget

Every guardrail below is already built and tested. The order matters —
each check is placed so the cheapest way to reject a request happens
first, and a paid provider call is the last thing that happens.

**Address validation** rejects junk (too short, no street number, 2KB of
garbage) before it can cost anything.

**Origin lock** (`ALLOWED_ORIGINS`) stops another site pointing its
frontend at your `/api/lookup` and spending your budget.

**Burst limiting** (5/minute per visitor, default) is what actually stops
a script. A daily-only limit still allows all 20 of a visitor's lookups
inside two seconds.

**Real IP extraction.** Rate limiting reads the IP from headers the
platform sets, not the `X-Forwarded-For` a client can forge — otherwise an
abuser gets a fresh bucket per request just by changing a header, and the
limiter is decorative. There's a test for this.

**The cache** (`LOOKUP_CACHE_TTL_SECONDS`, 3 days) is the main lever, and
it now keys on a *normalized* address, so "214 Maple St., Columbia, SC
29201-1234" and "214 maple street columbia sc 29201" are one cache entry
instead of two paid lookups. Failures to look up an address are cached
too, for a shorter window — otherwise every visitor who tries the same
unindexed new-construction address pays for the same three empty calls.

**Cache hits don't count against a visitor's daily limit**, because they
don't cost anything. Only lookups that will actually spend do.

**Single-flight coalescing.** When fifty people hit the same address in
the same second — one listing going viral is exactly what a traffic spike
looks like — one request pays and the other forty-nine read its result.
Without this, a popular address costs one paid call per concurrent
visitor.

**Site-wide daily AND monthly spend caps**, refunded when a call fails, so
a RentCast outage doesn't permanently eat your budget.

**Timeouts and retries with jittered backoff** on every outbound call.
RentCast rate-limits at 20 requests/second and a 429 there is retryable;
a hung provider otherwise burns your whole function timeout on Vercel's
clock.

**Turnstile is required in production by default.** A public site that
spends money per request shouldn't ship with its only real bot defense
switched off by an unset variable. Set `TURNSTILE_REQUIRED=false` if you
want to deploy without it anyway.

**Alerting.** Budget exhausted, provider outage, and cache-write failures
push to `ALERT_WEBHOOK_URL`. The cache one matters most: if Upstash writes
start failing silently, every lookup becomes a paid call and nothing looks
broken until the invoice.

## 2c. Is there an unlimited RentCast plan? And can I just make multiple accounts?

No unlimited plan — every self-serve tier is metered with overage billing
past the cap: Free (50/mo), Foundation ($74/mo, 1,000), Growth ($199/mo,
5,000), Scale ($449/mo, 25,000). Above Scale it's a custom enterprise
deal, not a self-serve unlimited option.

On multiple accounts to route around the cap when one runs low: **I didn't
build that, and you shouldn't want it built.** Two separate problems with
it, not just one:

1. **It's a Terms of Service violation.** Creating multiple accounts to
   get around a usage limit is exactly the kind of thing usage-based API
   terms exist to prohibit, and it's the easiest kind of abuse for a
   provider to detect (same payment method, same domain calling in, same
   IP registering the accounts). The realistic outcome isn't "more free
   quota," it's RentCast banning every key tied to your site at once, with
   no warning, the day it matters most — mid-traffic-spike. You said this
   isn't a fun side project; that's exactly why it shouldn't run on
   infrastructure one ban away from going dark.
2. **The math doesn't get you where you're asking to go anyway.** 50
   free calls/account × even 10 accounts is 500 calls/month — nowhere
   close to "thousands of users." Rotating free accounts was never going
   to reach the scale you're describing; it just adds a ban risk on top
   of not solving the problem.

What actually gets you to real scale is everything in 2a and 2b above:
caching, spend caps, rate limiting and a bot check, sized against a paid
plan you chose on purpose.

**One more real constraint, not a code problem:** Vercel's free Hobby
plan is licensed for personal, non-commercial use in their own terms —
a site serving real public traffic for something you're calling a real
business needs Vercel Pro ($20/mo), both to stay within their terms and
because Hobby's bandwidth/execution limits aren't sized for "thousands of
users." That's a plan upgrade in the Vercel dashboard, not a code change.

**Also worth deciding, not something I should assume:** right now, every
visitor's saved listings live in *that visitor's own browser*
(`localStorage`) — there's no shared database, no accounts, no login.
That's actually fine, maybe even better, for "thousands of people each
privately evaluate their own deals" — it's how a calculator should work,
and it means zero user-data liability for you. It becomes a real gap only
if you want people to have accounts, save listings across devices, or see
each other's data. If you want that, say so — it's a real database and
auth system, a bigger build than anything above, and I'd want to know
what you actually need it to do before building it.

## 3. Why this doesn't scrape Craigslist or Facebook Marketplace

You asked about pulling per-unit rent data from Craigslist/Facebook —
worth explaining why that's not in here. Both explicitly prohibit
automated scraping in their terms of service (Craigslist has sued scrapers
over this and won), and Facebook Marketplace requires a logged-in session
and runs aggressive anti-bot detection that breaks scrapers constantly and
risks the account doing the scraping. For a tool that's staying personal
that's a bad trade — fragile, needs constant maintenance, and the
"savings" over a legitimate API isn't worth the legal exposure. Once
you're publishing this as a site other people use, that exposure is
yours, not just a research inconvenience.

Rentometer (above) is the legitimate version of what you're after — a
licensed API, not scraped listings, built specifically for exactly this
(rent comps by address + bedroom count). It's the second source
`api/lookup.js` cross-checks against RentCast.

## 4. Deploy to Vercel (recommended — free, handles both serverless
   functions automatically, easy to attach a real domain)

**Fastest path (no git required):**

```bash
npm install -g vercel
cd deal-qualifier-site
vercel
```

Follow the prompts (link or create a project). Defaults are fine — no
build command, no output directory override needed.

**Set your keys** so the live site can use them:

```bash
# Required to run at all
vercel env add RENTCAST_API_KEY

# Required before real public traffic (see section 2)
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add TURNSTILE_SECRET_KEY
vercel env add TURNSTILE_SITE_KEY
vercel env add ALLOWED_ORIGINS
vercel env add ADMIN_TOKEN

# Optional features
vercel env add MAPBOX_TOKEN
vercel env add RENTOMETER_API_KEY
vercel env add ALERT_WEBHOOK_URL

# Budget caps — set these to match your RentCast plan on day one
vercel env add DAILY_GLOBAL_LOOKUP_LIMIT
vercel env add MONTHLY_GLOBAL_LOOKUP_LIMIT
```

Only `RENTCAST_API_KEY` is required to get the site running at all, but
in production the bot check is required too — deploy without
`TURNSTILE_SECRET_KEY` and every lookup returns a 503 telling you to set
it (or set `TURNSTILE_REQUIRED=false` to override that on purpose). See
`.env.example` for the full annotated list. Select all three environments
(Production, Preview, Development) when prompted, then redeploy so the
functions pick the values up:

```bash
vercel --prod
```

You'll get a `https://your-project.vercel.app` URL immediately.

**Attach your own domain** (the "actual www" step): in the Vercel
dashboard, open the project → Settings → Domains → add the domain you own
(or buy one first through any registrar — Namecheap, Cloudflare, Porkbun
are all fine, ~$10-15/yr for a `.com`). Vercel gives you a couple of DNS
records to add at your registrar; once they propagate (usually under an
hour) your real domain serves the site over HTTPS automatically.

**If you'd rather use git** (lets you `git push` to redeploy instead of
running `vercel --prod` each time): push this folder to a new GitHub repo,
then in the Vercel dashboard choose "Add New Project" → import that repo.
Set the env vars under Settings → Environment Variables before the first
deploy.

## 5. Using it

Start typing an address into "Look up an address" — with `MAPBOX_TOKEN`
set, a dropdown of real matching addresses appears after 3 characters (no
typos, no guessing the exact format RentCast wants). Pick one, or just
type the full address and skip the dropdown — either way, hit **Look up**
to actually spend a RentCast (and Rentometer, if configured) call and
fill in:

- **Address / nickname** — from RentCast's resolved address
- **Purchase price** — RentCast's AVM value estimate. **This is not the
  asking price** — RentCast doesn't have listing data, only a valuation
  model. Replace it with the real list price from Zillow/Redfin/MLS.
- **Annual property tax** — most recent tax record RentCast has on file
- **Total units** — from property records, defaults to 1 if RentCast
  can't tell (single-family) or 2 if it's flagged multi-family without a
  precise count
- **Tenant rent** — the real limitation here: no data source, RentCast,
  Rentometer, or otherwise, publishes distinct rents per unit in a
  building from an address alone. `api/lookup.js` narrows the guess by
  dividing the property's total square footage AND bedroom count by the
  unit count, so both providers are asked "what does a unit THIS size
  rent for" instead of pricing the whole building as one home — then
  reports both RentCast's and Rentometer's per-unit numbers side by side
  so you can see whether they agree or not, rather than trusting either
  alone. This field then fills as (the better of the two estimates) ×
  (tenant-paying unit count), which still assumes every unit rents about
  the same. Fine for a duplex with two matching units, wrong for a
  property with a real mix of unit sizes — check it against actual
  listings when the units clearly differ.

Everything else (insurance, HOA, utilities, loan program) you still fill
in yourself — no data source covers those from an address alone.

## 6. Debugging a lookup that comes back empty

Provider docs describe some response shapes in prose rather than verbatim
JSON, so a field name in `api/lookup.js` could be off for a given property
type. Hit the function directly with `&debug=1` to see the raw provider
responses and adjust field names if something comes back `null` that
shouldn't:

```
https://your-domain.com/api/lookup?address=214+Maple+St+Columbia+SC&debug=1&adminToken=YOUR_ADMIN_TOKEN
```

In production `debug=1` requires `adminToken` to match your `ADMIN_TOKEN`
— raw provider bodies can carry account details and error text you don't
want served to anyone who guesses the query string. Locally (`vercel dev`)
it works without the token.

Start at `/api/health` for anything that looks like an outage — it names
which dependency is missing or unresponsive without you having to read
logs.

Common real failure modes that aren't bugs: a brand-new construction
address RentCast hasn't indexed yet (404 on property records), an address
that can't be geocoded confidently (try adding the zip code), RentCast's
20-requests/second rate limit if you're hammering it in a loop, or
Rentometer returning too few comps to give a usable number in a thin
rental market.

## 7. Local development (optional)

```bash
npm install -g vercel
cd deal-qualifier-site
vercel dev
```

Runs the site and both functions locally at `http://localhost:3000`,
reading keys from a `.env.local` file you create in this folder (already
gitignored):

Copy `.env.example` to `.env.local` and fill in what you have — every
variable is documented there. At minimum:

```
RENTCAST_API_KEY=your_key_here
TURNSTILE_REQUIRED=false
```

Run the test suite any time — it needs no keys and makes no network
calls:

```bash
npm test
```

## 8. Going live: the checklist

Work down this list in order. Everything above `npm test` is free.

1. `npm test` passes.
2. Upstash database created, both env vars set. **Do not skip this one** —
   without it there is no cache and no spend ceiling, and section 2a's
   top row is what you're signed up for.
3. Turnstile site created, both keys set.
4. `ALLOWED_ORIGINS` set to your real domain(s).
5. `ADMIN_TOKEN` set to a random string.
6. `DAILY_GLOBAL_LOOKUP_LIMIT` and `MONTHLY_GLOBAL_LOOKUP_LIMIT` set to
   match the RentCast plan you actually bought. Do this before launch, not
   after the first invoice.
7. `ALERT_WEBHOOK_URL` pointed at a Slack or Discord channel you read.
8. Vercel upgraded to Pro.
9. Domain attached, HTTPS live.
10. `curl https://your-domain.com/api/health` returns `"status":"ok"` with
    an empty `fatal` array.
11. Uptime monitor pointed at `/api/health`, alerting on non-200.
12. Do one real lookup. Then a second one for the same address — it should
    come back with `"cached": true`, which is your proof the cache is
    working. If it doesn't, the cache is dark and every lookup is costing
    you money; check the logs for `cache_write_failed`.
13. Check `/api/stats?token=...` after a week and size your RentCast plan
    against the real number instead of a guess.

## 9. Monitoring, once it's live

Every request emits one structured JSON line to stdout, which Vercel
captures and any log drain can forward. The events worth alerting on:

| Event | What it means |
|---|---|
| `cache_write_failed` | **the expensive one.** Upstash writes are failing, so every lookup is now a fresh paid call and nothing looks broken |
| `spend_budget_exhausted` | your daily or monthly ceiling was hit — visitors are being turned away |
| `provider_outage` | RentCast is returning 5xx or timing out |
| `turnstile_misconfigured` | the bot check is required but unset; lookups are all being rejected |
| `rentcast_key_missing` | the key isn't set at all |
| `origin_rejected` | someone else's site is calling your API |
| `lookup_cache_hit` / `lookup_fresh` | the ratio between these two is your cache hit rate, and your bill |

Set `ALERT_WEBHOOK_URL` and the top five push to Slack or Discord
automatically, deduped to at most one message per event per 15 minutes.

## Your saved listings

Everything you `Add property` on the site is saved in that browser's
`localStorage`, tied to the domain you deploy to — same as the Claude
artifact was tied to its `claude.ai` link. The 8 properties you already
researched (Horseshoe, Kinard, Caroline, Valleybrook, both Oak St
scenarios) are baked into `index.html` as seed data, so they'll show up on
this site too, on first load, exactly as they did on the artifact.
