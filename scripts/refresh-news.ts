/**
 * Fetch news into the local database.
 *
 *   npm run news:refresh                       every market, plus whatever moved
 *   npm run news:refresh -- --market=crypto    one market
 *   npm run news:refresh -- --days=14          a wider window
 *   npm run news:refresh -- --assets=psx:LUCK,crypto:BTC
 *   npm run news:refresh -- --min-z=1.5 --limit=20    look wider for movers
 *   npm run news:refresh -- --prune=60         drop anything older than 60 days
 *
 * Which assets get their own lookup is decided by how unusual their latest
 * session was *against their own volatility* — see `newsworthy`. Run
 * `npm run market:backfill` first: with no daily bars there is nothing to call
 * unusual, and the run degrades to the market sweep alone.
 */
import { ingestNews } from "@/lib/news/ingest";
import { lastNewsRun, pruneNews } from "@/lib/news/store";
import { isMarket, type Market } from "@/lib/markets/types";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function num(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`--${name}=${raw} is not a number.`);
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const marketArg = arg("market");
  if (marketArg !== undefined && !isMarket(marketArg)) {
    console.error(`Unknown --market=${marketArg}.`);
    process.exit(1);
  }
  const market = marketArg === undefined ? undefined : (marketArg as Market);
  const assetIds = arg("assets")?.split(",").map((s) => s.trim()).filter(Boolean);

  const pruneDays = num("prune");
  if (pruneDays !== undefined) {
    const dropped = await pruneNews(pruneDays);
    console.log(`Pruned ${dropped} article(s) older than ${pruneDays} days.\n`);
  }

  console.log(`Ingesting news${market ? ` · market=${market}` : ""}\n`);
  const started = Date.now();
  const outcome = await ingestNews({
    market,
    assetIds,
    days: num("days"),
    minZ: num("min-z"),
    assetLimit: num("limit"),
    skipMarkets: process.argv.includes("--no-markets"),
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Queries run      : ${outcome.queriesRun}`);
  console.log(`Queries empty    : ${outcome.queriesFail}`);
  console.log(`Articles seen    : ${outcome.articlesSeen}`);
  console.log(`Articles new     : ${outcome.articlesNew}`);
  console.log(`Matches written  : ${outcome.matchesMade}`);
  console.log(`Elapsed          : ${seconds}s`);

  if (outcome.candidates.length > 0) {
    console.log("\nUnusual moves that earned their own lookup:");
    for (const c of outcome.candidates) {
      const z = c.zScore >= 0 ? `+${c.zScore.toFixed(1)}` : c.zScore.toFixed(1);
      console.log(
        `  ${c.asset.id.padEnd(20)} ${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}%`.padEnd(36) +
          `${z}σ (own daily σ ${c.sigma.toFixed(2)}%)`,
      );
    }
  } else {
    console.log("\nNothing moved unusually — market sweep only.");
  }

  if (outcome.errors.length > 0) {
    console.log("\nFeed failures:");
    for (const e of outcome.errors.slice(0, 20)) console.log(`  ${e}`);
    if (outcome.errors.length > 20) console.log(`  … and ${outcome.errors.length - 20} more`);
  }

  const last = await lastNewsRun();
  if (last) console.log(`\nRecorded as NewsRun(scope=${last.scope}).`);
}

main()
  .catch((e) => {
    console.error(`\nNews ingest failed: ${(e as Error).message}`);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
