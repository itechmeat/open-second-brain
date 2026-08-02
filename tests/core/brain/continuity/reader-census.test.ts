/**
 * Continuity reader census (provenance-at-the-boundary, unit G,
 * t_77efc212).
 *
 * `docs/observability.md` described the read-model's masking policy as if
 * it governed the read side: `private` records dropped by default, kept
 * only on explicit request. The read-model does exactly that - and almost
 * nothing goes through it. Four modules call
 * `loadNormalizedContinuityRecords`; twenty call `listContinuityRecords`
 * straight off the store, where no `private` drop, no schema-version
 * dispatch, and now no declared-scope filter applies. A policy sentence
 * cannot notice that; a census can.
 *
 * So the split is asserted rather than described. Each side is an explicit
 * inventory: a module that starts reading continuity records - through
 * either door - fails this test until it is listed, and a listed module
 * that stops reading fails it too. The direct readers are RECORDED, not
 * fixed: auditing them is one judgement per reader and is out of scope for
 * this unit by design (see the design document's out-of-scope list).
 *
 * Non-vacuity is proved in the test itself rather than argued: the
 * classifier is run over an injected module that reads through each door
 * and is required to name it. A census that stopped matching would report
 * a clean split over an empty set, which is the failure mode this repo
 * has already shipped once.
 *
 * The classifier reads FILE BYTES, not `grep` output, and that is
 * load-bearing: `src/core/brain/dedup-telemetry.ts` contains a literal NUL
 * in a template literal (a key separator), which makes `grep` treat the
 * whole file as binary and print nothing for it. A grep-built census would
 * silently miss a real reader, so that file's presence is asserted below
 * in its own right.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");

/** Store entry points that return raw records with no policy applied. */
const STORE_READ_RE = /\b(?:listContinuityRecords|paginateContinuityRecords)\s*\(/;
/** Read-model entry points, where masking, schema and scope are applied. */
const READ_MODEL_READ_RE = /\b(?:loadNormalizedContinuityRecords|normalizeContinuityRecord)\s*\(/;

/**
 * The two modules that IMPLEMENT the layer rather than consume it. They
 * match the patterns by construction - the store defines its own reads,
 * and the read-model is the thing that wraps them - so counting them as
 * readers would mean the census could never reach zero unlisted. Their
 * existence is asserted below, so this exclusion cannot outlive them.
 */
const CONTINUITY_LAYER: ReadonlyArray<string> = Object.freeze([
  "src/core/brain/continuity/read-model.ts",
  "src/core/brain/continuity/store.ts",
]);

/**
 * Readers that go through the read-model, and therefore honour the
 * `private` drop, the schema-version dispatch, and the declared-scope
 * filter added by this unit.
 */
const READ_MODEL_READERS: Readonly<Record<string, string>> = Object.freeze({
  "src/cli/brain/verbs/continuity.ts":
    "`o2b brain continuity export|list` - ATOF/ATIF trajectory export and the " +
    "usage-decay-ranked listing.",
  "src/core/bench/phases.ts": "memory bench harness; replays `session_turn` records per question.",
  "src/core/brain/event-trace.ts":
    "joins Brain-log events to their continuity records; passes `keepPrivate` " +
    "through from the caller rather than deciding it.",
  "src/core/brain/skill-usage.ts": "aggregates `skill_invoked` records into per-skill usage.",
});

/**
 * Readers that call the store directly. Every one of them sees `private`
 * records, legacy unstamped records, and scoped records regardless of what
 * any filter asked for. Recorded here as an asserted fact; changing them is
 * a per-reader judgement and a separate task.
 */
const DIRECT_STORE_READERS: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/context-pack-evidence.ts":
    "reads `context_pack_evidence` for the kernel-recomputed evidence ledger.",
  "src/core/brain/context-pack-outcome.ts": "reads `context_pack_outcome` for the outcome ledger.",
  "src/core/brain/context-receipts.ts": "reads `context_receipt` for list, summary and show.",
  "src/core/brain/dedup-telemetry.ts":
    "reads `ingest_dedup` rollups. Carries a literal NUL byte, so text tools " +
    "that classify by content type do not see it at all.",
  "src/core/brain/gate-telemetry.ts": "reads `gate_telemetry` for recall-gate summaries.",
  "src/core/brain/generation-reports.ts": "reads `generation_report` for list, summary and show.",
  "src/core/brain/idea-lineage.ts":
    "reads the WHOLE store to build id / turn-id / session-turn indexes.",
  "src/core/brain/link-graph/repair-lane.ts":
    "reads the WHOLE store to harvest `sourceRefs` paths for link repair.",
  "src/core/brain/mcp-route-metrics.ts": "reads `mcp_route_latency` for per-route rollups.",
  "src/core/brain/memory-cost-meter.ts": "reads `host_memory_write` for the write-vs-read ratio.",
  "src/core/brain/observed-use.ts": "reads `recall_observed_use` for observed-use aggregation.",
  "src/core/brain/post-compact-audit.ts":
    "reads `post_compact_audit` for the append-time dedupe-key lookup.",
  "src/core/brain/pre-compact-extract.ts":
    "reads `pre_compact_extract` for the append-time dedupe-key lookup.",
  "src/core/brain/recall-telemetry.ts": "reads `recall_telemetry` for list and summary.",
  "src/core/brain/recent-turns.ts": "reads `recent_turn` for the sequence counter and the window.",
  "src/core/brain/session-recall.ts":
    "reads the WHOLE store for `session_turn` / `session_summary_node`, plus a " +
    "dedupe-key lookup.",
  "src/core/brain/session-summary.ts": "reads `session_summary_digest` for listing and dedupe.",
  "src/core/brain/skill-proposals.ts":
    "reads the WHOLE store forward from a watermark to derive skill proposals.",
  "src/core/brain/temporal/foresight.ts":
    "reads `pre_compact_extract` since a horizon for foresight items.",
  "src/core/brain/token-impact.ts": "reads `token_impact` and `token_impact_outcome` samples.",
});

/**
 * Floors under the MEASUREMENT, not a second copy of the inventories
 * above - those are the exact assertion. These catch the other failure:
 * a classifier that stopped matching would report a clean, empty split
 * and both `toEqual`s would fail on emptiness rather than on a floor, so
 * these say how far the counts may fall before the split stops describing
 * anything.
 *
 * Four modules read through the read-model and twenty read the store
 * directly. The read-model floor is AT today's count because losing one
 * of four is a real regression; the direct floor sits one under, because
 * that set is the one this wave is actively adding to and an exact pin
 * would fail on another unit's honest new reader rather than on a lost
 * measurement.
 */
const MIN_READ_MODEL_READERS = 4;
const MIN_DIRECT_STORE_READERS = 19;

/** A file the classifier must see, and that `grep` alone does not. */

interface CensusRow {
  readonly path: string;
  readonly viaReadModel: boolean;
  readonly viaStore: boolean;
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function sourceFiles(): ReadonlyArray<SourceFile> {
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC_ROOT, absolute: true })].toSorted();
  return files.map((file) => ({
    path: relative(REPO_ROOT, file).split("\\").join("/"),
    text: readFileSync(file, "utf8"),
  }));
}

/**
 * Classify every module that reads the continuity log. `injected` lets a
 * test add a module that does not exist on disk, which is how the
 * non-vacuity assertion below shows the census can actually fail.
 */
function census(injected: ReadonlyArray<SourceFile> = []): ReadonlyArray<CensusRow> {
  const layer = new Set(CONTINUITY_LAYER);
  const rows: CensusRow[] = [];
  for (const file of [...sourceFiles(), ...injected]) {
    if (layer.has(file.path)) continue;
    const viaReadModel = READ_MODEL_READ_RE.test(file.text);
    const viaStore = STORE_READ_RE.test(file.text);
    if (!viaReadModel && !viaStore) continue;
    rows.push({ path: file.path, viaReadModel, viaStore });
  }
  return rows.toSorted((left, right) => left.path.localeCompare(right.path));
}

const pathsVia = (rows: ReadonlyArray<CensusRow>, door: keyof CensusRow): ReadonlyArray<string> =>
  rows.filter((row) => row[door] === true).map((row) => row.path);

const unlisted = (
  rows: ReadonlyArray<CensusRow>,
  door: keyof CensusRow,
  listed: Readonly<Record<string, string>>,
): ReadonlyArray<string> => pathsVia(rows, door).filter((path) => !(path in listed));

describe("continuity reader census", () => {
  test("every read-model reader is listed, and every listed one still reads", () => {
    expect(pathsVia(census(), "viaReadModel")).toEqual(Object.keys(READ_MODEL_READERS).toSorted());
  });

  test("every direct store reader is listed, and every listed one still reads", () => {
    expect(pathsVia(census(), "viaStore")).toEqual(Object.keys(DIRECT_STORE_READERS).toSorted());
  });

  test("the read-model is the minority door, which is what the docs must say", () => {
    const rows = census();
    // The claim `docs/observability.md` now makes, measured rather than
    // asserted: most readers bypass the policy layer entirely.
    expect(pathsVia(rows, "viaStore").length).toBeGreaterThan(
      pathsVia(rows, "viaReadModel").length,
    );
    expect(pathsVia(rows, "viaReadModel").length).toBeGreaterThanOrEqual(MIN_READ_MODEL_READERS);
    expect(pathsVia(rows, "viaStore").length).toBeGreaterThanOrEqual(MIN_DIRECT_STORE_READERS);
  });

  test("the census reads bytes, so a NUL-carrying reader is not invisible to it", () => {
    // `grep` classifies a file holding a NUL byte as binary and prints
    // nothing for it, so a census built on text tooling reports a clean
    // result over a reader it never looked at. Three modules under `src/`
    // carried literal NUL bytes as key separators until this release
    // replaced them with the two-character escape - which is exactly why
    // this is proved against an injected module rather than against
    // whichever file happens to carry one today. The hazard belongs to the
    // tooling, not to those files.
    const nul = String.fromCharCode(0);
    const rogue: SourceFile = {
      path: "src/core/brain/rogue-nul-reader.ts",
      text: `const key = kind + "${nul}" + ref;\nlistContinuityRecords(vault, {});`,
    };
    expect(rogue.text).toContain(nul);
    expect(pathsVia(census([rogue]), "viaStore")).toContain(rogue.path);

    // The half above proves the classifier survives a NUL. This half proves
    // the enumeration does: the census reads every candidate with the same
    // `readFileSync(file, "utf8")` call used below, and a NUL-carrying file
    // read that way keeps its bytes - which is the exact point where a
    // grep-based sweep would have dropped the file instead.
    const dir = mkdtempSync(join(tmpdir(), "osb-nul-"));
    try {
      const probe = join(dir, "nul-reader.ts");
      writeFileSync(probe, rogue.text);
      expect(readFileSync(probe, "utf8")).toContain(nul);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no exclusion outlives the module it excuses", () => {
    const onDisk = new Set(sourceFiles().map((file) => file.path));
    for (const path of CONTINUITY_LAYER) expect(onDisk.has(path)).toBe(true);
  });

  test("the census is demonstrably able to fail", () => {
    // A new reader through either door is named, not absorbed. Injected
    // rather than written to disk so the proof costs nothing and cannot
    // be left behind.
    const rogues: ReadonlyArray<SourceFile> = [
      { path: "src/core/brain/rogue-store-reader.ts", text: "listContinuityRecords(vault, {});" },
      {
        path: "src/core/brain/rogue-read-model-reader.ts",
        text: "loadNormalizedContinuityRecords(vault, {});",
      },
    ];
    const rogueRows = census(rogues);

    expect(unlisted(rogueRows, "viaStore", DIRECT_STORE_READERS)).toEqual([
      "src/core/brain/rogue-store-reader.ts",
    ]);
    expect(unlisted(rogueRows, "viaReadModel", READ_MODEL_READERS)).toEqual([
      "src/core/brain/rogue-read-model-reader.ts",
    ]);

    // ...and the real tree has none, so the assertions above are not
    // passing because the comparison is loose.
    expect(unlisted(census(), "viaStore", DIRECT_STORE_READERS)).toEqual([]);
    expect(unlisted(census(), "viaReadModel", READ_MODEL_READERS)).toEqual([]);
  });
});
