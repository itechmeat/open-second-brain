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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";

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
export function readMergedInto(
  meta: Readonly<Record<string, unknown>>,
): string | null {
  const v = meta["merged_into"];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

function pageIdToPath(vault: string, id: string): string | null {
  const dirs = brainDirs(vault);
  if (id.startsWith("pref-")) return join(dirs.preferences, `${id}.md`);
  if (id.startsWith("ret-")) return join(dirs.retired, `${id}.md`);
  return null;
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
      throw new MergeChainError(
        "MALFORMED",
        current,
        `page id has no known prefix: ${current}`,
      );
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
export function setMergedInto(
  vault: string,
  secondaryId: string,
  canonicalId: string,
): string {
  if (secondaryId === canonicalId) {
    throw new MergeChainError(
      "CYCLE",
      secondaryId,
      `cannot point a page at itself: ${secondaryId}`,
    );
  }
  const secondaryPath = pageIdToPath(vault, secondaryId);
  if (secondaryPath === null || !existsSync(secondaryPath)) {
    throw new MergeChainError(
      "MALFORMED",
      secondaryId,
      `secondary page not found: ${secondaryId}`,
    );
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
      writeFileSync(secondaryPath, next, "utf8");
    }
    return canonicalId;
  }
  throw new MergeChainError(
    "MALFORMED",
    secondaryId,
    `file has no frontmatter: ${secondaryPath}`,
  );
}
