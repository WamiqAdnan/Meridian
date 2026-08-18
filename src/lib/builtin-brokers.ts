/**
 * Broker parsers that ship with the app, hand-written rather than learned.
 *
 * These are seeded into `BrokerProfile` on first use and re-seeded from here on
 * every import, so this file stays the source of truth for them. They're also the
 * worked example of what a good spec looks like — the learning prompt in
 * `broker-learn.ts` describes these same conventions in prose.
 *
 * No database import here on purpose: `scripts/check-parse.ts` exercises the specs
 * standalone.
 */
import type { BrokerParseSpec } from "@/lib/broker-spec";

/**
 * Finqalab's Periodic Trade Details Report, the layout this app started with.
 *
 * A row looks like:
 *   HBL 90000101 2026-03-02 2026-03-03 BUY 152.4 200 30480 0.381 76.2 0
 *   SYMBOL TRADE_NO [BILL_NO?] TRADE_DATE SETTLE_DATE SIDE RATE QTY GROSS BROKER/SH BROKER_TOTAL CVT
 *
 * The two "Broker" columns are the per-share commission (rate * 0.25%) and the
 * total commission (gross * 0.25%); only the total is a real fee, so the per-share
 * column is captured and then deliberately left unmapped.
 *
 * Anchoring on the two ISO dates + the BUY/SELL keyword + the six trailing numbers
 * means a future report that fills in the currently-blank "Bill No." column still
 * parses.
 */
export const FINQALAB_SPEC: BrokerParseSpec = {
  version: 1,
  broker: "Finqalab",
  rowPattern:
    "^(?<security>[A-Z][A-Z0-9]*)\\s+(?<tradeNo>\\d+)(?:\\s+\\d+)?\\s+(?<tradeDate>\\d{4}-\\d{2}-\\d{2})\\s+(?<settlementDate>\\d{4}-\\d{2}-\\d{2})\\s+(?<sideToken>BUY|SELL)\\s+(?<rate>[\\d.,]+)\\s+(?<qty>[\\d,]+)\\s+(?<gross>[\\d.,]+)\\s+(?<brokerPerShare>[\\d.,]+)\\s+(?<brokerTotal>[\\d.,]+)\\s+(?<cvt>[\\d.,]+)$",
  dateFormat: "iso",
  decimalSeparator: ".",
  sideRule: { type: "map", group: "sideToken", map: { BUY: "BUY", SELL: "SELL" } },
  qtyGroup: "qty",
  rateGroup: "rate",
  grossGroup: "gross",
  netGroup: null, // not printed — derived from gross ± fees
  brokerageGroups: ["brokerTotal"],
  cvtGroups: ["cvt"],
  metadata: {
    clientPattern: "^Client Name:\\s*(?<value>.+)$",
    periodPattern: "^Period:\\s*(?<value>.+)$",
    totalRecordsPattern: "^Total Records:\\s*(?<value>[\\d,]+)",
  },
  ignorePatterns: [],
  notes: "Built in. Checked against data/sample/finqalab-sample.pdf by scripts/check-parse.ts.",
};

export interface BuiltinProfile {
  /** Stable profile slug — also the `broker` tag on every row imported with it. */
  slug: string;
  spec: BrokerParseSpec;
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [{ slug: "finqalab", spec: FINQALAB_SPEC }];
