/**
 * Pre-`dream` snapshot, rotation, and rollback support.
 *
 * The contract (design doc §7.4 "Pre-run snapshot" + §15 Step 9a):
 *
 *   - Before any state-changing operation in a `dream` run we write
 *     `Brain/.snapshots/<run_id>.tar.zst` containing the entire
 *     `Brain/` tree **excluding** `Brain/.snapshots/` itself.
 *     Including the snapshots dir would either explode the archive or
 *     racy-clobber an in-progress write.
 *
 *   - Retention is enforced by `pruneSnapshots`: keep the
 *     `snapshots.retention_count` newest files, delete the rest.
 *
 *   - `restoreSnapshot` extracts the archive over `Brain/`. Critical
 *     constraint: the restore must NOT touch `Brain/.snapshots/`,
 *     otherwise rolling back to an older state could destroy newer
 *     snapshots (and with them the user's only path forward again).
 *     We achieve this by extracting into a sibling temp directory,
 *     verifying the contents, then replacing every top-level entry
 *     under `Brain/` *except* `.snapshots/`.
 *
 *   - Tooling: we shell out to system `tar` and `zstd`. Both are
 *     ubiquitous on the deployment surface (Linux server, macOS dev
 *     workstations, every shared CI runner). Falling back to gzip
 *     when `zstd` is absent keeps the feature usable on minimal
 *     containers; falling back to nothing when `tar` is absent throws
 *     {@link BrainSnapshotToolingMissingError} with an actionable
 *     message.
 *
 * No external dependencies. Everything is `node:child_process` +
 * `node:fs` so the cost is one subprocess per archive operation.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildManifest, manifestSidecarPath, writeManifestSidecar } from "./manifest.ts";
import { BRAIN_ROOT_REL, brainDirs, snapshotPath, validateRunId } from "./paths.ts";

// ----- Errors ---------------------------------------------------------------

/**
 * Thrown when the host lacks both `tar` and any compressor we know how
 * to use. Distinct from `BrainSnapshotError` so callers can pattern-
 * match and offer install instructions.
 */
export class BrainSnapshotToolingMissingError extends Error {
  constructor(tool: string, hint: string) {
    super(`snapshot tooling missing: '${tool}' not found on PATH. ${hint}`);
    this.name = "BrainSnapshotToolingMissingError";
  }
}

/**
 * Generic snapshot failure (archive write failed, restore failed,
 * archive contents corrupted). Includes the runId in the message so
 * the operator can locate it.
 */
export class BrainSnapshotError extends Error {
  readonly runId: string;
  constructor(message: string, runId: string) {
    super(`snapshot[${runId}]: ${message}`);
    this.name = "BrainSnapshotError";
    this.runId = runId;
  }
}

// ----- Types ---------------------------------------------------------------

export interface CreateSnapshotResult {
  /** Absolute path of the resulting archive. */
  readonly path: string;
}

export interface SnapshotInfo {
  readonly run_id: string;
  readonly path: string;
  /** ISO-8601 UTC mtime of the archive file. */
  readonly created_at: string;
  readonly size_bytes: number;
  /**
   * Absolute path of the sidecar manifest, or `null` when the
   * sidecar write failed at snapshot time (read-only directory or
   * similar). Rollback gracefully degrades on `null`.
   */
  readonly manifest_path: string | null;
}

export interface PruneSnapshotsResult {
  /** Vault-relative path of each deleted archive. */
  readonly deleted: ReadonlyArray<string>;
}

export interface RestoreSnapshotResult {
  /** Number of regular files restored under `Brain/` (excluding `.snapshots/`). */
  readonly restored_files: number;
}

// ----- Tooling detection ---------------------------------------------------

interface ToolAvailability {
  readonly tar: boolean;
  readonly zstd: boolean;
  readonly gzip: boolean;
}

/**
 * Detect tool availability by walking `process.env.PATH` and checking
 * the candidate binary exists. We deliberately avoid `spawnSync(cmd,
 * ["--version"])` because the underlying Node/Bun runtime resolves
 * commands against an internal PATH snapshot taken at process start
 * — so tests that mutate `process.env.PATH` between calls would have
 * no effect on a `spawnSync` probe. Reading the filesystem at probe
 * time keeps the detection honest and test-controllable.
 *
 * The cost (a handful of `existsSync` calls) is dwarfed by the actual
 * archive operation that follows.
 */
function detectTooling(): ToolAvailability {
  const pathEnv = process.env["PATH"] ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
  const probe = (cmd: string): boolean => {
    for (const d of dirs) {
      if (existsSync(join(d, cmd))) return true;
      // On Windows, executables have .exe extension
      if (process.platform === "win32" && existsSync(join(d, cmd + ".exe"))) return true;
    }
    return false;
  };
  return {
    tar: probe("tar"),
    zstd: probe("zstd"),
    gzip: probe("gzip"),
  };
}

// ----- createSnapshot ------------------------------------------------------

/**
 * Archive `Brain/` (except `.snapshots/`) into
 * `Brain/.snapshots/<run_id>.tar.zst`.
 *
 * Implementation:
 *
 *   1. Detect available tools. If `tar` is absent we throw.
 *   2. List the top-level entries under `Brain/`, drop `.snapshots/`.
 *   3. `tar -c -C <vault> Brain/<entry> ...` streamed into `zstd -19`
 *      (or `gzip -9` fallback) → output file.
 *
 * Using `--exclude=Brain/.snapshots` is tempting, but tar's exclude
 * pattern matching is shell-dependent and prone to subtle surprises
 * on filenames containing whitespace. Enumerating the kept entries
 * explicitly is byte-stable and easy to reason about.
 */
export function createSnapshot(vault: string, runId: string): CreateSnapshotResult {
  validateRunId(runId);
  const dirs = brainDirs(vault);
  mkdirSync(dirs.snapshots, { recursive: true });

  const outPath = snapshotPath(vault, runId);
  const tools = detectTooling();
  if (!tools.tar) {
    throw new BrainSnapshotToolingMissingError(
      "tar",
      "install GNU tar or BSD tar; both are supported.",
    );
  }

  // List top-level entries of Brain/ that we want to capture. Sort the
  // result so the resulting archive's contents are deterministic
  // across filesystems (readdirSync's order is FS-dependent).
  let topEntries: string[];
  try {
    topEntries = readdirSync(dirs.brain).filter((e) => e !== ".snapshots");
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to list Brain/: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  }
  topEntries.sort();
  if (topEntries.length === 0) {
    // No content to archive. Tar would still produce an empty archive,
    // which is fine — `restoreSnapshot` on an empty archive is a no-op
    // that doesn't delete anything (because the exclude-`.snapshots`
    // rule keeps the dir intact).
  }

  // Build `tar -c -C <vault> Brain/<entry> Brain/<entry>...` so paths
  // inside the archive start at `Brain/` — matching the rollback
  // contract that the archive is "the Brain/ tree".
  const tarArgs = ["-c", "-C", vault, "--", ...topEntries.map((e) => `${BRAIN_ROOT_REL}/${e}`)];

  if (tools.zstd) {
    runArchivePipeline(["tar", tarArgs], ["zstd", ["-19", "-q", "-o", outPath, "-"]], runId);
  } else if (tools.gzip) {
    // Same on-disk extension keeps the snapshot listing logic
    // homogeneous. The contents are gzip-compressed regardless; the
    // restore probes both compressors so this is safe.
    runArchivePipeline(["tar", tarArgs], ["gzip", ["-9", "-c"]], runId, outPath);
  } else {
    throw new BrainSnapshotToolingMissingError(
      "zstd or gzip",
      "install zstd (preferred) or gzip; we use the first available.",
    );
  }

  if (!existsSync(outPath)) {
    throw new BrainSnapshotError(`archive write reported success but ${outPath} is absent`, runId);
  }

  // Sidecar manifest. Failure is non-fatal: the archive is the
  // load-bearing artifact, and a snapshot without a manifest just
  // degrades rollback's drift detection to a silent-overwrite path
  // (with a warning at rollback time). The alternative — failing
  // the whole snapshot because the sidecar could not be written —
  // would block dream from making any progress on a read-only
  // `.snapshots/` directory.
  try {
    writeManifestSidecar(vault, runId, buildManifest(dirs.brain));
  } catch (err) {
    process.stderr.write(
      `warning: manifest sidecar write failed for snapshot ` +
        `'${runId}': ${(err as Error).message ?? String(err)}; ` +
        `rollback drift detection will be skipped for this snapshot.\n`,
    );
  }
  return { path: outPath };
}

/**
 * Run `producer | consumer` synchronously. On Linux `spawnSync`
 * supports a `stdio` pipe between two processes via the `input` field
 * — but we want a streaming pipe, not a full-buffer round-trip, since
 * the Brain tree could in principle exceed available memory. Use
 * `sh -c '<cmd1> | <cmd2>'` so the shell wires the pipe directly.
 *
 * Argument quoting: we deliberately do NOT shell-escape paths because
 * `tar -C <vault>` already roots everything relative to the vault,
 * and the only user-supplied bytes in `tarArgs` are the run id (which
 * `validateRunId` constrains to `[A-Za-z0-9._-]`) and the top-level
 * Brain/ entries (`inbox`, `preferences`, …) which are themselves
 * filesystem names produced by our own writers.
 *
 * For full safety against any future caller pattern, callers can
 * audit `tarArgs` to confirm no unconstrained user input lands here.
 */
function runArchivePipeline(
  producer: readonly [string, ReadonlyArray<string>],
  consumer: readonly [string, ReadonlyArray<string>],
  runId: string,
  outPath?: string,
): void {
  // We avoid shell pipe entirely: spawn the producer, capture its
  // stdout into a Buffer (acceptable: Brain trees are small —
  // typical compressed output is well under 1 MB per the design
  // doc), then feed it to the consumer's stdin synchronously.
  //
  // The previous approach used `sh -c "tar ... | zstd ..."` and broke
  // on quoting of paths with whitespace. Buffering through Node is
  // simpler and verifiably correct.
  const [prodCmd, prodArgs] = producer;
  const tarResult = spawnSync(prodCmd, [...prodArgs], {
    maxBuffer: 256 * 1024 * 1024, // 256 MB hard ceiling matches the design's "small" guarantee.
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (tarResult.error) {
    throw new BrainSnapshotError(`${prodCmd} failed to start: ${tarResult.error.message}`, runId);
  }
  if (tarResult.status !== 0) {
    const stderr = (tarResult.stderr ?? Buffer.from("")).toString("utf8").trim();
    throw new BrainSnapshotError(
      `${prodCmd} exited with status ${tarResult.status}: ${stderr}`,
      runId,
    );
  }
  const tarPayload = tarResult.stdout;
  if (!tarPayload) {
    throw new BrainSnapshotError(`${prodCmd} produced no stdout`, runId);
  }

  const [consCmd, consArgs] = consumer;
  // `zstd -o <out>` opens the file itself; gzip writes to stdout and
  // we pipe to file via `outPath`.
  if (outPath === undefined) {
    const r = spawnSync(consCmd, [...consArgs], {
      input: tarPayload,
      stdio: ["pipe", "inherit", "pipe"],
    });
    if (r.error) {
      throw new BrainSnapshotError(`${consCmd} failed to start: ${r.error.message}`, runId);
    }
    if (r.status !== 0) {
      const stderr = (r.stderr ?? Buffer.from("")).toString("utf8").trim();
      throw new BrainSnapshotError(`${consCmd} exited with status ${r.status}: ${stderr}`, runId);
    }
  } else {
    // gzip pipeline → capture stdout, write to file.
    const r = spawnSync(consCmd, [...consArgs], {
      input: tarPayload,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) {
      throw new BrainSnapshotError(`${consCmd} failed to start: ${r.error.message}`, runId);
    }
    if (r.status !== 0) {
      const stderr = (r.stderr ?? Buffer.from("")).toString("utf8").trim();
      throw new BrainSnapshotError(`${consCmd} exited with status ${r.status}: ${stderr}`, runId);
    }
    // Write the compressed payload to the snapshot file atomically.
    // Use writeFileSync since the file is binary and lives inside
    // `.snapshots/` (no Markdown parser cares about torn writes here;
    // worst case is a corrupt archive that fails on restore — same
    // outcome as any other interrupted snapshot).
    writeFileSync(outPath, r.stdout ?? Buffer.from(""));
  }
}

// ----- listSnapshots / pruneSnapshots --------------------------------------

/**
 * Enumerate `.snapshots/*.tar.zst` in newest-first order (by mtime).
 * Files outside the canonical naming pattern are silently skipped so
 * a stray text file in the dir doesn't poison the listing.
 */
export function listSnapshots(vault: string): SnapshotInfo[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.snapshots)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dirs.snapshots);
  } catch {
    return [];
  }
  const infos: SnapshotInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(".tar.zst")) continue;
    const runId = name.slice(0, -".tar.zst".length);
    // The `.snapshots/` dir is ours, so a malformed run_id here would
    // indicate manual tampering — we keep the listing tolerant and
    // skip rather than throw.
    try {
      validateRunId(runId);
    } catch {
      continue;
    }
    const full = join(dirs.snapshots, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const sidecar = manifestSidecarPath(vault, runId);
    infos.push({
      run_id: runId,
      path: full,
      created_at: new Date(st.mtimeMs).toISOString(),
      size_bytes: st.size,
      manifest_path: existsSync(sidecar) ? sidecar : null,
    });
  }
  // Sort newest-first by mtime. We deliberately avoid lexicographic
  // sort on the run_id because manual rollback runs might use a
  // non-timestamped id and we still want them to land where the
  // operator's mental model expects (most recent first).
  infos.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return infos;
}

/**
 * Delete all but the `retention_count` newest archives. Returns the
 * paths that were deleted, vault-relative. Idempotent — a second run
 * on the same dir returns `deleted: []`.
 */
export function pruneSnapshots(vault: string, retentionCount: number): PruneSnapshotsResult {
  if (!Number.isInteger(retentionCount) || retentionCount < 0) {
    throw new Error(
      `pruneSnapshots: retentionCount must be a non-negative integer; got ${retentionCount}`,
    );
  }
  const all = listSnapshots(vault);
  if (all.length <= retentionCount) {
    return { deleted: [] };
  }
  const victims = all.slice(retentionCount);
  const deleted: string[] = [];
  for (const v of victims) {
    try {
      rmSync(v.path, { force: true });
      deleted.push(v.path);
    } catch {
      // Best-effort: a snapshot we can't delete (permission error)
      // stays put. The next dream run will try again.
    }
    // Remove the matching sidecar manifest if present. Independent
    // try/catch so a missing sidecar (snapshot whose sidecar write
    // failed at creation time) must not abort the prune of
    // subsequent victims.
    if (v.manifest_path !== null) {
      try {
        rmSync(v.manifest_path, { force: true });
      } catch {
        // Same rationale as above — best-effort.
      }
    }
  }
  return { deleted };
}

// ----- restoreSnapshot -----------------------------------------------------

/**
 * Restore the archive identified by `runId` over `Brain/`. The current
 * `.snapshots/` directory is preserved verbatim so older rollbacks
 * still have a path back.
 *
 * Steps:
 *
 *   1. Locate the archive.
 *   2. Extract into a sibling temp dir.
 *   3. Verify the extracted tree contains a `Brain/` root.
 *   4. For each top-level entry under the extracted `Brain/` (which
 *      excludes `.snapshots/` by virtue of how the archive was
 *      written), remove the corresponding live entry and copy the
 *      extracted one into place.
 *   5. Clean up the temp dir.
 */
/**
 * Result of {@link extractSnapshotToTemp}. `brainRoot` is the
 * extracted `Brain/` directory (sibling to the live tree, inside a
 * private tmp dir); `tmpRoot` is the parent directory the caller
 * owns. {@link cleanup} removes the tmp dir best-effort.
 */
export interface ExtractSnapshotResult {
  readonly tmpRoot: string;
  readonly brainRoot: string;
  readonly cleanup: () => void;
}

/**
 * Extract a snapshot archive into a private tmp directory and return
 * pointers to the materialised tree. The caller is responsible for
 * invoking {@link ExtractSnapshotResult.cleanup} once the data is no
 * longer needed.
 *
 * Used by:
 *   - {@link restoreSnapshot} — actually replaces the live tree.
 *   - `o2b brain rollback --dry-run` — previews the restore plan.
 *   - `o2b brain snapshot diff` — read-only inspector across two
 *     snapshots or a snapshot and the live tree.
 *
 * Shared so the tar / zstd / gzip decompression logic stays in one
 * place. Throws {@link BrainSnapshotError} on archive corruption /
 * missing root, {@link BrainSnapshotToolingMissingError} when the
 * host lacks the required external tool.
 */
export function extractSnapshotToTemp(vault: string, runId: string): ExtractSnapshotResult {
  validateRunId(runId);
  const archive = snapshotPath(vault, runId);
  if (!existsSync(archive)) {
    throw new BrainSnapshotError(`archive does not exist: ${archive}`, runId);
  }
  const tools = detectTooling();
  if (!tools.tar) {
    throw new BrainSnapshotToolingMissingError(
      "tar",
      "install GNU tar or BSD tar; both support the same -x command.",
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), `o2b-brain-extract-${runId}-`));
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // tmp cleanup is best-effort; the OS will reclaim it eventually.
    }
  };
  try {
    // Probe the magic bytes to decide how to decompress. zstd starts
    // with `28 B5 2F FD`; gzip with `1F 8B`. Anything else is rejected
    // — we don't blindly try every decompressor.
    const decompressor = detectArchiveCompression(archive);
    if (decompressor === "zstd" && !tools.zstd) {
      throw new BrainSnapshotToolingMissingError(
        "zstd",
        "archive is zstd-compressed; install zstd to restore it.",
      );
    }
    if (decompressor === "gzip" && !tools.gzip) {
      throw new BrainSnapshotToolingMissingError(
        "gzip",
        "archive is gzip-compressed; install gzip to restore it.",
      );
    }

    if (decompressor === "zstd") {
      const zstd = spawnSync("zstd", ["-d", "-c", archive], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (zstd.error || zstd.status !== 0) {
        const stderr = (zstd.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(
          `zstd decompress failed: ${zstd.error?.message ?? stderr}`,
          runId,
        );
      }
      // `-f -` is explicit stdin: GNU tar defaults to stdin without
      // it, but BSD tar and busybox tar do not, so passing the flag
      // keeps the extraction portable across hosts.
      const tar = spawnSync("tar", ["-x", "-f", "-", "-C", tmp], {
        input: zstd.stdout,
        stdio: ["pipe", "inherit", "pipe"],
      });
      if (tar.error || tar.status !== 0) {
        const stderr = (tar.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(`tar extract failed: ${tar.error?.message ?? stderr}`, runId);
      }
    } else {
      const tar = spawnSync("tar", ["-x", "-z", "-f", archive, "-C", tmp], {
        stdio: ["ignore", "inherit", "pipe"],
      });
      if (tar.error || tar.status !== 0) {
        const stderr = (tar.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(`tar extract failed: ${tar.error?.message ?? stderr}`, runId);
      }
    }

    const extractedBrain = join(tmp, BRAIN_ROOT_REL);
    if (!existsSync(extractedBrain)) {
      throw new BrainSnapshotError(`archive does not contain a ${BRAIN_ROOT_REL}/ root`, runId);
    }
    return Object.freeze({ tmpRoot: tmp, brainRoot: extractedBrain, cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function restoreSnapshot(
  vault: string,
  runId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future log emission
  _opts: { now?: Date } = {},
): RestoreSnapshotResult {
  const dirs = brainDirs(vault);
  const ext = extractSnapshotToTemp(vault, runId);
  try {
    // Replace every top-level entry under Brain/, EXCEPT `.snapshots/`.
    // The exclusion is the load-bearing safety guarantee: rolling back
    // an older state must not erase newer snapshots, otherwise the
    // operator is one click away from losing their forward path.
    const replacementEntries = readdirSync(ext.brainRoot).filter((e) => e !== ".snapshots");

    // The correct semantics are "live tree == snapshot tree minus
    // `.snapshots/`". Delete every live top-level entry except
    // `.snapshots/`, then copy in from the extracted Brain/. This
    // makes restore deterministic.
    const liveEntries = existsSync(dirs.brain)
      ? readdirSync(dirs.brain).filter((e) => e !== ".snapshots")
      : [];
    for (const name of liveEntries) {
      const target = join(dirs.brain, name);
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        throw new BrainSnapshotError(
          `failed to remove live entry ${name}: ${(err as Error).message ?? String(err)}`,
          runId,
        );
      }
    }
    // Copy in each extracted entry. `cpSync({ recursive: true })` is
    // available in Node 18+ and Bun, which is the target runtime.
    let restoredFiles = 0;
    mkdirSync(dirs.brain, { recursive: true });
    for (const name of replacementEntries) {
      const from = join(ext.brainRoot, name);
      const to = join(dirs.brain, name);
      cpSync(from, to, { recursive: true });
      restoredFiles += countFiles(to);
    }
    return { restored_files: restoredFiles };
  } finally {
    ext.cleanup();
  }
}

// ----- Helpers -------------------------------------------------------------

function detectArchiveCompression(archive: string): "zstd" | "gzip" {
  const buf = Buffer.alloc(4);
  const fd = openSync(archive, "r");
  try {
    readSync(fd, buf, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  // zstd magic: 0x28 0xB5 0x2F 0xFD (little-endian view of 0xFD2FB528).
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    return "zstd";
  }
  // gzip magic: 0x1F 0x8B
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return "gzip";
  }
  // Default to zstd since that's our preferred writer — restore will
  // fail loudly through the zstd subprocess if the bytes don't match.
  return "zstd";
}

function countFiles(path: string): number {
  try {
    const st = statSync(path);
    if (st.isFile()) return 1;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const sub = join(path, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(sub);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

// Silence unused-symbol lints for helpers exported only via re-export.
void basename;
