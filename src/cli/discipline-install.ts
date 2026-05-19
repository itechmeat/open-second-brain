/**
 * `o2b discipline install` / `o2b discipline uninstall` verb handlers.
 *
 * Manages the Hermes cron job that delivers the daily OSB discipline report
 * to a Telegram topic. The real cron config lives at DEFAULT_JOBS_FILE;
 * tests override via the OSB_HERMES_JOBS env var to avoid touching the
 * user's live config.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../core/fs-atomic.ts";

const DEFAULT_JOBS_FILE = "/root/.hermes/cron/jobs.json";

function jobsFilePath(): string {
  return process.env.OSB_HERMES_JOBS ?? DEFAULT_JOBS_FILE;
}

/**
 * Resolve the absolute path to `bin/o2b-discipline-report` from this
 * module's own location instead of hardcoding `/srv/projects/...`. The
 * cron job needs an absolute path because Hermes cron exec's it verbatim;
 * the path the operator running `install` sees is the path the cron will
 * use, so this works for any install root.
 */
function scriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // src/cli
  return resolve(here, "..", "..", "bin", "o2b-discipline-report");
}

function jobId(vault: string): string {
  const slug = createHash("sha256")
    .update(resolve(vault))
    .digest("hex")
    .slice(0, 12);
  return `osb-discipline-report-${slug}`;
}

interface HermesJob {
  id: string;
  name: string;
  [k: string]: unknown;
}

interface JobsFile {
  jobs: HermesJob[];
}

function loadJobs(file: string): JobsFile {
  if (!existsSync(file)) return { jobs: [] };
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `o2b discipline: jobs file is corrupted JSON: ${file}\n` +
      `Original error: ${(e as Error).message}\n` +
      `Resolve manually before re-running install/uninstall.`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { jobs?: unknown }).jobs)
  ) {
    throw new Error(
      `o2b discipline: jobs file is missing the jobs[] array: ${file}`,
    );
  }
  return parsed as JobsFile;
}

function saveJobs(file: string, data: JobsFile): void {
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

function pickVault(args: ReadonlyArray<string>, defaultVault: string): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && i + 1 < args.length) return args[i + 1]!;
  }
  return defaultVault;
}

export async function disciplineInstallVerb(
  args: string[],
  defaultVault: string,
): Promise<number> {
  let vault = pickVault(args, defaultVault);
  let telegramTarget = "";
  let at = "59 4 * * *";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault") {
      // already picked up by pickVault; skip the value
      i++;
      continue;
    }
    if (args[i] === "--telegram-target") {
      telegramTarget = args[++i] ?? "";
      continue;
    }
    if (args[i] === "--at") {
      at = args[++i] ?? at;
      continue;
    }
  }
  if (!vault) {
    process.stderr.write("o2b discipline install: --vault is required\n");
    return 2;
  }
  if (!telegramTarget) {
    // Refuse to bake a default chat id into the cron entry — that would
    // ship a private chat target with the open-source release. The
    // operator must name their own Telegram destination explicitly.
    process.stderr.write(
      "o2b discipline install: --telegram-target is required " +
        "(e.g. --telegram-target telegram:-100<chat_id>:<topic_id>)\n",
    );
    return 2;
  }
  const file = jobsFilePath();
  const data = loadJobs(file);
  const id = jobId(vault);
  const existing = data.jobs.find((j) => j.id === id);
  const next: HermesJob = {
    id,
    name: "osb-discipline-report",
    script: scriptPath(),
    no_agent: true,
    schedule: { kind: "cron", expr: at, display: at },
    deliver: telegramTarget,
    enabled: true,
  };
  if (existing) {
    Object.assign(existing, next);
  } else {
    data.jobs.push(next);
  }
  saveJobs(file, data);
  process.stdout.write(
    `o2b discipline: job '${id}' ${existing ? "updated" : "created"} (schedule: ${at}, deliver: ${telegramTarget})\n`,
  );
  return 0;
}

export async function disciplineUninstallVerb(
  args: string[],
  defaultVault: string,
): Promise<number> {
  const vault = pickVault(args, defaultVault);
  if (!vault) {
    process.stderr.write(
      "o2b discipline uninstall: --vault is required\n",
    );
    return 2;
  }
  const file = jobsFilePath();
  const data = loadJobs(file);
  const id = jobId(vault);
  const before = data.jobs.length;
  data.jobs = data.jobs.filter((j) => j.id !== id);
  saveJobs(file, data);
  const removed = before - data.jobs.length;
  process.stdout.write(
    `o2b discipline: ${removed > 0 ? "removed" : "no-op"} (job '${id}')\n`,
  );
  return 0;
}
