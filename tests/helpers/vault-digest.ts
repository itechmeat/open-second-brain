/**
 * Test helper: the one tree digest every "wrote nothing" assertion uses.
 *
 * "The dry run wrote nothing" is only worth asserting if it covers the
 * whole tree. Spot-checking the two files a preview was expected to touch
 * cannot catch a write somewhere the test author did not think to look -
 * an audit record, a lock left behind, a rebuilt projection - and those
 * are exactly the writes a preview must not make.
 *
 * Directories and symlinks are entries too: a switched writer that runs
 * `mkdirSync(Brain/log/..., { recursive: true })` before it routes to the
 * store, or leaves an empty lock or lane folder behind, recreates the
 * legacy tree (the condition the doctor reports as
 * `legacy-tree-reappeared`) without writing a single file, and a
 * files-only digest cannot see that.
 *
 * {@link digestVaultTree} answers "did anything at all change?" in one
 * value; {@link treeEntries} answers "which entries changed?", which is
 * what an apply-changed-exactly-the-reported-set assertion needs;
 * {@link treeSnapshot} is the same entries as readable sorted lines, so a
 * failing comparison names the entry. With `mtime: true` a touched entry
 * (rewritten with the same bytes, or a directory whose listing changed and
 * changed back) counts as a change as well.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Options of the tree digests. */
export interface TreeDigestOptions {
  /** Also record each entry's modification time (catches a touch). */
  readonly mtime?: boolean;
}

/**
 * Every entry under `root`, keyed by POSIX-style root-relative path:
 * `d` for a directory, `f <sha256>` for a file, `l <target>` for a
 * symlink, `special` for anything else.
 */
export function treeEntries(root: string, opts: TreeDigestOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    const names = readdirSync(dir).toSorted();
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      const stat = lstatSync(abs);
      const when = opts.mtime === true ? ` @${stat.mtimeMs}` : "";
      if (stat.isDirectory()) {
        out.set(rel, `d${when}`);
        walk(abs);
      } else if (stat.isFile()) {
        out.set(rel, `f ${createHash("sha256").update(readFileSync(abs)).digest("hex")}${when}`);
      } else if (stat.isSymbolicLink()) {
        out.set(rel, `l ${readlinkSync(abs)}${when}`);
      } else {
        out.set(rel, `special${when}`);
      }
    }
  };
  walk(root);
  return out;
}

/** {@link treeEntries} as sorted `<rel> <descriptor>` lines. */
export function treeSnapshot(root: string, opts: TreeDigestOptions = {}): string[] {
  return [...treeEntries(root, opts)].map(([rel, what]) => `${rel} ${what}`).toSorted();
}

/**
 * One digest over every entry under `root`, path names included, so a
 * created or deleted file or directory changes the value as surely as an
 * edited file.
 */
export function digestVaultTree(root: string, opts: TreeDigestOptions = {}): string {
  const hash = createHash("sha256");
  for (const line of treeSnapshot(root, opts)) hash.update(`${line}\n`);
  return hash.digest("hex");
}

/**
 * Root-relative paths whose entry differs between two snapshots,
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

/** `"h":"<64 hex>"` / `"prev":"<64 hex>"`, capturing the key. */
const LOG_CHAIN_DIGEST_RE = /("(?:prev|h)":)"[0-9a-f]{64}"/g;

/**
 * The Brain log's chain digests, masked (who-wrote-what, Task E).
 *
 * Every JSONL log row carries `h`, a sha256 over its own `{ prev, ts,
 * kind, payload }`, and `prev`, the previous row's `h`. A byte-for-byte
 * comparison of two independently produced vaults therefore inherits
 * every exemption the payload already needed: the `snapshot` audit row
 * records an archive's byte length, tar embeds per-entry mtimes, so two
 * identically seeded vaults differ there - and once they differ there,
 * the hash of that row and of every row after it differs too. A test
 * that normalises the length without normalising the hash is asking the
 * chain to be blind to a value it has just declared unreproducible.
 *
 * Only the 64-hex DIGEST is masked. The key names stay, and
 * `"prev":null` is deliberately left alone, so the comparison still
 * asserts that every row carries a hash and that exactly the same rows
 * anchor their shard's chain in both trees.
 */
export function maskLogChainDigests(text: string): string {
  return text.replaceAll(LOG_CHAIN_DIGEST_RE, '$1"<chain-digest>"');
}
