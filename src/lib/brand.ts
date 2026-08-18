/**
 * Product identity, in one place so renaming is a one-line change.
 *
 * Chosen as a sensible default during the rebrand from "PSX Portfolio" — edit
 * freely; nothing branches on these values.
 */
export const BRAND = {
  name: "Meridian",
  tagline: "Portfolio and market intelligence",
  description:
    "A centralized dashboard for a multi-market portfolio, with market data and AI-assisted weekly intelligence.",
} as const;

/**
 * The standing disclaimer for anything model-generated.
 *
 * This is a financial product; AI output here explains and contextualises price
 * moves, and is not advice. Shown wherever an insight is.
 */
export const AI_DISCLAIMER =
  "AI-generated market insights are informational and may contain uncertainty. They are not financial advice.";
