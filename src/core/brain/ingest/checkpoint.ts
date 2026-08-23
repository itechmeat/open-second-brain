/**
 * Per-plan ingest checkpoint (Ingestion & Import Robustness suite,
 * t_ba1fa5f6).
 *
 * The content-hash manifest ({@link ../ingest/content-manifest.ts}) records a
 * source only once its full {@link ../ingest/ingest.ts:ingestSource} write has
 * landed, so it answers "have we ever fully ingested this file". This module
 * answers a finer, plan-scoped question: "within THIS batch plan, which items
 * have completed so far" - so an interrupted large-folder ingest resumes at the
 * item boundary instead of re-planning from scratch.
 *
 * Union-as-you-go: each completed item is folded into the checkpoint as it
 * finishes; the content manifest stays the authoritative final state. The
 * checkpoint lives at `<vault>/.open-second-brain/ingest-checkpoints/<plan_id>.json`,
 * a machine artifact (not curated memory), mirroring the manifest's location and
 * atomic-write / no-op-on-unchanged discipline.
 *
 * Opt-out: setting `OSB_INGEST_NO_CHECKPOINT` to a truthy value makes record and
 * read inert - the deterministic-test escape hatch mirroring upstream graphify's
 * `GRAPHIFY_NO_INCREMENTAL_CACHE`.
 *
 * The mechanism below the record - the id validation, the location, the
 * schema-version refusal, the lock / identity / atomic write - lives in
 * {@link ../checkpoint-store.ts}, shared with the session-import lane. What
 * stays here is this lane's record: a plan id, a source dir, and a set of
 * completed paths that no-ops when the SET is unchanged.
 *
 * Language-agnostic: keys are canonical vault-relative paths and content hashes;
 * no natural-language content is inspected.
 */

import { createHash } from "node:crypto";

import { canonicalNotePath } from "../../path-safety.ts";
import {
  checkpointFilePath,
  checkpointingEnabled,
  NO_CHECKPOINT_ENV,
  readCheckpointObject,
  removeCheckpointFile,
  withCheckpointLock,
  writeCheckpointObject,
} from "../checkpoint-store.ts";
import { isoSecond } from "../time.ts";

/** Only schema version currently understood. Unknown versions are refused. */
const SCHEMA_VERSION = 1 as const;

/** Subdirectory holding one JSON checkpoint per batch plan. */
const CHECKPOINT_DIR = "ingest-checkpoints";

/** How a refusal names this lane's id and its file. */
const ID_LABEL = "plan";
const FILE_LABEL = "ingest checkpoint";

export { checkpointingEnabled, NO_CHECKPOINT_ENV };

/** The persisted per-plan checkpoint. */
export interface IngestCheckpoint {
  readonly schema_version: typeof SCHEMA_VERSION;
  /** Stable id derived from the source dir and the full discovered path set. */
  readonly plan_id: string;
  /** Canonical vault-relative source directory the plan covers. */
  readonly source_dir: string;
  /** Canonical vault-relative paths completed so far, sorted. */
  readonly completed: readonly string[];
  readonly updated_at: string;
}

/**
 * Deterministic plan id: a short SHA-256 hex over the canonical source dir and
 * the sorted full discovered path set. Keying on the FULL set (not the remaining
 * work) keeps the id stable across a resume even as items complete.
 */
export function computePlanId(sourceDir: string, discoveredPaths: readonly string[]): string {
  const dir = canonicalNotePath(sourceDir);
  const paths = discoveredPaths.map((p) => canonicalNotePath(p)).toSorted();
  const hash = createHash("sha256");
  hash.update(dir);
  hash.update("\0");
  for (const p of paths) {
    hash.update(p);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Absolute path of one plan's checkpoint file. */
export function checkpointPath(vault: string, planId: string): string {
  return checkpointFilePath(vault, CHECKPOINT_DIR, ID_LABEL, planId);
}

function serialize(cp: IngestCheckpoint): string {
  return (
    JSON.stringify(
      {
        schema_version: cp.schema_version,
        plan_id: cp.plan_id,
        source_dir: cp.source_dir,
        completed: [...cp.completed].toSorted(),
        updated_at: cp.updated_at,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Read a plan's checkpoint. A missing file (or checkpointing disabled) returns
 * `null`. A corrupt file or an unknown `schema_version` is a hard error - never
 * a silent reset that would masquerade completed items as pending.
 */
export function readCheckpoint(vault: string, planId: string): IngestCheckpoint | null {
  if (!checkpointingEnabled()) return null;
  const path = checkpointPath(vault, planId);
  const obj = readCheckpointObject(path, FILE_LABEL, SCHEMA_VERSION);
  if (obj === null) return null;
  const rawCompleted = obj["completed"];
  const completed = Array.isArray(rawCompleted)
    ? rawCompleted
        .filter((x): x is string => typeof x === "string")
        .map((p) => canonicalNotePath(p))
        .toSorted()
    : [];
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    plan_id: planId,
    source_dir: typeof obj["source_dir"] === "string" ? obj["source_dir"] : "",
    completed: Object.freeze(completed),
    updated_at: typeof obj["updated_at"] === "string" ? obj["updated_at"] : "",
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Fold `paths` into a plan's checkpoint (union-as-you-go), atomically. Returns
 * `true` when the checkpoint was written, `false` on a no-op - checkpointing
 * disabled, or the completed set (and hence the serialized bytes) unchanged. The
 * `updated_at` stamp is only bumped when the set actually grows, so a re-record
 * of an already-recorded set leaves the file byte-identical.
 *
 * The read, the union and the write are ONE critical section under the sync
 * lock. A plan's items are dispatched to parallel subagents, so two of them
 * finishing at once would otherwise each write back the completed set they
 * read - and the later write would erase the earlier item, silently turning a
 * done item back into pending work on the next resume.
 */
export function recordCompleted(
  vault: string,
  planId: string,
  sourceDir: string,
  paths: readonly string[],
  now: Date,
): boolean {
  if (!checkpointingEnabled()) return false;
  const path = checkpointPath(vault, planId);
  return withCheckpointLock(path, () => {
    const prev = readCheckpoint(vault, planId);
    const merged = new Set<string>(prev?.completed ?? []);
    for (const p of paths) merged.add(canonicalNotePath(p));
    const completed = [...merged].toSorted();
    if (prev && sameSet(prev.completed, completed)) return false;
    const next: IngestCheckpoint = {
      schema_version: SCHEMA_VERSION,
      plan_id: planId,
      source_dir: canonicalNotePath(sourceDir),
      completed,
      updated_at: isoSecond(now),
    };
    return writeCheckpointObject(vault, path, serialize(next));
  });
}

/**
 * Remove a plan's checkpoint (the authoritative-final cleanup once a plan is
 * fully drained). Returns `true` when a file was removed, `false` when none
 * existed.
 */
export function clearCheckpoint(vault: string, planId: string): boolean {
  return removeCheckpointFile(vault, checkpointPath(vault, planId));
}
