import type { MetadataRoute } from "next";

/**
 * Disallow everything, deliberately.
 *
 * This app is not for public deployment: the market data it stores comes from
 * feeds that do not license redistribution, and the pages it renders are one
 * household's actual positions. Neither is a thing to be indexed.
 *
 * It is written down rather than left implicit because "we never deployed it" is
 * a fact about today. If this ever does go up behind a login or on a box with a
 * public IP, the default should already be closed rather than depending on
 * whoever deploys it remembering why it should be.
 *
 * There is no `sitemap.ts` for the same reason. A sitemap exists to hand a
 * crawler a list of URLs to fetch, and every one of them is disallowed here;
 * shipping both would be two files disagreeing about the same question.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
