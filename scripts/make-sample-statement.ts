/**
 * Regenerates the checked-in broker-statement fixture and its reference exports.
 *
 * Run: npm run make:sample
 *
 * Everything under data/sample/ and the three data/reference/*.csv exports is
 * **invented**. The trades, the client and the account below belong to nobody —
 * this repository is public, and a broker statement is exactly the kind of thing
 * that must never be in one. The layout, though, is reproduced faithfully from
 * Finqalab's "Periodic Trade Details Report", because that is the whole point:
 * `scripts/check-parse.ts` runs the built-in spec in `src/lib/builtin-brokers.ts`
 * over this PDF and compares every field against transactions.csv, so a fixture
 * that parsed but didn't look like the real report would check nothing.
 *
 * Both artefacts are derived from TRADES in one pass, so they cannot drift apart.
 *
 * Two details the arithmetic depends on:
 *   - brokerage is 0.25% of gross, and the per-share column beside it is 0.25% of
 *     the *rate*. Only the total is a real fee (see FINQALAB_SPEC).
 *   - every quantity below is chosen so gross is a whole number of rupees
 *     divisible by four. That makes brokerage (gross/400) exact at two decimals,
 *     and the net with it, so the CSV can print money columns the way a real
 *     export does without rounding. check-parse compares brokerage to ±0.00005
 *     and the net to ±0.005; neither budget should be spent on the fixture's own
 *     rounding, and four of these rows would otherwise land exactly on it.
 */
import { writeFileSync } from "node:fs";

interface Trade {
  security: string;
  tradeNo: string;
  side: "BUY" | "SELL";
  rate: number;
  qty: number;
}

/** Trade dates are a Monday/Tuesday, settling T+1, as the real report does. */
const TRADE_DATE = "2026-03-02";
const SETTLEMENT_DATE = "2026-03-03";
const CLIENT = "Mr. SAMPLE CLIENT";
const PERIOD = "01/03/2026 to 03/03/2026";

/**
 * Fourteen symbols, sixteen fills. Three securities are filled twice (one of
 * them across both sides) because the real report does that whenever an order
 * fills at more than one price, and a parser that silently collapsed them would
 * still look right on a one-fill-per-symbol fixture.
 */
const TRADES: Trade[] = [
  { security: "HBL", tradeNo: "90000101", side: "BUY", rate: 152.4, qty: 200 },
  { security: "HBL", tradeNo: "90000102", side: "BUY", rate: 152.56, qty: 150 },
  { security: "UBL", tradeNo: "90000103", side: "BUY", rate: 368.75, qty: 96 },
  { security: "BAHL", tradeNo: "90000104", side: "BUY", rate: 88.2, qty: 300 },
  { security: "ENGRO", tradeNo: "90000105", side: "BUY", rate: 312.5, qty: 40 },
  { security: "NESTLE", tradeNo: "90000106", side: "BUY", rate: 7250, qty: 2 },
  { security: "POL", tradeNo: "90000107", side: "BUY", rate: 645, qty: 20 },
  { security: "POL", tradeNo: "90000108", side: "SELL", rate: 646, qty: 10 },
  { security: "TRG", tradeNo: "90000109", side: "BUY", rate: 68.44, qty: 500 },
  { security: "TRG", tradeNo: "90000110", side: "SELL", rate: 69.12, qty: 200 },
  { security: "SEARL", tradeNo: "90000111", side: "BUY", rate: 94.12, qty: 300 },
  { security: "INDU", tradeNo: "90000112", side: "BUY", rate: 1875, qty: 8 },
  { security: "PAEL", tradeNo: "90000113", side: "BUY", rate: 41.84, qty: 400 },
  { security: "KEL", tradeNo: "90000114", side: "BUY", rate: 5.62, qty: 5000 },
  { security: "CHCC", tradeNo: "90000115", side: "BUY", rate: 214.88, qty: 50 },
  { security: "NBP", tradeNo: "90000116", side: "BUY", rate: 47.32, qty: 300 },
];

const BROKERAGE_RATE = 0.0025;

interface Priced extends Trade {
  gross: number;
  brokerPerShare: number;
  brokerage: number;
  cvt: number;
  net: number;
}

/** Round to `dp` places without the float dust that breaks an exact comparison. */
const round = (n: number, dp: number) => Number(Math.round(Number(`${n}e${dp}`)) + `e-${dp}`);

function price(t: Trade): Priced {
  const gross = round(t.rate * t.qty, 2);
  const brokerPerShare = round(t.rate * BROKERAGE_RATE, 6);
  const brokerage = round(gross * BROKERAGE_RATE, 6);
  const cvt = 0;
  const fees = brokerage + cvt;
  return {
    ...t,
    gross,
    brokerPerShare,
    brokerage,
    cvt,
    net: round(t.side === "BUY" ? gross + fees : gross - fees, 6),
  };
}

const priced = TRADES.map(price);

/** "76.200000" -> "76.2", the way the report prints a number. */
const trim = (n: number, dp = 6) =>
  n.toFixed(dp).replace(/\.?0+$/, "") || "0";

// ------------------------------------------------------------------ the PDF

/**
 * A minimal single-font PDF writer.
 *
 * Only what this fixture needs: Helvetica, absolutely-positioned text, no
 * compression. Each cell is its own text-showing operator placed at the row's
 * baseline, because that is what the real report does and what
 * `renderPageWithSpaces` in src/lib/statement-text.ts reassembles into columns —
 * it joins items sharing a `y` with a space and breaks a line when `y` changes.
 * Emitting a row as one pre-spaced string would sail past the parser here and
 * tell us nothing about real PDFs.
 */
interface Cell {
  x: number;
  text: string;
}

class PdfBuilder {
  private pages: string[] = [];
  private current: string[] = [];
  private y = 0;
  private readonly top = 750;
  private readonly bottom = 60;

  private escape(s: string) {
    return s.replace(/([\\()])/g, "\\$1");
  }

  /** Start a fresh page, resetting the cursor to the top margin. */
  newPage() {
    if (this.current.length > 0) this.pages.push(this.current.join("\n"));
    this.current = [];
    this.y = this.top;
  }

  /** One baseline of text. `size` and `leading` follow the report's proportions. */
  row(cells: Cell[], size = 8, leading = 12) {
    if (this.y - leading < this.bottom) this.newPage();
    for (const c of cells) {
      if (c.text === "") continue;
      this.current.push(
        `BT /F1 ${size} Tf 1 0 0 1 ${c.x} ${this.y} Tm (${this.escape(c.text)}) Tj ET`,
      );
    }
    this.y -= leading;
  }

  blank(leading = 12) {
    this.y -= leading;
  }

  build(): Buffer {
    if (this.current.length > 0) this.pages.push(this.current.join("\n"));

    const objects: string[] = [];
    const pageCount = this.pages.length;
    // 1 catalog, 2 pages, 3 font, then per page: content stream + page object.
    const contentId = (i: number) => 4 + i * 2;
    const pageId = (i: number) => 5 + i * 2;

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] =
      `<< /Type /Pages /Count ${pageCount} /Kids [` +
      this.pages.map((_, i) => `${pageId(i)} 0 R`).join(" ") +
      "] >>";
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

    for (const [i, content] of this.pages.entries()) {
      objects[contentId(i)] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
      objects[pageId(i)] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R >> >> ` +
        `/Contents ${contentId(i)} 0 R >>`;
    }

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = Buffer.byteLength(out);
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xrefAt = Buffer.byteLength(out);
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) {
      out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

/** Column origins, chosen so no cell overlaps its neighbour at 8pt Helvetica. */
const COL = {
  security: 36,
  tradeNo: 88,
  billNo: 146,
  tradeDate: 178,
  settlement: 238,
  type: 298,
  rate: 330,
  qty: 382,
  total: 414,
  brokerPerShare: 470,
  brokerTotal: 522,
  cvt: 574,
};

function buildPdf(): Buffer {
  const pdf = new PdfBuilder();
  pdf.newPage();

  pdf.row([{ x: COL.security, text: "Periodic Trade Details Report By Finqalab" }], 11, 18);
  pdf.row([{ x: COL.security, text: `Client Name: ${CLIENT}` }], 9, 14);
  pdf.row([{ x: COL.security, text: `Period: ${PERIOD}` }], 9, 14);
  pdf.row([{ x: COL.security, text: `Total Records: ${priced.length}` }], 9, 18);

  pdf.row(
    [
      { x: COL.security, text: "Security" },
      { x: COL.tradeNo, text: "Trade No." },
      { x: COL.billNo, text: "Bill No." },
      { x: COL.tradeDate, text: "Trade Date" },
      { x: COL.settlement, text: "Settlement" },
      { x: COL.type, text: "Type" },
      { x: COL.rate, text: "Rate" },
      { x: COL.qty, text: "Qty." },
      { x: COL.total, text: "Total" },
      { x: COL.brokerPerShare, text: "Broker " },
      { x: COL.brokerTotal, text: "Broker Total" },
      { x: COL.cvt, text: "CVT" },
    ],
    8,
    16,
  );

  // Grouped by security in first-appearance order, each group closed by the two
  // side subtotals the report prints — non-trade lines the parser must ignore.
  const order = [...new Set(priced.map((t) => t.security))];
  for (const security of order) {
    const group = priced.filter((t) => t.security === security);
    for (const t of group) {
      pdf.row([
        { x: COL.security, text: t.security },
        { x: COL.tradeNo, text: t.tradeNo },
        { x: COL.tradeDate, text: TRADE_DATE },
        { x: COL.settlement, text: SETTLEMENT_DATE },
        { x: COL.type, text: t.side },
        { x: COL.rate, text: trim(t.rate) },
        { x: COL.qty, text: String(t.qty) },
        { x: COL.total, text: trim(t.gross) },
        { x: COL.brokerPerShare, text: trim(t.brokerPerShare) },
        { x: COL.brokerTotal, text: trim(t.brokerage) },
        { x: COL.cvt, text: "0" },
      ]);
    }
    for (const side of ["BUY", "SELL"] as const) {
      const rows = group.filter((t) => t.side === side);
      const qty = rows.reduce((n, t) => n + t.qty, 0);
      const gross = round(
        rows.reduce((n, t) => n + t.gross, 0),
        2,
      );
      pdf.row([{ x: COL.security, text: `${side} ` }]);
      pdf.row([{ x: COL.security, text: "TOTAL:" }]);
      pdf.row([
        { x: COL.qty, text: String(qty) },
        { x: COL.total, text: gross.toFixed(2) },
      ]);
    }
    pdf.blank(6);
  }

  return pdf.build();
}

// ----------------------------------------------------------------- the CSVs

function transactionsCsv(): string {
  const header =
    "security,trade_no,trade_date,settlement_date,side,rate,qty,gross_amount,brokerage,cvt,net_amount";
  const rows = priced.map((t) =>
    [
      t.security,
      t.tradeNo,
      TRADE_DATE,
      SETTLEMENT_DATE,
      t.side,
      t.rate.toFixed(4),
      t.qty,
      t.gross.toFixed(2),
      t.brokerage.toFixed(4),
      t.cvt.toFixed(2),
      t.net.toFixed(2),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

/**
 * What the ledger looks like once the statement is imported: one row per
 * security, sells netted off, cost weighted by the fills that built the position.
 */
interface Position {
  security: string;
  qty: number;
  cost: number; // gross only, so avg_rate stays a clean weighted mean
  fees: number;
}

function positions(): Position[] {
  const bySecurity = new Map<string, Position>();
  for (const t of priced) {
    const p = bySecurity.get(t.security) ?? { security: t.security, qty: 0, cost: 0, fees: 0 };
    const sign = t.side === "BUY" ? 1 : -1;
    p.qty += sign * t.qty;
    p.cost += sign * t.gross;
    p.fees += t.brokerage + t.cvt;
    bySecurity.set(t.security, p);
  }
  return [...bySecurity.values()]
    .filter((p) => p.qty > 0)
    .sort((a, b) => a.security.localeCompare(b.security));
}

function holdingsCsv(rows: Position[]): string {
  const header = "security,qty,avg_rate,fees,total_cost,avg_cost_incl_fees";
  return (
    [
      header,
      ...rows.map((p) => {
        const totalCost = round(p.cost + p.fees, 2);
        return [
          p.security,
          p.qty,
          (p.cost / p.qty).toFixed(4),
          round(p.fees, 2).toFixed(2),
          totalCost.toFixed(2),
          (totalCost / p.qty).toFixed(4),
        ].join(",");
      }),
    ].join("\n") + "\n"
  );
}

/**
 * A P&L snapshot needs a "live" price, and this fixture has no market to ask.
 * Each one is nudged off the weighted average by a fixed, deterministic amount so
 * the column is reproducible and obviously not a real quote.
 */
function pnlCsv(rows: Position[]): string {
  const header =
    "security,qty,avg_cost_incl_fees,total_cost,live_price,market_value,unrealized_pnl,pnl_pct";
  return (
    [
      header,
      ...rows.map((p, i) => {
        const totalCost = round(p.cost + p.fees, 2);
        const avg = totalCost / p.qty;
        // -1.5%, -0.5%, +0.5%, +1.5%, repeating.
        const drift = ((i % 4) - 1.5) / 100;
        const live = round(avg * (1 + drift), 2);
        const marketValue = round(live * p.qty, 2);
        const pnl = round(marketValue - totalCost, 2);
        return [
          p.security,
          p.qty,
          avg.toFixed(4),
          totalCost.toFixed(2),
          live.toFixed(2),
          marketValue.toFixed(2),
          pnl.toFixed(2),
          ((pnl / totalCost) * 100).toFixed(2),
        ].join(",");
      }),
    ].join("\n") + "\n"
  );
}

// --------------------------------------------------------------------- main

const pos = positions();
writeFileSync("data/sample/finqalab-sample.pdf", buildPdf());
writeFileSync("data/reference/transactions.csv", transactionsCsv());
writeFileSync("data/reference/holdings.csv", holdingsCsv(pos));
writeFileSync("data/reference/holdings_pnl.csv", pnlCsv(pos));

console.log(
  `Wrote a ${priced.length}-trade statement for ${CLIENT} ` +
    `(${pos.length} resulting positions) to data/sample/ and data/reference/.`,
);
