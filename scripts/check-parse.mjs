// Standalone sanity check: does pdf-parse extract text the Finqalab regex can read?
// Run: node scripts/check-parse.mjs
import pdf from "pdf-parse/lib/pdf-parse.js";
import { readFileSync } from "node:fs";

const render = (pageData) =>
  pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((tc) => {
      let lastY, text = "";
      for (const item of tc.items) {
        const y = item.transform[5];
        if (lastY === undefined) text += item.str;
        else if (y === lastY) text += " " + item.str;
        else text += "\n" + item.str;
        lastY = y;
      }
      return text;
    });

const buf = readFileSync("data/sample/finqalab-sample.pdf");
const { text } = await pdf(buf, { pagerender: render });

const RE =
  /^([A-Z][A-Z0-9]*)\s+(\d+)(?:\s+\d+)?\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(BUY|SELL)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/;

let trades = 0;
const bySym = {};
for (const raw of text.split(/\r?\n/)) {
  const m = RE.exec(raw.trim());
  if (!m) continue;
  trades++;
  const [, sym, , , , , , qty, gross, , brokerTotal, cvt] = m;
  const s = (bySym[sym] ??= { qty: 0, cost: 0 });
  const q = +qty;
  s.qty += q;
  s.cost += +gross + +brokerTotal + +cvt;
}

const total = Object.values(bySym).reduce((a, b) => a + b.cost, 0);
console.log("parsed trades:", trades);
console.log("securities:", Object.keys(bySym).length);
console.log("total invested (incl fees):", total.toFixed(2));
