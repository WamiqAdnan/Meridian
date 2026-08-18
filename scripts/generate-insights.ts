/**
 * Write weekly market insights into the local database.
 *
 *   npm run insights:generate                          every market, this week
 *   npm run insights:generate -- --market=commodities  one market
 *   npm run insights:generate -- --force               regenerate what already exists
 *   npm run insights:generate -- --week=2026-08-10     an earlier week
 *   npm run insights:generate -- --dry-run             print the brief, call no model
 *   npm run insights:generate -- --show-rejections     print what failed validation
 *   npm run insights:generate -- --prune=26            drop insights older than 26 weeks
 *
 * `--dry-run` is the one to reach for first. It prints exactly what the model
 * would read — the movements, the headlines, and how each headline came to be
 * attached to an asset — without spending a call. Almost every bad insight is a
 * bad brief, and this is where you see it.
 *
 * Run `npm run market:refresh` and `npm run news:refresh` first: with no bars there
 * is nothing to call unusual, and with no headlines there is nothing to explain it.
 */
import { AiUnavailableError, StructuredTaskError, aiBackendLabel } from "@/lib/ai";
import { buildPackForMarket, generateInsight } from "@/lib/insights/generate";
import { renderPack } from "@/lib/insights/evidence";
import { pruneInsights } from "@/lib/insights/store";
import { weekStartOf } from "@/lib/insights/types";
import { MARKETS, MARKET_META, isMarket, type Market } from "@/lib/markets/types";

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
  const markets: Market[] = marketArg === undefined ? [...MARKETS] : [marketArg as Market];
  const week = arg("week") ?? weekStartOf();
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  // Worth turning on whenever a market keeps failing: an answer that gets rejected
  // three times is usually one rule the prompt states badly, and this names it.
  const showRejections = process.argv.includes("--show-rejections");

  const pruneWeeks = num("prune");
  if (pruneWeeks !== undefined) {
    const dropped = await pruneInsights(pruneWeeks);
    console.log(`Pruned ${dropped} insight(s) older than ${pruneWeeks} weeks.\n`);
  }

  if (dryRun) {
    for (const market of markets) {
      const pack = await buildPackForMarket({ market, weekStart: week });
      console.log(`\n${"─".repeat(72)}\n${renderPack(pack)}`);
    }
    console.log(`\n${"─".repeat(72)}\nDry run — no model was called.`);
    return;
  }

  const backend = aiBackendLabel();
  if (!backend) {
    console.error(
      "Nothing is configured to generate with.\n" +
        "Set ANTHROPIC_API_KEY, or AI_BASE_URL + AI_MODEL for a local model.",
    );
    process.exit(1);
  }

  console.log(`Generating insights for week of ${week} on ${backend}${force ? " (forced)" : ""}\n`);

  for (const market of markets) {
    const label = MARKET_META[market].label;
    const started = Date.now();
    try {
      const outcome = await generateInsight({
        market,
        weekStart: week,
        force,
        onRejected: showRejections
          ? ({ attempt, errors }) => {
              console.log(`  ${label.padEnd(16)} attempt ${attempt} rejected:`);
              for (const e of errors) console.log(`  ${" ".repeat(16)} ✗ ${e}`);
            }
          : undefined,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      if (outcome.status === "cached") {
        console.log(`  ${label.padEnd(16)} cached — ${outcome.insight.headline}`);
        continue;
      }
      if (outcome.status === "skipped") {
        console.log(`  ${label.padEnd(16)} skipped — ${outcome.reason}`);
        continue;
      }

      const accounted = outcome.insight.body.readings.filter((r) => r.verdict !== "insufficient");
      console.log(
        `  ${label.padEnd(16)} ${outcome.insight.headline}\n` +
          `  ${" ".repeat(16)} ${accounted.length}/${outcome.insight.body.readings.length} moves accounted for` +
          ` · ${outcome.pack.articles.length} headlines · attempt ${outcome.attempts} · ${seconds}s`,
      );
    } catch (e) {
      // One market failing must not cost the rest of the sweep.
      const why =
        e instanceof AiUnavailableError || e instanceof StructuredTaskError
          ? e.message
          : `${(e as Error).message}`;
      console.log(`  ${label.padEnd(16)} failed — ${why}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(`\nInsight generation failed: ${(e as Error).message}`);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
