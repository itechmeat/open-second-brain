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
 *
 * A cycle DID happen (GitHub #180), so "should never" is now enforced
 * where the pointer is written rather than only survived where it is
 * read: {@link setMergedInto} refuses a write that would close a loop
 * and refuses to silently repoint a page that is already merged.
 * {@link isMergeResolved} is the one definition of "already merged"
 * every duplicate detector in the project asks.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export const MERGE_CHAIN_MAX_DEPTH = 5;

/**
 * What went wrong with a merge chain, or with a write that would have
 * broken one. `REPOINT` is a refusal rather than a corruption: the page
 * on disk is intact and the caller asked for something it has to say
 * out loud.
 */
export type MergeChainErrorCode = "CYCLE" | "DEPTH" | "MALFORMED" | "REPOINT";

export class MergeChainError extends Error {
  readonly code: MergeChainErrorCode;
  readonly id: string;
  constructor(code: MergeChainErrorCode, id: string, message: string) {
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
 * The `merged_into:` pointer a page on disk carries, or `null`.
 *
 * `null` for a page id with no known prefix, for a target file nobody
 * kept, and for frontmatter that will not parse. All three end a walk
 * at the id that named them, which is what lets the caller say what is
 * wrong with THAT id rather than with the chain as a whole.
 */
function filePointerLookup(vault: string): MergePointerLookup {
  return (id) => {
    const path = pageIdToPath(vault, id);
    if (path === null || !existsSync(path)) return null;
    try {
      const [meta] = parseFrontmatter(path);
      return readMergedInto(meta);
    } catch {
      return null;
    }
  };
}

/** Why a {@link walkMergeChain} stopped where it did. */
type MergeWalkOutcome = "terminal" | "cycle" | "depth";

/** Where following one page's `merged_into:` chain led. */
interface MergeChainWalk {
  /** Ids visited in order, starting with the id the walk began at. */
  readonly visited: ReadonlyArray<string>;
  readonly outcome: MergeWalkOutcome;
  /**
   * The id the outcome is about: the terminal page, or the one the walk
   * came back to. Meaningless for `depth`, where no single id is at
   * fault.
   */
  readonly at: string;
}

/**
 * Follow a merge chain from `startId` through `pointerOf`, bounded at
 * {@link MERGE_CHAIN_MAX_DEPTH} hops.
 *
 * Reports rather than throws, because its two callers ask different
 * questions of the same walk: {@link resolveCanonicalId} wants the
 * destination and raises on a broken chain, while the write seam only
 * wants to know whether one particular id is already on the path.
 */
function walkMergeChain(startId: string, pointerOf: MergePointerLookup): MergeChainWalk {
  const visited: string[] = [];
  const seen = new Set<string>();
  let current = startId;
  for (let depth = 0; depth <= MERGE_CHAIN_MAX_DEPTH; depth++) {
    if (seen.has(current)) return { visited, outcome: "cycle", at: current };
    seen.add(current);
    visited.push(current);
    const next = pointerOf(current);
    if (next === null) return { visited, outcome: "terminal", at: current };
    current = next;
  }
  return { visited, outcome: "depth", at: startId };
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
 *
 * A DANGLING pointer is not an error: the id whose file is missing is
 * returned as terminal, so a reader sees the broken chain instead of a
 * throw on every read. An id with no known prefix reaches the same
 * terminal state - it can have no file and so no pointer - which is why
 * the malformed check reads the id the walk stopped at.
 */
export function resolveCanonicalId(vault: string, startId: string): string {
  const walk = walkMergeChain(startId, filePointerLookup(vault));
  if (walk.outcome === "cycle") {
    throw new MergeChainError("CYCLE", walk.at, `merge cycle detected at ${walk.at}`);
  }
  if (walk.outcome === "depth") {
    throw new MergeChainError(
      "DEPTH",
      startId,
      `merge chain exceeds ${MERGE_CHAIN_MAX_DEPTH} hops starting at ${startId}`,
    );
  }
  if (!isValidPageId(walk.at)) {
    throw new MergeChainError("MALFORMED", walk.at, `page id has no known prefix: ${walk.at}`);
  }
  return walk.at;
}

export interface SetMergedIntoOptions {
  /**
   * Replace a pointer that names a DIFFERENT canonical, instead of
   * refusing. The caller is stating that it knows the page was already
   * merged somewhere and means to move it; nothing in this project sets
   * it today, and a batch pass must not.
   */
  readonly repoint?: boolean;
}

export interface SetMergedIntoResult {
  readonly secondary: string;
  /** The canonical the page points at now. */
  readonly canonical: string;
  /** What it pointed at before; `null` when it carried no pointer. */
  readonly previous: string | null;
  /** False when the page already said exactly this - no bytes written. */
  readonly changed: boolean;
}

/**
 * Stamp `merged_into: <canonical>` into the secondary page's
 * frontmatter and rewrite the file. The secondary keeps all other
 * fields and body content - the pointer is the only signal that a
 * merge happened.
 *
 * The caller is responsible for picking which side is the canonical
 * and which is the secondary; this function only writes the pointer.
 *
 * Two refusals, both added after GitHub #180 reproduced them (and both
 * kept at the seam that does the damage rather than only at the pass
 * that proposes a merge, since a proposer can be wrong and a second one
 * can be written):
 *
 *   - A page already pointing at a DIFFERENT canonical is not
 *     overwritten. That overwrite was silent, and it destroyed the
 *     record of an operator's own merge decision on every re-run of a
 *     batch pass. `repoint` is how a caller says it means to move one.
 *     Re-setting the SAME canonical is not a repoint: it changes
 *     nothing, writes nothing, and reports `changed: false`.
 *   - A pointer whose canonical already resolves back through the
 *     secondary is refused, because the pair would then resolve to
 *     nothing at all: `resolveCanonicalId` raises `CYCLE` and
 *     `lint --consolidate` loses the ability to repair any link to
 *     either page.
 */
export function setMergedInto(
  vault: string,
  secondaryId: string,
  canonicalId: string,
  opts: SetMergedIntoOptions = {},
): SetMergedIntoResult {
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
  if (!raw.startsWith("---\n")) {
    throw new MergeChainError(
      "MALFORMED",
      secondaryId,
      `file has no frontmatter: ${secondaryPath}`,
    );
  }
  // Inject `merged_into: <canonical>` right before the closing
  // frontmatter fence, replacing the existing line when present.
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
  const existing = head.match(EXISTING_POINTER_RE);
  const previous = existing === null ? null : existing[1]!.trim();

  if (previous === canonicalId) {
    return Object.freeze({
      secondary: secondaryId,
      canonical: canonicalId,
      previous,
      changed: false,
    });
  }
  if (walkMergeChain(canonicalId, filePointerLookup(vault)).visited.includes(secondaryId)) {
    throw new MergeChainError(
      "CYCLE",
      secondaryId,
      `refusing to merge ${secondaryId} into ${canonicalId}: ${canonicalId} already resolves ` +
        `through ${secondaryId}`,
    );
  }
  if (previous !== null && opts.repoint !== true) {
    throw new MergeChainError(
      "REPOINT",
      secondaryId,
      `${secondaryId} is already merged into ${previous}; refusing to repoint it at ` +
        `${canonicalId} without an explicit repoint`,
    );
  }

  const nextHead =
    previous === null
      ? `${head}\nmerged_into: ${canonicalId}`
      : head.replace(EXISTING_POINTER_RE, `merged_into: ${canonicalId}`);
  atomicWriteFileSync(secondaryPath, `${nextHead}${tail}`);
  return Object.freeze({
    secondary: secondaryId,
    canonical: canonicalId,
    previous,
    changed: true,
  });
}

/** The `merged_into:` line already in a page's frontmatter, if any. */
const EXISTING_POINTER_RE = /^merged_into:\s(.*)$/m;
