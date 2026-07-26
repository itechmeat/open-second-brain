/**
 * Vault-wide broken-link ratchet: the counter and the ceiling
 * comparison (context-integrity-gates, unit G).
 *
 * Nothing in this repository counted broken links vault-wide before
 * this module. `doctor.ts:checkBrokenBacklinks` answers a deliberately
 * narrower question (Brain-layer `pref-`/`ret-`/`sig-` targets only)
 * and is untouched; the graph-degree machinery in `link-graph/` counts
 * RESOLVED edges and never the unresolved ones.
 *
 * ## What "dangling" means here
 *
 * A link row that carries a target path and that the READ-TIME
 * resolution ladder cannot resolve to any document. The ladder is the
 * one every reader already follows - `store.resolvedDocLinkPairs()` and
 * its siblings - and it lives in exactly one place,
 * `RESOLVED_LINK_TARGET_SQL` in `store.ts`: a materialized id, then a
 * `<target>.md` exact match, then an unambiguous basename. Tags carry
 * no target path and are excluded.
 *
 * ## Why not the narrower SQL predicate
 *
 * The first cut of this gate counted `target_document_id IS NULL AND
 * target_path IS NOT NULL`, chosen for stability and index-backing.
 * Measurement refuted it: `templates/brain-starter` reported 55
 * dangling out of 55 link rows - every row in the vault - because that
 * vault is written in basename wikilinks (`[[pref-x]]`), which the
 * ladder resolves and the raw predicate does not. Under that
 * definition, adding a healthy basename link raises the count exactly
 * as adding a broken one does, so the gate fires on correct edits and
 * gets routinely bumped. A gate nobody believes is the misleading
 * signal this wave exists to remove, so the definition follows the
 * reader instead: {@link DANGLING_LINK_DEFINITION} names the rule that
 * produced a number, and a ceiling recorded under a different one is
 * refused at parse time rather than being read as link rot.
 *
 * Determinism survives the move. Every rung is index-backed
 * (`idx_links_target_path`, the UNIQUE `documents.path`,
 * `idx_documents_basename`), the ambiguous-basename rung resolves to
 * nothing rather than guessing, alias collisions resolve first-wins by
 * sorted document path, and `walkVault` sorts every listing - so two
 * runs over an unchanged subject agree, which the tests assert.
 *
 * ## The full-resolution precondition
 *
 * `resolveLinkTargets` and `resolveAliasTargets` run as global
 * post-passes, but `replaceDocAliases` runs only for the documents a
 * run actually read, so a count taken after an incremental pass can
 * differ from one taken after a forced full pass. The precondition is
 * therefore VERIFIED, not documented: `measureFromIndex` refuses to
 * return a number unless the index itself records that its last run was
 * a forced one (`last_full_index_at === last_indexed_at`, both stamped
 * from the same instant by `indexVault`). {@link measureVault} verifies
 * more: it indexes a hermetic copy from an empty database and checks
 * that every walked file materialized a document row.
 *
 * An unmeasurable subject is a distinct outcome from a clean one at
 * every layer - there is no fallback that reports zero.
 */

import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSearchConfig } from "./index.ts";
import { indexVault } from "./indexer.ts";
import { LAST_FULL_INDEX_AT_STATE_KEY, LAST_INDEXED_AT_STATE_KEY, Store } from "./store.ts";
import { SearchError, type ResolvedSearchConfig } from "./types.ts";
import { walkVault } from "./walker.ts";

/**
 * The counting rule that produced a number, recorded beside it. Bump
 * the `@n` suffix whenever the predicate changes, so a redefinition
 * fails the comparison loudly instead of reading as link rot.
 */
export const DANGLING_LINK_DEFINITION = "ladder:links-unresolved-after-read-resolution@2";

/** Schema version of `link-ratchet.json`, per `schemas/brain/` convention. */
export const LINK_RATCHET_SCHEMA_VERSION = 1;

/** The single remediation, named once and quoted by every failure path. */
export const LINK_RATCHET_FIX_COMMAND = "bun run link-ratchet";

/** Chunking pinned for the gate: chunk boundaries decide how many link
 * rows a document produces (extraction dedupes per chunk), so the
 * measurement must not inherit an operator's `search_chunk_*` override. */
const RATCHET_CHUNK_SIZE = 800;
const RATCHET_CHUNK_OVERLAP = 100;
const RATCHET_CHUNK_MIN_SIZE = 100;

/** Why a count could not be obtained. Never folded into a zero. */
export type LinkRatchetUnmeasurableReason =
  /** The subject directory does not exist or is not a directory. */
  | "subject-missing"
  /** No index database at the configured path. */
  | "index-missing"
  /** The index exists but could not be opened or queried. */
  | "index-unreadable"
  /** The last index run was not a forced full pass. */
  | "partial-resolution"
  /** The index does not cover every markdown file under the subject. */
  | "index-incomplete"
  /**
   * The subject exists but holds no indexable markdown at all - emptied,
   * renamed, sparse-checked-out, or fully excluded by its own ignore
   * rules. A count over nothing satisfies every completeness guard and
   * reads as `dangling: 0`, which is a clean bill of health for a
   * subject nobody measured; the write form would then commit that zero
   * as a permanent ceiling.
   */
  | "subject-empty";

export type LinkRatchetMeasurement =
  | {
      readonly measurable: true;
      readonly definition: string;
      /**
       * Link rows matching {@link DANGLING_LINK_DEFINITION}: those the
       * read-time ladder leaves unresolved.
       */
      readonly dangling: number;
      /** Link rows carrying a target path (the denominator). */
      readonly links: number;
      readonly documents: number;
    }
  | {
      readonly measurable: false;
      readonly definition: string;
      readonly reason: LinkRatchetUnmeasurableReason;
      readonly detail: string;
    };

/** One committed ceiling entry: a repo-relative vault root and its count. */
export interface LinkRatchetSubject {
  readonly path: string;
  readonly dangling: number;
}

/** The committed `link-ratchet.json` document. */
export interface LinkRatchetCeiling {
  readonly schema_version: number;
  readonly definition: string;
  readonly subjects: ReadonlyArray<LinkRatchetSubject>;
}

export type LinkRatchetStatus =
  | "level"
  | "drop"
  | "rise"
  | "unmeasurable"
  /** Measured, but under a rule the recorded ceiling did not use. */
  | "redefined";

export interface LinkRatchetVerdict {
  readonly subject: string;
  readonly ceiling: number;
  readonly status: LinkRatchetStatus;
  readonly measurement: LinkRatchetMeasurement;
}

/** A malformed or incomparable ceiling file. */
export class LinkRatchetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkRatchetError";
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unmeasurable(
  reason: LinkRatchetUnmeasurableReason,
  detail: string,
): LinkRatchetMeasurement {
  return Object.freeze({
    measurable: false as const,
    definition: DANGLING_LINK_DEFINITION,
    reason,
    detail,
  });
}

/**
 * The search config the gate measures under: the operator's resolved
 * config with the determinism-relevant fields pinned - the database
 * location (so the subject tree is never written into), the chunk
 * geometry, and the embedding lane (a link census needs no vectors).
 * Ignore rules still come from the subject's own `Brain/_brain.yaml`,
 * which is part of the subject and therefore part of the measurement.
 */
export function ratchetSearchConfig(vault: string, dbPath: string): ResolvedSearchConfig {
  const base = resolveSearchConfig({ vault });
  return Object.freeze({
    ...base,
    dbPath,
    chunkSize: RATCHET_CHUNK_SIZE,
    chunkOverlap: RATCHET_CHUNK_OVERLAP,
    chunkMinSize: RATCHET_CHUNK_MIN_SIZE,
    semantic: Object.freeze({ ...base.semantic, enabled: false }),
  });
}

/**
 * Count dangling links in an EXISTING index, refusing unless that index
 * records a full resolution pass as its most recent run.
 *
 * Read-only: opens the store in read mode, never indexes, never writes.
 */
export async function measureFromIndex(
  config: ResolvedSearchConfig,
): Promise<LinkRatchetMeasurement> {
  let store: Store;
  try {
    store = await Store.open(config, { mode: "read" });
  } catch (e) {
    if (e instanceof SearchError && e.code === "INDEX_MISSING") {
      return unmeasurable("index-missing", `no search index at ${config.dbPath}`);
    }
    return unmeasurable("index-unreadable", errorMessage(e));
  }
  try {
    const full = store.getState(LAST_FULL_INDEX_AT_STATE_KEY);
    const last = store.getState(LAST_INDEXED_AT_STATE_KEY);
    if (full === null || last === null || full !== last) {
      return unmeasurable(
        "partial-resolution",
        `last full index ${full ?? "(never)"} is not the last index run ${last ?? "(never)"}; ` +
          "a dangling count is only reproducible after a forced full pass",
      );
    }
    const links = store.linkResolutionCounts();
    return Object.freeze({
      measurable: true as const,
      definition: DANGLING_LINK_DEFINITION,
      dangling: links.unresolved,
      links: links.total,
      documents: store.counts().documents,
    });
  } catch (e) {
    return unmeasurable("index-unreadable", errorMessage(e));
  } finally {
    await store.close();
  }
}

/**
 * Markdown files the walker admits under `config.vault`. Materialized
 * rather than streamed: a completeness check needs the whole set, and
 * the walker has already applied the ignore rules and the index
 * admission predicate, so this is exactly the population the indexer
 * saw.
 */
function countWalkedFiles(config: ResolvedSearchConfig): number {
  return [...walkVault(config)].length;
}

/**
 * Measure one vault root from scratch: copy it, index the copy from an
 * empty database with `force`, and count.
 *
 * The copy is not paranoia - `indexVault` appends a run record under
 * `<vault>/Brain/metrics/`, so measuring a subject in place would
 * mutate the tree being measured. The copy also removes any prior index
 * state from the comparison, which is what makes two runs over an
 * unchanged subject agree.
 */
export async function measureVault(vaultDir: string): Promise<LinkRatchetMeasurement> {
  try {
    if (!statSync(vaultDir).isDirectory()) {
      return unmeasurable("subject-missing", `not a directory: ${vaultDir}`);
    }
  } catch {
    return unmeasurable("subject-missing", `no such directory: ${vaultDir}`);
  }

  const work = mkdtempSync(join(tmpdir(), "o2b-link-ratchet-"));
  try {
    const copy = join(work, "vault");
    cpSync(vaultDir, copy, { recursive: true });
    const config = ratchetSearchConfig(copy, join(work, "index.sqlite"));
    const stats = await indexVault(config, { force: true });
    if (stats.unchanged !== 0 || stats.deleted !== 0) {
      return unmeasurable(
        "index-incomplete",
        `forced run reported ${stats.unchanged} unchanged and ${stats.deleted} deleted file(s)`,
      );
    }
    const walked = countWalkedFiles(config);
    if (walked === 0) {
      return unmeasurable(
        "subject-empty",
        `no indexable markdown under ${vaultDir}; a count over an empty subject ` +
          "would read as zero dangling and pass every completeness guard",
      );
    }
    const measurement = await measureFromIndex(config);
    if (measurement.measurable && measurement.documents !== walked) {
      return unmeasurable(
        "index-incomplete",
        `indexed ${measurement.documents} of ${walked} markdown file(s) under ${vaultDir}`,
      );
    }
    return measurement;
  } catch (e) {
    return unmeasurable("index-unreadable", errorMessage(e));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface JudgeSubjectOptions {
  /**
   * Whether the recorded ceiling was produced by the rule this build
   * counts with. False makes the comparison meaningless, so the verdict
   * reports `redefined` instead of inventing a rise or a drop.
   * Defaults to true.
   */
  readonly comparable?: boolean;
}

/** Compare one measurement against its committed ceiling. */
export function judgeSubject(
  subject: string,
  ceiling: number,
  measurement: LinkRatchetMeasurement,
  options: JudgeSubjectOptions = {},
): LinkRatchetVerdict {
  const status: LinkRatchetStatus = !measurement.measurable
    ? "unmeasurable"
    : options.comparable === false
      ? "redefined"
      : measurement.dangling > ceiling
        ? "rise"
        : measurement.dangling < ceiling
          ? "drop"
          : "level";
  return Object.freeze({ subject, ceiling, status, measurement });
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinkRatchetError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export interface ParseCeilingOptions {
  /**
   * Accept a ceiling recorded under a different counting definition,
   * returning it with that definition preserved so the caller can see
   * the numbers are incomparable.
   *
   * Only the WRITE form passes this. The refusal names
   * {@link LINK_RATCHET_FIX_COMMAND} as the remedy, so that command has
   * to be able to read the very file the comparison rejects - otherwise
   * a definition change could never be adopted. `--check` keeps the
   * refusal, which is what makes a redefinition a reviewable diff
   * rather than a silent reinterpretation of the gate.
   */
  readonly allowForeignDefinition?: boolean;
}

/**
 * Parse a committed ceiling file, refusing anything that cannot be
 * compared: a foreign schema version, a foreign counting definition
 * (unless {@link ParseCeilingOptions.allowForeignDefinition}), a
 * non-integer count, a duplicate subject, or an empty subject list (a
 * gate with nothing to measure is not a gate).
 */
export function parseCeiling(text: string, options: ParseCeilingOptions = {}): LinkRatchetCeiling {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new LinkRatchetError(`ceiling file is not valid JSON: ${errorMessage(e)}`);
  }
  const doc = asRecord(raw, "ceiling file");

  if (doc["schema_version"] !== LINK_RATCHET_SCHEMA_VERSION) {
    throw new LinkRatchetError(
      `ceiling schema_version ${String(doc["schema_version"])} is not the supported ` +
        `${LINK_RATCHET_SCHEMA_VERSION}`,
    );
  }
  const rawDefinition = doc["definition"];
  if (typeof rawDefinition !== "string" || rawDefinition.length === 0) {
    throw new LinkRatchetError("ceiling 'definition' must be a non-empty string");
  }
  if (rawDefinition !== DANGLING_LINK_DEFINITION && options.allowForeignDefinition !== true) {
    throw new LinkRatchetError(
      `ceiling definition '${rawDefinition}' is not the current ` +
        `'${DANGLING_LINK_DEFINITION}': the counts are not comparable, ` +
        `re-measure with: ${LINK_RATCHET_FIX_COMMAND}`,
    );
  }
  const rawSubjects = doc["subjects"];
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) {
    throw new LinkRatchetError("ceiling 'subjects' must be a non-empty array");
  }

  const seen = new Set<string>();
  const subjects: LinkRatchetSubject[] = [];
  for (const entry of rawSubjects) {
    const subject = asRecord(entry, "ceiling subject");
    const path = subject["path"];
    const dangling = subject["dangling"];
    if (typeof path !== "string" || path.length === 0) {
      throw new LinkRatchetError("every ceiling subject needs a non-empty 'path'");
    }
    if (typeof dangling !== "number" || !Number.isInteger(dangling) || dangling < 0) {
      throw new LinkRatchetError(`subject '${path}': 'dangling' must be a non-negative integer`);
    }
    if (seen.has(path)) throw new LinkRatchetError(`duplicate ceiling subject '${path}'`);
    seen.add(path);
    subjects.push(Object.freeze({ path, dangling }));
  }
  return Object.freeze({
    schema_version: LINK_RATCHET_SCHEMA_VERSION,
    definition: rawDefinition,
    subjects: Object.freeze(subjects),
  });
}

/**
 * Render a ceiling file: subjects sorted by path, two-space indent,
 * trailing newline - the shape `fmt:check` already enforces for every
 * other JSON file at the repository root.
 */
export function serializeCeiling(ceiling: LinkRatchetCeiling): string {
  const subjects = ceiling.subjects
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((s) => ({ path: s.path, dangling: s.dangling }));
  return (
    JSON.stringify(
      {
        schema_version: ceiling.schema_version,
        definition: ceiling.definition,
        subjects,
      },
      null,
      2,
    ) + "\n"
  );
}
