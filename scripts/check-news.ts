/**
 * Standalone checks for the news layer: RSS parsing, URL canonicalisation, the
 * search-term vocabulary, relevance matching, the unusual-move trigger, every
 * provider's routing, and the registry's union-and-merge behaviour.
 *
 * Run: npm run check:news
 *
 * No network and no database. Feed parsing runs against checked-in fixtures in
 * data/reference/news/ (real captured feeds, trimmed to four items each), and the
 * registry is exercised with stub providers injected in place of the real ones.
 * Every date is passed in explicitly so the suite gives the same answer in a year
 * as it does today.
 */
import { readFileSync } from "node:fs";
import {
  articleIdFor,
  canonicalUrl,
  decodeEntities,
  parseFeed,
  parseRssDate,
  richText,
  splitItems,
  stripHtml,
  tagAttr,
  tagText,
} from "@/lib/news/rss";
import {
  isEchoOfTitle,
  publisherFromUrl,
  toArticles,
} from "@/lib/news/providers/shared";
import { assetTerms, hasOwnStory, marketTerms } from "@/lib/news/terms";
import {
  containsPhrase,
  containsSymbol,
  matchArticle,
  newsworthy,
  MIN_SCORE,
} from "@/lib/news/relevance";
import { newsSymbolFor, yahooNewsUrl } from "@/lib/news/providers/yahoo";
import { googleNewsUrl, searchPhrase } from "@/lib/news/providers/google";
import { cnbcFeedUrl, feedsFor } from "@/lib/news/providers/cnbc";
import {
  candidateProviders,
  curatedProviderIds,
  fetchNews,
  mergeArticles,
} from "@/lib/news/registry";
import { buildQueries, coveringScopes, matchOutcomes } from "@/lib/news/ingest";
import {
  assetQuery,
  marketQuery,
  queryKey,
  topicQuery,
  type NewsArticle,
  type NewsProvider,
} from "@/lib/news/types";
import { MARKETS, type AssetRef, type BarData } from "@/lib/markets/types";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: string) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function near(label: string, actual: number | null | undefined, expected: number, tol = 0.005) {
  ok(
    label,
    actual != null && Math.abs(actual - expected) <= tol,
    `got ${actual}, want ${expected} ±${tol}`,
  );
}

function section(name: string) {
  console.log(`\n${name}`);
}

const fixture = (name: string) => readFileSync(`data/reference/news/${name}`, "utf8");

/** Well after every fixture's timestamps, so the sanity window never fires. */
const NOW = new Date("2026-09-01T00:00:00Z");

function testAsset(over: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "stocks:TEST",
    market: "stocks",
    symbol: "TEST",
    name: "Test",
    kind: "stock",
    currency: "USD",
    source: "yahoo",
    sourceSymbol: "TEST",
    rank: 1,
    benchmark: true,
    ...over,
  };
}

const APPLE = testAsset({ id: "stocks:AAPL", symbol: "AAPL", name: "Apple", sourceSymbol: "AAPL" });
const GOLD = testAsset({
  id: "commodities:XAU",
  market: "commodities",
  symbol: "XAU",
  name: "Gold",
  kind: "commodity",
  sourceSymbol: "GC=F",
});
const BITCOIN = testAsset({
  id: "crypto:BTC",
  market: "crypto",
  symbol: "BTC",
  name: "Bitcoin",
  kind: "crypto",
  source: "coingecko",
  sourceSymbol: "bitcoin",
});
const RUPEE = testAsset({
  id: "forex:USDPKR",
  market: "forex",
  symbol: "USDPKR",
  name: "US Dollar / Pakistani Rupee",
  kind: "fx_pair",
  currency: "PKR",
  sourceSymbol: "PKR=X",
});
const TEN_YEAR = testAsset({
  id: "bonds:US10Y",
  market: "bonds",
  symbol: "US10Y",
  name: "US 10-Year Treasury Yield",
  kind: "bond_yield",
  currency: "PCT",
  sourceSymbol: "^TNX",
});
const LUCK = testAsset({
  id: "psx:LUCK",
  market: "psx",
  symbol: "LUCK",
  name: "LUCK",
  currency: "PKR",
  source: "psx",
  sourceSymbol: "LUCK",
});
const COSTCO = testAsset({ id: "stocks:COST", symbol: "COST", name: "Costco", sourceSymbol: "COST" });
const TECH_ETF = testAsset({
  id: "stocks:XLK",
  symbol: "XLK",
  name: "Technology Select Sector SPDR",
  kind: "etf",
  sourceSymbol: "XLK",
});

/** Build a daily series from closes, one bar per calendar day ending `endDate`. */
function series(closes: number[], id = "stocks:TEST", endDate = "2026-08-18"): BarData[] {
  const end = new Date(`${endDate}T00:00:00Z`);
  return closes.map((close, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (closes.length - 1 - i));
    return {
      assetId: id,
      date: d.toISOString().slice(0, 10),
      open: null,
      high: null,
      low: null,
      close,
      volume: null,
      source: "test",
    };
  });
}

function article(over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "a1",
    title: "A headline",
    url: "https://example.com/a1",
    source: "Example",
    provider: "test",
    summary: null,
    publishedAt: new Date("2026-08-17T12:00:00Z"),
    market: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ entities */

function checkText() {
  section("Entities and text");

  eq("named entity", decodeEntities("AT&amp;T"), "AT&T");
  eq("decimal numeric entity", decodeEntities("&#39;quoted&#39;"), "'quoted'");
  eq("hex numeric entity", decodeEntities("&#x2019;"), "’");
  eq("several in one string", decodeEntities("&lt;b&gt;hi&lt;/b&gt;"), "<b>hi</b>");
  eq("unknown entity is left alone", decodeEntities("a &foo; b"), "a &foo; b");
  eq("a bare ampersand is left alone", decodeEntities("Tom & Jerry"), "Tom & Jerry");
  eq("out-of-range codepoint is left alone", decodeEntities("&#99999999;"), "&#99999999;");
  // The single-pass rule: this must NOT become a real "<".
  eq("escaped entity text is not re-decoded", decodeEntities("&amp;lt;"), "&lt;");

  eq("tags removed", stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
  eq("script bodies removed", stripHtml("a<script>evil()</script>b"), "a b");
  eq("style bodies removed", stripHtml("a<style>.x{}</style>b"), "a b");
  eq("whitespace collapsed", stripHtml("a\n\n   b"), "a b");

  eq(
    "double-escaped html is flattened",
    richText("&lt;ol&gt;&lt;li&gt;&lt;a&gt;Gold up&lt;/a&gt;&lt;/li&gt;&lt;/ol&gt;"),
    "Gold up",
  );
  eq("entities inside stripped markup survive", richText("&lt;a&gt;AT&amp;amp;T&lt;/a&gt;"), "AT&T");
  eq("plain text passes through", richText("Just a headline"), "Just a headline");
}

/* ----------------------------------------------------------------------- xml */

function checkXml() {
  section("XML primitives");

  eq("tag text", tagText("<title>Hello</title>", "title"), "Hello");
  eq("cdata unwrapped", tagText("<description><![CDATA[Body]]></description>", "description"), "Body");
  eq("attributes on the tag are tolerated", tagText('<link rel="x">u</link>', "link"), "u");
  eq("missing tag is null", tagText("<a>1</a>", "title"), null);
  // The leading "<" is what stops <metadata:type> matching a search for <type>.
  eq("namespaced tag does not match", tagText("<metadata:type>x</metadata:type>", "type"), null);
  eq("first match wins", tagText("<t>1</t><t>2</t>", "t"), "1");

  eq("attribute read", tagAttr('<source url="https://cnbc.com">CNBC</source>', "source", "url"), "https://cnbc.com");
  eq("attribute entities decoded", tagAttr('<source url="a?x=1&amp;y=2">S</source>', "source", "url"), "a?x=1&y=2");
  eq("missing attribute is null", tagAttr("<source>CNBC</source>", "source", "url"), null);

  eq("items split", splitItems("<item>a</item><item>b</item>").length, 2);
  eq("item with attributes splits", splitItems('<item foo="1">a</item>').length, 1);
  eq("no items is empty", splitItems("<channel></channel>").length, 0);
}

/* --------------------------------------------------------------------- dates */

function checkDates() {
  section("Dates");

  const rfc = parseRssDate("Mon, 17 Aug 2026 20:35:43 +0000", NOW);
  eq("rfc 822 parses", rfc?.toISOString(), "2026-08-17T20:35:43.000Z");
  const gmt = parseRssDate("Tue, 18 Aug 2026 04:34:22 GMT", NOW);
  eq("rfc 822 with GMT parses", gmt?.toISOString(), "2026-08-18T04:34:22.000Z");
  eq("iso parses", parseRssDate("2026-08-17T20:35:43Z", NOW)?.toISOString(), "2026-08-17T20:35:43.000Z");

  eq("null in, null out", parseRssDate(null, NOW), null);
  eq("gibberish is rejected", parseRssDate("last tuesday", NOW), null);
  // Both ends of the sanity window: a broken clock must not sort to the bottom
  // forever, nor pin itself to the top of every page.
  eq("epoch-era date is rejected", parseRssDate("Thu, 01 Jan 1970 00:00:00 GMT", NOW), null);
  eq("far-future date is rejected", parseRssDate("Fri, 01 Jan 2099 00:00:00 GMT", NOW), null);
  ok(
    "a few days ahead is tolerated",
    parseRssDate("Thu, 03 Sep 2026 00:00:00 GMT", NOW) !== null,
    "a publisher timezone bug should not lose the article",
  );
}

/* ---------------------------------------------------------------------- urls */

function checkUrls() {
  section("URL canonicalisation");

  eq(
    "yahoo rss tracking param stripped",
    canonicalUrl("https://finance.yahoo.com/video/x.html?.tsrc=rss"),
    "https://finance.yahoo.com/video/x.html",
  );
  eq(
    "utm params stripped",
    canonicalUrl("https://a.com/p?utm_source=rss&utm_medium=feed"),
    "https://a.com/p",
  );
  eq("real query params survive", canonicalUrl("https://a.com/p?id=7"), "https://a.com/p?id=7");
  eq("fragment dropped", canonicalUrl("https://a.com/p#section"), "https://a.com/p");
  eq("host lower-cased", canonicalUrl("https://A.COM/p"), "https://a.com/p");
  eq("trailing slash trimmed", canonicalUrl("https://a.com/p/"), "https://a.com/p");
  eq("root slash kept", canonicalUrl("https://a.com/"), "https://a.com/");
  eq(
    "param order does not change identity",
    canonicalUrl("https://a.com/p?b=2&a=1"),
    canonicalUrl("https://a.com/p?a=1&b=2"),
  );
  eq("unparseable url is returned as-is", canonicalUrl("not a url"), "not a url");

  eq("id is 24 hex chars", /^[0-9a-f]{24}$/.test(articleIdFor("https://a.com/p")), true);
  eq(
    "the same story tracked differently is one id",
    articleIdFor("https://a.com/p?utm_source=rss"),
    articleIdFor("https://a.com/p"),
  );
  ok(
    "different stories get different ids",
    articleIdFor("https://a.com/p") !== articleIdFor("https://a.com/q"),
  );
}

/* ------------------------------------------------------------------ fixtures */

function checkFixtures() {
  section("Captured feeds");

  const yahoo = parseFeed(fixture("yahoo-aapl.xml"), NOW);
  eq("yahoo items", yahoo.items.length, 4);
  eq("yahoo skipped none", yahoo.skipped, 0);
  ok("yahoo titles are non-empty", yahoo.items.every((i) => i.title.length > 0));
  ok("yahoo links are absolute", yahoo.items.every((i) => i.link.startsWith("https://")));
  ok("yahoo carries standfirsts", yahoo.items.every((i) => (i.description?.length ?? 0) > 0));
  eq("yahoo names no source element", yahoo.items[0].sourceName, null);

  const google = parseFeed(fixture("google-gold.xml"), NOW);
  eq("google items", google.items.length, 4);
  ok(
    "google names the publisher in a source element",
    google.items.every((i) => (i.sourceName?.length ?? 0) > 0),
  );
  ok(
    "google titles carry the publisher suffix",
    google.items.every((i) => i.title.endsWith(` - ${i.sourceName}`)),
  );
  ok(
    "google links are its own redirects",
    google.items.every((i) => i.link.includes("news.google.com/rss/articles/")),
  );

  const cnbc = parseFeed(fixture("cnbc-topnews.xml"), NOW);
  eq("cnbc items", cnbc.items.length, 4);
  ok("cnbc cdata descriptions decoded", cnbc.items.every((i) => !i.description?.includes("CDATA")));
  ok(
    "cnbc namespaced metadata is ignored",
    cnbc.items.every((i) => !i.title.includes("cnbcnewsstory")),
  );

  // Malformed input must degrade to nothing, never throw.
  eq("empty feed parses to nothing", parseFeed("", NOW).items.length, 0);
  eq("junk parses to nothing", parseFeed("<html><body>hi</body></html>", NOW).items.length, 0);
  const broken = parseFeed("<item><title>No link or date</title></item>", NOW);
  eq("an unusable item is skipped", broken.items.length, 0);
  eq("and counted", broken.skipped, 1);
}

/* -------------------------------------------------------- article normalising */

function checkArticles() {
  section("Article normalisation");

  const yahoo = toArticles(parseFeed(fixture("yahoo-aapl.xml"), NOW).items, {
    provider: "yahoo",
    market: "stocks",
    fallbackSource: "Yahoo Finance",
  });
  eq("yahoo articles", yahoo.length, 4);
  eq("newest first", yahoo[0].publishedAt >= yahoo[1].publishedAt, true);
  eq("fallback source applied", yahoo[0].source, "Yahoo Finance");
  eq("market recorded", yahoo[0].market, "stocks");
  ok("tracking params gone from stored urls", yahoo.every((a) => !a.url.includes("tsrc")));
  ok("yahoo standfirsts are kept", yahoo.some((a) => a.summary !== null));

  const google = toArticles(parseFeed(fixture("google-gold.xml"), NOW).items, {
    provider: "google",
    market: "commodities",
    stripSourceSuffix: true,
  });
  eq("google articles", google.length, 4);
  ok(
    "publisher suffix stripped from titles",
    google.every((a) => !a.title.endsWith(` - ${a.source}`)),
  );
  ok("publisher taken from the source element", google.some((a) => a.source === "KITCO"));
  // Google's description is the headline plus the publisher and nothing else.
  ok("echoed summaries are dropped", google.every((a) => a.summary === null));

  eq("limit respected", toArticles(parseFeed(fixture("cnbc-topnews.xml"), NOW).items, {
    provider: "cnbc",
    market: null,
    limit: 2,
  }).length, 2);

  eq(
    "since filters older items out",
    toArticles(parseFeed(fixture("google-gold.xml"), NOW).items, {
      provider: "google",
      market: "commodities",
      since: "2026-08-13",
    }).length,
    1,
  );

  eq("empty input is fine", toArticles([], { provider: "x", market: null }).length, 0);

  const dupes = parseFeed(fixture("cnbc-topnews.xml"), NOW).items;
  eq(
    "the same story twice in one batch collapses",
    toArticles([...dupes, ...dupes], { provider: "cnbc", market: null }).length,
    dupes.length,
  );

  eq("known host prettified", publisherFromUrl("https://www.cnbc.com/x"), "CNBC");
  eq("unknown host shows its domain", publisherFromUrl("https://www.benzinga.com/x"), "benzinga.com");
  eq("unparseable url is named honestly", publisherFromUrl("nonsense"), "unknown");

  eq("echo detected", isEchoOfTitle("Gold rises today CNBC", "Gold rises today", "CNBC"), true);
  eq(
    "a real standfirst is not an echo",
    isEchoOfTitle(
      "Gold rises today. Analysts point to a weaker dollar and heavier central-bank buying.",
      "Gold rises today",
      "CNBC",
    ),
    false,
  );
  eq("unrelated summary is not an echo", isEchoOfTitle("Something else", "Gold rises", "CNBC"), false);
}

/* --------------------------------------------------------------------- terms */

function checkTerms() {
  section("Search terms");

  ok("a stock searches by name", assetTerms(APPLE).query.includes('"Apple"'));
  ok("a commodity searches by price", assetTerms(GOLD).query.includes("price"));
  ok("crypto is disambiguated", assetTerms(BITCOIN).query.includes("crypto"));
  ok("an etf searches by ticker", assetTerms(TECH_ETF).query.includes('"XLK"'));
  ok("a psx equity names the exchange", assetTerms(LUCK).query.includes("Pakistan Stock Exchange"));
  // The dollar side of a USD pair is not what a story is about.
  ok("an fx pair searches the non-dollar side", assetTerms(RUPEE).query.includes("Pakistani Rupee"));
  ok("fx query asks for a rate", assetTerms(RUPEE).query.includes("exchange rate"));
  // The catalogue label is never a sentence; a story names one side of the pair.
  ok("an fx pair is matchable by its currency", assetTerms(RUPEE).aliases.includes("Pakistani Rupee"));

  ok("a stock matches on its name", assetTerms(APPLE).aliases.includes("Apple"));
  ok("a stock matches on its ticker", assetTerms(APPLE).symbols.includes("AAPL"));
  // A fund name never appears in prose, and its first word would match everything.
  ok("an etf does not match on its name", !assetTerms(TECH_ETF).aliases.includes("Technology Select Sector SPDR"));
  ok("an etf still matches on its ticker", assetTerms(TECH_ETF).symbols.includes("XLK"));
  ok("hand-written synonyms are included", assetTerms(GOLD).aliases.includes("bullion"));
  ok("gold still matches on its name", assetTerms(GOLD).aliases.includes("Gold"));

  // COST is a word before it is a ticker.
  ok("an ambiguous ticker is not a symbol term", !assetTerms(COSTCO).symbols.includes("COST"));
  ok("but its name still is", assetTerms(COSTCO).aliases.includes("Costco"));
  const visa = testAsset({ id: "stocks:V", symbol: "V", name: "Visa", sourceSymbol: "V" });
  ok("a two-letter ticker is not a symbol term", visa.symbol.length < 3 && assetTerms(visa).symbols.length === 0);

  ok("a market has a phrase", marketTerms("crypto").query.length > 0);
  ok("psx names the exchange", marketTerms("psx").query.includes("Pakistan"));

  eq("a stock has its own story", hasOwnStory(APPLE), true);
  eq("a commodity has its own story", hasOwnStory(GOLD), true);
  // An index level and a yield move because the market did; the market query covers it.
  eq("a yield does not", hasOwnStory(TEN_YEAR), false);
  eq("an index does not", hasOwnStory(testAsset({ kind: "index" })), false);
}

/* ----------------------------------------------------------------- relevance */

function checkRelevance() {
  section("Relevance matching");

  eq("phrase matches", containsPhrase("Apple beats estimates", "Apple"), true);
  eq("phrase is case-insensitive", containsPhrase("APPLE BEATS", "Apple"), true);
  eq("phrase respects word boundaries", containsPhrase("Pineapple crop", "Apple"), false);
  eq("phrase matches next to punctuation", containsPhrase("Apple's quarter", "Apple"), true);
  // \b would break on these; the lookaround is why they work.
  eq("phrase with a symbol in it", containsPhrase("The S&P 500 rose", "S&P 500"), true);
  eq("hyphenated phrase", containsPhrase("The 10-year Treasury fell", "10-year Treasury"), true);
  eq("empty phrase never matches", containsPhrase("anything", ""), false);

  eq("symbol matches uppercase", containsSymbol("Shares of AAPL rose", "AAPL"), true);
  eq("symbol matches after a dollar sign", containsSymbol("$AAPL is up", "AAPL"), true);
  // The whole point of case-sensitivity.
  eq("symbol does not match lowercase prose", containsSymbol("the cost of living", "COST"), false);
  eq("symbol respects boundaries", containsSymbol("AAPLE", "AAPL"), false);

  const assets = [APPLE, GOLD, BITCOIN, COSTCO, TECH_ETF, TEN_YEAR];

  const byFeed = matchArticle(article({ title: "Something vague about a company" }), assets, {
    feedAssetId: "stocks:AAPL",
  });
  eq("provenance matches even with no textual clue", byFeed.length, 1);
  eq("provenance is attributed as feed", byFeed[0].via, "feed");
  near("provenance scores full confidence", byFeed[0].score, 1);

  const bySymbol = matchArticle(article({ title: "AAPL climbs on chip news" }), assets);
  eq("a ticker in the headline matches", bySymbol[0].assetId, "stocks:AAPL");
  eq("attributed as symbol", bySymbol[0].via, "symbol");
  near("symbol confidence", bySymbol[0].score, 0.8);

  const byName = matchArticle(article({ title: "Apple changes tracking rules" }), assets);
  eq("a name in the headline matches", byName[0].assetId, "stocks:AAPL");
  eq("attributed as name", byName[0].via, "name");
  near("name confidence", byName[0].score, 0.65);

  const byAlias = matchArticle(article({ title: "Central banks keep buying bullion" }), assets);
  eq("a synonym matches", byAlias[0].assetId, "commodities:XAU");
  eq("attributed as alias", byAlias[0].via, "alias");

  const inSummary = matchArticle(
    article({ title: "Markets wrap", summary: "Apple led the tape higher." }),
    assets,
  );
  eq("a name in the standfirst still matches", inSummary[0].assetId, "stocks:AAPL");
  near("but scores lower than the headline", inSummary[0].score, 0.65 * 0.7);

  // The other side of that gradient: the loosest signal in body text is noise.
  eq(
    "a synonym buried in the standfirst does not match",
    matchArticle(article({ title: "Weekend roundup", summary: "Talk of bullion continued." }), assets)
      .length,
    0,
  );

  const strongest = matchArticle(article({ title: "Apple (AAPL) beats estimates" }), assets);
  eq("naming an asset twice is still one match", strongest.filter((m) => m.assetId === "stocks:AAPL").length, 1);
  eq("and the strongest signal wins", strongest[0].via, "symbol");

  const bonus = matchArticle(article({ title: "Gold steadies", market: "commodities" }), assets);
  ok(
    "the feed's own market corroborates a text match",
    (bonus.find((m) => m.assetId === "commodities:XAU")?.score ?? 0) > 0.65,
    "a commodities feed saying 'gold' is likelier to mean the metal",
  );

  eq(
    "a story about nothing tracked matches nothing",
    matchArticle(article({ title: "Local council approves new bypass" }), assets).length,
    0,
  );
  eq(
    "the cost of living is not Costco",
    matchArticle(article({ title: "The rising cost of living" }), assets).length,
    0,
  );
  eq(
    "a fund name in prose does not match the fund",
    matchArticle(article({ title: "Technology stocks rallied" }), assets).length,
    0,
  );

  eq(
    "a raised threshold drops weak matches",
    matchArticle(article({ title: "Markets wrap", summary: "Apple led." }), assets, { minScore: 0.9 })
      .length,
    0,
  );
  ok("the default threshold is stated once", MIN_SCORE > 0 && MIN_SCORE < 1);

  const multi = matchArticle(
    article({ title: "Apple and Bitcoin both rallied as gold slipped" }),
    assets,
  );
  eq("several assets in one story all match", multi.length, 3);
  ok("results are ranked strongest first", multi[0].score >= multi[multi.length - 1].score);
}

/* ---------------------------------------------------------------- newsworthy */

function checkNewsworthy() {
  section("Newsworthy selection");

  // 70 flat-ish sessions, then a violent one. Enough history for unusualMove.
  const calm = Array.from({ length: 70 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));
  const spiked = [...calm, 115];
  const steady = [...calm, 100.05];

  const picked = newsworthy([
    { asset: APPLE, bars: series(spiked, APPLE.id) },
    { asset: COSTCO, bars: series(steady, COSTCO.id) },
  ]);
  eq("an unusual move is picked up", picked.length, 1);
  eq("and it is the right asset", picked[0].asset.id, "stocks:AAPL");
  ok("the z-score is reported", Math.abs(picked[0].zScore) > 2);
  ok("so is the raw move", picked[0].changePct > 10);
  ok("so is the asset's own volatility", picked[0].sigma > 0);

  eq(
    "a notional asset is never looked up on its own",
    newsworthy([{ asset: TEN_YEAR, bars: series(spiked, TEN_YEAR.id) }]).length,
    0,
  );

  const crashed = [...calm, 85];
  const both = newsworthy([
    { asset: APPLE, bars: series(spiked, APPLE.id) },
    { asset: GOLD, bars: series(crashed, GOLD.id) },
  ]);
  eq("a crash counts as much as a spike", both.length, 2);
  ok("ranked by magnitude, not direction", Math.abs(both[0].zScore) >= Math.abs(both[1].zScore));

  eq(
    "a short series yields nothing rather than a guess",
    newsworthy([{ asset: APPLE, bars: series([100, 130], APPLE.id) }]).length,
    0,
  );
  eq("no bars at all is fine", newsworthy([{ asset: APPLE, bars: [] }]).length, 0);
  eq(
    "a raised threshold is respected",
    newsworthy([{ asset: APPLE, bars: series(spiked, APPLE.id) }], { minZ: 99 }).length,
    0,
  );
  eq(
    "the limit bounds what a run will cost",
    newsworthy(
      [
        { asset: APPLE, bars: series(spiked, APPLE.id) },
        { asset: GOLD, bars: series(crashed, GOLD.id) },
      ],
      { limit: 1 },
    ).length,
    1,
  );
}

/* ----------------------------------------------------------------- providers */

function checkProviders() {
  section("Providers");

  eq("yahoo maps an equity", newsSymbolFor(assetQuery(APPLE)), "AAPL");
  eq("yahoo maps crypto to its pair", newsSymbolFor(assetQuery(BITCOIN)), "BTC-USD");
  eq("yahoo maps a commodity future", newsSymbolFor(assetQuery(GOLD)), "GC=F");
  // Verified against the live feed: PKR=X answers 200 with an empty channel.
  eq("yahoo declines fx pairs", newsSymbolFor(assetQuery(RUPEE)), null);
  eq("yahoo declines psx", newsSymbolFor(assetQuery(LUCK)), null);
  eq("yahoo declines a market query", newsSymbolFor(marketQuery("stocks")), null);
  ok("yahoo url carries the symbol", yahooNewsUrl("GC=F").includes("s=GC%3DF"));

  ok("google searches an asset", (searchPhrase(assetQuery(APPLE)) ?? "").includes("Apple"));
  ok("google searches a market", (searchPhrase(marketQuery("crypto")) ?? "").includes("crypto"));
  ok("google searches a topic", (searchPhrase(topicQuery("Fed decision")) ?? "").includes("Fed"));
  eq("google declines an empty topic", searchPhrase(topicQuery("   ")), null);
  ok(
    "a since date becomes a when: operator",
    (searchPhrase(marketQuery("crypto", { since: "2026-08-11" }), new Date("2026-08-18")) ?? "")
      .includes("when:7d"),
  );
  ok("google url is encoded", googleNewsUrl('"Gold" price').includes("%22Gold%22"));

  eq("cnbc covers a market", feedsFor(marketQuery("commodities")).length > 0, true);
  eq("cnbc shares a desk between markets", feedsFor(marketQuery("bonds")).includes("economy"), true);
  // CNBC does not report on the Pakistan Stock Exchange; a feed that never
  // mentions it would be worse than no feed.
  eq("cnbc declines psx", feedsFor(marketQuery("psx")).length, 0);
  eq("cnbc declines an asset query", feedsFor(assetQuery(APPLE)).length, 0);
  ok("cnbc url is built from the id", cnbcFeedUrl("100003114").includes("/id/100003114/"));

  eq("asset queries key by asset", queryKey(assetQuery(APPLE)), "asset:stocks:AAPL");
  eq("market queries key by market", queryKey(marketQuery("crypto")), "market:crypto");
  eq("topic queries key case-insensitively", queryKey(topicQuery("Fed")), "topic:fed");
}

/* ------------------------------------------------------------------ registry */

function stubProvider(
  id: string,
  supports: (kind: string) => boolean,
  articles: (q: string) => NewsArticle[],
  behaviour: "ok" | "error" | "throw" = "ok",
  curated = false,
): NewsProvider {
  return {
    id,
    label: id,
    curated,
    supports: (q) => supports(q.kind),
    async fetch(queries) {
      if (behaviour === "throw") throw new Error(`${id} exploded`);
      return queries.map((query) => ({
        query,
        articles: behaviour === "error" ? [] : articles(queryKey(query)),
        error: behaviour === "error" ? `${id} is down` : null,
      }));
    },
  };
}

async function checkRegistry() {
  section("Registry");

  const a1 = article({ id: "one", url: "https://a.com/1", title: "One", summary: "A standfirst" });
  const a2 = article({ id: "two", url: "https://a.com/2", title: "Two" });
  // The same story, arriving from a second provider without the standfirst.
  const a1Thin = article({ id: "one", url: "https://a.com/1", title: "One", summary: null, source: "" });

  const alpha = stubProvider("alpha", (k) => k === "asset", () => [a1], "ok", true);
  const beta = stubProvider("beta", () => true, () => [a1Thin, a2]);
  const dead = stubProvider("dead", () => true, () => [], "error");
  const broken = stubProvider("broken", () => true, () => [], "throw");

  eq("only supporting providers are candidates", candidateProviders(marketQuery("crypto"), [alpha, beta]).length, 1);
  eq("curated providers are identified", [...curatedProviderIds([alpha, beta])].join(","), "alpha");
  eq("the real registry curates only yahoo", [...curatedProviderIds()].join(","), "yahoo");
  eq("both when both support it", candidateProviders(assetQuery(APPLE), [alpha, beta]).length, 2);

  const unioned = await fetchNews([assetQuery(APPLE)], [alpha, beta]);
  eq("one outcome per query", unioned.length, 1);
  // The whole difference from markets/registry: both are asked, not just the first.
  eq("both providers contributed", unioned[0].providersOk.length, 2);
  eq("the duplicate story is merged away", unioned[0].articles.length, 2);
  eq(
    "and the richer copy survives",
    unioned[0].articles.find((a) => a.id === "one")?.summary,
    "A standfirst",
  );

  const partial = await fetchNews([assetQuery(APPLE)], [dead, beta]);
  eq("a dead provider does not empty the union", partial[0].articles.length, 2);
  eq("but its failure is reported", partial[0].errors.length, 1);

  const contained = await fetchNews([assetQuery(APPLE)], [broken, beta]);
  eq("a provider that throws is contained", contained[0].articles.length, 2);
  ok("and named in the errors", contained[0].errors[0].includes("broken"));

  const none = await fetchNews([marketQuery("psx")], [alpha]);
  eq("an unsupported query still yields an outcome", none.length, 1);
  eq("with nothing in it", none[0].articles.length, 0);

  eq("no queries, no outcomes", (await fetchNews([], [alpha])).length, 0);

  const merged = mergeArticles([a1Thin, a1]);
  eq("merging keeps one row", merged.length, 1);
  // The market registry's rule, applied to prose: never overwrite what is known.
  eq("first writer wins on identity", merged[0].source, a1Thin.source || a1.source);
  eq("but a gap is filled", merged[0].summary, "A standfirst");

  const ordered = mergeArticles([
    article({ id: "old", url: "https://a.com/o", publishedAt: new Date("2026-08-01") }),
    article({ id: "new", url: "https://a.com/n", publishedAt: new Date("2026-08-17") }),
  ]);
  eq("merged output is newest first", ordered[0].id, "new");
}

/* -------------------------------------------------------------------- ingest */

function checkIngest() {
  section("Ingest work list");

  const queries = buildQueries(["crypto", "commodities"], [APPLE, GOLD], { since: "2026-08-11" });
  eq("one query per market plus one per asset", queries.length, 4);
  ok("the since date is passed through", queries.every((q) => q.since === "2026-08-11"));
  ok("asset queries carry the asset", queries.some((q) => q.kind === "asset" && q.asset?.id === "stocks:AAPL"));
  ok("asset queries carry its market", queries.some((q) => q.kind === "asset" && q.market === "stocks"));

  const deduped = buildQueries(["crypto", "crypto"], [GOLD, GOLD], { since: "2026-08-11" });
  eq("a repeated ask is only asked once", deduped.length, 2);

  eq("no work is no queries", buildQueries([], [], { since: "2026-08-11" }).length, 0);

  const outcomes = [
    {
      query: assetQuery(APPLE),
      articles: [article({ id: "x", title: "An opaque headline", provider: "yahoo" })],
      providersOk: ["yahoo"],
      errors: [],
    },
    {
      query: marketQuery("commodities"),
      articles: [
        article({ id: "y", title: "Gold hits a record", market: "commodities" as const, provider: "cnbc" }),
      ],
      providersOk: ["cnbc"],
      errors: [],
    },
  ];
  const curated = new Set(["yahoo"]);
  const entries = matchOutcomes(outcomes, [APPLE, GOLD], curated);
  eq("every article is carried through", entries.length, 2);
  // Provenance: a curated provider filed it there, which the text alone is not.
  eq("a curated asset feed attributes by provenance", entries[0].matches[0].via, "feed");
  eq("and to the right asset", entries[0].matches[0].assetId, "stocks:AAPL");
  eq("a market feed falls back to text", entries[1].matches[0].assetId, "commodities:XAU");
  ok("which is not provenance", entries[1].matches[0].via !== "feed");

  // The regression this guards: a search provider asked about one asset returns
  // whatever ranks. Granting that provenance attached crypto-converter spam to
  // USD/AED at full confidence.
  const searched = matchOutcomes(
    [
      {
        query: assetQuery(RUPEE),
        articles: [
          article({ id: "z", title: "Convert 10 MEGA (MegaETH) to AED", provider: "google" }),
        ],
        providersOk: ["google"],
        errors: [],
      },
    ],
    [RUPEE, APPLE],
    curated,
  );
  eq("a search provider's asset query is not provenance", searched[0].matches.length, 0);

  const alsoSearched = matchOutcomes(
    [
      {
        query: assetQuery(APPLE),
        articles: [article({ id: "w", title: "Apple ships a new phone", provider: "google" })],
        providersOk: ["google"],
        errors: [],
      },
    ],
    [APPLE],
    curated,
  );
  eq("but its results are still matched on their text", alsoSearched[0].matches.length, 1);
  eq("attributed honestly", alsoSearched[0].matches[0].via, "name");

  // What `ingestIfStale` judges staleness over. Coverage runs one way: a global
  // sweep stands in for any market, and no market stands in for the sweep. Asking
  // over every recent run regardless of scope meant a single visit to
  // /markets/psx suppressed the overview's 8-market ingest for half an hour.
  eq("an unscoped sweep is covered by the global run alone", coveringScopes().join(","), "all");
  ok("a market's own run does not cover the sweep", !coveringScopes().includes("psx"));
  ok("a market request is covered by its own run", coveringScopes("psx").includes("psx"));
  ok("and by a global sweep, which asked for strictly more", coveringScopes("psx").includes("all"));
  ok("every market is covered by the global sweep", MARKETS.every((m) => coveringScopes(m).includes("all")));
  ok(
    "and by nothing else",
    MARKETS.every((m) => coveringScopes(m).every((s) => s === m || s === "all")),
  );
}

/* ------------------------------------------------------------------------ run */

async function main() {
  checkText();
  checkXml();
  checkDates();
  checkUrls();
  checkFixtures();
  checkArticles();
  checkTerms();
  checkRelevance();
  checkNewsworthy();
  checkProviders();
  await checkRegistry();
  checkIngest();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
