/**
 * Content hash used by `o2b brain scan-inline` (§9) and `o2b brain
 * import-session` (§16) to dedup signals.
 *
 * The hash is computed over a normalised view of the signal payload —
 * topic, signal sign, principle, scope. Two payloads that describe
 * the same rule hash identically even when the source text differs
 * in cosmetic ways (Unicode normal form, whitespace, missing-vs-empty
 * scope). A real edit to `principle` (typo fix, rephrasing) changes
 * the hash — by design: the user re-stated the rule, treat it as a
 * fresh signal.
 *
 * `agent` is deliberately excluded. The same rule from two different
 * agents is still one rule; dream is what assigns provenance through
 * `evidenced_by`.
 *
 * Output: lowercase hex sha256 (64 chars).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { brainDirs } from "./paths.ts";
import { normalizeForDedup } from "./text/normalize.ts";

export interface DedupHashInput {
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
}

export interface DedupIndexEntry {
  readonly id: string;
  readonly path: string;
}

/**
 * Read-side complement of {@link computeDedupHash}. Walks
 * `Brain/inbox/` and `Brain/inbox/processed/`, parses every
 * `sig-*.md`, and builds `hash → {id, path}` (first-seen wins).
 *
 * Shared between `o2b brain scan-inline` and `o2b brain
 * import-session` so the two capture paths cross-deduplicate
 * automatically. Both surfaces also mutate the returned map as new
 * signals are written, which keeps the index hot for the rest of
 * the run.
 *
 * `onError` is an optional sink for per-file parse failures. By
 * default they are silently skipped — the doctor command surfaces
 * malformed signals separately, and the dedup builder is best-effort.
 */
export function buildDedupIndex(
  vault: string,
  opts: { onError?: (path: string, message: string) => void } = {},
): Map<string, DedupIndexEntry> {
  const out = new Map<string, DedupIndexEntry>();
  const dirs = brainDirs(vault);
  for (const dir of [dirs.inbox, dirs.processed]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || !name.startsWith("sig-")) continue;
      const path = join(dir, name);
      try {
        const [meta] = parseFrontmatter(path);
        const hash = meta["dedup_hash"];
        const id = meta["id"];
        if (
          typeof hash === "string" &&
          typeof id === "string" &&
          hash.length > 0 &&
          !out.has(hash)
        ) {
          out.set(hash, { id, path });
        }
      } catch (err) {
        opts.onError?.(
          path,
          `dedup-index parse failed: ${(err as Error).message ?? String(err)}`,
        );
      }
    }
  }
  return out;
}

export function computeDedupHash(input: DedupHashInput): string {
  // Use NUL as the field separator so a topic / principle containing
  // any printable character can't collide with the next field's prefix.
  const parts = [
    normalizeForDedup(input.topic.trim()),
    input.signal,
    normalizeForDedup(input.principle.trim().replace(/\s+/g, " ")),
    normalizeForDedup((input.scope ?? "").trim()),
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
