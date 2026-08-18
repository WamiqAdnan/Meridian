/**
 * Fetch market data into the local database.
 *
 *   npm run market:refresh              quotes only, every tracked asset
 *   npm run market:backfill             quotes + a year of daily bars
 *   npm run market:backfill -- --range=1y --market=crypto
 *   npm run market:refresh  -- --missing    only assets with no history yet
 *
 * Run the backfill once before using the market pages: weekly and monthly moves
 * are computed from daily bars, and without them every window reads "insufficient
 * data" — which is correct, but not useful.
 */
import { assetsMissingHistory, ensureCatalogue, refreshMarketData } from "@/lib/markets/refresh";
import { lastRefresh } from "@/lib/markets/refresh";
import { isMarket, type HistoryRange, type Market } from "@/lib/markets/types";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const RANGES = new Set(["1mo", "3mo", "6mo", "1y"]);

async function main() {
  const rangeArg = arg("range");
  if (rangeArg && !RANGES.has(rangeArg)) {
    console.error(`Unknown --range=${rangeArg}. Use one of: ${[...RANGES].join(", ")}`);
    process.exit(1);
  }

  const marketArg = arg("market");
  if (marketArg !== undefined && !isMarket(marketArg)) {
    console.error(`Unknown --market=${marketArg}.`);
    process.exit(1);
  }
  const market = marketArg === undefined ? undefined : (marketArg as Market);

  const wantHistory = process.argv.includes("--history") || rangeArg !== undefined;
  // A year by default: the longest window the UI reports is 1Y, and a backfill
  // shorter than the window it feeds just makes every long period read
  // "insufficient data". Costs the same one call per asset either way.
  const range = (rangeArg ?? "1y") as Exclude<HistoryRange, "none">;

  await ensureCatalogue();

  let ids: string[] | undefined;
  if (process.argv.includes("--missing")) {
    const missing = await assetsMissingHistory();
    if (missing.length === 0) {
      console.log("Every tracked asset already has history. Nothing to do.");
      return;
    }
    ids = missing.map((a) => a.id);
    console.log(`${missing.length} asset(s) missing history.`);
  }

  const label = wantHistory ? `backfill (${range})` : "quotes";
  console.log(`Refreshing: ${label}${market ? ` · market=${market}` : ""}\n`);

  const started = Date.now();
  const outcome = await refreshMarketData({
    market,
    ids,
    range: wantHistory ? range : undefined,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Assets requested : ${outcome.assetsRequested}`);
  console.log(`Quotes written   : ${outcome.quotesWritten}`);
  console.log(`Bars written     : ${outcome.barsWritten}`);
  console.log(`Failed           : ${outcome.failures.length}`);
  console.log(`Elapsed          : ${seconds}s`);

  if (outcome.failures.length > 0) {
    console.log("\nFailures:");
    for (const f of outcome.failures.slice(0, 20)) {
      console.log(`  ${f.assetId.padEnd(24)} ${f.error}`);
    }
    if (outcome.failures.length > 20) {
      console.log(`  … and ${outcome.failures.length - 20} more`);
    }
  }

  const last = await lastRefresh();
  if (last) console.log(`\nRecorded as RefreshRun(source=${last.source}).`);
}

main()
  .catch((e) => {
    console.error(`\nRefresh failed: ${(e as Error).message}`);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
