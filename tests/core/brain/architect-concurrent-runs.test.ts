/**
 * Two architect runs on one repo, driven by genuinely concurrent
 * processes (finding C5 of the locks-and-races review).
 *
 * `generateArchDocs` takes `<vault>/Brain/projects/arch/<key>.lock` across
 * the whole plan-then-write pass, because planning is a read of every note
 * on disk and writing is a rewrite of the same notes. A lock that starts
 * after the read does not prevent a lost update - and the file's existing
 * lock test cannot see the difference: it samples `existsSync(lock)` from
 * the `advanced` events, and every one of those is emitted from the write
 * loop, which runs after all planning either way.
 *
 * WHY THE TALLY IS THE INSTRUMENT, AND NOT THE BYTES. One run's output is
 * a pure function of the scanned facts plus the prose already outside each
 * note's regions. Two runs on one repo therefore compute the same bytes,
 * so whichever writes last leaves the same file whether it read the
 * other's output or the state before it - the bytes cannot tell the two
 * interleavings apart. What CAN is `created`/`updated`/`unchanged`: those
 * counts are the verdict of the read, they are in the CLI's JSON envelope,
 * and they are only true if the read that produced them is inside the same
 * critical section as the write. Under the lock, exactly one of N
 * concurrent runs may report that it created a note; the rest must report
 * finding it already correct. With the lock moved to cover only the
 * writes, every run claims to have created the same file.
 *
 * Real `bun` children behind a wall-clock barrier, the discipline of
 * `tests/core/brain/ingest/concurrent-shared-writes.test.ts`: process
 * startup alone staggers three processes by more than a plan takes, which
 * would serialize them by accident and pass against the defect.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";
import { repoKey } from "../../../src/core/brain/git/identity.ts";

/** Enough notes that one run's write loop outlasts another run's plan. */
const MODULES = 40;
const FILES_PER_MODULE = 3;
/** One overview plus one note per module. */
const NOTE_COUNT = MODULES + 1;

const RUNNERS = 3;
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * Milliseconds the children wait before starting work. `bun` startup alone
 * staggers three processes by more than a plan pass takes, which would
 * serialize them by accident; the barrier makes the overlap real.
 */
const BARRIER_LEAD_MS = 1_500;

const GENERATE = join(import.meta.dir, "../../../src/core/brain/architect/generate.ts");

let tmp: string;
let project: string;
let vault: string;
let archDir: string;

function seedProject(): void {
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "race-app", version: "0.0.1" }),
  );
  for (let m = 0; m < MODULES; m += 1) {
    const name = `m${String(m).padStart(2, "0")}`;
    const dir = join(project, "src", name);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_MODULE; f += 1) {
      writeFileSync(join(dir, `f${f}.ts`), `// ${name} ${f}\n`, "utf8");
    }
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-race-"));
  project = join(tmp, "race-app");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  seedProject();
  archDir = join(vault, "Brain", "projects", "arch", repoKey(project));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** What one child run reported about the disk it found. */
interface RunReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

/** Run `RUNNERS` copies of one architect run, released together. */
async function raceRuns(scriptName: string): Promise<ReadonlyArray<RunReport>> {
  const script = join(tmp, scriptName);
  writeFileSync(
    script,
    [
      // Imported BEFORE the barrier: module graph load is exactly the
      // startup stagger the barrier exists to absorb.
      `const { generateArchDocs } = await import(${JSON.stringify(GENERATE)});`,
      "const [vaultArg, projectArg, startAt] = process.argv.slice(2);",
      "while (Date.now() < Number(startAt)) Bun.sleepSync(1);",
      "const res = generateArchDocs(vaultArg, projectArg);",
      "process.stdout.write(JSON.stringify({",
      "  created: res.created, updated: res.updated, unchanged: res.unchanged,",
      "}));",
    ].join("\n"),
    "utf8",
  );
  const startAt = String(Date.now() + BARRIER_LEAD_MS);
  const procs = Array.from({ length: RUNNERS }, () =>
    Bun.spawn(["bun", script, vault, project, startAt], { stdout: "pipe", stderr: "pipe" }),
  );
  const reports: RunReport[] = [];
  const failures: string[] = [];
  await Promise.all(
    procs.map(async (proc) => {
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) {
        failures.push(`exit ${code}: ${err.trim()}`);
        return;
      }
      reports.push(JSON.parse(out) as RunReport);
    }),
  );
  expect(failures).toEqual([]);
  return reports;
}

/** Reports that claim the run changed something, and the ones that do not. */
function split(reports: ReadonlyArray<RunReport>): {
  readonly acting: ReadonlyArray<RunReport>;
  readonly observing: ReadonlyArray<RunReport>;
} {
  return {
    acting: reports.filter((r) => r.created + r.updated > 0),
    observing: reports.filter((r) => r.created + r.updated === 0),
  };
}

describe("concurrent architect runs on one repo", () => {
  test(
    "only one of three simultaneous first runs may report creating the notes",
    async () => {
      const reports = await raceRuns("first-run-racer.ts");

      // The winner of the lock finds an empty tree; the two that queue
      // behind it must find the tree it left, note for note.
      expect(split(reports).acting).toEqual([{ created: NOTE_COUNT, updated: 0, unchanged: 0 }]);
      expect(split(reports).observing).toEqual([
        { created: 0, updated: 0, unchanged: NOTE_COUNT },
        { created: 0, updated: 0, unchanged: NOTE_COUNT },
      ]);
      expect(existsSync(`${archDir}.lock`)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "only one of three simultaneous re-runs may report refreshing the notes",
    async () => {
      // The read-modify-write shape proper: every note already exists, so
      // each run's plan is a `readFileSync` plus a `mergeRegions` of what
      // it read. Three runs that all read the same "before" state all
      // decide the same three notes need rewriting.
      const first = generateArchDocs(vault, project);
      expect(first.created).toBe(NOTE_COUNT);

      // One module gains a file and a new module appears: overview.md and
      // m00.md change, znew.md is new, the other 39 notes are already right.
      writeFileSync(join(project, "src", "m00", "extra.ts"), "// extra\n", "utf8");
      mkdirSync(join(project, "src", "znew"), { recursive: true });
      writeFileSync(join(project, "src", "znew", "a.ts"), "// new\n", "utf8");

      const reports = await raceRuns("rerun-racer.ts");

      expect(split(reports).acting).toEqual([
        { created: 1, updated: 2, unchanged: NOTE_COUNT - 2 },
      ]);
      expect(split(reports).observing).toEqual([
        { created: 0, updated: 0, unchanged: NOTE_COUNT + 1 },
        { created: 0, updated: 0, unchanged: NOTE_COUNT + 1 },
      ]);
      expect(existsSync(`${archDir}.lock`)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});
