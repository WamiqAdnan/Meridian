/**
 * Assembling what the model gets to see — and nothing else.
 *
 * Phase C already answers both halves of this. `newsworthyAssets` decides which
 * assets did something that wants explaining, scored in units of their own
 * volatility rather than a fixed percentage; `listNews` returns the headlines that
 * might explain it, each carrying *how* it came to be attached to an asset. Neither
 * is re-derived here. This file turns those into a numbered, bounded, checkable
 * brief.
 *
 * Two decisions are worth stating plainly:
 *
 *   - **Everything is referenced, nothing is free text.** Movements are M1…Mn and
 *     articles are A1…An, so every claim the model makes can be traced back to a
 *     row we gave it. It is also markedly easier for a small local model to carry
 *     "M1" through a paragraph than "commodities:XAU".
 *   - **`via` is carried through, not flattened.** "Reuters filed this story
 *     against gold" and "this sentence contains the word gold" are different kinds
 *     of evidence, and the model is told which is which. Flattening them is how a
 *     confident insight gets built on a crypto-converter listing.
 *
 * Pure. No Prisma, no fetch — the check script builds a pack by hand and renders
 * it without a database.
 */
import { fmtPrice } from "@/lib/format";
import { MARKET_META, type Market } from "@/lib/markets/types";
import type { AssetPerformance } from "@/lib/markets/performance";
import type { NewsItem } from "@/lib/news/store";
import type { MatchVia } from "@/lib/news/types";
import type { NewsCandidate } from "@/lib/news/relevance";
import type { EvidenceArticle, EvidencePack, MovementFact } from "./types";
import { endOfDay, weekEndOf } from "./types";

/**
 * How much fits in one brief.
 *
 * Both caps cost tokens directly, and a local model's attention more than that.
 * Ten movements is already more than a week usually produces; twenty headlines is
 * about as much as an 8B model will weigh carefully.
 */
export const PACK_LIMITS = { movements: 10, articles: 20 } as const;

/**
 * Headlines from just before the week still count.
 *
 * A Monday move is often a reaction to Friday's news, and a window that starts
 * exactly at the week boundary would leave that move looking unexplained.
 */
const LOOKBACK_DAYS = 3;

/**
 * What a match means, in words the model can weigh.
 *
 * Deliberately separate from `NewsList`'s labels, which describe the same
 * distinction to a reader hovering a chip. These are written to be read as
 * evidence grades, strongest first.
 */
export const VIA_EVIDENCE: Record<MatchVia, string> = {
  feed: "the publisher filed this story against that instrument",
  symbol: "its ticker appears in the text",
  name: "its name appears in the text",
  alias: "a synonym for it appears in the text — this may be coincidence",
};

export interface EvidenceInput {
  market: Market;
  weekStart: string;
  /** What needs explaining, strongest first. From `newsworthyAssets`. */
  candidates: NewsCandidate[];
  /** Performance by asset id, for the weekly move and the latest close. */
  performance: Map<string, AssetPerformance>;
  /** Retrieved headlines, matches already resolved. From `loadNewsFeed`. */
  news: NewsItem[];
  marketChangePct: number | null;
  /** What that market figure is measured on — its headline asset, or its median. */
  marketBasis: string;
  advancers: number;
  decliners: number;
  assetsTracked: number;
  movementLimit?: number;
  articleLimit?: number;
}

function daysBefore(date: string, days: number): Date {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86_400_000);
}

/** Turn the ingest layer's candidates and the market's bars into numbered facts. */
export function buildMovements(
  candidates: NewsCandidate[],
  performance: Map<string, AssetPerformance>,
  limit: number = PACK_LIMITS.movements,
): MovementFact[] {
  return candidates.slice(0, limit).map((c, i) => {
    const perf = performance.get(c.asset.id);
    return {
      ref: `M${i + 1}`,
      assetId: c.asset.id,
      symbol: c.asset.symbol,
      name: c.asset.name,
      market: c.asset.market,
      currency: c.asset.currency,
      changePct: c.changePct,
      sigma: c.sigma,
      zScore: c.zScore,
      weekChangePct: perf?.periods.week?.changePct ?? null,
      price: perf?.latest ?? null,
      asOf: perf?.latestDate ?? null,
    };
  });
}

/**
 * Pick the headlines worth spending tokens on.
 *
 * Articles linked to something that moved come first, strongest link first — those
 * are the ones with a chance of explaining a specific movement. Market-wide stories
 * follow by recency: a rates decision explains a move without ever naming the
 * instrument, and dropping it because it matched nothing would lose the best
 * evidence there is on some weeks.
 */
export function selectArticles(
  news: NewsItem[],
  movements: MovementFact[],
  options: { weekStart: string; limit?: number } ,
): EvidenceArticle[] {
  const limit = options.limit ?? PACK_LIMITS.articles;
  const refByAsset = new Map(movements.map((m) => [m.assetId, m.ref]));
  const since = daysBefore(options.weekStart, LOOKBACK_DAYS);
  // Bounded above as well, or a pack for a past week fills up with the present:
  // the week that has not closed yet ends in the future, so this is a no-op on
  // the only case that runs in normal use.
  const until = endOfDay(weekEndOf(options.weekStart));

  const scored = news
    .filter((item) => item.article.publishedAt >= since && item.article.publishedAt <= until)
    .map((item) => {
      const links = item.matches
        .filter((m) => refByAsset.has(m.assetId))
        .map((m) => ({ ref: refByAsset.get(m.assetId)!, assetId: m.assetId, via: m.via, score: m.score }))
        .sort((a, b) => b.score - a.score);
      const best = links[0]?.score ?? 0;
      return { item, links, best };
    })
    .sort((a, b) => {
      if (a.best !== b.best) return b.best - a.best;
      return b.item.article.publishedAt.getTime() - a.item.article.publishedAt.getTime();
    })
    .slice(0, limit);

  return scored.map(({ item, links }, i) => ({
    ref: `A${i + 1}`,
    articleId: item.article.id,
    title: item.article.title,
    summary: item.article.summary,
    source: item.article.source,
    url: item.article.url,
    publishedAt: item.article.publishedAt,
    links,
  }));
}

export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const movements = buildMovements(input.candidates, input.performance, input.movementLimit);
  const articles = selectArticles(input.news, movements, {
    weekStart: input.weekStart,
    limit: input.articleLimit,
  });

  return {
    market: input.market,
    weekStart: input.weekStart,
    asOf: movements.map((m) => m.asOf).filter((d): d is string => d != null).sort().at(-1) ?? null,
    movements,
    articles,
    marketChangePct: input.marketChangePct,
    marketBasis: input.marketBasis,
    advancers: input.advancers,
    decliners: input.decliners,
    assetsTracked: input.assetsTracked,
  };
}

/**
 * Whether there is anything here worth a model call.
 *
 * **At least one movement.** Headlines alone are not enough, and this was learned
 * the hard way: asked about a market with twenty headlines and no unusual moves,
 * `qwen3:8b` invented M1 through M20 — one movement per article — because "give one
 * entry per M-ref" reads as nonsense when there are no M-refs. The validator caught
 * every one of them, but the repair turn then carried twenty-one complaints and the
 * attempt was wasted.
 *
 * The deeper reason is that the fix is not a better prompt. A movement is what
 * anchors this whole layer: it is the fact a claim gets checked against, the thing
 * a citation has to bear on, and the reason a figure is quotable. With nothing that
 * moved, the model is left summarising headlines with no facts to tie them to —
 * which is the least anchored and least checkable thing it can produce, and not
 * what an insight is for. A quiet market simply says it was quiet.
 */
export function hasSomethingToExplain(pack: EvidencePack): boolean {
  return pack.movements.length > 0;
}

/* ----------------------------------------------------------------- render */

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The brief, as the model reads it.
 *
 * Kept as plain labelled text rather than JSON: every local model handles it
 * better, and it stays legible when a generation goes wrong and somebody has to
 * work out what the model was actually looking at.
 */
export function renderPack(pack: EvidencePack): string {
  const meta = MARKET_META[pack.market];
  const lines: string[] = [];

  lines.push(`MARKET: ${meta.label} — ${meta.blurb}`);
  lines.push(
    `WEEK: ${pack.weekStart} to ${weekEndOf(pack.weekStart)}` +
      (pack.asOf ? ` (latest session ${pack.asOf})` : ""),
  );
  const breadth =
    pack.marketChangePct != null
      ? `${signed(pack.marketChangePct)}% over the week, measured on ${pack.marketBasis}`
      : "no weekly figure available";
  lines.push(
    `MARKET MOVE: ${breadth}. ${pack.advancers} of ${pack.assetsTracked} tracked assets rose, ${pack.decliners} fell.`,
  );

  lines.push("");
  if (pack.movements.length === 0) {
    lines.push(
      "FACTS — no asset in this market moved unusually against its own volatility this week.",
    );
  } else {
    lines.push("FACTS — moves far enough from each asset's own norm to want explaining:");
    for (const m of pack.movements) {
      lines.push(
        `${m.ref}  ${m.symbol} (${m.name}) ${signed(m.changePct)}% on ${m.asOf ?? "the latest session"}` +
          ` — ${Math.abs(m.zScore).toFixed(1)}σ, against its own daily σ of ${m.sigma.toFixed(2)}%.` +
          (m.weekChangePct != null ? ` Over the week: ${signed(m.weekChangePct)}%.` : "") +
          (m.price != null ? ` Last close ${fmtPrice(m.price, m.currency)}.` : ""),
      );
    }
  }

  lines.push("");
  if (pack.articles.length === 0) {
    lines.push("HEADLINES — none were retrieved for this market this week.");
  } else {
    lines.push(
      "HEADLINES — every story retrieved for this market and these instruments. Titles and standfirsts only; you have not read any article body.",
    );
    for (const a of pack.articles) {
      lines.push(`${a.ref}  ${a.source} · ${day(a.publishedAt)} · "${a.title}"`);
      if (a.summary) lines.push(`    standfirst: ${a.summary}`);
      if (a.links.length === 0) {
        lines.push("    linked to: nothing specific — a market-wide story.");
      } else {
        for (const l of a.links) {
          const fact = pack.movements.find((m) => m.ref === l.ref);
          lines.push(
            `    linked to: ${l.ref} ${fact?.symbol ?? ""} — ${VIA_EVIDENCE[l.via]} (confidence ${l.score.toFixed(2)}).`,
          );
        }
      }
    }
  }

  return lines.join("\n");
}
