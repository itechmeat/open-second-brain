/**
 * Atomic in-place annotation of `@osb` markers with their captured
 * signal id.
 *
 * Two shapes:
 *
 *   - Inline: prepend `✓ [[<sig-id>]] ` between `@osb` and the rest of
 *     the line. The leading sentinel `@osb✓` is what {@link
 *     discoverMarkers} skips on a re-run, providing idempotency.
 *
 *   - Block: flip the opening info-string `osb` → `osb-checked` and
 *     insert `<!-- @osb✓ [[<sig-id>]] -->` as the new first body line.
 *     The fence body is preserved verbatim so the human-readable
 *     payload stays in the source file (Obsidian renderers don't
 *     interpret HTML comments inside fenced blocks).
 *
 * Concurrency: a `proper-lockfile` lock on the parent directory
 * serialises rewrites — the same shared-lock pattern as
 * {@link appendEvent}. Per-file locks would race against the temp
 * file `atomicWriteFileSync` itself creates next to the target.
 *
 * Atomicity: writes go through {@link atomicWriteFileSync}, which
 * uses the tmp-file-and-rename pattern. A crash mid-rewrite leaves
 * the previous version intact; the new version becomes visible only
 * after the directory entry is updated.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { ParsedMarker } from "./inline.ts";

export interface RewriteOp {
  readonly marker: ParsedMarker;
  /** Resulting `sig-<date>-<slug>` (or any other id) to embed. */
  readonly signalId: string;
}

/**
 * Apply every op to the file at `path`. Ops are applied in document
 * order; line-shift from inserting a block-comment is handled by
 * processing the op list in reverse (so earlier line indices stay
 * valid).
 */
export async function rewriteMarkers(
  path: string,
  ops: ReadonlyArray<RewriteOp>,
): Promise<void> {
  if (ops.length === 0) return;

  // proper-lockfile requires the target to exist; locking the parent
  // dir mirrors what `appendEvent` does for Daily/.
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  const release = await lockfile.lock(parent, {
    retries: { retries: 30, factor: 1.2, minTimeout: 30, maxTimeout: 500 },
    stale: 10_000,
    realpath: false,
  });
  try {
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n");

    // Sort ops descending by originLine so that inserts in block-form
    // ops don't shift the line indices of earlier ops.
    const sorted = [...ops].sort(
      (a, b) => b.marker.originLine - a.marker.originLine,
    );

    for (const op of sorted) {
      const idx = op.marker.originLine - 1;
      if (idx < 0 || idx >= lines.length) {
        // Off-the-end: file changed since the marker was discovered.
        // Skip silently rather than corrupt; the caller's next
        // `discoverMarkers` will re-find the live state.
        continue;
      }
      if (op.marker.shape === "inline") {
        const line = lines[idx]!;
        // Replace the leading '@osb' with '@osb✓ [[id]]' — preserve any
        // leading whitespace.
        const replaced = line.replace(
          /@osb(?=\s)/,
          `@osb✓ [[${op.signalId}]]`,
        );
        lines[idx] = replaced;
      } else {
        // Block form: idx points at the opening ```osb line. Use an
        // exact-match check so an already-rewritten `\`\`\`osb-checked`
        // fence (from a stale op replay) cannot be re-annotated.
        const fenceLine = lines[idx]!;
        if (!/^\s*```osb\s*$/.test(fenceLine)) {
          continue;
        }
        // Preserve any leading whitespace before the fence (CommonMark
        // allows up to 3 spaces of indentation on a fence).
        const indent = fenceLine.match(/^\s*/)?.[0] ?? "";
        lines[idx] = `${indent}\`\`\`osb-checked`;
        // Insert the HTML-comment sentinel as the first body line.
        lines.splice(idx + 1, 0, `<!-- @osb✓ [[${op.signalId}]] -->`);
      }
    }

    const updated = lines.join("\n");
    if (updated === original) return; // nothing to do (defensive)
    atomicWriteFileSync(path, updated);
  } finally {
    await release();
  }
}
