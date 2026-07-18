/**
 * Delete and search by exact source file (C6 / t_edde2198).
 *
 * When a benchmark file, log, or accidental import pollutes a Brain, the
 * operator needs to (a) find every derived entry that traces back to one
 * EXACT source path and (b) surgically remove those entries — including
 * the ingest index artifacts (the per-source summary page and the
 * content-manifest entry) — without re-mining the vault or hand-chasing
 * summary pages.
 *
 * Two surfaces, one shared tracer:
 *   - {@link searchBySourceFile} — read-only. Every Brain page that traces
 *     to the exact source.
 *   - {@link deleteBySource} — DRY-RUN BY DEFAULT. Reports the blast radius
 *     and deletes nothing. With `confirm`, removes the derived entries and
 *     the index artifacts; original user notes are removed ONLY with an
 *     explicit `includeOriginals`. Every confirmed cleanup writes a
 *     `source_invalidation` continuity record (auditable).
 *
 * Provenance a page can carry back to a source:
 *   - frontmatter `source_path` (the ingest summary page, kind
 *     `brain-source`),
 *   - frontmatter `session_ref` (a session-derived signal),
 *   - a `[[source]]` wikilink in the frontmatter `source` array or in the
 *     page body's `## Sources` provenance section,
 *   - a preference `evidenced_by` link to a signal that itself derives
 *     from the source (transitive fold).
 *
 * Blast-radius safety. A page is only auto-DELETED when it is a
 * single-purpose derived file that traces SOLELY to this source:
 *   - a per-item derivation page (summary / signal / preference / entity /
 *     retired), AND
 *   - it co-references no OTHER source (a signal citing a second source, or
 *     a preference folded from a second signal, is REPORTED, never
 *     deleted).
 * Everything else that merely mentions the source — daily logs, research
 * reports, MOCs, any aggregate surface — is reported as a protected
 * mention so the operator can hand-edit it. This is the "never remove more
 * than intended" guarantee the dry-run report exists to make good on.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { canonicalNotePath, ensureInsideVault, vaultRelative } from "../path-safety.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  BRAIN_ENTITIES_REL,
  BRAIN_INBOX_REL,
  BRAIN_PREFERENCES_REL,
  BRAIN_REPORTS_REL,
  BRAIN_RETIRED_REL,
  BRAIN_SOURCES_REL,
  brainDirs,
} from "./paths.ts";
import { BRAIN_SOURCE_KIND } from "./ingest/ingest.ts";
import { manifestPath, readManifest, writeManifestAtomic } from "./ingest/content-manifest.ts";
import { appendContinuitySourceInvalidation } from "./continuity/store.ts";
import { isoSecond } from "./time.ts";
import { withDestructiveSnapshot } from "./snapshot-gate.ts";

/** Run-id label for the snapshot taken before a confirmed source cleanup. */
const DELETE_BY_SOURCE_SNAPSHOT_LABEL = "delete-by-source";

/** How a page was found to trace back to the source. */
export type SourceCleanupMatch = "source_path" | "session_ref" | "wikilink" | "evidenced_by";

/** Coarse classification of the referencing page, by its home directory. */
export type SourceCleanupKind =
  | "summary"
  | "signal"
  | "preference"
  | "entity"
  | "retired"
  | "report"
  | "log"
  | "other";

export interface SourceCleanupEntry {
  /** Vault-relative POSIX path of the referencing page. */
  readonly path: string;
  /** Frontmatter `id` when present, else the file basename (no extension). */
  readonly id: string;
  readonly kind: SourceCleanupKind;
  readonly match: SourceCleanupMatch;
  /** True for the ingest summary page — an index artifact, always purged. */
  readonly isIndexArtifact: boolean;
  /**
   * True when the page is a single-purpose derived file tracing SOLELY to
   * this source and is therefore safe to auto-delete on `confirm`. False
   * for aggregate surfaces and shared-derivation pages (reported only).
   */
  readonly deletable: boolean;
}

export interface SourceCleanupPlan {
  /** Canonical form of the queried source. */
  readonly source: string;
  /** False on a dry run (the default); true only when `confirm` was set. */
  readonly confirmed: boolean;
  readonly includeOriginals: boolean;
  /** Single-purpose derived entries removed (or that would be) on confirm. */
  readonly derived: ReadonlyArray<SourceCleanupEntry>;
  /** Referencing pages reported but NOT auto-deleted (aggregates / shared). */
  readonly mentions: ReadonlyArray<SourceCleanupEntry>;
  /** Original source file(s) outside `Brain/`; removed only with includeOriginals. */
  readonly originals: ReadonlyArray<string>;
  /** Manifest key for the source, when the content manifest tracks it. */
  readonly manifestEntry: string | null;
  /** Paths actually removed this run (empty on a dry run). */
  readonly deleted: ReadonlyArray<string>;
  readonly manifestEntryRemoved: boolean;
  /** Id of the audit continuity record, when one was written. */
  readonly auditRecordId: string | null;
  /**
   * Run id of the pre-deletion snapshot taken behind the D1 gate, or
   * null when none was taken (a dry run, or a confirmed run with nothing
   * to delete). This is the recovery point the operator can roll back to.
   */
  readonly snapshotRunId: string | null;
  /** Absolute path of the snapshot archive, paired with {@link snapshotRunId}. */
  readonly snapshotPath: string | null;
  /** Total referencing pages + originals (the reported blast radius). */
  readonly blastRadius: number;
}

export interface DeleteBySourceOptions {
  /** Required true to actually delete; absent/false = dry run. */
  readonly confirm?: boolean;
  /** Also remove the original source file(s) outside `Brain/`. */
  readonly includeOriginals?: boolean;
  /** Injected clock for the audit record's timestamp. */
  readonly now?: Date;
  /** Agent identity recorded in the audit reason. */
  readonly agent?: string;
}

/** Directories whose pages are per-item, single-source derived artifacts. */
const DERIVATION_DIRS: ReadonlyArray<string> = Object.freeze([
  BRAIN_SOURCES_REL,
  BRAIN_INBOX_REL,
  BRAIN_PREFERENCES_REL,
  BRAIN_ENTITIES_REL,
  BRAIN_RETIRED_REL,
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A wikilink to exactly `target`: `[[target]]`, `[[target|alias]]`, or
 * `[[target#heading]]`. Anchored on the `[[` boundary so `[[foo]]` never
 * matches `[[foobar]]`.
 */
function wikilinkRegExp(target: string): RegExp {
  return new RegExp(`\\[\\[${escapeRegExp(target)}(?:[|#][^\\]]*)?\\]\\]`);
}

function stringField(meta: FrontmatterMap, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayField(meta: FrontmatterMap, key: string): ReadonlyArray<string> {
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * A preference's evidence links. The writer stores the field under the
 * managed `_evidenced_by` key (with a plain `evidenced_by` on legacy
 * pages), so consult both.
 */
function evidencedByLinks(meta: FrontmatterMap): ReadonlyArray<string> {
  const managed = stringArrayField(meta, "_evidenced_by");
  return managed.length > 0 ? managed : stringArrayField(meta, "evidenced_by");
}

/** Strip a single enclosing `[[ … ]]` and any `|alias` / `#heading` tail. */
function wikilinkTarget(raw: string): string {
  const m = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(raw.trim());
  return m ? m[1]!.trim() : raw.trim();
}

function classifyKind(vault: string, absPath: string): SourceCleanupKind {
  const dirs = brainDirs(vault);
  if (insideDir(absPath, join(vault, BRAIN_SOURCES_REL))) return "summary";
  if (insideDir(absPath, dirs.retired)) return "retired";
  if (insideDir(absPath, dirs.preferences)) return "preference";
  if (insideDir(absPath, dirs.inbox)) return "signal";
  if (insideDir(absPath, dirs.entities)) return "entity";
  if (insideDir(absPath, join(vault, BRAIN_REPORTS_REL))) return "report";
  if (insideDir(absPath, dirs.log)) return "log";
  return "other";
}

function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}

function inDerivationDir(vault: string, absPath: string): boolean {
  return DERIVATION_DIRS.some((rel) => insideDir(absPath, join(vault, rel)));
}

function readId(meta: FrontmatterMap, absPath: string): string {
  const id = stringField(meta, "id") ?? stringField(meta, "entity_id");
  if (id) return id;
  const base = absPath.slice(absPath.lastIndexOf(sep) + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

interface RawMatch {
  readonly absPath: string;
  readonly path: string;
  readonly id: string;
  readonly kind: SourceCleanupKind;
  readonly match: SourceCleanupMatch;
  readonly isIndexArtifact: boolean;
  /** Structured source links this page carries (signal `source` array). */
  readonly sourceLinks: ReadonlyArray<string>;
  /** Structured evidence links this page carries (preference `evidenced_by`). */
  readonly evidencedBy: ReadonlyArray<string>;
}

/**
 * Classify one Brain page against the canonical source. Returns null when
 * the page does not reference the source at all. Only DIRECT references are
 * detected here (source_path / session_ref / `[[source]]` wikilink); the
 * transitive `evidenced_by` fold is resolved in a second pass once the set
 * of directly-derived signals is known.
 */
function directMatch(
  vault: string,
  absPath: string,
  canonical: string,
  sourceFile: string,
): RawMatch | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  let meta: FrontmatterMap = {};
  try {
    [meta] = parseFrontmatter(absPath);
  } catch {
    // A page we cannot parse is scanned as raw text only.
    meta = {};
  }

  const kind = classifyKind(vault, absPath);
  const sourceLinks = stringArrayField(meta, "source");
  // Managed `_evidenced_by` links take precedence over the legacy plain key
  // (see evidencedByLinks). Reading only the plain key here let a preference
  // whose evidence lives in `_evidenced_by` slip past the foreign-evidence
  // guard in computeDeletable and be auto-deleted as a first-pass wikilink
  // match, even when it is a shared fold.
  const evidencedBy = evidencedByLinks(meta);
  const base = {
    absPath,
    path: vaultRelative(absPath, vault),
    id: readId(meta, absPath),
    kind,
    sourceLinks,
    evidencedBy,
  };

  const sourcePath = stringField(meta, "source_path");
  if (sourcePath !== null && canonicalNotePath(sourcePath) === canonical) {
    return {
      ...base,
      match: "source_path",
      isIndexArtifact: meta["kind"] === BRAIN_SOURCE_KIND,
    };
  }

  const sessionRef = stringField(meta, "session_ref");
  if (sessionRef !== null && (sessionRef === canonical || sessionRef === sourceFile)) {
    return { ...base, match: "session_ref", isIndexArtifact: false };
  }

  if (wikilinkRegExp(canonical).test(text)) {
    return { ...base, match: "wikilink", isIndexArtifact: false };
  }

  return null;
}

/**
 * A directly-derived page traces SOLELY to this source when it declares no
 * OTHER structured source link. A signal whose `source` array names a
 * second source is a shared observation — reported, never auto-deleted.
 */
function tracesSolelyToSource(raw: RawMatch, canonical: string): boolean {
  for (const link of raw.sourceLinks) {
    if (canonicalNotePath(wikilinkTarget(link)) !== canonical) return false;
  }
  return true;
}

interface Traced {
  readonly derived: ReadonlyArray<SourceCleanupEntry>;
  readonly mentions: ReadonlyArray<SourceCleanupEntry>;
}

/**
 * Walk `Brain/` and classify every page referencing the source into the
 * deletable-derived set and the reported-only mentions set. Deterministic:
 * both lists are sorted by vault-relative path.
 */
function traceReferences(vault: string, sourceFile: string): Traced {
  const canonical = canonicalNotePath(sourceFile);
  const root = brainDirs(vault).brain;
  const rawMatches: RawMatch[] = [];
  if (existsSync(root)) {
    for (const absPath of walkBrainMarkdown(root)) {
      const m = directMatch(vault, absPath, canonical, sourceFile);
      if (m !== null) rawMatches.push(m);
    }
  }

  // Second pass: a preference folded SOLELY from directly-derived signals
  // is itself a derived entry. One evidenced by any foreign signal is a
  // shared fold — reported, never auto-deleted.
  const derivedSignalIds = new Set(rawMatches.filter((m) => m.kind === "signal").map((m) => m.id));
  const alreadyMatched = new Set(rawMatches.map((m) => m.absPath));
  if (existsSync(root)) {
    for (const absPath of walkBrainMarkdown(root)) {
      if (alreadyMatched.has(absPath)) continue;
      const kind = classifyKind(vault, absPath);
      if (kind !== "preference") continue;
      let meta: FrontmatterMap;
      try {
        [meta] = parseFrontmatter(absPath);
      } catch {
        continue;
      }
      const evidencedBy = evidencedByLinks(meta);
      const targets = evidencedBy.map((link) => wikilinkTarget(link));
      if (targets.length === 0) continue;
      if (!targets.some((t) => derivedSignalIds.has(t))) continue;
      rawMatches.push({
        absPath,
        path: vaultRelative(absPath, vault),
        id: readId(meta, absPath),
        kind,
        match: "evidenced_by",
        isIndexArtifact: false,
        sourceLinks: [],
        evidencedBy,
      });
    }
  }

  const derived: SourceCleanupEntry[] = [];
  const mentions: SourceCleanupEntry[] = [];
  for (const raw of rawMatches) {
    const deletable = computeDeletable(vault, raw, canonical, derivedSignalIds);
    const entry: SourceCleanupEntry = {
      path: raw.path,
      id: raw.id,
      kind: raw.kind,
      match: raw.match,
      isIndexArtifact: raw.isIndexArtifact,
      deletable,
    };
    (deletable ? derived : mentions).push(entry);
  }
  return { derived: derived.toSorted(byPath), mentions: mentions.toSorted(byPath) };
}

function byPath(a: SourceCleanupEntry, b: SourceCleanupEntry): number {
  return a.path.localeCompare(b.path);
}

function computeDeletable(
  vault: string,
  raw: RawMatch,
  canonical: string,
  derivedSignalIds: ReadonlySet<string>,
): boolean {
  // The ingest summary page is always an index artifact to purge.
  if (raw.isIndexArtifact) return true;
  // Only per-item derivation pages are ever auto-deleted.
  if (!inDerivationDir(vault, raw.absPath)) return false;
  // A signal citing a second source is a shared observation — report it.
  if (!tracesSolelyToSource(raw, canonical)) return false;
  // A preference folded from any foreign signal is a shared fold — report it.
  // This holds however the preference was first matched: a second-pass
  // `evidenced_by` fold OR a first-pass `[[source]]` wikilink match that also
  // carries evidence links. Keying only on match === "evidenced_by" let a
  // wikilink-matched shared preference reach `--confirm` deletion.
  if (raw.kind === "preference" && raw.evidencedBy.length > 0) {
    const targets = raw.evidencedBy.map((link) => wikilinkTarget(link));
    if (!targets.every((t) => derivedSignalIds.has(t))) return false;
  }
  return true;
}

function walkBrainMarkdown(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (st.isFile() && name.endsWith(".md")) out.push(full);
    }
  };
  visit(root);
  return out.toSorted();
}

/**
 * Every Brain page tracing back to the EXACT source — the derived entries
 * and the protected mentions, merged and sorted by path. Read-only.
 */
export function searchBySourceFile(
  vault: string,
  sourceFile: string,
): ReadonlyArray<SourceCleanupEntry> {
  const { derived, mentions } = traceReferences(vault, sourceFile);
  return Object.freeze([...derived, ...mentions].toSorted(byPath));
}

/**
 * Original source file(s) outside `Brain/`: the imported artifact itself.
 * A source that lives inside `Brain/` (or that has no on-disk file — e.g. a
 * URL identity) contributes no original.
 */
function findOriginals(vault: string, canonical: string): string[] {
  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, canonical), vault);
  } catch {
    return [];
  }
  if (!existsSync(abs)) return [];
  try {
    if (!statSync(abs).isFile()) return [];
  } catch {
    return [];
  }
  if (insideDir(abs, brainDirs(vault).brain)) return [];
  return [canonical];
}

function removeFile(vault: string, relPath: string): boolean {
  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, relPath), vault);
  } catch {
    return false;
  }
  try {
    rmSync(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Plan and (with `confirm`) execute the removal of everything derived from
 * one exact source file. Dry-run by default.
 */
export function deleteBySource(
  vault: string,
  sourceFile: string,
  opts: DeleteBySourceOptions = {},
): SourceCleanupPlan {
  const canonical = canonicalNotePath(sourceFile);
  const confirm = opts.confirm === true;
  const includeOriginals = opts.includeOriginals === true;

  const { derived, mentions } = traceReferences(vault, sourceFile);
  const originals = findOriginals(vault, canonical);
  const manifestKey = readManifest(vault).entries[canonical] !== undefined ? canonical : null;
  const blastRadius = derived.length + mentions.length + originals.length;

  if (!confirm) {
    return Object.freeze({
      source: canonical,
      confirmed: false,
      includeOriginals,
      derived: Object.freeze(derived),
      mentions: Object.freeze(mentions),
      originals: Object.freeze(originals),
      manifestEntry: manifestKey,
      deleted: Object.freeze([]),
      manifestEntryRemoved: false,
      auditRecordId: null,
      snapshotRunId: null,
      snapshotPath: null,
      blastRadius,
    });
  }

  // Confirmed path — delete the derived entries first, then (opt-in) the
  // originals, then drop the manifest entry (an index artifact).
  const deleted: string[] = [];
  let manifestEntryRemoved = false;

  // Audit only a run that actually changed something; a no-op re-run writes
  // no record (idempotent). Factored so both the success path AND a partial
  // failure can persist the record of what was already removed.
  const writeInvalidationAudit = (): string | null => {
    if (deleted.length === 0 && !manifestEntryRemoved) return null;
    const agent = opts.agent?.trim() ? opts.agent.trim() : "delete_by_source";
    const record = appendContinuitySourceInvalidation(vault, {
      createdAt: isoSecond(opts.now ?? new Date()),
      source: { id: canonical, path: canonical, kind: "source" },
      reason:
        `${agent}: removed ${deleted.length} derived/original entr${deleted.length === 1 ? "y" : "ies"}` +
        `${manifestEntryRemoved ? " and the ingest manifest entry" : ""}` +
        `${includeOriginals ? " (originals included)" : ""}`,
    });
    return record.id;
  };

  let auditRecordId: string | null = null;

  // The destructive core: remove derived entries, opt-in originals, and
  // the manifest index entry, then audit. Runs behind the D1 snapshot
  // gate so every confirmed cleanup has a pre-deletion recovery point.
  const runDeletion = (): void => {
    try {
      for (const entry of derived) {
        if (removeFile(vault, entry.path)) deleted.push(entry.path);
      }
      if (includeOriginals) {
        for (const original of originals) {
          if (removeFile(vault, original)) deleted.push(original);
        }
      }

      if (manifestKey !== null && existsSync(manifestPath(vault))) {
        const entries = { ...readManifest(vault).entries };
        if (entries[manifestKey] !== undefined) {
          delete entries[manifestKey];
          manifestEntryRemoved = writeManifestAtomic(vault, entries);
        }
      }
    } catch (err) {
      // A removeFile (or manifest write) that throws mid-cleanup would otherwise
      // exit before the audit append, leaving already-deleted paths with no
      // record for a retry to reconstruct. Persist what was removed so far, then
      // rethrow; never let an audit-write error mask the original failure.
      try {
        writeInvalidationAudit();
      } catch {
        /* swallow: the original error below is the one that matters */
      }
      throw err;
    }
    auditRecordId = writeInvalidationAudit();
  };

  // Only snapshot when there is something to remove. A confirmed run over
  // a source with no derived material, no included originals, and no
  // manifest entry is a no-op and must stay one - snapshotting an empty
  // deletion would churn `.snapshots/` for nothing.
  const hasWork =
    derived.length > 0 || (includeOriginals && originals.length > 0) || manifestKey !== null;

  let snapshotRunId: string | null = null;
  let snapshotArchivePath: string | null = null;
  if (hasWork) {
    const gated = withDestructiveSnapshot(vault, DELETE_BY_SOURCE_SNAPSHOT_LABEL, runDeletion, {
      now: opts.now,
    });
    snapshotRunId = gated.snapshot.runId;
    snapshotArchivePath = gated.snapshot.path;
  } else {
    runDeletion();
  }

  return Object.freeze({
    source: canonical,
    confirmed: true,
    includeOriginals,
    derived: Object.freeze(derived),
    mentions: Object.freeze(mentions),
    originals: Object.freeze(originals),
    manifestEntry: manifestKey,
    deleted: Object.freeze(deleted),
    manifestEntryRemoved,
    auditRecordId,
    snapshotRunId,
    snapshotPath: snapshotArchivePath,
    blastRadius,
  });
}
