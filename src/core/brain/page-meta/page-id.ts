/**
 * Canonical page identity helpers for the `merged_into:` pointer
 * written by the page-dedup pass.
 *
 * Convention: the secondary page (the one being de-canonicalised)
 * gets a `merged_into: pref-<canonical-slug>` field in its
 * frontmatter. Readers that need to resolve identity to the canonical
 * page walk the chain with {@link resolveCanonicalId}; depth is
 * bounded at {@link MERGE_CHAIN_MAX_DEPTH} so a cycle (which should
 * never happen but is cheap to defend against) fails loud rather
 * than recursing forever.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export const MERGE_CHAIN_MAX_DEPTH = 5;

export class MergeChainError extends Error {
  readonly code: "CYCLE" | "DEPTH" | "MALFORMED";
  readonly id: string;
  constructor(code: "CYCLE" | "DEPTH" | "MALFORMED", id: string, message: string) {
    super(message);
    this.name = "MergeChainError";
    this.code = code;
    this.id = id;
  }
}

/**
 * Read `merged_into:` from a frontmatter map. Returns the canonical
 * page id (e.g. `pref-foo`) when set, or `null` when absent.
 * Non-string values are treated as absent so a malformed file does
 * not poison the canonical lookup.
 */
export function readMergedInto(meta: Readonly<Record<string, unknown>>): string | null {
  const v = meta["merged_into"];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

/**
 * What a page id points at, for a set of pages a caller already holds.
 *
 * The merge graph lives in frontmatter, so every question about it is
 * really a question about a pointer lookup. Passing the lookup rather
 * than a vault path is what lets one definition of "already resolved"
 * serve a detector working from records it has parsed and a writer
 * working from files on disk.
 */
export type MergePointerLookup = (id: string) => string | null;

/**
 * A {@link MergePointerLookup} over pages already in memory. Entries are
 * `[id, pointer]` pairs; a `null` or empty pointer means the page
 * carries none.
 */
export function mergePointerLookup(
  entries: Iterable<readonly [string, string | null]>,
): MergePointerLookup {
  const pointers = new Map<string, string>();
  for (const [id, target] of entries) {
    if (target !== null && target.trim().length > 0) pointers.set(id, target.trim());
  }
  return (id) => pointers.get(id) ?? null;
}

/**
 * True when a merge has already resolved this page into another one -
 * the single definition every duplicate detector asks (GitHub #180).
 *
 * The test is the presence of a pointer, not where the pointer leads,
 * and that IS the transitive answer rather than an approximation of one:
 * a chain (`b -> x -> a`), a pointer that leaves the group entirely, and
 * a pointer whose target nobody kept all begin with a pointer on this
 * page. A page that has been de-canonicalised is not a merge candidate
 * again whatever its canonical turned out to be, so following the chain
 * further could only ever confirm what the first hop already said.
 *
 * A DANGLING target is deliberately included. It means the merge
 * happened and the canonical was later lost - a lint problem, never a
 * licence to re-merge the page at some new canonical and overwrite the
 * record of the first decision.
 *
 * Where the chain leads does matter to the write seam, which has to
 * refuse a pointer that would close a loop; that question is
 * {@link resolveCanonicalId}'s, and it walks.
 */
export function isMergeResolved(id: string, pointerOf: MergePointerLookup): boolean {
  return pointerOf(id) !== null;
}

/**
 * Strict page-id format: `pref-<slug>` or `ret-<slug>` where the
 * slug matches the same `[a-z0-9-]+` shape `validateSlug` enforces.
 * Anything else - path separators, newlines, dots, uppercase - is
 * rejected so a crafted `merged_into:` value cannot escape the
 * Brain/ dirs or inject extra YAML keys into a write.
 */
const PAGE_ID_RE = /^(pref|ret)-[a-z0-9-]+$/;

function isValidPageId(id: string): boolean {
  return PAGE_ID_RE.test(id);
}

function pageIdToPath(vault: string, id: string): string | null {
  if (!isValidPageId(id)) return null;
  const dirs = brainDirs(vault);
  if (id.startsWith("pref-")) return join(dirs.preferences, `${id}.md`);
  return join(dirs.retired, `${id}.md`);
}

/**
 * Follow the `merged_into:` chain from a starting page id to its
 * canonical destination. The walk terminates when a page has no
 * `merged_into` set or the chain exceeds {@link MERGE_CHAIN_MAX_DEPTH}.
 *
 * Throws {@link MergeChainError}:
 *   - `CYCLE`     when the same id is visited twice.
 *   - `DEPTH`     when the chain is longer than the cap.
 *   - `MALFORMED` when an intermediate target id has neither `pref-`
 *                 nor `ret-` prefix.
 */
export function resolveCanonicalId(vault: string, startId: string): string {
  const visited = new Set<string>();
  let current = startId;
  for (let depth = 0; depth <= MERGE_CHAIN_MAX_DEPTH; depth++) {
    if (visited.has(current)) {
      throw new MergeChainError("CYCLE", current, `merge cycle detected at ${current}`);
    }
    visited.add(current);

    const path = pageIdToPath(vault, current);
    if (path === null) {
      throw new MergeChainError("MALFORMED", current, `page id has no known prefix: ${current}`);
    }
    if (!existsSync(path)) {
      // Dangling pointer - the canonical page was moved or deleted.
      // Treat the current id as terminal so we surface the broken
      // chain to the caller without throwing on every read.
      return current;
    }
    let meta: Record<string, unknown>;
    try {
      [meta] = parseFrontmatter(path);
    } catch {
      return current;
    }
    const next = readMergedInto(meta);
    if (next === null) return current;
    current = next;
  }
  throw new MergeChainError(
    "DEPTH",
    startId,
    `merge chain exceeds ${MERGE_CHAIN_MAX_DEPTH} hops starting at ${startId}`,
  );
}

/**
 * Stamp `merged_into: <canonical>` into the secondary page's
 * frontmatter and rewrite the file. The secondary keeps all other
 * fields and body content - the pointer is the only signal that a
 * merge happened. Returns the resolved canonical id.
 *
 * The caller is responsible for picking which side is the canonical
 * and which is the secondary; this function only writes the pointer.
 */
export function setMergedInto(vault: string, secondaryId: string, canonicalId: string): string {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (!isValidPageId(secondaryId)) {
    throw new MergeChainError(
      "MALFORMED",
      secondaryId,
      `invalid secondary page id: ${secondaryId}`,
    );
  }
  if (!isValidPageId(canonicalId)) {
    throw new MergeChainError(
      "MALFORMED",
      canonicalId,
      `invalid canonical page id: ${canonicalId}`,
    );
  }
  if (secondaryId === canonicalId) {
    throw new MergeChainError(
      "CYCLE",
      secondaryId,
      `cannot point a page at itself: ${secondaryId}`,
    );
  }
  const secondaryPath = pageIdToPath(vault, secondaryId);
  if (secondaryPath === null || !existsSync(secondaryPath)) {
    throw new MergeChainError("MALFORMED", secondaryId, `secondary page not found: ${secondaryId}`);
  }
  const raw = readFileSync(secondaryPath, "utf8");
  if (raw.startsWith("---\n")) {
    // Inject `merged_into: <canonical>` right before the closing
    // frontmatter fence. Idempotent: replace the existing line when
    // present.
    const end = raw.indexOf("\n---\n", 4);
    if (end < 0) {
      throw new MergeChainError(
        "MALFORMED",
        secondaryId,
        `frontmatter has no closing fence: ${secondaryPath}`,
      );
    }
    const head = raw.slice(0, end);
    const tail = raw.slice(end);
    const existingPattern = /^merged_into:\s.*$/m;
    let nextHead: string;
    if (existingPattern.test(head)) {
      nextHead = head.replace(existingPattern, `merged_into: ${canonicalId}`);
    } else {
      nextHead = `${head}\nmerged_into: ${canonicalId}`;
    }
    const next = `${nextHead}${tail}`;
    if (next !== raw) {
      atomicWriteFileSync(secondaryPath, next);
    }
    return canonicalId;
  }
  throw new MergeChainError("MALFORMED", secondaryId, `file has no frontmatter: ${secondaryPath}`);
}
