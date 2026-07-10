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
 * Language-agnostic: keys are canonical vault-relative paths and content hashes;
 * no natural-language content is inspected.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { isoSecond } from "../time.ts";

/** Only schema version currently understood. Unknown versions are refused. */
const SCHEMA_VERSION = 1 as const;

/** Vault-relative directory holding OSB machine artifacts (not curated memory). */
const MACHINE_ARTIFACT_DIR = ".open-second-brain";

/** Subdirectory holding one JSON checkpoint per batch plan. */
const CHECKPOINT_DIR = "ingest-checkpoints";

/** Env var that, when truthy, disables checkpoint reads and writes. */
export const NO_CHECKPOINT_ENV = "OSB_INGEST_NO_CHECKPOINT";

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
 * Whether checkpointing is active. Off only when {@link NO_CHECKPOINT_ENV} holds
 * a truthy value; the empty string, `0`, and `false` are all treated as unset so
 * an accidentally-exported empty var does not silently disable resumability.
 */
export function checkpointingEnabled(): boolean {
  const raw = process.env[NO_CHECKPOINT_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "0" || v === "false";
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

function assertPlanId(planId: string): void {
  if (!/^[0-9a-f]{6,64}$/.test(planId)) {
    throw new Error(`invalid plan id (expected lowercase hex): ${JSON.stringify(planId)}`);
  }
}

/** Absolute path of one plan's checkpoint file. */
export function checkpointPath(vault: string, planId: string): string {
  assertPlanId(planId);
  return join(vault, MACHINE_ARTIFACT_DIR, CHECKPOINT_DIR, `${planId}.json`);
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
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`ingest checkpoint is corrupted JSON: ${path}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ingest checkpoint is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SCHEMA_VERSION) {
    throw new Error(
      `ingest checkpoint schema_version ${String(obj["schema_version"])} not supported (expected ${SCHEMA_VERSION}): ${path}`,
    );
  }
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
 */
export function recordCompleted(
  vault: string,
  planId: string,
  sourceDir: string,
  paths: readonly string[],
  now: Date,
): boolean {
  if (!checkpointingEnabled()) return false;
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
  atomicWriteFileSync(checkpointPath(vault, planId), serialize(next));
  return true;
}

/**
 * Remove a plan's checkpoint (the authoritative-final cleanup once a plan is
 * fully drained). Returns `true` when a file was removed, `false` when none
 * existed.
 */
export function clearCheckpoint(vault: string, planId: string): boolean {
  const path = checkpointPath(vault, planId);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
