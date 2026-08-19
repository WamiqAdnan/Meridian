/**
 * Standalone checks for the unattended schedule.
 *
 * Run: npm run check:schedule
 *
 * No network, no database, and nothing is installed — this renders the same text
 * `scripts/schedule.ts` would write and reads it back.
 *
 * Three properties earn the file. The cadences must stay tied to the staleness
 * windows they exist to stay ahead of, or the schedule quietly stops covering the
 * gap it was built for. The rendered plist must be well-formed XML, because every
 * command in it contains `&&` and launchd's response to a malformed plist is to
 * refuse the job with nothing in the log. And every step must name an npm script
 * that still exists, because renaming one is otherwise a silent break that shows
 * up as data going stale a week later.
 */
import { readFileSync } from "node:fs";
import { QUOTE_TTL_MS } from "@/lib/markets/refresh";
import { NEWS_TTL_MS } from "@/lib/news/ingest";
import {
  JOBS,
  LABEL_PREFIX,
  MONDAY,
  commandFor,
  crontabFor,
  describeCadence,
  jobById,
  labelFor,
  logPathFor,
  plistFor,
  shellQuote,
  xmlEscape,
  type Cadence,
  type Job,
} from "@/lib/schedule";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: string) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function has(label: string, haystack: string, needle: string) {
  ok(label, haystack.includes(needle), `missing ${JSON.stringify(needle)}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

/** A path with both a space and an apostrophe in it — neither is hypothetical on a Mac. */
const REPO = "/Users/sam/Desktop/it's mine/psxPM";
const LOGS = `${REPO}/logs`;
const OPTS = { repoDir: REPO, logDir: LOGS } as const;

/* ------------------------------------------------------------------ the table */

function checkTable() {
  section("The job table");

  ok("there are jobs", JOBS.length > 0);
  eq("ids are unique", new Set(JOBS.map((j) => j.id)).size, JOBS.length);
  eq("labels are unique", new Set(JOBS.map(labelFor)).size, JOBS.length);
  eq("log paths are unique", new Set(JOBS.map((j) => logPathFor(j, LOGS))).size, JOBS.length);

  for (const job of JOBS) {
    ok(`${job.id}: id is a safe filename and label component`, /^[a-z0-9]+(-[a-z0-9]+)*$/.test(job.id), job.id);
    ok(`${job.id}: has at least one step`, job.steps.length > 0);
    ok(`${job.id}: says why it runs at that cadence`, job.why.trim().length > 0);
    has(`${job.id}: label is namespaced`, labelFor(job), `${LABEL_PREFIX}.`);
  }

  eq("a job can be looked up by id", jobById("market-refresh")?.id, "market-refresh");
  eq("an unknown id resolves to nothing", jobById("nope"), undefined);
}

/**
 * The drift guard.
 *
 * These two intervals are not numbers chosen to sit near the TTLs; they are the
 * TTLs. If someone widens `QUOTE_TTL_MS` and the installed job keeps firing every
 * five minutes, the schedule still looks healthy while doing more work than it
 * needs to — and if someone narrows it, every visitor pays for a fetch again.
 */
function checkCadencesFollowTheTtls() {
  section("Cadence follows the staleness window");

  const quotes = jobById("market-refresh")!;
  ok("quotes refresh on an interval", quotes.cadence.kind === "interval");
  if (quotes.cadence.kind === "interval") {
    eq("…and that interval is QUOTE_TTL_MS", quotes.cadence.seconds, QUOTE_TTL_MS / 1000);
  }

  const news = jobById("news-refresh")!;
  ok("news refreshes on an interval", news.cadence.kind === "interval");
  if (news.cadence.kind === "interval") {
    eq("…and that interval is NEWS_TTL_MS", news.cadence.seconds, NEWS_TTL_MS / 1000);
  }

  const backfill = jobById("market-backfill")!;
  eq("the backfill is daily", backfill.cadence.kind, "daily");

  const weekly = jobById("insights-weekly")!;
  eq("insights are weekly", weekly.cadence.kind, "weekly");
  if (weekly.cadence.kind === "weekly") {
    eq("…on Monday", weekly.cadence.weekday, MONDAY);
    eq("…in the morning", weekly.cadence.hour, 8);
  }
}

/**
 * The ordering guarantee, asserted rather than described.
 *
 * An insight generated before the week's bars and headlines have landed is not a
 * late insight, it is a wrong one — `hasSomethingToExplain()` reads whatever is in
 * the database at the moment it is called.
 */
function checkInsightChain() {
  section("The weekly chain");

  const weekly = jobById("insights-weekly")!;
  const generateAt = weekly.steps.findIndex((s) => s.startsWith("insights:generate"));
  const backfillAt = weekly.steps.findIndex((s) => s.startsWith("market:backfill"));
  const newsAt = weekly.steps.findIndex((s) => s.startsWith("news:refresh"));

  ok("the week's insights are generated", generateAt >= 0);
  ok("bars are backfilled first", backfillAt >= 0 && backfillAt < generateAt);
  ok("news is refreshed first", newsAt >= 0 && newsAt < generateAt);
  has("the generation prunes old weeks in the same call", weekly.steps[generateAt], "--prune=26");

  const command = commandFor(weekly, REPO);
  eq(
    "steps are chained with && so a failed step stops the run",
    command.split(" && ").length,
    weekly.steps.length + 1, // + the leading cd
  );
  ok("no step is chained with a bare ; ", !command.includes(";"), command);
}

/** A renamed npm script would otherwise show up as data quietly going stale. */
function checkStepsExist() {
  section("Every step names a real npm script");

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  for (const job of JOBS) {
    for (const step of job.steps) {
      const script = step.split(" -- ")[0].trim();
      ok(`${job.id}: "${script}" is in package.json`, script in pkg.scripts);
    }
  }
}

/* ------------------------------------------------------------------ rendering */

function checkQuoting() {
  section("Shell quoting");

  eq("a plain path is quoted", shellQuote("/tmp/x"), "'/tmp/x'");
  eq("a space is contained", shellQuote("/a b/c"), "'/a b/c'");
  eq("an apostrophe is escaped out and back in", shellQuote("it's"), `'it'\\''s'`);
  eq("a double quote needs nothing", shellQuote(`say "hi"`), `'say "hi"'`);

  const command = commandFor(JOBS[0], REPO);
  has("the command cds into the repo first", command, `cd '/Users/sam/Desktop/it'\\''s mine/psxPM' &&`);
  has("…and runs the step through npm", command, "npm run market:refresh");
}

function checkXmlEscape() {
  section("XML escaping");

  eq("ampersands escape", xmlEscape("a && b"), "a &amp;&amp; b");
  eq("angle brackets escape", xmlEscape("<x>"), "&lt;x&gt;");
  eq("an already-escaped entity is not double-escaped into nonsense", xmlEscape("&amp;"), "&amp;amp;");
  eq("plain text is untouched", xmlEscape("npm run market:refresh"), "npm run market:refresh");
}

/**
 * Enough of an XML check to catch the failure that actually happens: a raw `&`
 * from an unescaped `&&`, or an unbalanced tag from a bad edit. launchd rejects
 * either one silently.
 */
function wellFormed(xml: string): string | null {
  const bare = xml.replace(/&(amp|lt|gt|quot|apos);/g, "");
  if (bare.includes("&")) return "contains an unescaped &";
  const stack: string[] = [];
  const tag = /<\/?([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const [whole, name, , selfClose] = m;
    if (whole.startsWith("<?") || whole.startsWith("<!")) continue;
    if (selfClose === "/") continue;
    if (whole.startsWith("</")) {
      if (stack.pop() !== name) return `closing </${name}> does not match`;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0 ? null : `unclosed <${stack[stack.length - 1]}>`;
}

function checkPlist() {
  section("launchd plists");

  for (const job of JOBS) {
    const xml = plistFor(job, OPTS);
    eq(`${job.id}: well-formed`, wellFormed(xml), null);
    has(`${job.id}: carries its label`, xml, `<string>${labelFor(job)}</string>`);
    has(`${job.id}: runs through a login shell`, xml, "<string>-lc</string>");
    has(`${job.id}: logs stdout and stderr to one file`, xml, logPathFor(job, LOGS));
    has(`${job.id}: is a background job`, xml, "<string>Background</string>");
    has(`${job.id}: names the working directory`, xml, "<key>WorkingDirectory</key>");
    ok(`${job.id}: the && in its command is escaped`, xml.includes("&amp;&amp;"), "raw && would not parse");
    ok(`${job.id}: no raw && survives`, !xml.includes("&&"));

    const interval = job.cadence.kind === "interval";
    ok(
      `${job.id}: ${interval ? "starts at load" : "does not fire on every login"}`,
      xml.includes(`<key>RunAtLoad</key>\n  <${interval ? "true" : "false"}/>`),
    );
    if (interval) {
      has(`${job.id}: uses StartInterval`, xml, `<key>StartInterval</key>\n  <integer>${job.cadence.seconds}</integer>`);
      ok(`${job.id}: no calendar entry`, !xml.includes("StartCalendarInterval"));
    } else {
      has(`${job.id}: uses StartCalendarInterval`, xml, "<key>StartCalendarInterval</key>");
      ok(`${job.id}: no interval entry`, !xml.includes("<key>StartInterval</key>"));
    }
  }

  const weekly = plistFor(jobById("insights-weekly")!, OPTS);
  has("the weekly job pins a weekday", weekly, `<key>Weekday</key>\n    <integer>${MONDAY}</integer>`);
  const daily = plistFor(jobById("market-backfill")!, OPTS);
  ok("a daily job pins no weekday", !daily.includes("<key>Weekday</key>"));
  has("a daily job pins the hour", daily, "<key>Hour</key>\n    <integer>6</integer>");

  const quoted = plistFor(JOBS[0], { ...OPTS, shell: "/bin/bash" });
  has("the shell is configurable", quoted, "<string>/bin/bash</string>");
}

/** The five time fields, without the command that follows them. */
function cronSpecOf(line: string | null): string | null {
  return line === null ? null : line.split(" ").slice(0, 5).join(" ");
}

function checkCrontab() {
  section("crontab rendering");

  eq("a five-minute job", cronSpecOf(crontabFor(jobById("market-refresh")!, OPTS)), "*/5 * * * *");
  eq("a thirty-minute job", cronSpecOf(crontabFor(jobById("news-refresh")!, OPTS)), "*/30 * * * *");
  eq("a daily job", cronSpecOf(crontabFor(jobById("market-backfill")!, OPTS)), "0 6 * * *");
  eq("a weekly job names Monday", cronSpecOf(crontabFor(jobById("insights-weekly")!, OPTS)), "0 8 * * 1");

  for (const job of JOBS) {
    const line = crontabFor(job, OPTS);
    ok(`${job.id}: cron is expressible`, line !== null, describeCadence(job.cadence));
    if (line) {
      has(`${job.id}: appends to its log`, line, `>> ${logPathFor(job, LOGS)} 2>&1`);
      has(`${job.id}: runs the same command as launchd`, line, commandFor(job, REPO));
    }
  }

  // The honest refusal: cron's grain is a minute, and a step only means "every n"
  // when n divides the hour.
  const odd = (seconds: number): Job => ({
    ...JOBS[0],
    cadence: { kind: "interval", seconds } as Cadence,
  });
  eq("90 seconds is not a cron cadence", crontabFor(odd(90), OPTS), null);
  eq("7 minutes does not divide the hour", crontabFor(odd(7 * 60), OPTS), null);
  eq("every minute is fine", cronSpecOf(crontabFor(odd(60), OPTS)), "* * * * *");
  eq("an hour is not a step field", crontabFor(odd(3600), OPTS), null);
}

function checkDescriptions() {
  section("Human descriptions");

  eq("an interval reads in minutes", describeCadence({ kind: "interval", seconds: 300 }), "every 5 minutes");
  eq("one minute is singular", describeCadence({ kind: "interval", seconds: 60 }), "every 1 minute");
  eq("a sub-minute interval keeps its seconds", describeCadence({ kind: "interval", seconds: 45 }), "every 45s");
  eq("a daily job pads its clock", describeCadence({ kind: "daily", hour: 6, minute: 0 }), "daily at 06:00");
  eq(
    "a weekly job names its day",
    describeCadence({ kind: "weekly", weekday: MONDAY, hour: 8, minute: 0 }),
    "Monday at 08:00",
  );
}

/* --------------------------------------------------------------------- run */

function main() {
  checkTable();
  checkCadencesFollowTheTtls();
  checkInsightChain();
  checkStepsExist();
  checkQuoting();
  checkXmlEscape();
  checkPlist();
  checkCrontab();
  checkDescriptions();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
