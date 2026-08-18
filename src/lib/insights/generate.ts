/**
 * The pipeline: what moved → what was written about it → a checked explanation.
 *
 * The order matters and is the whole design. Prices decide what needs explaining,
 * before any model is involved; news is retrieved against that list; the model is
 * asked only about the movements and headlines it was handed; and the answer is
 * validated against them before a word of it is stored.
 *
 * Nothing here calls a model speculatively. A market where nothing moved unusually
 * is skipped outright, however much was written about it that week: with no
 * movement to anchor a claim to, there is nothing for a citation to bear on and
 * nothing to check a figure against — see `hasSomethingToExplain`.
 *
 * This is the one module in `insights/` that touches the database and the network.
 */
import { runStructuredTask, type AiProvider, type Review } from "@/lib/ai";
import { buildMarketViews, loadAssetViews, marketChange } from "@/lib/markets/view";
import type { AssetPerformance } from "@/lib/markets/performance";
import type { Market } from "@/lib/markets/types";
import { newsworthyAssets } from "@/lib/news/ingest";
import { loadNewsFeed } from "@/lib/news/view";
import { buildEvidencePack, hasSomethingToExplain } from "./evidence";
import { buildRepair, buildRequest, SYSTEM_PROMPT } from "./prompt";
import { INSIGHT_SCHEMA, validateInsight } from "./schema";
import { loadInsight, saveInsight } from "./store";
import {
  weekStartOf,
  type EvidencePack,
  type InsightBody,
  type InsightDraft,
  type InsightStatus,
  type ResolvedCitation,
  type ResolvedReading,
  type StoredInsight,
  type Verdict,
} from "./types";

/**
 * A week's insight is one flat object with a handful of short paragraphs. This is
 * generous for the answer and leaves a thinking model room to get there.
 */
const MAX_TOKENS = 8000;

/**
 * How wide to look for news.
 *
 * Wider than the week itself: a Monday move often answers to Friday's story, and
 * `selectArticles` applies the same lookback when it picks what to show.
 */
const NEWS_DAYS = 12;
const NEWS_LIMIT = 60;

export interface GenerateOptions {
  market: Market;
  /** Defaults to the current week. */
  weekStart?: string;
  /** Regenerate even when this week already has one. */
  force?: boolean;
  /** Overridable so the check script can drive the whole pipeline with a stub. */
  provider?: AiProvider;
  /** Standard deviations from an asset's own norm before it earns an explanation. */
  minZ?: number;
  movementLimit?: number;
  now?: Date;
  onRejected?: (info: { attempt: number; answer: string; errors: string[] }) => void;
}

export type GenerateOutcome =
  | { status: "cached"; insight: StoredInsight }
  | { status: "generated"; insight: StoredInsight; attempts: number; pack: EvidencePack }
  | { status: "skipped"; reason: string; pack: EvidencePack };

/**
 * Gather everything this market's week is made of.
 *
 * Separated from the generation itself so the pack can be inspected — by the
 * script, or by anyone wondering what the model was actually looking at when it
 * said something odd.
 */
export async function buildPackForMarket(options: GenerateOptions): Promise<EvidencePack> {
  const weekStart = options.weekStart ?? weekStartOf(options.now ?? new Date());

  // Load every market, then narrow: a market's headline asset may live elsewhere
  // (US Stocks is headlined by the S&P, which sits in `indices`).
  const { assets: all } = await loadAssetViews();
  const assets = all.filter((a) => a.market === options.market);
  const [view] = buildMarketViews(assets, "week", all);

  const performance = new Map<string, AssetPerformance>(assets.map((a) => [a.id, a.performance]));
  const candidates = await newsworthyAssets({
    market: options.market,
    minZ: options.minZ,
    limit: options.movementLimit,
  });
  const news = await loadNewsFeed({ market: options.market, days: NEWS_DAYS, limit: NEWS_LIMIT });

  return buildEvidencePack({
    market: options.market,
    weekStart,
    candidates,
    performance,
    news,
    marketChangePct: view ? marketChange(view, "week") : null,
    marketBasis: view?.headline
      ? `${view.headline.name} (${view.headline.symbol})`
      : "the median across the market",
    advancers: view?.advancers ?? 0,
    decliners: view?.decliners ?? 0,
    assetsTracked: assets.length,
    movementLimit: options.movementLimit,
  });
}

/**
 * Attach each citation to the headline it points at, copied in full.
 *
 * `via` is resolved against *this* movement: an article can be filed against gold
 * and merely mention silver, and the reader is owed the difference. A citation
 * with no link to the movement at all is legitimate — a market-wide story — and
 * carries `via: null` rather than being dropped.
 */
export function resolveReadings(draft: InsightDraft, pack: EvidencePack): ResolvedReading[] {
  const byRef = new Map(pack.articles.map((a) => [a.ref, a]));
  const factByRef = new Map(pack.movements.map((m) => [m.ref, m]));

  return draft.movements.map((reading) => {
    const sources: ResolvedCitation[] = [];
    for (const ref of reading.citations) {
      const article = byRef.get(ref);
      if (!article) continue; // validation already refused these; belt and braces
      sources.push({
        ref,
        title: article.title,
        url: article.url,
        source: article.source,
        publishedAt: article.publishedAt,
        via: article.links.find((l) => l.ref === reading.ref)?.via ?? null,
      });
    }
    return { ...reading, fact: factByRef.get(reading.ref)!, sources };
  });
}

/**
 * Whether the week's headlines explained anything.
 *
 * "insufficient" means one specific thing: assets moved unusually and nothing
 * retrieved accounted for any of them. A week with no unusual moves at all is not
 * insufficient — there was nothing to be insufficient about, and the summary of
 * what the coverage said stands on its own. Conflating the two would make the
 * field useless for deciding what to surface.
 *
 * Either way the insight is stored and displayed. Neither is hidden.
 */
export function statusFor(readings: { verdict: Verdict }[]): InsightStatus {
  // An insight is only generated when there is at least one movement, so the empty
  // case does not arise in practice. It is handled anyway, and handled correctly:
  // nothing to explain is not the same as failing to explain something.
  if (readings.length === 0) return "ok";
  return readings.some((r) => r.verdict !== "insufficient") ? "ok" : "insufficient";
}

function bodyFrom(draft: InsightDraft, pack: EvidencePack): InsightBody {
  return {
    headline: draft.headline,
    summary: draft.summary,
    watchItems: draft.watchItems,
    readings: resolveReadings(draft, pack),
    asOf: pack.asOf,
    marketChangePct: pack.marketChangePct,
    marketBasis: pack.marketBasis,
    advancers: pack.advancers,
    decliners: pack.decliners,
    assetsTracked: pack.assetsTracked,
    articlesConsidered: pack.articles.length,
  };
}

/**
 * Generate — or return — this week's insight for one market.
 *
 * Throws `AiUnavailableError` when nothing is configured and `StructuredTaskError`
 * when the model could not produce an answer that survives validation. Neither is
 * fatal to a page: the caller decides whether to surface it, and `insights/view.ts`
 * simply shows what is stored.
 */
export async function generateInsight(options: GenerateOptions): Promise<GenerateOutcome> {
  const weekStart = options.weekStart ?? weekStartOf(options.now ?? new Date());

  if (!options.force) {
    const existing = await loadInsight(options.market, weekStart);
    if (existing) return { status: "cached", insight: existing };
  }

  const pack = await buildPackForMarket({ ...options, weekStart });
  if (!hasSomethingToExplain(pack)) {
    return {
      status: "skipped",
      reason: `nothing in this market moved unusually this week (${pack.articles.length} headlines retrieved, nothing to attach them to)`,
      pack,
    };
  }

  const outcome = await runStructuredTask<InsightDraft>({
    system: SYSTEM_PROMPT,
    request: buildRequest(pack),
    schema: INSIGHT_SCHEMA,
    schemaName: "market_insight",
    maxTokens: MAX_TOKENS,
    provider: options.provider,
    review: (draft): Review<InsightDraft> => {
      const checked = validateInsight(draft, pack);
      if (checked.ok) return { ok: true, value: checked.value };
      return { ok: false, errors: checked.errors, repair: buildRepair(checked.errors) };
    },
    onRejected: options.onRejected,
  });

  const body = bodyFrom(outcome.value, pack);
  const insight: StoredInsight = {
    market: options.market,
    weekStart,
    generatedAt: options.now ?? new Date(),
    model: outcome.model,
    status: statusFor(body.readings),
    headline: outcome.value.headline,
    body,
  };

  await saveInsight(insight);
  return { status: "generated", insight, attempts: outcome.attempts, pack };
}
