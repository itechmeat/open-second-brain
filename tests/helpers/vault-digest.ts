/**
 * Test helper: content digests over a vault tree.
 *
 * "The dry run wrote nothing" is only worth asserting if it covers the
 * whole tree. Spot-checking the two files a preview was expected to touch
 * cannot catch a write somewhere the test author did not think to look -
 * an audit record, a lock left behind, a rebuilt projection - and those
 * are exactly the writes a preview must not make.
 *
 * {@link digestVaultTree} answers "did anything at all change?" in one
 * value; {@link digestVaultFiles} answers "which files changed?", which
 * is what an apply-changed-exactly-the-reported-set assertion needs.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Per-file content digests, keyed by POSIX-style vault-relative path. */
export function digestVaultFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * One digest over every file under `root`, path names included, so a
 * created or deleted file changes the value as surely as an edited one.
 */
export function digestVaultTree(root: string): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...digestVaultFiles(root)].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    hash.update(`${path}\0${digest}\n`);
  }
  return hash.digest("hex");
}

/**
 * Vault-relative paths whose content differs between two snapshots,
 * including files that appeared or vanished. Sorted, so a test can
 * compare the set against a reported one directly.
 */
export function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, digest] of before) if (after.get(path) !== digest) changed.add(path);
  for (const [path, digest] of after) if (before.get(path) !== digest) changed.add(path);
  return [...changed].toSorted();
}
