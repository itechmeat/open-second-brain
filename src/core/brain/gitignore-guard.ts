/**
 * The `.gitignore` guard seeder (t_206562ae): one managed block in the
 * vault's `.gitignore` covering the derived store.
 *
 * `<vault>/.open-second-brain/` holds every piece of derived runtime
 * state this tool keeps for itself - brain.sqlite, the hook audit, the
 * secrets store, the maintenance lease and journals, the ingest
 * checkpoints, dead letters, the session ledgers, the watchdog fallback,
 * the self-heal state, the lockfiles and the bench runs. The vault scope
 * already excludes the directory (`DEFAULT_VAULT_IGNORE_PATHS`), but
 * nothing told git, so a fresh `o2b brain init` in a repository left
 * `brain.sqlite` visible to `git status`. This module seeds the git-side
 * guard: a managed block whose entry list starts as exactly one
 * vault-root-anchored line, `/.open-second-brain/`.
 *
 * Behaviour:
 *
 *   - No `.gitignore` → one is created containing only the block.
 *   - An existing file keeps every byte of its user content and gains
 *     the block appended with one separating blank line (the
 *     `insertManagedBlock` merge). A conforming block already present is
 *     MERGED, never clobbered: its own entries survive and only the
 *     missing guard entries are added.
 *   - Exact-line membership is checked first, so a user who already
 *     ignores the path - inside the block or beside it - yields a skip,
 *     not a duplicate. The skip is only clean while no LATER line
 *     negates the entry: git evaluates patterns in order and the last
 *     match wins, so `!.open-second-brain` after the entry leaves the
 *     store visible, and that surfaces as the same named conflict a
 *     malformed block gets.
 *   - A second run is a no-op: byte-equal file, `skipped`.
 *   - Markers present but malformed (unpaired, doubled, inverted) surface
 *     as a named conflict with warn-and-continue: nothing is written,
 *     and the doctor's git tracked-state row reports the still-unprotected
 *     state. Surgery on a block a human or another tool mangled is not a
 *     decision for a seeder to make.
 *   - CRLF files keep their line endings, inside the block too (the
 *     managed-block editor detects and restores them).
 *   - No git subprocess is ever spawned: git is asked only by the
 *     doctor's `git-tracked-state` probe, which measures what actually
 *     happened on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
  extractManagedBlock,
  hasManagedBlock,
  insertManagedBlock,
  ManagedBlockError,
} from "../install/managed-block.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";

/** Vault-relative name of the file this guard seeds. */
export const GITIGNORE_GUARD_FILE = ".gitignore";

/**
 * The identity of this guard's block, named in warnings and doctor
 * messages so an operator can tell which managed block a finding is
 * about. The markers themselves are the shared `install/managed-block.ts`
 * defaults - the same convention `o2b brain protect` uses - so every
 * block this tree writes parses with the one editor.
 */
export const GITIGNORE_GUARD_BLOCK_ID = "derived-brain-state";

/**
 * The seeded entry list: starts as exactly one vault-root-anchored
 * pattern. Anchored at the vault root (`/.open-second-brain/`, with
 * trailing slash) so a vault nested inside a larger repository ignores
 * its own store and not a sibling's, and one entry covers every Tier A
 * writer. The source-reading census in
 * `tests/core/brain/gitignore-guard.test.ts` pins the list and the
 * population it covers.
 */
export const GITIGNORE_GUARD_ENTRIES: ReadonlyArray<string> = Object.freeze([
  `/${DERIVED_STORE_DIR}/`,
]);

/** What one seeding pass did to `<vault>/.gitignore`. */
export type GitignoreGuardStatus =
  | "created" // the file did not exist and was written with only the block
  | "updated" // an existing file gained the block (or the block gained entries)
  | "skipped" // every entry already present as an exact line; no bytes moved
  | "conflict"; // malformed markers, or a later line negates the entry; nothing written, warning emitted

export interface GitignoreGuardResult {
  readonly status: GitignoreGuardStatus;
  /** Vault-relative name of the file, always {@link GITIGNORE_GUARD_FILE}. */
  readonly file: string;
  /** The named conflict detail, present only when status is "conflict". */
  readonly detail?: string;
}

/** The exact block body for `entries`: markers around one entry per line. */
function blockBody(entries: ReadonlyArray<string>): string {
  return `${DEFAULT_BEGIN_MARKER}\n${entries.join("\n")}\n${DEFAULT_END_MARKER}\n`;
}

/**
 * A line that re-includes the derived store: `!.open-second-brain` or
 * the root-anchored `!/.open-second-brain`, with git's optional trailing
 * slash. Built from the directory constant so the guard and its negation
 * cannot drift apart.
 */
const NEGATED_ENTRY_RE = new RegExp(`^!/?${DERIVED_STORE_DIR.replaceAll(".", "\\.")}/?$`);

/**
 * The first line after the LAST guard entry that negates it, or null.
 * git evaluates .gitignore patterns in order and the last match wins, so
 * only a negation AFTER the entry re-opens the store - one before it is
 * overridden and harmless.
 */
function negationAfterEntry(lines: ReadonlyArray<string>): string | null {
  let lastEntry = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (GITIGNORE_GUARD_ENTRIES.includes(lines[i]!)) lastEntry = i;
  }
  for (let i = lastEntry + 1; i < lines.length; i += 1) {
    if (NEGATED_ENTRY_RE.test(lines[i]!)) return lines[i]!;
  }
  return null;
}

/**
 * Seed the guard block into `<vault>/.gitignore`, merging with whatever
 * is already there. Idempotent and best-effort in the conflict case; the
 * only throws are genuine I/O errors reading or writing the file.
 */
export function ensureVaultGitignoreEntries(vault: string): GitignoreGuardResult {
  const file = join(vault, GITIGNORE_GUARD_FILE);

  if (!existsSync(file)) {
    atomicWriteFileSync(file, blockBody(GITIGNORE_GUARD_ENTRIES));
    return { status: "created", file: GITIGNORE_GUARD_FILE };
  }

  const current = readFileSync(file, "utf8");

  // Exact-line membership first, over the CRLF-normalized whole file: a
  // user who already ignores the path anywhere in it gets a skip, never
  // a second (redundant) line.
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const present = new Set(lines);
  const missing = GITIGNORE_GUARD_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    // The entry being present is not the whole story: git takes the LAST
    // matching pattern, so a later `!.open-second-brain` re-includes the
    // store and a clean skip here would be optimistic - the doctor's
    // tracked-state row would catch it, but the init report should not
    // wait to be corrected. Surface the same named conflict the
    // malformed-marker case gets; write nothing either way.
    const negation = negationAfterEntry(lines);
    if (negation !== null) {
      const detail =
        `the guard entry is negated by the later line ${negation} ` +
        "(git last-match-wins: the derived store stays visible to git)";
      process.stderr.write(
        `warning: the ${GITIGNORE_GUARD_BLOCK_ID} .gitignore guard is negated ` +
          `(derived brain state stays visible to git): ${file}: ${detail}\n`,
      );
      return { status: "conflict", file: GITIGNORE_GUARD_FILE, detail };
    }
    return { status: "skipped", file: GITIGNORE_GUARD_FILE };
  }

  try {
    // Merge, never clobber: a conforming block's own entries survive and
    // only the missing guard entries are added to it. Entries the user
    // already wrote elsewhere in the file are not duplicated into it.
    const blockEntries = hasManagedBlock(current)
      ? (extractManagedBlock(current) ?? "").split("\n")
      : [];
    const next = insertManagedBlock(current, [...blockEntries, ...missing].join("\n"));
    if (next === current) {
      return { status: "skipped", file: GITIGNORE_GUARD_FILE };
    }
    atomicWriteFileSync(file, next);
    return { status: "updated", file: GITIGNORE_GUARD_FILE };
  } catch (err) {
    if (!(err instanceof ManagedBlockError)) throw err;
    const detail = err.message;
    process.stderr.write(
      `warning: could not seed the ${GITIGNORE_GUARD_BLOCK_ID} .gitignore block ` +
        `(derived brain state stays visible to git): ${file}: ${detail}\n`,
    );
    return { status: "conflict", file: GITIGNORE_GUARD_FILE, detail };
  }
}
