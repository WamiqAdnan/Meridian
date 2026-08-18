# Meridian

A centralized portfolio and multi-market intelligence dashboard. Tracks holdings
across asset classes, shows what each market is doing, and reads broker
statements it has never seen before by learning a parser for them once.

Runs entirely on your own machine against a local SQLite file. No account, no
hosted backend, no market-data subscription required.

---

## What it does today

**Overview** — the portfolio, every market, the biggest cross-market movers and the
week's AI summary on one screen, per investor or combined. It reads; it never
generates.

**Search** — find anything tracked from anywhere in the app, by ticker, name,
market, or the word a headline would actually use: `bullion` finds Gold, `the Dow`
finds the Dow Jones, `greenback` finds the dollar index. Every hit says which of
those it matched on. Works with JavaScript off.

**Asset pages** — one page per asset, whatever market it is in: a labelled price
chart over any window, every window's change with the sessions it was measured
between, the position held, and the headlines matched to that asset. Every symbol
in the app links here.

**Portfolio** — holdings derived by replaying a trade ledger (weighted-average
cost including fees, realized P&L booked on sells), across every market at once
and totalled in one currency. Allocation by market and by asset, best and worst
performer, and day/week/month movement on what is held now. Split by investor or
combined.

**Trade entry** — record a trade by hand for anything, not just PSX: pick a
tracked asset or name a ticker nobody tracks yet, which is verified against a
price provider before it is added. Quantities are fractional, so 0.05 BTC is a
position.

**Statement import** — drop in a broker PDF or CSV. Known layouts parse for free;
an unknown one is handed to an LLM *once*, which writes a declarative parse spec
that is validated against the whole document before it is saved and replayed
free thereafter. The model never sees the ledger and never parses trades itself.

**Markets** — eight asset classes (US stocks, crypto, commodities, forex,
indices, bonds, real estate, PSX) with daily/weekly/monthly/YTD performance,
cross-market gainers and losers, and per-market detail pages.

**News** — headlines from several keyless feeds, matched to the assets they
actually concern and scored by how they were matched. Which assets get their own
lookup is decided by how unusual their latest session was *against their own
volatility*, not by a fixed percentage — so a 0.02% day on a pegged currency can
qualify while a 4% day in crypto does not.

**AI insights** — a weekly, per-market explanation of what moved and what the
retrieved headlines suggest about it. The price data decides what needs
explaining before any model is involved; the model only ever sees that list and
the headlines matched against it; and every answer is validated against both
before it is stored — every citation has to resolve to an article it was given,
and every percentage in its prose has to be a figure it was handed. Facts and
inferences are stored and displayed separately, and *"insufficient data to
determine"* is treated as a correct answer rather than a failure.

**Index replicator** — turn a cash amount and a chosen index into a whole-share
buy list matching the published weights, with real broker fees modelled.

---

## Running locally

```bash
npm install
```

Create `.env` (see [Environment](#environment)):

```bash
DATABASE_URL="file:./dev.db"
```

Then:

```bash
npm run db:push
```

Seed the market catalogue and pull a year of daily prices — **do this once before
using the market pages**, or every weekly and monthly figure will correctly read
"insufficient data":

```bash
npm run market:backfill
```

Start it:

```bash
npm run dev
```

Open <http://localhost:3000>.

### Keeping prices current

```bash
npm run market:refresh
```

Quotes only, for every tracked asset — cheap enough to run on a few-minute
cadence. The full backfill pulls daily bars as well and belongs on a daily
schedule, since a daily close only changes once a day.

```bash
npm run market:backfill -- --market=crypto --range=1y
npm run market:refresh -- --missing
```

### Keeping news current

```bash
npm run news:refresh
```

Sweeps every market's feeds and adds a per-asset lookup for anything that moved
unusually. A handful of requests and a couple of seconds, so it suits the same
few-minute cadence as the quote refresh. Run `market:backfill` first — with no
daily bars there is nothing to call unusual, and the run degrades to the market
sweep alone.

```bash
npm run news:refresh -- --market=commodities --days=14
npm run news:refresh -- --assets=psx:LUCK,crypto:BTC --no-markets
npm run news:refresh -- --prune=60      # drop anything older than 60 days
```

### Generating weekly insights

```bash
npm run insights:generate
```

One insight per market per week, cached hard on that key. Unlike prices and news,
this never runs on a page render: a generation is up to three model calls and can
take minutes against a local model, while the answer is the same all week. It
arrives from this script, from a scheduled run, or from the button on a market
page.

```bash
npm run insights:generate -- --market=commodities
npm run insights:generate -- --dry-run            # print the brief, call no model
npm run insights:generate -- --force              # regenerate this week
npm run insights:generate -- --show-rejections    # print what failed validation
npm run insights:generate -- --week=2026-08-10
npm run insights:generate -- --prune=26           # drop insights older than 26 weeks
```

**Reach for `--dry-run` first.** It prints exactly what the model would read — the
unusual moves in units of each asset's own volatility, every headline retrieved,
and how each headline came to be attached to an asset — without spending a call.
Almost every bad insight is a bad brief, and that is where you see it.

**An insight needs something to explain.** A market where nothing moved unusually
against its own volatility is skipped, however much was written about it that week.
That is not a token-saving rule: a movement is what anchors the whole layer — the
fact a claim gets checked against, the thing a citation has to bear on, the reason a
figure is quotable — and without one the model is left summarising headlines with
nothing to tie them to. Asked to do exactly that, `qwen3:8b` invented twenty
movements, one per headline. The validator caught all twenty; the design was wrong.

Run `market:refresh` and `news:refresh` first. With no daily bars nothing can be
called unusual at all, and the run has nothing to do.

---

## Environment

Everything is optional except `DATABASE_URL`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Required.** SQLite path, e.g. `file:./dev.db` |
| `ANTHROPIC_API_KEY` | Run the model-backed features via the Anthropic API |
| `AI_BASE_URL` | An OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM). **Wins over the Anthropic key.** e.g. `http://localhost:11434/v1` |
| `AI_MODEL` | Model name for whichever backend is in use |
| `AI_API_KEY` | Bearer token, if the endpoint needs one |
| `AI_TIMEOUT_MS` | Cap on one attempt (default 600000 — local reasoning models are slow) |
| `AI_REASONING_EFFORT` | Set `none` to trade answer quality for speed |
| `COINGECKO_API_KEY` | Raises the crypto rate limit. Without it the keyless tier is used |
| `COINGECKO_PLAN` | `pro` to use the pro host; otherwise the demo key path is used |

One backend serves both model-backed features: learning a parser for an unknown
broker, and writing the weekly insights. The `LEARNING_*` spelling of each `AI_*`
variable above is still read, so an existing `.env` keeps working; `AI_*` wins
where both are set.

Nothing in the browser ever sees a key — every provider call is server-side.

### Running the model locally

```bash
ollama serve
ollama pull qwen3:8b
```

```bash
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3:8b
```

Ollama defaults to a 4096-token context, which truncates a statement sample —
start the server with `OLLAMA_CONTEXT_LENGTH=32768`. With a local model, nothing
leaves the machine: not the statement, and not the holdings the insights are
about. For a financial document that is the more interesting property of the two
backends.

Both features are built to be survivable on an 8B model, which is why the answer
is always a small schema-constrained object validated locally and repaired with
the specific failures rather than a reroll. On `qwen3:8b`, one market's insight
takes a couple of minutes and typically needs one repair.

---

## Data providers

No provider is hardcoded into the app. Assets name a preferred source; the
registry batches by provider and retries failures against any other provider that
supports the asset (`src/lib/markets/registry.ts`).

| Provider | Covers | Key | Notes |
|---|---|---|---|
| **Yahoo Finance** (`v8/finance/chart`) | equities, ETFs, indices, commodity futures, FX, Treasury yields | none | One request returns quote, metadata and the full daily series. **Unofficial** — can change without notice, and not licensed for redistribution. Personal use only |
| **CoinGecko** | crypto | optional | Official and keyless. Quotes are batched into one call; history is one call per coin and the keyless tier throttles hard, so history is spaced and retried |
| **PSX** (`dps.psx.com.pk`) | Pakistani equities and indices | none | Market-watch scrape for live prices, plus a JSON EOD endpoint giving ~5 years of daily closes for both stocks and index codes |
| **Frankfurter (ECB)** | FX majors | none | Official reference rates. Registered as the FX **fallback**: one rate per working day, so no intraday tick, but it will still be there when an unofficial endpoint is not |

Two providers were evaluated and rejected: **Alpha Vantage** (free tier is now 25
requests/day) and **Stooq** (now behind a JavaScript proof-of-work challenge).

### News sources

All keyless RSS, behind a `NewsProvider` interface that mirrors
`MarketDataProvider` (`src/lib/news/registry.ts`).

| Source | Answers | Curated | Notes |
|---|---|---|---|
| **Yahoo Finance** (`feeds.finance.yahoo.com`) | one instrument | **yes** | Stories filed against a symbol by the publisher. Covers equities, ETFs, crypto, futures, indices and bond ETFs — verified. **Not FX pairs**: `PKR=X` answers 200 with an empty channel |
| **Google News** (`/rss/search`) | anything | no | Any phrase becomes a feed, so it is the only source that reaches a PSX equity or a currency pair. Names the publisher in a `<source url>` element. Links are its own redirects, not publisher URLs |
| **CNBC** (`/id/{desk}/…`) | one market | no | Seven desk feeds, each id verified against its channel title. No search endpoint, and no PSX coverage — that market routes to Google alone |

**News unions its providers; market data falls back between them.** A price has
one right answer, so a second opinion is waste. Coverage does not — two desks on
the same move is the reason to have two desks — so every supporting provider is
asked and the results are merged, deduplicated on canonical URL.

**Only a curated provider's asset feed counts as provenance.** Yahoo files a
story against a symbol; Google, handed the same question, runs a text search and
will return crypto-converter spam for "UAE Dirham". Both were treated as
provenance in a first draft, which attached that spam to USD/AED at full
confidence. A search provider's results are now matched on their text like any
other article.

GDELT was evaluated and rejected: it timed out on every attempt.

---

## Architecture

```
src/lib/markets/
  types.ts        vocabulary: Market, AssetRef, QuoteData, BarData, provider interface
  catalogue.ts    seed universe (data, not logic — the Asset table is the truth)
  providers/      yahoo · coingecko · psx · frankfurter · shared helpers
  registry.ts     routing and fallback between providers
  performance.ts  pure: period changes, movers, unusual-move detection
  chart.ts        pure: which bars a chart draws, and where its gridlines go
  currency.ts     pure: FX table and conversion, pivoted through USD
  store.ts        the only place market data touches Prisma
  refresh.ts      the refresh job, with a RefreshRun audit row
  view.ts         assembles what the pages render

src/lib/news/
  types.ts        vocabulary: NewsArticle, NewsQuery, the provider interface
  rss.ts          pure: entities, CDATA, items, dates, canonical URLs
  terms.ts        data: what to call an asset, and what to recognise it by
  relevance.ts    pure: article-to-asset matching, and the unusual-move trigger
  providers/      yahoo · google · cnbc · shared helpers
  registry.ts     routing, union and merge across providers
  store.ts        the only place news touches Prisma
  ingest.ts       the ingest job, with a NewsRun audit row
  view.ts         day-grouping for the pages

src/lib/ai/
  types.ts        vocabulary: the provider interface, one method, JSON in and out
  provider.ts     backend selection: Anthropic, or any OpenAI-compatible server
  json.ts         pure: getting JSON out of an answer wrapped in prose or a fence
  task.ts         the ask-validate-repair loop every model call in the app shares

src/lib/search/
  rank.ts         pure: scores a phrase against every tracked asset, and says which
                  field matched — reuses news/terms.ts so one synonym list serves both
  store.ts        the only place search touches Prisma
  view.ts         pure: the flat row the API, the typeahead and /search all share

src/lib/insights/
  types.ts        vocabulary: facts, inferences, verdicts, the stored record
  evidence.ts     pure: assembles the numbered brief, and renders it for the model
  prompt.ts       pure: the system prompt and how a rejection is explained back
  schema.ts       pure: the response schema, and the validator that decides honesty
  generate.ts     the pipeline — the one module here that touches Prisma
  store.ts        the only place insights touch Prisma
  view.ts         what the pages show (read-only; never generates)

src/lib/
  routes.ts         pure: one definition per destination, so every link agrees
  holdings.ts       pure: replays the ledger into positions (asset-class agnostic)
  ledger.ts         pure: asset resolution + manual-trade validation
  portfolio.ts      pure: positions, allocation, windowed P&L, multi-currency totals
  portfolio-view.ts the seam where the portfolio engine meets Prisma
```

The engines (`performance.ts`, `currency.ts`) and every provider's payload parser
are pure functions with no database and no network, which is why they can be
tested exhaustively offline.

**Portfolio data and market data are kept apart.** The ledger stores no prices;
it joins to quotes at read time. `Transaction.assetId` is a *soft* reference to
`Asset.id` with no foreign key, deliberately — the market catalogue can be wiped
and reseeded without touching a single user-owned row.

**Positions are keyed by asset id, never by ticker.** PSX's LUCK and a US LUCK
are different instruments; keying by symbol would silently merge them. Rows
imported before markets existed carry no `assetId` and resolve to `psx:{SYMBOL}`,
which is the only market whose currency can be safely inferred.

**A fact and an inference are never the same field.** A movement's size, its
deviation from the asset's own norm and its close are computed here from stored
bars and are true. What a headline suggests about it is a model's reading and is
not. They are separate fields in the stored record, rendered in separate blocks on
the page, and the validator refuses an answer that quotes a percentage it was not
given — because a plausible invented figure is the failure a reader cannot catch.

**How an article was matched decides how confident an insight may be.** A story a
publisher filed against an instrument can support a confident claim; a headline
that merely contains a hand-written synonym for it cannot, however apt it reads.
That is what `NewsMatch.via` is carried through the whole pipeline for, and the
validator rejects a high-confidence claim resting on a text match alone.

**A search hit says which field it matched.** A query for `bullion` returning Gold
reads as a bug until the row admits it matched a hand-written synonym, so every hit
carries the field and the text that matched it — the same instinct as showing
`NewsMatch.via` next to a headline. The scoring tiers are an evenly spaced ladder
rather than hand-tuned numbers, and the gap between rungs is wider than the
held-position bonus, so owning an asset can decide a tie but can never promote a
substring match above a ticker match. `check:search` asserts the spacing, not the
values; the first version of the table failed that check.

**A chart and the number above it measure the same window.** The line is drawn from
the *reference* session a period change is computed from, not from the first session
inside the window. On a market that does not trade every day those are different
bars: FFC's 1M read "+0.18%" beside a line that visibly fell, because the line began
after the close it was being measured against. Both came from
`markets/performance.ts`; only one of them was anchored properly.

**Two currencies are on screen at once, on purpose.** A position is priced and
costed in its own currency — rounding a US holding into rupees to display it
would misstate what you own — while every *total* is converted, because a sum
across currencies is otherwise meaningless. Anything that cannot be converted is
named in a warning rather than dropped from the total.

---

## Testing

No test runner. Seven standalone check scripts, each deterministic and each
runnable on its own — 1,270 checks in total:

```bash
npm run check:parse       # statement parser: spec engine, validator, learning loop
npm run check:replicator  # index replicator: fees, allocation, edge cases
npm run check:market      # markets: performance, movers, currency, chart maths, providers
npm run check:news        # news: RSS parsing, terms, relevance, providers, registry
npm run check:portfolio   # portfolio: asset resolution, manual entry, the engine
npm run check:insights    # AI layer + insights: weeks, evidence, prompt, validator
npm run check:search      # search: scoring tiers, aliases, multi-word, total ordering
```

`check:market`, `check:news`, `check:portfolio`, `check:insights` and
`check:search` run with no network and no database — payload parsing is exercised against captured payloads in
`data/reference/market/` and `data/reference/news/`, and both registries are
driven with stub providers to prove routing, merging and containment of a
provider that throws. `check:news` passes every date in explicitly, so it gives
the same answer next year as it does today.

**The model calls are tested; the prose is not.** `check:parse` and
`check:insights` drive the whole ask-validate-repair loop with scripted stub
providers, so what gets asserted is the boundary around the model — that a
rejection carries the specific failure back rather than a shrug, that three bad
answers store nothing, that a citation resolves to an article we supplied, that a
figure was one we handed over, and that a confident claim rests on provenance.
Whether the prose reads well is not testable, and pretending otherwise would be
theatre.

---

## Notes

This is a personal tool. Market data comes from sources that are free for
personal use and not licensed for redistribution; do not deploy it as a public
service. Nothing here is financial advice.
