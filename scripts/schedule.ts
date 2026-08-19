/**
 * Install, inspect and remove the unattended schedule.
 *
 *   npm run schedule                     what would run, how often, and what is installed
 *   npm run schedule -- --print          the launchd plists, to stdout
 *   npm run schedule -- --crontab        the same schedule as crontab lines
 *   npm run schedule -- --install        write the agents and load them
 *   npm run schedule -- --uninstall      unload and remove them
 *   npm run schedule -- --run=news-refresh    run one job now, through launchd
 *
 * The job table and every line of rendered text live in `src/lib/schedule.ts`,
 * under `npm run check:schedule`. This file is only the part that touches the
 * machine, and it is deliberately the smaller half.
 *
 * `--install` writes into `~/Library/LaunchAgents` and loads the agents, which
 * outlives the terminal that ran it — so it is opt-in, never a side effect of
 * running the command with no arguments.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JOBS,
  commandFor,
  crontabFor,
  describeCadence,
  jobById,
  labelFor,
  logPathFor,
  plistFor,
  type Job,
  type RenderOptions,
} from "@/lib/schedule";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(REPO_DIR, "logs");
const AGENT_DIR = join(homedir(), "Library", "LaunchAgents");
const OPTS: RenderOptions = { repoDir: REPO_DIR, logDir: LOG_DIR };

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function agentPath(job: Job): string {
  return join(AGENT_DIR, `${labelFor(job)}.plist`);
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message).trim() };
  }
}

function isLoaded(job: Job): boolean {
  return launchctl(["print", `${domain()}/${labelFor(job)}`]).ok;
}

function requireMac(action: string): void {
  if (process.platform === "darwin") return;
  console.error(
    `${action} installs launchd agents, which is macOS only.\n` +
      `On another machine use --crontab, but read the note in src/lib/schedule.ts first:\n` +
      `cron silently skips whatever was due while the machine was asleep, which is\n` +
      `exactly what would happen to the weekly insight.`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------- actions */

function status(): void {
  console.log(`Repo   ${REPO_DIR}`);
  console.log(`Logs   ${LOG_DIR}`);
  console.log(`Agents ${AGENT_DIR}\n`);

  const mac = process.platform === "darwin";
  for (const job of JOBS) {
    const installed = existsSync(agentPath(job));
    const loaded = mac && installed && isLoaded(job);
    const state = !installed ? "not installed" : loaded ? "loaded" : "installed, not loaded";
    console.log(`${job.id}  [${state}]`);
    console.log(`  ${job.summary}`);
    console.log(`  ${describeCadence(job.cadence)} — ${job.why}`);
    console.log(`  ${job.steps.map((s) => `npm run ${s}`).join(" && ")}`);
    const log = logPathFor(job, LOG_DIR);
    if (existsSync(log)) {
      const lines = readFileSync(log, "utf8").trimEnd().split("\n");
      if (lines[0]) console.log(`  last log: ${lines[lines.length - 1].slice(0, 100)}`);
    }
    console.log();
  }

  if (!JOBS.some((j) => existsSync(agentPath(j)))) {
    console.log("Nothing is scheduled. Install with:  npm run schedule -- --install");
  }
}

function print(): void {
  const only = value("print");
  for (const job of JOBS) {
    if (only && job.id !== only) continue;
    console.log(`==> ${agentPath(job)}`);
    console.log(plistFor(job, OPTS));
  }
}

function crontab(): void {
  console.log(`# ${JOBS.length} jobs for the psxPM schedule. Append to \`crontab -e\`.`);
  console.log(`# Read src/lib/schedule.ts first: cron does not run what it slept through.`);
  console.log(`# Ensure PATH includes node/npm — cron's is barer than a login shell's.`);
  for (const job of JOBS) {
    const line = crontabFor(job, OPTS);
    console.log(`\n# ${job.summary} — ${describeCadence(job.cadence)}`);
    console.log(line ?? `# (${describeCadence(job.cadence)} is not expressible in cron)`);
  }
}

function install(): void {
  requireMac("--install");
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(AGENT_DIR, { recursive: true });

  for (const job of JOBS) {
    const path = agentPath(job);
    const label = labelFor(job);
    // Replace rather than reload: a plist edited in place is not re-read, and a
    // job left loaded from the old file is the hardest kind of stale to notice.
    if (isLoaded(job)) launchctl(["bootout", `${domain()}/${label}`]);
    writeFileSync(path, plistFor(job, OPTS), "utf8");
    const res = launchctl(["bootstrap", domain(), path]);
    console.log(`${res.ok ? "loaded  " : "FAILED  "}${label}  (${describeCadence(job.cadence)})`);
    if (!res.ok) console.error(`         ${res.out}`);
  }
  console.log(`\nLogs will appear in ${LOG_DIR}. Check state with:  npm run schedule`);
}

function uninstall(): void {
  requireMac("--uninstall");
  for (const job of JOBS) {
    const path = agentPath(job);
    const label = labelFor(job);
    if (isLoaded(job)) launchctl(["bootout", `${domain()}/${label}`]);
    if (existsSync(path)) rmSync(path);
    console.log(`removed  ${label}`);
  }
  console.log(`\nLogs left in place at ${LOG_DIR}.`);
}

function runNow(id: string): void {
  requireMac("--run");
  const job = jobById(id);
  if (!job) {
    console.error(`Unknown job "${id}". Known: ${JOBS.map((j) => j.id).join(", ")}`);
    process.exit(1);
  }
  if (!existsSync(agentPath(job))) {
    console.error(`${job.id} is not installed. Run it directly instead:\n  ${commandFor(job, REPO_DIR)}`);
    process.exit(1);
  }
  const res = launchctl(["kickstart", "-k", `${domain()}/${labelFor(job)}`]);
  console.log(res.ok ? `started ${job.id} — output in ${logPathFor(job, LOG_DIR)}` : res.out);
  if (!res.ok) process.exit(1);
}

/* ----------------------------------------------------------------------- run */

function main(): void {
  const run = value("run");
  if (run !== undefined) return runNow(run);
  if (flag("install")) return install();
  if (flag("uninstall")) return uninstall();
  if (flag("crontab")) return crontab();
  if (flag("print") || value("print") !== undefined) return print();
  status();
}

main();
