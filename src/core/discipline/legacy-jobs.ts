import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_PREFIXES = ["osb-discipline-report-", "osb-weekly-brain-digest-"];

export interface LegacyDisciplineJobs {
  readonly file: string;
  readonly ids: ReadonlyArray<string>;
}

/** Find old Open Second Brain jobs without changing Hermes state. */
export function findLegacyDisciplineJobs(): LegacyDisciplineJobs | null {
  const home = process.env["HERMES_HOME"] || join(homedir(), ".hermes");
  const file = process.env["OSB_HERMES_JOBS"] || join(home, "cron", "jobs.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const jobs = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { jobs?: unknown }).jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : [];
    const ids = jobs.flatMap((job) => {
      if (typeof job !== "object" || job === null) return [];
      const id = (job as { id?: unknown }).id;
      return typeof id === "string" && LEGACY_PREFIXES.some((prefix) => id.startsWith(prefix))
        ? [id]
        : [];
    });
    return ids.length > 0 ? { file, ids } : null;
  } catch {
    return null;
  }
}
