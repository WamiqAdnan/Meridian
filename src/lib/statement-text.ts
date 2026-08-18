/**
 * Getting a broker statement into flat text, plus the two derived things the
 * parser registry needs: a layout fingerprint (to recognise a statement we've
 * seen the shape of before) and a bounded sample (the only part ever sent to an
 * LLM when we have to learn a new layout).
 */
import { createHash } from "node:crypto";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type StatementKind = "pdf" | "text";

export function statementKind(filename: string, mimeType?: string): StatementKind {
  if (/\.pdf$/i.test(filename) || mimeType === "application/pdf") return "pdf";
  return "text";
}

/**
 * pdf-parse concatenates text items on a line with no separator
 * ("HBL900001012026-03-02..."). This custom renderer inserts a space between
 * items sharing the same baseline (y), reconstructing the column layout — while
 * still breaking lines when the baseline changes.
 */
function renderPageWithSpaces(pageData: {
  getTextContent: (opts: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }) => Promise<{ items: { str: string; transform: number[] }[] }>;
}): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((tc) => {
      let lastY: number | undefined;
      let text = "";
      for (const item of tc.items) {
        const y = item.transform[5];
        if (lastY === undefined) text += item.str;
        else if (y === lastY) text += " " + item.str;
        else text += "\n" + item.str;
        lastY = y;
      }
      return text;
    });
}

/** Extract flat text from an uploaded statement (PDF, or any delimited text file). */
export async function extractStatementText(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<string> {
  if (statementKind(filename, mimeType) === "pdf") {
    const data = await pdfParse(buffer, { pagerender: renderPageWithSpaces });
    return data.text;
  }
  return buffer.toString("utf8").replace(/^﻿/, "");
}

/**
 * A hash of the statement's *shape* — its labels and column headings — with the
 * data rows and every digit stripped out. Two monthly statements from the same
 * broker hash the same; a different broker (or a redesigned report) doesn't.
 *
 * It only ever short-circuits the search for a parser: a fingerprint hit still
 * has to survive full validation, so a collision costs a wasted regex pass, not
 * a mis-parse.
 */
export function fingerprintLayout(text: string): string {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/).slice(0, 120)) {
    const line = raw.trim();
    if (!line) continue;

    // Keep the label, drop the value: "Client Name: A. Investor" -> "Client Name".
    const label = line.includes(":") ? line.slice(0, line.indexOf(":")) : line;
    const nonSpace = label.replace(/\s/g, "");
    if (nonSpace.length < 4) continue;
    const letters = (label.match(/[A-Za-z]/g) ?? []).length;
    if (letters / nonSpace.length < 0.5) continue; // a data row, not a heading

    const normalized = label
      .toLowerCase()
      .replace(/\d/g, "#")
      .replace(/[^a-z#\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(normalized);
    if (kept.length === 12) break;
  }

  return createHash("sha256").update(kept.join("\n")).digest("hex").slice(0, 24);
}

const SAMPLE_CHAR_BUDGET = 12_000;

/**
 * A bounded excerpt for the learning call: the header (where the labels and column
 * headings live) plus a window from the middle of the document, so the model sees
 * both the schema and enough rows to infer formats. Capped so one upload can't turn
 * into an enormous prompt.
 */
export function sampleForLearning(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const head = lines.slice(0, 70);
  const midStart = Math.min(lines.length, head.length + 1);
  const mid = lines.slice(midStart, midStart + 30);
  const picked = mid.length > 0 ? [...head, "…", ...mid] : head;

  let out = "";
  for (const line of picked) {
    if (out.length + line.length + 1 > SAMPLE_CHAR_BUDGET) break;
    out += line + "\n";
  }
  return out;
}
