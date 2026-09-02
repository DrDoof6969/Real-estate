# Deal Qualifier

A self-hosted version of your rental deal qualifier. Same tool as the Claude
artifact — FHA / conventional owner-occ / conventional investor / DSCR,
portfolio-aware reserves, loan recommendations — plus three things the
artifact couldn't do: an address-autocomplete dropdown, an address lookup
that auto-fills price/tax/unit count/rent from two independent data
providers, and a real domain.

Three files matter:

- `index.html` — the whole site. Static HTML/CSS/JS, no build step.
- `api/lookup.js` — serverless function holding your RentCast + Rentometer
  keys, does the property-data calls.
- `api/autocomplete.js` — serverless function holding your Mapbox token,
  powers the address dropdown as you type.

None of these keys ever reach the browser — the frontend only ever calls
`/api/lookup` and `/api/autocomplete` on your own domain.

## 1. Get your API keys

| Provider | What it's for | Cost | Sign up |
|---|---|---|---|
| **RentCast** | property records, value estimate, rent estimate — required | Free: 50 lookups/mo, no card | [app.rentcast.io/app/api](https://app.rentcast.io/app/api) |
| **Mapbox** | address-autocomplete dropdown — optional, site works without it, you just type the full address instead | Free: 50,000 requests/mo | [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/) |
| **Rentometer** | second, independent rent estimate to cross-check RentCast's — optional | Pro plan $29/mo (includes 200 API credits, more purchasable) | [rentometer.com/pricing/individual](https://www.rentometer.com/pricing/individual) |

Only RentCast is required. Leave `MAPBOX_TOKEN` or `RENTOMETER_API_KEY`
unset and those features quietly turn themselves off — autocomplete
becomes a plain text box, and the rent estimate falls back to RentCast
alone.

## 2. Is there an unlimited RentCast plan? And can I just make multiple accounts?

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

What actually gets you to real scale, all of which is now built into this
project:

- **A shared cache** (`lib/upstash.js` + `LOOKUP_CACHE_TTL_SECONDS`, default
  3 days). This is the real lever. When visitor #2 looks up an address
  visitor #1 already looked up today, they get the cached result — zero
  RentCast/Rentometer calls spent. At real traffic, the same popular
  listings get looked up over and over; caching turns most of that
  traffic into free repeat views instead of fresh paid calls.
- **A site-wide daily budget** (`DAILY_GLOBAL_LOOKUP_LIMIT`, default 200)
  — a hard ceiling on fresh (non-cached) lookups per day across *all*
  visitors combined, sized to whatever your actual paid RentCast tier can
  absorb. Once real traffic tells you your average daily fresh-lookup
  count, size your RentCast plan and this number together on purpose,
  instead of finding out from a surprise invoice.
- **Per-visitor rate limiting** (`LOOKUP_DAILY_LIMIT_PER_IP`, default 20)
  — stops one visitor or script from eating the whole shared budget alone.
- **Cloudflare Turnstile** (`TURNSTILE_SITE_KEY` in `index.html` +
  `TURNSTILE_SECRET_KEY` env var) — free, no usage cap, blocks scripted
  lookups before they ever reach RentCast. Off by default (empty site
  key); turning it on is the actual fix for "a script is draining my
  budget," not account rotation. Setup: [Cloudflare dashboard](https://dash.cloudflare.com/)
  → Turnstile → Add site → copy the site key into `TURNSTILE_SITE_KEY`
  near the top of `index.html`'s `<script>`, copy the secret key into
  `TURNSTILE_SECRET_KEY` in your environment variables. ~5 minutes.

**All four of these need `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
to actually hold at real scale** (cache and the global budget don't work
at all without it; per-visitor rate limiting silently degrades to a
weaker per-instance-only counter). Sign up free at
[upstash.com](https://upstash.com) (free tier: 500K commands/month, plenty
for this), create a Redis database, copy the REST URL and token from its
dashboard into your env vars. This is the one piece of infrastructure I
couldn't create for you — it needs your own account — but the code that
uses it is already written and tested (see `lib/upstash.js`,
`lib/limiter.js`).

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
vercel env add RENTCAST_API_KEY
vercel env add MAPBOX_TOKEN
vercel env add RENTOMETER_API_KEY
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add TURNSTILE_SECRET_KEY
```

Only `RENTCAST_API_KEY` is required to get the site running at all — skip
the rest for now and add them later the same way when you're ready for
each piece (autocomplete, the Rentometer cross-check, real shared caching
+ rate limiting, bot-blocking — see "Scaling to real traffic" above for
what each unlocks). Select all three environments (Production, Preview,
Development) when prompted, then redeploy so the functions pick the
values up:

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
https://your-domain.com/api/lookup?address=214+Maple+St+Columbia+SC&debug=1
```

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

```
RENTCAST_API_KEY=your_key_here
MAPBOX_TOKEN=your_token_here
RENTOMETER_API_KEY=your_key_here
UPSTASH_REDIS_REST_URL=your_url_here
UPSTASH_REDIS_REST_TOKEN=your_token_here
TURNSTILE_SECRET_KEY=your_secret_here
LOOKUP_DAILY_LIMIT_PER_IP=20
DAILY_GLOBAL_LOOKUP_LIMIT=200
LOOKUP_CACHE_TTL_SECONDS=259200
```

## Your saved listings

Everything you `Add property` on the site is saved in that browser's
`localStorage`, tied to the domain you deploy to — same as the Claude
artifact was tied to its `claude.ai` link. The 8 properties you already
researched (Horseshoe, Kinard, Caroline, Valleybrook, both Oak St
scenarios) are baked into `index.html` as seed data, so they'll show up on
this site too, on first load, exactly as they did on the artifact.
