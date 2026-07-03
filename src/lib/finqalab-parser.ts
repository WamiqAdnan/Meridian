import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type Side = "BUY" | "SELL";

export interface ParsedTrade {
  security: string;
  tradeNo: string;
  tradeDate: string; // yyyy-mm-dd
  settlementDate: string; // yyyy-mm-dd
  side: Side;
  rate: number; // execution price per share
  qty: number;
  grossAmount: number; // rate * qty
  brokerage: number; // total broker commission for the trade
  cvt: number;
  netAmount: number; // BUY: gross + fees, SELL: gross - fees
}

export interface FinqalabParseResult {
  trades: ParsedTrade[];
  client: string | null;
  period: string | null;
  totalRecords: number | null; // the "Total Records" figure printed in the report
  countMatches: boolean; // does trades.length match totalRecords?
}

/**
 * A Finqalab trade row looks like:
 *   HBL 90000101 2026-03-02 2026-03-03 BUY 152.4 200 30480 0.381 76.2 0
 *   SYMBOL TRADE_NO TRADE_DATE SETTLE_DATE SIDE RATE QTY GROSS BROKER/SH BROKER_TOTAL CVT
 *
 * The two "Broker" columns are the per-share commission (rate * 0.25%) and the
 * total commission (gross * 0.25%); the total commission is the real brokerage fee.
 */
const ROW_RE =
  /^([A-Z][A-Z0-9]*)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(BUY|SELL)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/;

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/** Parse the raw extracted text of a Finqalab Periodic Trade Details Report. */
export function parseFinqalabText(text: string): FinqalabParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  let client: string | null = null;
  let period: string | null = null;
  let totalRecords: number | null = null;
  const trades: ParsedTrade[] = [];

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("Client Name:")) {
      client = line.slice("Client Name:".length).trim();
      continue;
    }
    if (line.startsWith("Period:")) {
      period = line.slice("Period:".length).trim();
      continue;
    }
    if (line.startsWith("Total Records:")) {
      const n = parseInt(line.slice("Total Records:".length).trim(), 10);
      totalRecords = Number.isNaN(n) ? null : n;
      continue;
    }

    const m = ROW_RE.exec(line);
    if (!m) continue;

    const [, security, tradeNo, tradeDate, settlementDate, side, rate, qty, gross, , brokerTotal, cvt] =
      m;

    const brokerage = num(brokerTotal);
    const cvtVal = num(cvt);
    const grossAmount = num(gross);
    const fees = brokerage + cvtVal;

    trades.push({
      security,
      tradeNo,
      tradeDate,
      settlementDate,
      side: side as Side,
      rate: num(rate),
      qty: parseInt(qty, 10),
      grossAmount,
      brokerage,
      cvt: cvtVal,
      netAmount: side === "BUY" ? grossAmount + fees : grossAmount - fees,
    });
  }

  return {
    trades,
    client,
    period,
    totalRecords,
    countMatches: totalRecords === null ? true : totalRecords === trades.length,
  };
}

/** Extract text from a Finqalab PDF (as a Buffer) and parse it. */
export async function parseFinqalabPdf(buffer: Buffer): Promise<FinqalabParseResult> {
  const data = await pdfParse(buffer);
  return parseFinqalabText(data.text);
}
