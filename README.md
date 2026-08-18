# Meridian

A centralized portfolio and multi-market intelligence dashboard. Tracks holdings
across asset classes, shows what each market is doing, and reads broker
statements it has never seen before by learning a parser for them once.

Runs entirely on your own machine against a local SQLite file. No account, no
hosted backend, no market-data subscription required.

---

## What it does today

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

---

## Environment

Everything is optional except `DATABASE_URL`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Required.** SQLite path, e.g. `file:./dev.db` |
| `ANTHROPIC_API_KEY` | Learn a parser for an unrecognised broker via the Anthropic API |
| `LEARNING_BASE_URL` | An OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM). **Wins over the Anthropic key.** e.g. `http://localhost:11434/v1` |
| `LEARNING_MODEL` | Model name for whichever backend is in use |
| `LEARNING_API_KEY` | Bearer token, if the endpoint needs one |
| `LEARNING_TIMEOUT_MS` | Cap on one attempt (default 600000 — local reasoning models are slow) |
| `LEARNING_REASONING_EFFORT` | Set `none` to trade spec quality for speed |
| `COINGECKO_API_KEY` | Raises the crypto rate limit. Without it the keyless tier is used |
| `COINGECKO_PLAN` | `pro` to use the pro host; otherwise the demo key path is used |

Nothing in the browser ever sees a key — every provider call is server-side.

### Running the parser learning locally

```bash
ollama serve
ollama pull qwen3:8b
```

```bash
LEARNING_BASE_URL=http://localhost:11434/v1
LEARNING_MODEL=qwen3:8b
```

Ollama defaults to a 4096-token context, which truncates a statement sample —
start the server with `OLLAMA_CONTEXT_LENGTH=32768`. With a local model, the
statement never leaves the machine, which for a financial document is the more
interesting property of the two backends.

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

---

## Architecture

```
src/lib/markets/
  types.ts        vocabulary: Market, AssetRef, QuoteData, BarData, provider interface
  catalogue.ts    seed universe (data, not logic — the Asset table is the truth)
  providers/      yahoo · coingecko · psx · frankfurter · shared helpers
  registry.ts     routing and fallback between providers
  performance.ts  pure: period changes, movers, unusual-move detection
  currency.ts     pure: FX table and conversion, pivoted through USD
  store.ts        the only place market data touches Prisma
  refresh.ts      the refresh job, with a RefreshRun audit row
  view.ts         assembles what the pages render

src/lib/
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

**Two currencies are on screen at once, on purpose.** A position is priced and
costed in its own currency — rounding a US holding into rupees to display it
would misstate what you own — while every *total* is converted, because a sum
across currencies is otherwise meaningless. Anything that cannot be converted is
named in a warning rather than dropped from the total.

---

## Testing

No test runner. Four standalone check scripts, each deterministic and each
runnable on its own:

```bash
npm run check:parse       # statement parser: spec engine, validator, learning schema
npm run check:replicator  # index replicator: fees, allocation, edge cases
npm run check:market      # markets: performance, movers, currency, providers, registry
npm run check:portfolio   # portfolio: asset resolution, manual entry, the engine
```

`check:market` and `check:portfolio` run with no network and no database — provider parsing is
exercised against captured payloads in `data/reference/market/`, and the registry
is driven with stub providers to prove routing, fallback and containment of a
provider that throws.

---

## Notes

This is a personal tool. Market data comes from sources that are free for
personal use and not licensed for redistribution; do not deploy it as a public
service. Nothing here is financial advice.
