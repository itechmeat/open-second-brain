/**
 * What the payload store holds, who points at it, and what may go
 * (t_35440e83).
 *
 * The registry (`payload-registry.ts`) writes and reads single payloads.
 * This module answers the questions about the store as a whole, which
 * the list verb, the doctor, the gc and the remote read gate all ask:
 *
 *   - which payload files exist (`Brain/.payloads/<sha256>.txt`);
 *   - which refs the vault holds, and in which files;
 *   - which stored payloads nothing references (orphans) and which
 *     referenced payloads have no file (missing);
 *   - whether a payload is reachable from something a REMOTE caller may
 *     read.
 *
 * ## "Referenced anywhere in the vault"
 *
 * Every text-shaped file (`.md`, `.jsonl`, `.json`, `.txt`, `.yaml`,
 * `.yml`, `.canvas`, `.base`) under the vault is scanned for
 * `osb-payload://<sha256>`, except:
 *
 *   - `Brain/.payloads/` itself, which is followed TRANSITIVELY instead:
 *     a whole-turn payload can hold the placeholders of the blobs that
 *     were externalized out of it first, and those stay live exactly as
 *     long as the payload holding them does;
 *   - `Brain/.snapshots/`, whose archives carry their own copy of the
 *     store, so a restore brings back every payload the restored rows
 *     name;
 *   - `.git`, `node_modules` and `.stversions` (Syncthing's own version
 *     history) - tooling state, not vault content. The derived-store
 *     directory is NOT skipped by name: its databases are not text files
 *     and never match the extension filter, and a JSON ledger inside it
 *     that ever held a ref would be a reference like any other.
 *
 * A ref anywhere else keeps its payload, including in `.trash` and in a
 * hand-written note: the gc is dry-run by default and removes only what
 * this scan cannot find a single reference to.
 *
 * ## Remote readability
 *
 * Payloads are session data, and only the session turns they were cut
 * out of may grant a remote read. A continuity row carries a `private`
 * flag (set when a `<private>` region was stripped from it; the read
 * model drops such rows from every export). A payload is readable at
 * remote reach only when a non-private `session_turn` row references it,
 * or a payload that is itself remotely readable does.
 *
 * Everything else keeps a payload live for the gc and grants nothing:
 *
 *   - a summary node names a payload only because it copied the text of
 *     the turns it summarizes, and carries no `private` flag of its own -
 *     counting it would let every private turn's payload through its
 *     summary;
 *   - a page, whatever its visibility, because pages (the Brain log
 *     included) are written by tools a session turn is not - a ref pasted
 *     into a note must not turn a private payload public;
 *   - any other file (a JSON ledger, a YAML config), and an orphan: a
 *     payload nothing references is not something a remote caller can
 *     have been shown a ref for.
 *
 * Because only the continuity ledger and the store itself can grant, the
 * remote check ({@link isPayloadRemotelyReadable}) reads just those two
 * directories rather than walking the vault.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";

import { continuityLogDir } from "./continuity/store.ts";
import {
  BRAIN_LOG_REL,
  BRAIN_PAYLOADS_REL,
  BRAIN_SNAPSHOTS_REL,
  payloadPath,
  payloadsDir,
  vaultRelative,
} from "./paths.ts";
import {
  PAYLOAD_GC_GRACE_MS,
  PAYLOAD_REF_RE,
  payloadRefFor,
  withPayloadStoreLock,
} from "./payload-registry.ts";
import { withDestructiveSnapshot, type DestructiveSnapshot } from "./snapshot-gate.ts";
import { LOCK_WAIT_INTERACTIVE_MS } from "./sync-lockfile.ts";
import { BRAIN_SNAPSHOT_REASON } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** One file (and, for a ledger, one line) that names a payload. */
export interface PayloadReferrer {
  /** Vault-relative POSIX path of the referring file. */
  readonly path: string;
  /** 1-based line, for a continuity ledger row. */
  readonly line?: number;
  /** Whether a remote caller may read this referrer. */
  readonly remoteReadable: boolean;
}

/** One stored payload file. */
export interface StoredPayload {
  readonly sha256: string;
  readonly ref: string;
  /** Vault-relative POSIX path of the file. */
  readonly path: string;
  readonly bytes: number;
  /** Distinct referring files/rows, transitive through other payloads. */
  readonly referrers: number;
  readonly remoteReadable: boolean;
}

/** A ref some file holds whose payload file is gone. */
export interface MissingPayload {
  readonly sha256: string;
  readonly ref: string;
  readonly referrers: ReadonlyArray<PayloadReferrer>;
}

export interface PayloadInventory {
  readonly stored: ReadonlyArray<StoredPayload>;
  readonly orphans: ReadonlyArray<StoredPayload>;
  readonly missing: ReadonlyArray<MissingPayload>;
}

/** What a gc pass found and, with `apply`, removed. */
export interface PayloadGcResult {
  readonly applied: boolean;
  /** Unreferenced payloads past the grace period: removed on apply. */
  readonly orphans: ReadonlyArray<StoredPayload>;
  /**
   * Unreferenced payloads younger than {@link PAYLOAD_GC_GRACE_MS}, left
   * for a later pass: an import may be about to name them.
   */
  readonly deferred: ReadonlyArray<StoredPayload>;
  readonly removed: ReadonlyArray<string>;
  readonly bytes: number;
  /** The recovery point taken before anything was removed. */
  readonly snapshot: DestructiveSnapshot | null;
}

const PAYLOAD_FILE_RE = /^([a-f0-9]{64})\.txt$/;
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".jsonl",
  ".json",
  ".txt",
  ".yaml",
  ".yml",
  ".canvas",
  ".base",
]);
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".stversions"]);
const SKIPPED_PATHS: ReadonlySet<string> = new Set([BRAIN_PAYLOADS_REL, BRAIN_SNAPSHOTS_REL]);
const CONTINUITY_PREFIX = `${BRAIN_LOG_REL}/continuity/`;

/** Every payload file in the store, sorted by digest. */
export function listStoredPayloadFiles(
  vault: string,
): ReadonlyArray<{ sha256: string; bytes: number }> {
  const dir = payloadsDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const out: Array<{ sha256: string; bytes: number }> = [];
  for (const name of readdirSync(dir)) {
    const match = PAYLOAD_FILE_RE.exec(name);
    if (match === null) continue;
    const path = payloadPath(vault, match[1]!);
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    out.push({ sha256: match[1]!, bytes: size });
  }
  out.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  return Object.freeze(out);
}

/**
 * Every payload ref the vault holds, keyed by digest, with the files
 * (and ledger rows) that hold it - transitive through the store.
 */
export function scanPayloadReferences(vault: string): ReadonlyMap<string, PayloadReferrer[]> {
  const refs = new Map<string, PayloadReferrer[]>();
  const add = (sha256: string, referrer: PayloadReferrer): void => {
    const list = refs.get(sha256);
    if (list === undefined) refs.set(sha256, [referrer]);
    else list.push(referrer);
  };
  for (const rel of walkTextFiles(vault)) scanFile(vault, rel, add);

  // Transitive pass: a payload reachable from the vault keeps the
  // payloads its own text names. Remote readability is resolved after,
  // because a payload's readability depends on its referrers'.
  const expanded = new Set<string>();
  const queue = [...refs.keys()];
  const contained = new Map<string, ReadonlyArray<string>>();
  while (queue.length > 0) {
    const sha256 = queue.shift()!;
    if (expanded.has(sha256)) continue;
    expanded.add(sha256);
    const inner = payloadRefsInside(vault, sha256);
    contained.set(sha256, inner);
    for (const child of inner) if (!expanded.has(child)) queue.push(child);
  }
  const remote = new Set<string>();
  for (const [sha256, list] of refs) if (list.some((r) => r.remoteReadable)) remote.add(sha256);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [sha256, inner] of contained) {
      if (!remote.has(sha256)) continue;
      for (const child of inner) {
        if (!remote.has(child)) {
          remote.add(child);
          grew = true;
        }
      }
    }
  }
  for (const [sha256, inner] of contained) {
    const path = posix.join(BRAIN_PAYLOADS_REL, `${sha256}.txt`);
    for (const child of inner) add(child, { path, remoteReadable: remote.has(sha256) });
  }
  return refs;
}

/** Stored, orphaned and missing payloads in one pass. */
export function buildPayloadInventory(vault: string): PayloadInventory {
  const refs = scanPayloadReferences(vault);
  const files = listStoredPayloadFiles(vault);
  const storedSet = new Set(files.map((file) => file.sha256));
  const stored = files.map((file) => {
    const referrers = refs.get(file.sha256) ?? [];
    return Object.freeze({
      sha256: file.sha256,
      ref: payloadRefFor(file.sha256),
      path: posix.join(BRAIN_PAYLOADS_REL, `${file.sha256}.txt`),
      bytes: file.bytes,
      referrers: referrers.length,
      remoteReadable: referrers.some((r) => r.remoteReadable),
    });
  });
  const missing = [...refs.entries()]
    .filter(([sha256]) => !storedSet.has(sha256))
    .map(([sha256, referrers]) =>
      Object.freeze({ sha256, ref: payloadRefFor(sha256), referrers: Object.freeze(referrers) }),
    )
    .toSorted((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  return Object.freeze({
    stored: Object.freeze(stored),
    orphans: Object.freeze(stored.filter((entry) => entry.referrers === 0)),
    missing: Object.freeze(missing),
  });
}

/**
 * May a caller at remote reach read the payload `sha256`?
 *
 * Only when a non-private session turn references it, directly or through
 * a chain of payloads that starts at one - see the module docblock. Reads
 * the continuity ledger and the payload store only.
 */
export function isPayloadRemotelyReadable(vault: string, sha256: string): boolean {
  const granted = new Set<string>();
  const queue: string[] = [];
  const dir = continuityLogDir(vault);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    let text: string;
    try {
      if (!lstatSync(join(dir, name)).isFile()) continue;
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!text.includes("osb-payload://")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes("osb-payload://") || !continuityRowIsShareable(line)) continue;
      for (const ref of distinctRefs(line)) {
        if (!granted.has(ref)) {
          granted.add(ref);
          queue.push(ref);
        }
      }
    }
  }
  while (queue.length > 0) {
    if (granted.has(sha256)) return true;
    for (const child of payloadRefsInside(vault, queue.shift()!)) {
      if (!granted.has(child)) {
        granted.add(child);
        queue.push(child);
      }
    }
  }
  return granted.has(sha256);
}

/**
 * Remove every payload file nothing in the vault references and that is
 * older than {@link PAYLOAD_GC_GRACE_MS}.
 *
 * Dry-run unless `apply`: the plan is the same scan the apply performs.
 * The apply re-plans INSIDE the recovery point and under the payload
 * store lock, so a payload an import referenced between the dry run and
 * the apply is never removed, an import cannot land a row naming a
 * payload while it is being removed, and every removal sits behind a
 * snapshot that still holds the file.
 */
export function collectPayloadGarbage(
  vault: string,
  opts: { readonly apply: boolean; readonly now?: Date },
): PayloadGcResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  if (!opts.apply) {
    const split = splitByGrace(vault, buildPayloadInventory(vault).orphans, nowMs);
    return Object.freeze({
      applied: false,
      orphans: split.removable,
      deferred: split.deferred,
      removed: Object.freeze([]),
      bytes: sumBytes(split.removable),
      snapshot: null,
    });
  }
  assertVaultIdentityForWrite(vault);
  const planned = splitByGrace(vault, buildPayloadInventory(vault).orphans, nowMs);
  if (planned.removable.length === 0) {
    return Object.freeze({
      applied: true,
      orphans: planned.removable,
      deferred: planned.deferred,
      removed: Object.freeze([]),
      bytes: 0,
      snapshot: null,
    });
  }
  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.payloadGc,
    () =>
      withPayloadStoreLock(
        vault,
        () => {
          const split = splitByGrace(vault, buildPayloadInventory(vault).orphans, nowMs);
          const removed: string[] = [];
          for (const orphan of split.removable) {
            rmSync(payloadPath(vault, orphan.sha256), { force: true });
            removed.push(orphan.path);
          }
          return { ...split, removed };
        },
        // Operator-run: a busy import answers with a named ELOCKED after a
        // short wait rather than a frozen terminal.
        LOCK_WAIT_INTERACTIVE_MS,
      ),
    opts.now !== undefined ? { now: opts.now } : {},
  );
  return Object.freeze({
    applied: true,
    orphans: gated.result.removable,
    deferred: gated.result.deferred,
    removed: Object.freeze(gated.result.removed),
    bytes: sumBytes(gated.result.removable),
    snapshot: gated.snapshot,
  });
}

/**
 * Orphans past the grace period, and the ones still inside it. A file
 * whose age cannot be read is deferred: not knowing it is old is not a
 * reason to remove it.
 */
function splitByGrace(
  vault: string,
  orphans: ReadonlyArray<StoredPayload>,
  nowMs: number,
): { removable: ReadonlyArray<StoredPayload>; deferred: ReadonlyArray<StoredPayload> } {
  const removable: StoredPayload[] = [];
  const deferred: StoredPayload[] = [];
  for (const orphan of orphans) {
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(payloadPath(vault, orphan.sha256)).mtimeMs;
    } catch {
      deferred.push(orphan);
      continue;
    }
    (nowMs - mtimeMs >= PAYLOAD_GC_GRACE_MS ? removable : deferred).push(orphan);
  }
  return { removable: Object.freeze(removable), deferred: Object.freeze(deferred) };
}

/** One continuity row longer than the bound, reported per shard. */
export interface OversizedContinuityShard {
  /** Vault-relative POSIX path of the shard. */
  readonly path: string;
  readonly rows: number;
  readonly largestChars: number;
}

/**
 * Continuity shards holding rows longer than `maxRowChars`.
 *
 * A row written through the registry carries at most the text bound plus
 * its envelope, so a longer row predates the registry or came from a
 * writer that bypassed it. Reported per shard rather than per row: a
 * pre-registry vault can hold thousands, and the answer an operator needs
 * is where they are and how bad the worst one is.
 */
export function findOversizedContinuityRows(
  vault: string,
  maxRowChars: number,
): ReadonlyArray<OversizedContinuityShard> {
  const dir = continuityLogDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const out: OversizedContinuityShard[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".jsonl")) continue;
    const abs = join(dir, name);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let rows = 0;
    let largest = 0;
    for (const line of text.split("\n")) {
      if (line.length <= maxRowChars) continue;
      rows++;
      largest = Math.max(largest, line.length);
    }
    if (rows > 0) out.push({ path: vaultRelative(abs, vault), rows, largestChars: largest });
  }
  return Object.freeze(out);
}

function sumBytes(entries: ReadonlyArray<StoredPayload>): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function payloadRefsInside(vault: string, sha256: string): ReadonlyArray<string> {
  let text: string;
  try {
    text = readFileSync(payloadPath(vault, sha256), "utf8");
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const match of text.matchAll(PAYLOAD_REF_RE)) {
    if (match[1] !== sha256) out.add(match[1]!);
  }
  return [...out];
}

function* walkTextFiles(vault: string): Generator<string> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(relDir === "" ? vault : join(vault, relDir));
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      let stat;
      try {
        // lstat: a symlink is never followed, so the scan cannot leave
        // the vault or loop through a link back into it.
        stat = lstatSync(join(vault, rel));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(name) || SKIPPED_PATHS.has(rel)) continue;
        stack.push(rel);
        continue;
      }
      if (!stat.isFile()) continue;
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase())) continue;
      yield rel;
    }
  }
}

function scanFile(
  vault: string,
  rel: string,
  add: (sha256: string, referrer: PayloadReferrer) => void,
): void {
  let text: string;
  try {
    text = readFileSync(join(vault, rel), "utf8");
  } catch {
    return;
  }
  if (!text.includes("osb-payload://")) return;
  if (rel.startsWith(CONTINUITY_PREFIX) && rel.endsWith(".jsonl")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes("osb-payload://")) continue;
      const remoteReadable = continuityRowIsShareable(line);
      for (const sha256 of distinctRefs(line)) {
        add(sha256, { path: rel, line: i + 1, remoteReadable });
      }
    }
    return;
  }
  // Pages and every other file keep a payload live; none grants a remote
  // read (see the module docblock).
  for (const sha256 of distinctRefs(text)) add(sha256, { path: rel, remoteReadable: false });
}

function distinctRefs(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(PAYLOAD_REF_RE)].map((match) => match[1]!));
}

/** A ledger row that grants remote reads: a parseable, non-private session turn. */
function continuityRowIsShareable(line: string): boolean {
  try {
    const row = JSON.parse(line) as { private?: unknown; kind?: unknown };
    return row.kind === "session_turn" && row.private !== true;
  } catch {
    return false;
  }
}
