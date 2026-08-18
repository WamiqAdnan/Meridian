/**
 * RSS, reduced to the six fields a headline actually needs.
 *
 * Every source in this app speaks RSS 2.0, and each mangles it differently:
 * Yahoo indents and escapes, CNBC wraps descriptions in CDATA and mixes in
 * `metadata:`-namespaced elements, Google News double-escapes a whole HTML list
 * into `<description>` and hides the publisher in a `<source url>` attribute.
 * Normalising that is this file's entire job.
 *
 * Hand-rolled rather than a dependency: the subset of XML that RSS uses is small
 * and well-behaved, and this keeps the parser exercisable against captured feeds
 * with no network, no database and nothing to install. Pure throughout.
 *
 * Not handled, deliberately: Atom `<entry>`. No source here emits it. A provider
 * that speaks Atom means extending this file, and that is where it should go.
 */
import { createHash } from "node:crypto";

/** One raw feed item, before a provider decides what it means. */
export interface RssItem {
  title: string;
  link: string;
  description: string | null;
  /** The `<source>` element's text, where the feed names the publisher. */
  sourceName: string | null;
  publishedAt: Date;
}

/* ---------------------------------------------------------------- entities */

/** The named entities that actually appear in these feeds, plus the XML five. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

/**
 * Decode XML/HTML entities in one pass.
 *
 * One pass matters: replacing `&amp;` first and then `&lt;` would turn the
 * literal text `&amp;lt;` into a `<`, inventing markup that was never there.
 * A single regex whose replacement is not rescanned cannot do that.
 *
 * An unrecognised entity is left exactly as written rather than dropped — if a
 * feed says `&foo;` that is what it said.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Strip markup and collapse whitespace. Script and style bodies go with the tags. */
export function stripHtml(text: string): string {
  return text
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Feed text to display text.
 *
 * Decodes, strips any markup that decoding revealed, then decodes once more —
 * Google News escapes an entire `<ol>` of links into `<description>`, so the
 * entities belonging to the real prose sit one level in. On a feed that is not
 * double-escaped the second pass finds nothing left to do.
 */
export function richText(text: string): string {
  return decodeEntities(stripHtml(decodeEntities(text))).replace(/\s+/g, " ").trim();
}

/* --------------------------------------------------------------------- xml */

function unwrapCdata(inner: string): string {
  const trimmed = inner.trim();
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return match ? match[1] : inner;
}

/**
 * The text inside the first `<name>` element, CDATA unwrapped.
 *
 * The leading `<` in the pattern is what keeps `<title>` from matching CNBC's
 * `<metadata:title>`: a namespaced tag has a prefix and a colon between the
 * angle bracket and the name, so it simply is not the same string.
 */
export function tagText(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const match = re.exec(xml);
  return match ? unwrapCdata(match[1]) : null;
}

/** An attribute on the first `<name>` element — `<source url="…">`. */
export function tagAttr(xml: string, name: string, attr: string): string | null {
  const re = new RegExp(`<${name}\\s[^>]*${attr}\\s*=\\s*"([^"]*)"`, "i");
  const match = re.exec(xml);
  return match ? decodeEntities(match[1]) : null;
}

/** Every `<item>` block in a feed, in document order. */
export function splitItems(xml: string): string[] {
  return xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
}

/* -------------------------------------------------------------------- dates */

/**
 * A feed's timestamp, or null if it is missing or not believable.
 *
 * RFC 822 (`Mon, 17 Aug 2026 20:35:43 +0000`) and ISO 8601 both parse natively.
 * The sanity window is the part that matters: a feed with a broken clock would
 * otherwise file a story under 1970 — where it sorts below everything forever —
 * or under 2099, where it pins to the top of every page. Either would quietly
 * corrupt "what happened this week", which is the only question news is here to
 * answer. An article with no usable date is dropped rather than stamped with
 * `now`, because an invented date is indistinguishable from a real one later.
 */
export function parseRssDate(raw: string | null, now: Date = new Date()): Date | null {
  if (!raw) return null;
  const parsed = new Date(decodeEntities(raw).trim());
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  if (parsed.getUTCFullYear() < 2000) return null;
  // A few days of slack absorbs a publisher's timezone bug without accepting a
  // date that is plainly wrong.
  if (ms > now.getTime() + 7 * 86_400_000) return null;
  return parsed;
}

/* --------------------------------------------------------------------- urls */

/** Query parameters that identify the referrer, never the article. */
const TRACKING = [
  /^utm_/i,
  /^\.?tsrc$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^ncid$/i,
  /^cmpid$/i,
  /^guce/i,
  /^guccounter$/i,
  /^ito$/i,
  /^taid$/i,
  /^yptr$/i,
];

/**
 * The identity of an article, as a URL.
 *
 * Yahoo appends `?.tsrc=rss` and Google wraps everything in a redirect; without
 * normalising, the same story stored twice looks like two stories and doubles
 * its own weight in anything that counts coverage. Anything unparseable is
 * returned untouched — a URL we cannot read is still a stable string.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  // Sorted so `?a=1&b=2` and `?b=2&a=1` are one article, not two.
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

/**
 * The stable id for an article. 24 hex characters of SHA-256 over the canonical
 * URL — the same shape and length as a broker layout fingerprint.
 */
export function articleIdFor(url: string): string {
  return createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 24);
}

/* ------------------------------------------------------------------- parse */

export interface ParseFeedResult {
  items: RssItem[];
  /** Items rejected for having no title, no link, or no believable date. */
  skipped: number;
}

/**
 * Parse a feed into items, dropping anything that could not be trusted.
 *
 * Rejects rather than repairs: an item with no link cannot be opened, and one
 * with no usable date cannot be placed in time. Both are counted so a feed that
 * has quietly changed shape shows up as a wall of skips instead of an empty page.
 */
export function parseFeed(xml: string, now: Date = new Date()): ParseFeedResult {
  const items: RssItem[] = [];
  let skipped = 0;

  for (const block of splitItems(xml)) {
    const title = richText(tagText(block, "title") ?? "");
    const link = (tagText(block, "link") ?? "").trim();
    const publishedAt = parseRssDate(tagText(block, "pubDate") ?? tagText(block, "date"), now);

    if (!title || !link || !publishedAt) {
      skipped++;
      continue;
    }

    const description = richText(tagText(block, "description") ?? "");
    items.push({
      title,
      link: decodeEntities(link),
      // A description that merely repeats the headline carries nothing.
      description: description && description !== title ? description : null,
      sourceName: richText(tagText(block, "source") ?? "") || null,
      publishedAt,
    });
  }

  return { items, skipped };
}
