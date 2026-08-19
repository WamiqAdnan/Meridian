/**
 * The ledger's own vocabulary.
 *
 * Two jobs, both of which existed implicitly before and are worth naming:
 *
 *   1. Which asset does a stored trade refer to? Rows imported before markets
 *      existed carry a bare `security` and no `assetId`. They are PSX equities by
 *      definition — the PDF importer could never have produced anything else — so
 *      they resolve to `psx:{SECURITY}`. `resolveAssetId` is the one place that
 *      assumption is written down.
 *
 *   2. What does a hand-entered trade have to look like before it may be written?
 *      The PDF path gets its arithmetic from the broker's own report. A manual
 *      entry has no such authority behind it, so the numbers are derived here
 *      from qty/rate/fees rather than trusted from the caller.
 *
 * Pure — no Prisma, no fetch — so the check script can exercise all of it.
 */
import { parseAssetId, type Market } from "./markets/types";
import { isInvestor } from "./investors";

/** The `broker` slug hand-entered rows carry, so they are never mistaken for an import. */
export const MANUAL_BROKER = "manual";

/** Minimum a stored row needs for its asset to be identified. */
export interface AssetIdentifiable {
  security: string;
  assetId?: string | null;
}

/**
 * The asset a ledger row trades.
 *
 * Falls back to `psx:{SECURITY}` only when `assetId` is absent, which is true of
 * pre-markets rows and of nothing written since. Never guesses a market for a row
 * that already states one.
 */
export function resolveAssetId(row: AssetIdentifiable): string {
  const explicit = row.assetId?.trim();
  if (explicit) return explicit;
  return `psx:${row.security.trim().toUpperCase()}`;
}

/* ------------------------------------------------------------ manual entry */

/** What the form sends. Every numeric field arrives as a string from an input. */
export interface ManualTradeInput {
  owner?: unknown;
  assetId?: unknown;
  side?: unknown;
  tradeDate?: unknown;
  settlementDate?: unknown;
  qty?: unknown;
  rate?: unknown;
  /** Total commission/fees for the trade, in the asset's own currency. */
  fees?: unknown;
}

/** A row ready for `prisma.transaction.create`. Mirrors the importer's output. */
export interface NewTrade {
  owner: string;
  broker: string;
  security: string;
  assetId: string;
  tradeNo: string;
  tradeDate: string;
  settlementDate: string;
  side: "BUY" | "SELL";
  rate: number;
  qty: number;
  grossAmount: number;
  brokerage: number;
  cvt: number;
  netAmount: number;
}

export type ValidationResult =
  | { ok: true; trade: NewTrade }
  | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a well-formed yyyy-mm-dd that names a real calendar day. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  // Round-tripping catches 2026-02-30, which `new Date` silently rolls forward.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Read a number that arrived from a text input.
 *
 * Accepts the thousands separators people actually type. Rejects "" and "abc"
 * rather than reading them as 0 — a silent zero here becomes a free position.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** `M-20260818T0930-4f3a` — sorts by entry time, which is the right same-day tiebreak. */
export function manualTradeNo(now: Date = new Date(), suffix?: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13);
  const tail = suffix ?? Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `M-${stamp}-${tail}`;
}

/** The asset a manual trade is against, as far as validation needs to know it. */
export interface TradeableAsset {
  id: string;
  symbol: string;
  market: Market;
}

/**
 * Turn form input into a row, or into the list of reasons it isn't one.
 *
 * Every reason is collected rather than short-circuiting on the first, so the
 * form can mark all the bad fields in one pass.
 *
 * The money is computed here, never accepted: `gross = rate * qty`, and a BUY
 * costs `gross + fees` while a SELL nets `gross - fees`. That is the same
 * convention `computeHoldings` replays, so a hand-entered trade and an imported
 * one behave identically downstream.
 */
export function buildManualTrade(
  input: ManualTradeInput,
  asset: TradeableAsset,
  options: { now?: Date; tradeNo?: string } = {},
): ValidationResult {
  const errors: string[] = [];
  const now = options.now ?? new Date();

  const owner = input.owner;
  if (!isInvestor(owner)) errors.push("Pick who this trade belongs to.");

  if (!parseAssetId(asset.id)) errors.push(`"${asset.id}" is not a valid asset id.`);

  const side = typeof input.side === "string" ? input.side.toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") errors.push("Side must be BUY or SELL.");

  const tradeDate = input.tradeDate;
  if (!isIsoDate(tradeDate)) {
    errors.push("Trade date must be a real date in yyyy-mm-dd form.");
  } else if (tradeDate > now.toISOString().slice(0, 10)) {
    // A future trade date would sort after every real one and quietly distort
    // any window anchored to the latest bar.
    errors.push("Trade date cannot be in the future.");
  }

  const settlementDate =
    input.settlementDate === undefined || input.settlementDate === null || input.settlementDate === ""
      ? tradeDate
      : input.settlementDate;
  if (!isIsoDate(settlementDate)) errors.push("Settlement date must be a real date in yyyy-mm-dd form.");

  const qty = toNumber(input.qty);
  if (qty == null) errors.push("Quantity must be a number.");
  else if (qty <= 0) errors.push("Quantity must be greater than zero.");

  const rate = toNumber(input.rate);
  // Zero is allowed: an airdrop, a bonus issue and a gift are all real trades
  // acquired at no cost, and refusing them would push them out of the ledger.
  if (rate == null) errors.push("Price must be a number.");
  else if (rate < 0) errors.push("Price cannot be negative.");

  const fees = input.fees === undefined || input.fees === null || input.fees === "" ? 0 : toNumber(input.fees);
  if (fees == null) errors.push("Fees must be a number.");
  else if (fees < 0) errors.push("Fees cannot be negative.");

  if (errors.length > 0) return { ok: false, errors };

  const grossAmount = rate! * qty!;
  const netAmount = side === "BUY" ? grossAmount + fees! : grossAmount - fees!;

  return {
    ok: true,
    trade: {
      owner: owner as string,
      broker: MANUAL_BROKER,
      security: asset.symbol.toUpperCase(),
      assetId: asset.id,
      tradeNo: options.tradeNo ?? manualTradeNo(now),
      tradeDate: tradeDate as string,
      settlementDate: settlementDate as string,
      side: side as "BUY" | "SELL",
      rate: rate!,
      qty: qty!,
      grossAmount,
      // Fees land in `brokerage`; `cvt` is a PSX-specific tax the importer fills
      // and a manual entry has no separate figure for. Both feed the same total.
      brokerage: fees!,
      cvt: 0,
      netAmount,
    },
  };
}
