/**
 * `o2b discipline install` / `o2b discipline uninstall` verb handlers.
 *
 * Manages the Hermes cron job that delivers the daily Open Second Brain
 * discipline report to a Telegram topic. The real cron config is the
 * Hermes jobs file under the home directory of the user running the verb
 * (see {@link resolveJobsFilePath}); OSB_HERMES_JOBS names another file,
 * which is also how tests avoid touching the user's live config.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../core/fs-atomic.ts";

/** Env var that names the jobs file explicitly. */
const JOBS_FILE_ENV = "OSB_HERMES_JOBS";

/** Where Hermes keeps its cron jobs, relative to the home directory. */
const JOBS_FILE_SEGMENTS = Object.freeze([".hermes", "cron", "jobs.json"]);

/** No home directory and no override: there is no jobs file to name. */
export class HermesJobsPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesJobsPathError";
  }
}

/**
 * The Hermes jobs file this verb reads and writes: `OSB_HERMES_JOBS` when
 * set and non-empty, otherwise `~/.hermes/cron/jobs.json` of the running
 * user. The default used to be the root user's file whatever the user,
 * so on a non-root Hermes host install wrote where Hermes never reads (or
 * failed on permissions). Root hosts resolve to the same path as before.
 * An empty home with no override is a named error rather than a relative
 * `.hermes/...` path written into whatever directory the verb ran in.
 */
export function resolveJobsFilePath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env[JOBS_FILE_ENV];
  if (override !== undefined && override !== "") return override;
  if (home === "") {
    throw new HermesJobsPathError(
      "o2b discipline: cannot resolve the home directory to find the Hermes jobs file; " +
        "set " +
        JOBS_FILE_ENV +
        " to its path",
    );
  }
  return join(home, ...JOBS_FILE_SEGMENTS);
}

/**
 * The jobs file for this process, or `null` after naming on stderr why it
 * cannot be resolved.
 */
function jobsFilePathOrReport(): string | null {
  try {
    return resolveJobsFilePath(process.env, homedir());
  } catch (err) {
    if (!(err instanceof HermesJobsPathError)) throw err;
    process.stderr.write(err.message + "\n");
    return null;
  }
}

/** Exit when the jobs file cannot be located: an environment problem, not argv. */
const EXIT_JOBS_PATH_UNRESOLVED = 1;

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
  const slug = createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 12);
  return `osb-discipline-report-${slug}`;
}

function weeklyJobId(vault: string): string {
  const slug = createHash("sha256")
    .update(resolve(vault) + ":weekly")
    .digest("hex")
    .slice(0, 12);
  return `osb-weekly-brain-digest-${slug}`;
}

function weeklyScriptPath(vault: string): string {
  const escaped = vault.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  return scriptPath() + " --window 7d --vault '" + escaped + "'";
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
      { cause: e },
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { jobs?: unknown }).jobs)
  ) {
    throw new Error(`o2b discipline: jobs file is missing the jobs[] array: ${file}`);
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

export async function disciplineInstallVerb(args: string[], defaultVault: string): Promise<number> {
  let vault = pickVault(args, defaultVault);
  let telegramTarget = "";
  let at = "59 4 * * *";
  let atProvided = false;
  let weekly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault") {
      // already picked up by pickVault; skip the value
      i++;
      continue;
    }
    if (args[i] === "--weekly") {
      weekly = true;
      continue;
    }
    if (args[i] === "--telegram-target") {
      telegramTarget = args[++i] ?? "";
      continue;
    }
    if (args[i] === "--at") {
      at = args[++i] ?? at;
      atProvided = true;
      continue;
    }
  }
  if (weekly && !atProvided) {
    at = "59 8 * * 1";
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
  const file = jobsFilePathOrReport();
  if (file === null) return EXIT_JOBS_PATH_UNRESOLVED;
  const data = loadJobs(file);
  const id = weekly ? weeklyJobId(vault) : jobId(vault);
  const existing = data.jobs.find((j) => j.id === id);
  const next: HermesJob = {
    id,
    name: weekly ? "osb-weekly-brain-digest" : "osb-discipline-report",
    script: weekly ? weeklyScriptPath(vault) : scriptPath(),
    no_agent: true,
    schedule: {
      kind: "cron",
      expr: at,
      display: at,
    },
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
  let vault: string | undefined;
  let weekly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && i + 1 < args.length) {
      vault = args[++i];
    } else if (args[i] === "--weekly") {
      weekly = true;
    }
  }
  vault = vault ?? defaultVault;
  if (!vault) {
    process.stderr.write("o2b discipline uninstall: --vault is required\n");
    return 2;
  }
  const file = jobsFilePathOrReport();
  if (file === null) return EXIT_JOBS_PATH_UNRESOLVED;
  const data = loadJobs(file);
  const ids = weekly ? [weeklyJobId(vault)] : [jobId(vault), weeklyJobId(vault)];
  const before = data.jobs.length;
  data.jobs = data.jobs.filter((j) => !ids.includes(j.id));
  saveJobs(file, data);
  const removed = before - data.jobs.length;
  process.stdout.write(
    `o2b discipline: ${removed > 0 ? "removed" : "no-op"} (job '${ids.join("', '")}')\n`,
  );
  return 0;
}
