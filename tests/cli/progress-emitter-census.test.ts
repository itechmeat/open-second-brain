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
 * expected operation and stage actually arrived, that at least one of them
 * ADVANCED, and that the stream was terminated. The advance is the part
 * that took a second pass to get right: a `started`/`finished` pair proves
 * only that a counter was built, and three of the ten sites here were being
 * vouched for by exactly that - see {@link EmitterSite.noAdvanceReason}.
 * Three properties follow, and they are why it is worth the seconds it
 * costs:
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
 *   - **The loop behind a site that declares `noAdvanceReason`.** Two do,
 *     and for both of them what is proven is that the stage opens and
 *     terminates - the ticking itself needs an embedding layer no test in
 *     this tree may depend on.
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
 *
 * ## Why the population is read off a lexed view
 *
 * A census that matched raw text would count `progressCounter(` inside a
 * docblock as an emitter, and two docblocks in `src/` discuss the counter
 * by name. This file used to blank comments with a scanner of its own
 * that treated a quote as a string opener with no regex rule, so a line
 * such as `/["]/` above a docblock left that docblock unblanked and the
 * prose counted. It now reads {@link lexCode} from
 * `tests/helpers/source-lexer.ts`, which is the lexer the three other
 * source-reading censuses run and is tested beside itself. Blanking
 * rather than deleting keeps every offset usable for the
 * enclosing-function scan that follows.
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
import { lexCode } from "../helpers/source-lexer.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");

// ─────────────────────────────────────────────────────────────────────────────
// The population: every `progressCounter(` call site in src/
// ─────────────────────────────────────────────────────────────────────────────

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
    const code = lexCode(readFileSync(file, "utf8"));
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
  /**
   * Why this site's stream can carry `started` and `finished` but no
   * `advanced` on the path the fixture drives.
   *
   * A `started`/`finished` pair proves the counter was CONSTRUCTED, and
   * that is a weaker fact than it looks: commenting out the sole
   * `progress.advance(...)` call in `runHealEnrichment` once left this
   * census 3 pass / 0 fail, because the dream fixture had no user pages
   * and the per-page loop never ran. So an `advanced` record is required
   * by default, and a site that genuinely cannot produce one says so HERE
   * with a reason rather than passing quietly. The exception is checked
   * in both directions: a site declaring one that then advances is a
   * failure too, so a stale reason cannot outlive the condition it names.
   */
  readonly noAdvanceReason?: string;
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
  // The two single-step units. Each opens its own stream because a step
  // IS the run when it is asked for on its own - `runDreamStep`
  // dispatches and owns no counter. Inside a full pass neither is handed
  // a sink, so `dream()`'s own counter stays the only voice and these
  // two stay inert; that is why the witness for each is its own entry
  // point rather than the full-pass one.
  "core/brain/dream-scan.ts#scanBrain": {
    entryPoint: "o2b brain dream --step scan --progress",
    operation: OPERATION.dream,
    stage: "scan",
  },
  "core/brain/heal-run.ts#runHealEnrichment": {
    entryPoint: "o2b brain dream --step heal-enrich --progress",
    operation: OPERATION.dream,
    stage: "heal-enrich",
  },
  "core/brain/link-graph/bridge-discovery.ts#discoverBridges": {
    entryPoint: "o2b brain bridges discover --progress",
    operation: OPERATION.bridges,
    stage: "candidates",
    // The candidate loop - the only thing that ticks - sits behind
    // `store.vecLoaded() && store.countEmbeddings() > 0`. This fixture
    // indexes with the lexical lane only, because an embedding layer
    // means a provider key and a network call, which is the one thing
    // every test in this tree refuses to depend on. The lane's own
    // ticking is covered where an embedding store can be faked:
    // `tests/core/brain/bridge-discovery.test.ts`.
    noAdvanceReason: "the candidate loop needs an embedding layer this fixture cannot provide",
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
    // This counter owns no loop at all: it opens the stage and LENDS
    // itself to `runEmbeddingPhase`, which is entered only under
    // `--apply` with a non-empty pending set - so an advance here would
    // mean a provider call. What the default path proves is that the
    // stage opens and terminates, which is the whole of what this site
    // does on its own.
    noAdvanceReason: "the counter is lent to the embedding phase, which only --apply enters",
  },
  // The machine-wide session sweep. One stage, because the walk is three
  // orders of magnitude cheaper than the hashing (4 ms against 3.0 s over
  // 596 MB) and a rail that announced the walk would be reporting on
  // nothing.
  "core/brain/sessions/discover.ts#discoverSessions": {
    entryPoint: "o2b brain import-session --status --progress",
    operation: OPERATION.sessions,
    stage: "hash",
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
/** A temp HOME holding a synthetic Claude Code store, plus a vault to sweep into. */
let sessionHome: string;
let sessionVault: string;

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
  "o2b brain dream --step scan --progress": () =>
    runCli(["brain", "dream", "--step", "scan", "--progress"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: dreamConfig },
    }),
  "o2b brain dream --step heal-enrich --progress": () =>
    runCli(["brain", "dream", "--step", "heal-enrich", "--progress"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: dreamConfig },
    }),
  "o2b brain architect --progress": () =>
    runCli(["brain", "architect", archProject, "--vault", archVault, "--progress"]),
  "o2b brain import-session --status --progress": () =>
    runCli(["brain", "import-session", "--status", "--vault", sessionVault, "--progress"], {
      env: { HOME: sessionHome },
    }),
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
  // User pages, because the heal-enrich pass ticks once per page and a
  // vault with none opens its stage over a denominator of zero: the
  // counter reports `started` and `finished` and never runs the loop the
  // stage exists to report on. Two pages, each naming the other's title,
  // so the pass has work as well as a denominator.
  for (const [name, other] of [
    ["canary-rollout", "Blast Radius"],
    ["blast-radius", "Canary Rollout"],
  ]) {
    writeFileSync(
      join(dreamVault, `${name}.md`),
      `---\ntitle: ${name!
        .split("-")
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(" ")}\n---\n\nA note about ${other}.\n`,
    );
  }
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

  // A synthetic Claude Code store under a temp HOME. Three files, so the
  // counter has a denominator and at least one `advanced` record to emit;
  // the bytes are never parsed by the sweep, only hashed.
  sessionHome = join(tmp, "session-home");
  const projects = join(sessionHome, ".claude", "projects", "-srv-projects-demo");
  mkdirSync(projects, { recursive: true });
  for (const name of ["a", "b", "c"]) {
    writeFileSync(join(projects, `${name}.jsonl`), `{"type":"user","uuid":"${name}"}\n`);
  }
  sessionVault = join(tmp, "session-vault");
  mkdirSync(join(sessionVault, "Brain"), { recursive: true });
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
      const witnessed = records.filter(
        (r) => r["operation"] === decl.operation && r["stage"] === decl.stage,
      );
      if (witnessed.length === 0) {
        failures.push(
          `${site}: no ${decl.operation}/${decl.stage} record arrived from \`${decl.entryPoint}\``,
        );
        continue;
      }
      // The unit of work, not just the construction of the counter. See
      // `noAdvanceReason`.
      const advanced = witnessed.some((r) => r["kind"] === PROGRESS_KIND.advanced);
      if (!advanced && decl.noAdvanceReason === undefined) {
        failures.push(
          `${site}: \`${decl.entryPoint}\` opened and closed ${decl.operation}/${decl.stage} ` +
            `without one advanced record - give the fixture something to advance over, ` +
            `or declare noAdvanceReason`,
        );
      }
      if (advanced && decl.noAdvanceReason !== undefined) {
        failures.push(
          `${site}: declared noAdvanceReason (${decl.noAdvanceReason}) but an advanced ` +
            `record arrived - drop the exception`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
