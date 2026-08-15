/**
 * The EXECUTION census over the progress spine (nothing-runs-unwatched, U1).
 *
 * `tests/core/architecture/progress-census.test.ts` is a source census: it
 * reads declarations and asserts that a type which accepts a `Safeguard`
 * also accepts a `ProgressSink`. That is the half its author could see,
 * and it is genuinely half. A declared sink proves an options interface
 * has a field; it proves nothing about whether any caller ever passes one,
 * so an operation can declare the whole spine - the field, the counter,
 * the terminator - and still be unreachable from every surface an
 * operator has. That is exactly what `search vector-backfill` was.
 *
 * The obvious repair - "every member of `OPERATION` must have an entry
 * point that can attach a sink" - does not catch it. `vector-backfill`
 * emits under `OPERATION.reindex`, so `o2b search index --progress`
 * satisfies that rule on the operation's behalf while the backfill itself
 * stays dark. The unobservable unit is not an operation. It is an
 * EMITTER: one `progressCounter(` call site.
 *
 * So this census is not a scan. It DRIVES each entry point for real, with
 * progress on, against a fixture, and asserts that records carrying the
 * expected operation and stage actually arrived and that the stream was
 * terminated. Three properties follow, and they are why it is worth the
 * seconds it costs:
 *
 *   1. **No false positives.** A record either reached stderr or it did
 *      not. There is no pattern to match and therefore nothing to match
 *      wrongly.
 *   2. **No syntactic bypass.** The source census has seven known ones
 *      (a stage hoisted into a bare `const`, a `type` alias instead of an
 *      `interface`, a required rather than optional safeguard, a sink
 *      aliased through an indexed access, a heritage clause it cannot
 *      resolve, a counter it cannot recognise as one, a generic
 *      constraint that steers the block matcher). None of them can
 *      change what arrives on a stream.
 *   3. **It tests what the operator gets**, not the shape of a
 *      declaration.
 *
 * The declaration is {@link EMITTERS}: every `progressCounter(` call site
 * in `src/`, named by its file and enclosing function, mapped to the entry
 * point that reaches it and the (operation, stage) witness that proves it
 * ran. The population is enumerated from the source, so a new emitter
 * cannot be added without appearing here - and a call site with no entry
 * point named is a failure, which is the whole point of the file.
 *
 * ## What this census CANNOT see
 *
 *   - **A site the map reaches by the wrong route.** The witness is the
 *     (entry point, operation, stage) triple, so two sites that shared one
 *     would be indistinguishable. That is why {@link uniqueWitnesses}
 *     exists: a duplicate triple is a failure rather than a blind spot.
 *   - **Two emitters inside one function.** The enumeration names a site
 *     by its enclosing top-level `function`, so a second
 *     `progressCounter(` in the same body would collapse onto the same
 *     key. Also a failure, for the same reason.
 *   - **An emitter reached only under conditions the fixture does not
 *     create** - a provider-backed embed batch, a lock contended by a
 *     second process. The fixture drives the DEFAULT path of each verb;
 *     a stage that only opens under load is out of reach here and is
 *     covered by the per-verb tests under `tests/cli/`.
 *   - **Anything about the RATE of the stream.** A record that arrives
 *     only at the very end still counts here; that a run reports while it
 *     is still running is what the per-verb tests assert.
 *   - **A surface that is not the CLI.** The MCP progress transport has
 *     its own tests; an emitter reachable only from there would have to
 *     name an entry point this file can drive, and today none does.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { PROGRESS_KIND } from "../../src/core/brain/progress.ts";
import { OPERATION, type Operation } from "../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { progressRecords } from "../helpers/progress-records.ts";
import { runCli, type RunResult } from "../helpers/run-cli.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");

// ─────────────────────────────────────────────────────────────────────────────
// The population: every `progressCounter(` call site in src/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank every comment body in `source`, preserving length and therefore
 * every offset.
 *
 * A census that matched raw text would count `progressCounter(` inside a
 * docblock as an emitter, and two docblocks in `src/` discuss the counter
 * by name. Blanking rather than deleting keeps the offsets usable for the
 * enclosing-function scan that follows.
 */
function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < source.length) {
        out[i++] = " ";
        out[i++] = " ";
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * A call site's name: `<path under src/>#<enclosing top-level function>`.
 *
 * Deliberately not a line number. A key that moves whenever a comment
 * above it grows is a key nobody maintains, and the function name is what
 * a reader would look the site up by anyway.
 */
const CALL_RE = /\bprogressCounter\s*\(/g;
const FUNCTION_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm;

function enumerateCallSites(): ReadonlyArray<string> {
  const sites: string[] = [];
  for (const file of tsFiles(SRC)) {
    const code = blankComments(readFileSync(file, "utf8"));
    const functions: Array<{ at: number; name: string }> = [];
    FUNCTION_RE.lastIndex = 0;
    for (let m = FUNCTION_RE.exec(code); m !== null; m = FUNCTION_RE.exec(code)) {
      functions.push({ at: m.index, name: m[1]! });
    }
    const rel = relative(SRC, file).split("\\").join("/");
    CALL_RE.lastIndex = 0;
    for (let m = CALL_RE.exec(code); m !== null; m = CALL_RE.exec(code)) {
      // The declaration itself is `export function progressCounter(`; the
      // enclosing-function scan already names it, so it is excluded by
      // name rather than by file - an emitter added inside `progress.ts`
      // must still be declared.
      const enclosing = functions.findLast((f) => f.at < m!.index);
      if (enclosing === undefined) {
        sites.push(`${rel}#<top-level@${code.slice(0, m.index).split("\n").length}>`);
        continue;
      }
      if (enclosing.name === "progressCounter") continue;
      sites.push(`${rel}#${enclosing.name}`);
    }
  }
  return sites;
}

// ─────────────────────────────────────────────────────────────────────────────
// The declaration
// ─────────────────────────────────────────────────────────────────────────────

interface EmitterSite {
  /** The entry point that reaches this call site, as an operator types it. */
  readonly entryPoint: string;
  /** The operation every record from this counter names. */
  readonly operation: Operation;
  /**
   * A stage THIS counter opens that no other counter opens on the same
   * entry point's stream. It is the discriminator: `search reindex` also
   * emits `walk`, but it does so through the counter `reindexVault` owns
   * and lends, so `lock` is what proves that counter ran.
   */
  readonly stage: string;
}

const EMITTERS: Readonly<Record<string, EmitterSite>> = Object.freeze({
  "core/brain/architect/scan.ts#scanProject": {
    entryPoint: "o2b brain architect --progress",
    operation: OPERATION.architect,
    stage: "walk",
  },
  "core/brain/architect/generate.ts#generateArchDocs": {
    entryPoint: "o2b brain architect --progress",
    operation: OPERATION.architect,
    stage: "render",
  },
  "core/brain/dream.ts#dream": {
    entryPoint: "o2b brain dream --progress",
    operation: OPERATION.dream,
    stage: "scan",
  },
  "core/brain/link-graph/bridge-discovery.ts#discoverBridges": {
    entryPoint: "o2b brain bridges discover --progress",
    operation: OPERATION.bridges,
    stage: "candidates",
  },
  "core/brain/link-graph/communities.ts#detectCommunities": {
    entryPoint: "o2b brain clusters run --progress",
    operation: OPERATION.clusters,
    stage: "sweep",
  },
  "core/search/indexer.ts#indexInto": {
    entryPoint: "o2b search index --progress",
    operation: OPERATION.reindex,
    stage: "walk",
  },
  "core/search/indexer.ts#reindexVault": {
    entryPoint: "o2b search reindex --progress",
    operation: OPERATION.reindex,
    stage: "lock",
  },
  "core/search/vector-backfill.ts#planVectorBackfill": {
    entryPoint: "o2b search vector-backfill --progress",
    operation: OPERATION.reindex,
    stage: "plan",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The fixtures and the drivers
// ─────────────────────────────────────────────────────────────────────────────

let tmp: string;
/** Indexed, interlinked: serves index, reindex, vector-backfill, bridges, clusters. */
let searchVault: string;
/** Bootstrapped with signals to consolidate. */
let dreamVault: string;
let dreamConfig: string;
/** A tiny project tree plus the vault its notes are written into. */
let archProject: string;
let archVault: string;

/**
 * One run of one entry point, with `--progress` on.
 *
 * Every driver is a single in-process CLI invocation, which is what keeps
 * this census cheap enough to leave in the default suite: `runCli`
 * imports `main()` once rather than spawning `bun run` per call.
 */
const ENTRY_POINTS: Readonly<Record<string, () => Promise<RunResult>>> = Object.freeze({
  "o2b search index --progress": () =>
    runCli(["search", "index", "--vault", searchVault, "--progress"]),
  "o2b search reindex --progress": () =>
    runCli(["search", "reindex", "--vault", searchVault, "--progress"]),
  "o2b search vector-backfill --progress": () =>
    runCli(["search", "vector-backfill", "--vault", searchVault, "--progress"]),
  "o2b brain bridges discover --progress": () =>
    runCli(["brain", "bridges", "discover", "--vault", searchVault, "--progress"]),
  "o2b brain clusters run --progress": () =>
    runCli(["brain", "clusters", "run", "--vault", searchVault, "--progress"]),
  "o2b brain dream --progress": () =>
    runCli(["brain", "dream", "--dry-run", "--progress"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: dreamConfig },
    }),
  "o2b brain architect --progress": () =>
    runCli(["brain", "architect", archProject, "--vault", archVault, "--progress"]),
});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-progress-emitter-census-"));

  searchVault = join(tmp, "search-vault");
  mkdirSync(join(searchVault, "Brain"), { recursive: true });
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(searchVault, `${name}.md`), `# ${name}\n\nCanary rollout. See ${others}.\n`);
  }
  // Built through the CLI rather than through `indexVault` directly, so
  // every driver below sees the index the shipped verb would have left.
  const seeded = await runCli(["search", "index", "--vault", searchVault]);
  expect(seeded.returncode).toBe(0);

  dreamVault = join(tmp, "dream-vault");
  mkdirSync(dreamVault, { recursive: true });
  dreamConfig = join(tmp, "dream-config.yaml");
  atomicWriteFileSync(dreamConfig, `vault: ${dreamVault}\n`);
  bootstrapBrain(dreamVault, { configPath: dreamConfig });
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(dreamVault, {
      topic: "census-progress",
      signal: "positive",
      agent: "claude",
      principle: "Prefer the census-progress approach",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `census-progress-${i}`,
      scope: "writing",
    });
  }

  archProject = join(tmp, "demo-app");
  mkdirSync(join(archProject, "src", "core"), { recursive: true });
  writeFileSync(join(archProject, "package.json"), JSON.stringify({ name: "demo-app" }));
  writeFileSync(join(archProject, "src", "core", "engine.ts"), "// x\n");
  archVault = join(tmp, "arch-vault");
  mkdirSync(join(archVault, "Brain"), { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The witness triple, as one string, for the uniqueness rule. */
function uniqueWitnesses(): ReadonlyArray<string> {
  return Object.values(EMITTERS).map((s) => `${s.entryPoint}|${s.operation}|${s.stage}`);
}

/** First non-empty line of a stream, for a failure message. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "(no output)";
}

describe("progress emitter census", () => {
  test("every progressCounter call site in src/ is declared, exactly once", () => {
    const found = enumerateCallSites();
    // A second emitter in one function collapses onto one key, and the
    // census would then prove one of them and vouch for both.
    expect(found.toSorted()).toEqual([...new Set(found)].toSorted());
    expect(found.toSorted()).toEqual(Object.keys(EMITTERS).toSorted());
  });

  test("every declared entry point is drivable, and every driver is claimed", () => {
    const drivable = new Set(Object.keys(ENTRY_POINTS));
    for (const [site, decl] of Object.entries(EMITTERS)) {
      expect(`${site} -> ${decl.entryPoint} drivable: ${drivable.has(decl.entryPoint)}`).toBe(
        `${site} -> ${decl.entryPoint} drivable: true`,
      );
    }
    // No declared surface with no producer: an entry point nothing claims
    // is a driver that proves nothing and costs a CLI run.
    const claimed = new Set(Object.values(EMITTERS).map((s) => s.entryPoint));
    expect([...drivable].toSorted().filter((name) => !claimed.has(name))).toEqual([]);
    // The witness must discriminate, or two sites share one proof.
    const witnesses = uniqueWitnesses();
    expect(witnesses.toSorted()).toEqual([...new Set(witnesses)].toSorted());
  });

  test("driving each entry point delivers the stream its call sites promise", async () => {
    const streams = new Map<string, ReadonlyArray<Record<string, unknown>>>();
    const failures: string[] = [];

    // Sequential, not concurrent: `runCli` runs in-process and swaps
    // process-wide state, so two overlapping runs corrupt each other.
    for (const [name, drive] of Object.entries(ENTRY_POINTS)) {
      // oxlint-disable-next-line no-await-in-loop
      const run = await drive();
      if (run.returncode !== 0) {
        failures.push(`${name}: exited ${run.returncode} - ${firstLine(run.stderr)}`);
        continue;
      }
      const records = progressRecords(run.stderr);
      streams.set(name, records);
      if (records.length === 0) {
        failures.push(`${name}: exited 0 and wrote no progress record at all`);
        continue;
      }
      // A stream that simply stops arriving is the shape of a finished
      // run, a crashed run and a hung run at once, so the terminator is
      // as much of the contract as the ticks are.
      const terminators = records.filter(
        (r) => r["kind"] === PROGRESS_KIND.finished || r["kind"] === PROGRESS_KIND.stopped,
      );
      if (terminators.length !== 1) {
        failures.push(`${name}: ${terminators.length} terminator(s) for one run, expected 1`);
      } else if (records.at(-1) !== terminators[0]) {
        failures.push(`${name}: records arrived after the terminator`);
      }
    }

    for (const [site, decl] of Object.entries(EMITTERS)) {
      const records = streams.get(decl.entryPoint) ?? [];
      const witnessed = records.some(
        (r) => r["operation"] === decl.operation && r["stage"] === decl.stage,
      );
      if (!witnessed) {
        failures.push(
          `${site}: no ${decl.operation}/${decl.stage} record arrived from \`${decl.entryPoint}\``,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
