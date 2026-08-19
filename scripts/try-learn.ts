/**
 * Dry-run a broker statement through the parser: does a built-in spec read it, and
 * if not, can the configured model write one that validates?
 *
 * Run: npm run try:learn -- path/to/statement.pdf
 *
 * Touches no database and imports nothing — use it to try a new broker's report (or
 * a new learning backend) without putting anything in the ledger. Point it at a
 * local model to keep the statement on this machine:
 *
 *   LEARNING_BASE_URL=http://localhost:11434/v1 LEARNING_MODEL=qwen3:8b \
 *     npm run try:learn -- data/sample/finqalab-sample.pdf
 */
import { readFileSync } from "node:fs";
import { runSpec, validateRun, type BrokerParseSpec } from "@/lib/broker-spec";
import { BUILTIN_PROFILES } from "@/lib/builtin-brokers";
import { learnParser } from "@/lib/broker-learn";
import { aiBackendLabel } from "@/lib/ai";
import { extractStatementText, fingerprintLayout } from "@/lib/statement-text";

function report(spec: BrokerParseSpec, text: string) {
  const result = runSpec(text, spec);
  const validation = validateRun(result, spec);

  console.log(`\nbroker:        ${spec.broker}`);
  console.log(`dates:         ${spec.dateFormat}`);
  console.log(`side:          ${spec.sideRule.type}`);
  console.log(`fees:          brokerage=[${spec.brokerageGroups}] cvt=[${spec.cvtGroups}]`);
  console.log(`client/period: ${result.client ?? "—"} / ${result.period ?? "—"}`);
  console.log(
    `trades:        ${result.trades.length}${
      result.totalRecords !== null ? ` of ${result.totalRecords} stated` : ""
    }`,
  );
  console.log(`pattern:       ${spec.rowPattern}`);
  if (spec.notes) console.log(`notes:         ${spec.notes}`);

  for (const trade of result.trades.slice(0, 5)) {
    console.log(
      `  ${trade.tradeDate}  ${trade.side.padEnd(4)} ${trade.security.padEnd(7)} ` +
        `${String(trade.qty).padStart(7)} @ ${trade.rate.toFixed(2).padStart(10)}  ` +
        `gross ${trade.grossAmount.toFixed(2).padStart(12)}  fees ${(trade.brokerage + trade.cvt).toFixed(2).padStart(9)}  ` +
        `net ${trade.netAmount.toFixed(2).padStart(12)}`,
    );
  }
  if (result.trades.length > 5) console.log(`  … and ${result.trades.length - 5} more`);

  for (const e of validation.errors) console.log(`  ERROR   ${e}`);
  for (const w of validation.warnings) console.log(`  warning ${w}`);
  console.log(validation.ok ? "\nVALID — this spec would be saved." : "\nREJECTED — this spec would not be saved.");
  return validation.ok;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npm run try:learn -- path/to/statement.pdf");
    process.exit(2);
  }

  const text = await extractStatementText(readFileSync(path), path);
  console.log(`${path}: ${text.split(/\r?\n/).length} lines, fingerprint ${fingerprintLayout(text)}`);

  for (const { slug, spec } of BUILTIN_PROFILES) {
    const validation = validateRun(runSpec(text, spec), spec);
    if (validation.ok) {
      console.log(`\nRead by the built-in "${slug}" parser — no model needed.`);
      report(spec, text);
      return;
    }
  }

  const backend = aiBackendLabel();
  if (!backend) {
    console.error(
      "\nNo built-in parser reads this, and no learning backend is configured.\n" +
        "Set ANTHROPIC_API_KEY, or AI_BASE_URL + AI_MODEL for a local model.",
    );
    process.exit(1);
  }

  console.log(`\nNo built-in parser reads this. Asking ${backend} to write one…`);
  const started = Date.now();
  try {
    const learned = await learnParser(text, {
      onRejected: ({ attempt, spec, errors, answer }) => {
        const at = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`\n  attempt ${attempt} rejected after ${at}s:`);
        console.log(`    pattern: ${spec?.rowPattern ?? "(spec unusable)"}`);
        if (!spec) console.log(`    answer:  ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
        for (const e of errors) console.log(`    ✗ ${e.slice(0, 220)}`);
      },
    });
    console.log(
      `\nLearned in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
        `attempt ${learned.attempts} of 3, by ${learned.model}.`,
    );
    process.exit(report(learned.spec, text) ? 0 : 1);
  } catch (e) {
    console.error(`\nFailed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
