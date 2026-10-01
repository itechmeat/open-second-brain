/**
 * Functional self-test harness for the search store: `o2b doctor selftest`.
 *
 * Plain `o2b doctor` inspects state (two of its checks write probe files,
 * none opens the store), so a machine can pass every doctor check and still
 * be unable to init, migrate, index, search or survive concurrent writes.
 * This harness proves that pipeline end to end on THROWAWAY storage only:
 * every real write path asserts vault identity first, so the harness never
 * opens the configured vault - it creates its own temp vault and temp
 * config and drives the public entries (`Store.open`, `indexVault`,
 * `resolveSearchConfig`) against those.
 *
 * ## Why a verb and not a `doctor()` check
 *
 * A full store roundtrip is the heaviest probe imaginable; the readiness
 * registry's per-probe timeout/`unknown` semantics would need a budget that
 * defeats the design. `doctor()` is also byte-stable by contract and
 * bundled into the OpenClaw artifact with import policing (see the
 * `doctor-hermes-parity.ts` docblock for the same reasoning), so this module
 * is standalone: NOTHING in `doctor.ts` imports it, and the `o2b doctor`
 * verb wires it in.
 *
 * ## Stages
 *
 * temp-vault -> store-open -> index -> upsert -> search -> concurrent-write
 * -> delete -> close, in that order, stopping at the first failure (later
 * stages need the store state the earlier ones leave behind). Each stage is
 * one `CheckResult`-shaped entry (name/ok/message/fix) plus stable machine
 * metrics, following the `brain_eval` report precedent: deterministic
 * values only. Wall-clock timings are measured (the timed query loop needs
 * no benchmark dependency) but live in the human rendering exclusively -
 * the `--json` payload carries no duration, no timestamp and no path, so
 * two healthy runs on one machine stringify byte-identically.
 *
 * ## Isolation overrides (deliberate, not fallbacks)
 *
 * `resolveSearchConfig` is called with two overrides, both documented in
 * the store-open stage: the store path is pinned inside the throwaway vault
 * (an operator's `search_db_path`/`OPEN_SECOND_BRAIN_SEARCH_DB` override
 * must not move writes outside the temp tree), and the semantic lane is
 * forced off (the harness is network-free by construction; semantic
 * capability is `o2b search check`'s job).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256Hex } from "./integrity/digest.ts";
import { DERIVED_STORE_DIR, DERIVED_STORE_FILE } from "./brain/path-constants.ts";
import { buildFtsMatch } from "./search/fts.ts";
import { resolveSearchConfig } from "./search/index.ts";
import { indexVault } from "./search/indexer.ts";
import { LATEST_SCHEMA_VERSION } from "./search/schema.ts";
import { SearchError } from "./search/search-error.ts";
import { isWriterLockHeld } from "./search/store/writer-lock.ts";
import { Store, type DocumentInput, type KeywordHit } from "./search/store.ts";
import { planTrigramPrefilter } from "./search/trigram-prefilter.ts";
import type { ResolvedSearchConfig } from "./search/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Directory prefix for the throwaway tree, under `os.tmpdir()`. */
const SELFTEST_TEMP_PREFIX = "o2b-selftest-";

/** The temp config file the harness writes, in the plugin `key: value` format. */
const SELFTEST_CONFIG_FILE = "config.yaml";

/** The one config key the temp config carries: the throwaway vault itself. */
const SELFTEST_CONFIG_VAULT_KEY = "vault";

/**
 * The keyword-lane probe token. Chosen once, so the seeded corpus and the
 * query cannot drift apart; it occurs in exactly one seeded note and
 * nowhere else in the throwaway corpus.
 */
const SELFTEST_QUERY = "zephyrquill";

/** How many timed rounds the search stage runs over the temp store. */
const SELFTEST_QUERY_ROUNDS = 20;

/** Hit cap for the store-level queries. */
const SELFTEST_QUERY_LIMIT = 5;

/**
 * How long the concurrent-write stage waits after starting the contending
 * writer, so its first lock attempt verifiably happens while the first
 * writer holds the lock. The writer lock retries on the order of seconds,
 * so well under one second is ample.
 */
const SELFTEST_CONTENTION_SETTLE_MS = 50;

/** The measured journal mode that means the backing downgrade fired (lifecycle.ts). */
const JOURNAL_MODE_DOWNGRADED = "delete";

/** Warning surfaced when the downgrade is what the harness actually measured. */
const WAL_DOWNGRADE_WARNING =
  "journal mode measured as delete (network-backed store downgrade); " +
  "concurrency was exercised without WAL";

/** Remediation for every store-side stage fault: the search-stack diagnostic. */
const SELFTEST_FIX_STORE = "o2b search check";

/**
 * Remediation for a temp-storage fault. Path-free on purpose: `$TMPDIR` is
 * the environment's own name for the directory, and the report stays free
 * of machine-specific paths.
 */
const SELFTEST_FIX_TEMP = 'ls -ld "$TMPDIR"';

interface SeededNote {
  readonly path: string;
  readonly body: string;
}

/**
 * The throwaway corpus. Three notes over two directories, each carrying a
 * private probe token (zephyrquill / cobaltmariner / verdanthollow), a
 * wikilink and a tag, so the index pass exercises walking, chunking, link
 * extraction and tag extraction together.
 */
const SEEDED_NOTES: ReadonlyArray<SeededNote> = Object.freeze([
  {
    path: "Brain/notes/selftest-alpha.md",
    body: [
      "---",
      "title: Selftest alpha",
      "---",
      "",
      "# Selftest alpha",
      "",
      "The zephyrquill engine keeps a quilted lantern burning at the harbor of",
      "every indexed vault. This note exists so the selftest can prove the",
      "keyword lane of this machine: the probe token zephyrquill occurs here",
      "and nowhere else in the throwaway corpus.",
      "",
      "The counterpoint note is [[selftest-beta]], indexed from the same",
      "temporary vault. Nothing in this directory outlives the command that",
      "created it.",
      "",
      "#selftest",
      "",
    ].join("\n"),
  },
  {
    path: "Brain/notes/selftest-beta.md",
    body: [
      "---",
      "title: Selftest beta",
      "---",
      "",
      "# Selftest beta",
      "",
      "The cobaltmariner buoys mark the far edge of the throwaway corpus: a",
      "second document so the selftest can assert that a keyword roundtrip",
      "returns the document it means, not merely any hit at all. The probe",
      "token cobaltmariner occurs here and nowhere else.",
      "",
      "Nothing in this directory outlives the command that created it.",
      "",
      "#selftest",
      "",
    ].join("\n"),
  },
  {
    path: "Brain/captures/selftest-gamma.md",
    body: [
      "---",
      "title: Selftest gamma",
      "---",
      "",
      "# Selftest gamma",
      "",
      "A third note in a different directory, so the walk phase of the index",
      "pass has more than one parent directory to traverse. The probe token",
      "verdanthollow marks this document.",
      "",
      "Nothing in this directory outlives the command that created it.",
      "",
      "#selftest",
      "",
    ].join("\n"),
  },
]);

/** The seeded note the search stage must surface for {@link SELFTEST_QUERY}. */
const SELFTEST_TARGET_PATH = "Brain/notes/selftest-alpha.md";

/** The synthetic document the upsert stage round-trips and the delete stage removes. */
const DIRECT_DOC = Object.freeze({
  path: "Brain/notes/selftest-direct.md",
  title: "Selftest direct",
  body: [
    "A document the selftest wrote straight through the store facade, with no",
    "file behind it. The upsert stage reads it back by path; the delete stage",
    "removes it and asserts the index stayed consistent.",
  ].join(" "),
});

/** The two documents the concurrent writers each commit. */
const SELFTEST_CONCURRENT_DOCS: ReadonlyArray<SeededNote> = Object.freeze([
  {
    path: "Brain/notes/selftest-concurrent-a.md",
    body: "Written by the writer that held the index writer lock first.",
  },
  {
    path: "Brain/notes/selftest-concurrent-b.md",
    body: "Written by the writer that contended for the index writer lock.",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable state the stages hand to each other, in execution order. */
export interface SelftestContext {
  /** Root of the throwaway tree; created by the temp-vault stage. */
  tempRoot: string;
  /** The throwaway vault (the temp root itself). */
  vault: string;
  /** Temp config file naming the throwaway vault. */
  configPath: string;
  /** Store location pinned INSIDE the throwaway vault. */
  dbPath: string;
  /** Resolved by the store-open stage; every later stage requires it. */
  config: ResolvedSearchConfig | null;
  /** Journal mode the store-open stage measured off the live connection. */
  walMode: string | null;
  /** A write store handed from the delete stage to the close stage. */
  heldStore: Store | null;
}

/** What a passing stage reports back. */
export interface SelftestStageOutcome {
  readonly message: string;
  /** Stable machine metrics; ride the JSON payload. */
  readonly metrics?: Readonly<Record<string, number>>;
  /** Non-fatal observations; counted in the report's warnings. */
  readonly warnings?: ReadonlyArray<string>;
  /** Timed-loop percentiles; human rendering only, never the JSON. */
  readonly timingMs?: Readonly<{ readonly p50Ms: number; readonly p100Ms: number }>;
}

export interface SelftestStageSpec {
  readonly name: string;
  /** Copy-pasteable remediation, attached to the stage entry when it fails. */
  readonly fix: string;
  readonly run: (ctx: SelftestContext) => Promise<SelftestStageOutcome> | SelftestStageOutcome;
}

/** One stage's outcome, CheckResult-shaped, plus the harness-only extras. */
export interface SelftestStage {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /** Present on failures with a deterministic remediation, like `CheckResult.fix`. */
  readonly fix?: string;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly warnings: ReadonlyArray<string>;
  /** Wall-clock cost of the stage. Human output only. */
  readonly durationMs: number;
  /** Timed-loop percentiles for the search stage. Human output only. */
  readonly timingMs?: Readonly<{ readonly p50Ms: number; readonly p100Ms: number }>;
}

export interface SelftestReport {
  /** Every stage that ran passed, the harness ran, and the temp tree is gone. */
  readonly ok: boolean;
  /** False when the harness itself could not run (temp storage unavailable). */
  readonly harnessRan: boolean;
  readonly warnings: number;
  /** Journal mode actually measured on the throwaway store; null when never measured. */
  readonly walMode: string | null;
  /** The throwaway directory. Human rendering only - never the JSON payload. */
  readonly tempRoot: string | null;
  readonly tempRemoved: boolean;
  readonly stages: ReadonlyArray<SelftestStage>;
}

export interface SelftestRunOptions {
  /**
   * Stage list override. The default list is {@link SELFTEST_STAGES}; the
   * broken-stage test (and any future fault-injection diagnostic) drives
   * this seam instead of monkey-patching machinery.
   */
  readonly stages?: ReadonlyArray<SelftestStageSpec>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fault rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fault, named. A `SearchError` renders its typed code (the vocabulary
 * every search-side consumer reports), any other named error renders its
 * name, and only an anonymous error falls back to the bare message.
 */
function describeFault(exc: unknown): string {
  if (exc instanceof SearchError) return `${exc.code}: ${exc.message}`;
  const err = exc as Error | null;
  const message = err?.message ?? String(exc);
  return err?.name !== undefined && err.name !== "Error" ? `${err.name}: ${message}` : message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage runner
// ─────────────────────────────────────────────────────────────────────────────

/** Runs one stage, converting its throw into a failed entry with the fix. */
async function runSelftestStage(
  spec: SelftestStageSpec,
  ctx: SelftestContext,
): Promise<SelftestStage> {
  const t0 = Date.now();
  try {
    const outcome = await spec.run(ctx);
    return Object.freeze({
      name: spec.name,
      ok: true,
      message: outcome.message,
      ...(outcome.metrics !== undefined ? { metrics: Object.freeze(outcome.metrics) } : {}),
      warnings: Object.freeze([...(outcome.warnings ?? [])]),
      durationMs: Date.now() - t0,
      ...(outcome.timingMs !== undefined ? { timingMs: outcome.timingMs } : {}),
    });
  } catch (exc) {
    return Object.freeze({
      name: spec.name,
      ok: false,
      message: describeFault(exc),
      fix: spec.fix,
      warnings: Object.freeze([]),
      durationMs: Date.now() - t0,
    });
  }
}

/** The config later stages require; a named fault rather than a null deref. */
function requireConfig(ctx: SelftestContext): ResolvedSearchConfig {
  if (ctx.config === null) {
    throw new SearchError(
      "INVALID_INPUT",
      "no resolved search config: the store-open stage did not complete",
    );
  }
  return ctx.config;
}

/** Opens a short-lived write store, runs `body`, and closes it either way. */
async function withWriteStore<T>(
  config: ResolvedSearchConfig,
  body: (store: Store) => Promise<T> | T,
): Promise<T> {
  const store = await Store.open(config, { mode: "write" });
  try {
    return await body(store);
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The default stage list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Throwsaway storage: temp root, temp config, seeded notes. Its success is
 * what "the harness ran" means - without it nothing below can execute, so
 * its failure is the run-incomplete case, not a proved store fault.
 */
const createTempVaultStage: SelftestStageSpec = {
  name: "temp-vault",
  fix: SELFTEST_FIX_TEMP,
  run: (ctx) => {
    const tempRoot = mkdtempSync(join(tmpdir(), SELFTEST_TEMP_PREFIX));
    ctx.tempRoot = tempRoot;
    ctx.vault = tempRoot;
    ctx.configPath = join(tempRoot, SELFTEST_CONFIG_FILE);
    ctx.dbPath = join(tempRoot, DERIVED_STORE_DIR, DERIVED_STORE_FILE);
    writeFileSync(ctx.configPath, `${SELFTEST_CONFIG_VAULT_KEY}: ${tempRoot}\n`, "utf8");
    for (const note of SEEDED_NOTES) {
      const file = join(tempRoot, note.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, note.body, "utf8");
    }
    return {
      message: `throwaway vault + config created, ${SEEDED_NOTES.length} notes seeded`,
      metrics: { notes: SEEDED_NOTES.length },
    };
  },
};

/**
 * Real init + migration path: `resolveSearchConfig` over the temp config,
 * then a write-mode `Store.open` (create + apply every migration), asserting
 * the schema landed at the current version and MEASURING the journal mode
 * off the live connection. The two overrides are the isolation contract:
 * `dbPath` pinned inside the throwaway vault (an operator's store-location
 * override must not move writes outside it) and semantic forced off (the
 * harness is network-free by construction).
 */
const storeOpenStage: SelftestStageSpec = {
  name: "store-open",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const config = resolveSearchConfig({
      vault: ctx.vault,
      configPath: ctx.configPath,
      overrides: {
        dbPath: ctx.dbPath,
        semantic: { enabled: false },
      },
    });
    ctx.config = config;
    const store = await Store.open(config, { mode: "write" });
    try {
      const version = store.schemaVersion();
      if (version !== LATEST_SCHEMA_VERSION) {
        throw new SearchError(
          "SCHEMA_MISMATCH",
          `fresh store opened at schema v${version}, expected v${LATEST_SCHEMA_VERSION}`,
        );
      }
      const journal =
        store.rawQuery<{ journal_mode: string }>("PRAGMA journal_mode")[0]?.journal_mode ?? null;
      if (journal === null) {
        throw new SearchError(
          "INDEX_UNREADABLE",
          "could not measure the journal mode of the fresh store",
        );
      }
      ctx.walMode = journal;
      return {
        message: `init + migrations to schema v${version}; journal mode ${journal} (measured)`,
        metrics: { schemaVersion: version },
        warnings: journal === JOURNAL_MODE_DOWNGRADED ? [WAL_DOWNGRADE_WARNING] : [],
      };
    } finally {
      await store.close();
    }
  },
};

/** The real index pass over the throwaway vault, via the public `indexVault`. */
const indexStage: SelftestStageSpec = {
  name: "index",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const stats = await indexVault(requireConfig(ctx));
    if (stats.errors.length > 0) {
      const first = stats.errors[0]!;
      throw new SearchError(
        "INVALID_INPUT",
        `index pass reported ${stats.errors.length} error(s); first: ${first.path}: ${first.message}`,
      );
    }
    const indexed = stats.added + stats.updated + stats.unchanged;
    if (indexed !== SEEDED_NOTES.length) {
      throw new SearchError(
        "INVALID_INPUT",
        `index pass indexed ${indexed} document(s), expected ${SEEDED_NOTES.length}`,
      );
    }
    return {
      message:
        `index pass over ${SEEDED_NOTES.length} notes: ${stats.added} added, ` +
        `${stats.chunksTotal} chunks`,
      metrics: { documents: SEEDED_NOTES.length, chunks: stats.chunksTotal },
    };
  },
};

/**
 * Direct store-facade roundtrip: `upsertDocument` a synthetic document with
 * no file behind it, then resolve it back by path. Runs after the index
 * pass so the pass's deletion sweep cannot reclaim the synthetic row.
 */
const upsertStage: SelftestStageSpec = {
  name: "upsert",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    await withWriteStore(requireConfig(ctx), (store) => {
      store.upsertDocument({
        path: DIRECT_DOC.path,
        title: DIRECT_DOC.title,
        contentHash: sha256Hex(DIRECT_DOC.body),
        mtime: Math.floor(Date.now() / 1000),
        size: DIRECT_DOC.body.length,
      });
      if (store.getDocumentIdByPath(DIRECT_DOC.path) === null) {
        throw new SearchError("INVALID_INPUT", `direct upsert roundtrip lost ${DIRECT_DOC.path}`);
      }
    });
    return {
      message: `direct document roundtrip resolved ${DIRECT_DOC.path}`,
      metrics: { documents: 1 },
    };
  },
};

/** A document input for one of the synthetic selftest notes. */
function syntheticDocInput(note: SeededNote): DocumentInput {
  return {
    path: note.path,
    title: null,
    contentHash: sha256Hex(note.body),
    mtime: Math.floor(Date.now() / 1000),
    size: note.body.length,
  };
}

/** Sorted-ascending percentile of a wall-clock sample, in tenths of a ms. */
function percentileMs(sorted: ReadonlyArray<number>, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 10) / 10;
}

/**
 * Store-level query roundtrip: a keyword (BM25) query and a trigram
 * candidate query must both surface the seeded target document, over a
 * timed loop that measures this machine's keyword lane. The loop's
 * percentiles are wall-clock observations and stay in the human rendering;
 * the counts are deterministic and ride the JSON.
 */
const searchStage: SelftestStageSpec = {
  name: "search",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const config = requireConfig(ctx);
    const store = await Store.open(config, { mode: "read" });
    try {
      const expectedId = store.getDocumentIdByPath(SELFTEST_TARGET_PATH);
      if (expectedId === null) {
        throw new SearchError(
          "INDEX_MISSING",
          `indexed corpus lost ${SELFTEST_TARGET_PATH} before the query stage`,
        );
      }
      const ftsMatch = buildFtsMatch(SELFTEST_QUERY);
      let hits: ReadonlyArray<KeywordHit> = [];
      const roundMs: number[] = [];
      for (let round = 0; round < SELFTEST_QUERY_ROUNDS; round += 1) {
        const t0 = performance.now();
        hits = store.keywordTopK(ftsMatch, { limit: SELFTEST_QUERY_LIMIT });
        roundMs.push(performance.now() - t0);
      }
      if (!hits.some((hit) => hit.documentId === expectedId)) {
        throw new SearchError(
          "INVALID_INPUT",
          `keyword roundtrip for "${SELFTEST_QUERY}" did not surface ${SELFTEST_TARGET_PATH}`,
        );
      }
      const trigramPlan = planTrigramPrefilter(SELFTEST_QUERY);
      if (trigramPlan.mode !== "match") {
        throw new SearchError(
          "INVALID_INPUT",
          `trigram planner skipped the probe query (${trigramPlan.reason})`,
        );
      }
      const trigram = store.trigramCandidates(trigramPlan.ftsQuery, {
        limit: SELFTEST_QUERY_LIMIT,
      });
      if (trigram.hits.length === 0) {
        throw new SearchError(
          "INVALID_INPUT",
          `trigram candidates for "${SELFTEST_QUERY}" came back empty`,
        );
      }
      if (!trigram.hits.some((hit) => hit.documentId === expectedId)) {
        throw new SearchError(
          "INVALID_INPUT",
          `trigram candidates for "${SELFTEST_QUERY}" did not surface ${SELFTEST_TARGET_PATH}`,
        );
      }
      const sorted = roundMs.toSorted((a, b) => a - b);
      return {
        message:
          `keyword roundtrip: ${hits.length} hit(s) for "${SELFTEST_QUERY}"; ` +
          `trigram: ${trigram.hits.length} candidate(s); ` +
          `${SELFTEST_QUERY_ROUNDS} timed queries`,
        metrics: {
          queries: SELFTEST_QUERY_ROUNDS,
          keywordHits: hits.length,
          trigramHits: trigram.hits.length,
        },
        warnings: [...trigram.warnings],
        timingMs: {
          p50Ms: percentileMs(sorted, 0.5),
          p100Ms: percentileMs(sorted, 1),
        },
      };
    } finally {
      await store.close();
    }
  },
};

/**
 * Concurrent writers through the real writer lock. Writer A opens first and
 * verifiably holds the lock; writer B is started while the lock is held, so
 * its open cannot complete until A releases. Both commits must land - the
 * lock serializes, it never drops a writer.
 */
const concurrentWriteStage: SelftestStageSpec = {
  name: "concurrent-write",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const config = requireConfig(ctx);
    const writerA = await Store.open(config, { mode: "write" });
    // Writer B's open STARTS here, while A holds the lock, and can only
    // resolve once A has released - the lock gates it, it cannot error past
    // it. Holding the promise (not an assigned variable) keeps every path
    // drainable: awaiting it after A's release yields B's store, on the
    // happy path and on every fault path alike.
    const writerBOpen = Store.open(config, { mode: "write" });
    try {
      if (!isWriterLockHeld(config.dbPath)) {
        throw new SearchError(
          "INDEX_LOCKED",
          "writer lock not observable while a write-mode store is open",
        );
      }
      // Let writer B reach its lock attempt while A verifiably holds the
      // lock; B retries on the order of seconds, so this is ample.
      await new Promise((resolve) => setTimeout(resolve, SELFTEST_CONTENTION_SETTLE_MS));
      writerA.upsertDocument(syntheticDocInput(SELFTEST_CONCURRENT_DOCS[0]!));
      // Releasing A is what lets B in; `close()` is idempotent, so the
      // finally below is safe on every path.
      await writerA.close();
      const writerB = await writerBOpen;
      try {
        writerB.upsertDocument(syntheticDocInput(SELFTEST_CONCURRENT_DOCS[1]!));
      } finally {
        await writerB.close();
      }
    } finally {
      // A's release unblocks B, so B must be drained before the temp tree
      // is removed: close A first (it may still hold the lock), then wait
      // for B's open and close it. On the happy path that second close is
      // an idempotent no-op on the already-closed store.
      try {
        await writerA.close();
      } catch {
        /* the stage fault, if any, is reported on its own entry */
      }
      try {
        const orphan = await writerBOpen;
        await orphan.close();
      } catch {
        /* B's open fault is the stage fault; nothing further to release */
      }
    }
    const verify = await Store.open(config, { mode: "read" });
    try {
      for (const doc of SELFTEST_CONCURRENT_DOCS) {
        if (verify.getDocumentIdByPath(doc.path) === null) {
          throw new SearchError("INVALID_INPUT", `concurrent write did not land: ${doc.path}`);
        }
      }
    } finally {
      await verify.close();
    }
    return {
      message:
        `${SELFTEST_CONCURRENT_DOCS.length} concurrent writers serialized by the index ` +
        "writer lock; both writes landed",
      metrics: { writers: SELFTEST_CONCURRENT_DOCS.length },
    };
  },
};

/**
 * Delete through the facade: the synthetic document from the upsert stage
 * is removed and the index must stay consistent (no orphan FTS rows). The
 * store is deliberately handed to the close stage rather than closed here.
 */
const deleteStage: SelftestStageSpec = {
  name: "delete",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const store = await Store.open(requireConfig(ctx), { mode: "write" });
    ctx.heldStore = store;
    if (store.getDocumentIdByPath(DIRECT_DOC.path) === null) {
      throw new SearchError("INDEX_MISSING", `${DIRECT_DOC.path} absent before delete`);
    }
    store.deleteDocument(DIRECT_DOC.path);
    if (store.getDocumentIdByPath(DIRECT_DOC.path) !== null) {
      throw new SearchError("INVALID_INPUT", `deleteDocument left ${DIRECT_DOC.path} behind`);
    }
    const integrity = store.ftsIntegrityCounts();
    if (integrity.chunks !== integrity.ftsRows) {
      throw new SearchError(
        "INVALID_INPUT",
        `orphan rows after delete: ${integrity.chunks} chunk row(s) vs ` +
          `${integrity.ftsRows} fts row(s)`,
      );
    }
    return {
      message:
        `document deleted; index consistent (${integrity.chunks} chunk rows == ` +
        `${integrity.ftsRows} fts rows)`,
      metrics: { removed: 1 },
    };
  },
};

/** Orderly close of the store the delete stage handed over, lock release proven. */
const closeStage: SelftestStageSpec = {
  name: "close",
  fix: SELFTEST_FIX_STORE,
  run: async (ctx) => {
    const store = ctx.heldStore;
    if (store === null) {
      throw new SearchError("INVALID_INPUT", "no store handed over from the delete stage");
    }
    ctx.heldStore = null;
    await store.close();
    if (isWriterLockHeld(requireConfig(ctx).dbPath)) {
      throw new SearchError("INDEX_LOCKED", "writer lock still held after an orderly close");
    }
    return { message: "orderly close completed; writer lock released" };
  },
};

/** The default stage list, in execution order. */
export const SELFTEST_STAGES: ReadonlyArray<SelftestStageSpec> = Object.freeze([
  createTempVaultStage,
  storeOpenStage,
  indexStage,
  upsertStage,
  searchStage,
  concurrentWriteStage,
  deleteStage,
  closeStage,
]);

/** The stage names, in execution order - the vocabulary tests and renderers share. */
export const SELFTEST_STAGE_NAMES: ReadonlyArray<string> = Object.freeze(
  SELFTEST_STAGES.map((spec) => spec.name),
);

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive the full roundtrip on throwaway storage and report per-stage
 * entries. Never throws: stage faults become failed stage entries, and the
 * temp tree is removed on every path.
 */
export async function runDoctorSelftest(opts: SelftestRunOptions = {}): Promise<SelftestReport> {
  const stages = opts.stages ?? SELFTEST_STAGES;
  const ctx: SelftestContext = {
    tempRoot: "",
    vault: "",
    configPath: "",
    dbPath: "",
    config: null,
    walMode: null,
    heldStore: null,
  };
  const results: SelftestStage[] = [];
  let harnessRan = false;
  let tempRemoved = false;
  let cleanupFault: string | null = null;
  try {
    for (const spec of stages) {
      // Stages are strictly sequential by contract: each one needs the
      // store state the previous one left behind, and the run stops at
      // the first failure.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await runSelftestStage(spec, ctx);
      results.push(outcome);
      if (!outcome.ok) break;
      if (spec.name === createTempVaultStage.name) harnessRan = true;
    }
  } finally {
    const held = ctx.heldStore;
    ctx.heldStore = null;
    if (held !== null) {
      try {
        await held.close();
      } catch {
        /* the stage fault is already on its own entry */
      }
    }
    if (ctx.tempRoot !== "") {
      try {
        rmSync(ctx.tempRoot, { recursive: true, force: true });
        tempRemoved = true;
      } catch (exc) {
        cleanupFault = `temp vault could not be removed (${describeFault(exc)}): ${ctx.tempRoot}`;
      }
    }
  }
  const warnings = results.flatMap((stage) => [...stage.warnings]);
  if (cleanupFault !== null) warnings.push(cleanupFault);
  const allStagesOk = results.length > 0 && results.every((stage) => stage.ok);
  const tempSettled = ctx.tempRoot === "" || tempRemoved;
  return Object.freeze({
    ok: harnessRan && allStagesOk && tempSettled,
    harnessRan,
    warnings: warnings.length,
    walMode: ctx.walMode,
    tempRoot: ctx.tempRoot === "" ? null : ctx.tempRoot,
    tempRemoved,
    stages: Object.freeze(results),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stable JSON payload
// ─────────────────────────────────────────────────────────────────────────────

/** The JSON-visible projection of one stage (CheckResult shape + metrics). */
export interface SelftestJsonStage {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  readonly fix?: string;
  readonly metrics?: Readonly<Record<string, number>>;
}

/**
 * The stable `--json` report shape. Every field is deterministic for a
 * given machine state: no timestamps, no paths, no wall-clock durations.
 */
export interface SelftestJsonPayload {
  readonly verb: string;
  readonly ok: boolean;
  readonly harnessRan: boolean;
  readonly warnings: number;
  readonly walMode: string | null;
  readonly stages: ReadonlyArray<SelftestJsonStage>;
  readonly summary: { readonly stages: number; readonly failed: number };
}

/**
 * The machine-readable report, following the `brain_eval` metric-block
 * precedent: deterministic values only. `tempRoot` and every wall-clock
 * measurement are excluded by construction, so two healthy runs on one
 * machine stringify byte-identically (the CLI renders with a key-sorting
 * replacer, which settles key order too).
 */
export function selftestJsonPayload(report: SelftestReport): SelftestJsonPayload {
  return {
    verb: "doctor-selftest",
    ok: report.ok,
    harnessRan: report.harnessRan,
    warnings: report.warnings,
    walMode: report.walMode,
    stages: report.stages.map((stage): SelftestJsonStage => ({
      name: stage.name,
      ok: stage.ok,
      message: stage.message,
      ...(stage.fix !== undefined ? { fix: stage.fix } : {}),
      ...(stage.metrics !== undefined ? { metrics: stage.metrics } : {}),
    })),
    summary: {
      stages: report.stages.length,
      failed: report.stages.filter((stage) => !stage.ok).length,
    },
  };
}
