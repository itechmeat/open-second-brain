/**
 * The brain-usage block installer step for agent instruction files
 * (t_ba41a78a), the producer the write-back contract anticipated.
 *
 * Upstream installers finish by writing a "use the brain" instruction
 * block into the harness's own rules file; without one, a host that never
 * loads an OSB hook never learns the brain exists, and the audited
 * write-gate block is graded `missing-block` forever. This module is the
 * narrow missing half: an install step that writes the canonical
 * write-gate block (t_ba41a78a K2, {@link CANONICAL_WRITEBACK_BLOCK_BODY})
 * into the agent-instruction file the installed host actually reads, at
 * the VAULT root - the same workspace `o2b doctor --readiness` audits, so
 * the probe grades exactly what install wrote.
 *
 * Which file, per host: {@link instructionBlockTargetFor} reads
 * `HOST_INSTRUCTION_PRECEDENCE` - codex, cursor, opencode and aider read
 * AGENTS.md, gemini-cli reads GEMINI.md (name-implied only, an open
 * question that table's docblock already carries, surfaced as a plan note
 * here rather than resolved by pretending certainty), and targets with no
 * entry are a named skip. The mapping never forks a second host-to-file
 * table.
 *
 * Every byte goes through the shared rules-block writer
 * (`src/core/install/rules-block.ts`), never through a direct fs write:
 * operator content outside the block is preserved byte-for-byte, the
 * first write backs up exclusively, a re-apply is a byte no-op, and a
 * hand-edited block refuses with `user-modified-block` unless forced.
 *
 * The apply is bound to the approved preview (the `o2b brain protect`
 * pattern): {@link applyInstructionBlock} re-derives the plan from the
 * live disk and refuses with `preview-drift` unless every field the
 * consent was shown still holds - a write of anything but the approved
 * bytes is a typed refusal, never a fallback.
 *
 * Ownership is recorded in
 * `<vault>/.open-second-brain/instruction-block.lock.json`
 * ({@link INSTRUCTION_BLOCK_LOCK_FILE}, the derived store beside
 * `install.lock.json`): per file, which block owns the fence, the begin
 * marker, and the applied time that drives the hand-edit refusal. The
 * lock is what uninstall reads to remove exactly the pair this tool
 * wrote. It is machine state, not a credential, and is declared in the
 * state-surface inventory.
 *
 * Layering: core here, so no stdout, no exit codes, no prompts - the CLI
 * (`src/cli/install/install.ts`) owns consent, rendering and exits.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { DERIVED_STORE_DIR } from "../brain/path-constants.ts";
import {
  AGENT_INSTRUCTION_FILES,
  CANONICAL_WRITEBACK_BLOCK_BODY,
  HOST_INSTRUCTION_PRECEDENCE,
} from "../brain/writeback-contract.ts";
import { renderUnifiedDiff } from "../diff.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ManagedBlockError, insertManagedBlock, type BlockOpts } from "./managed-block.ts";
import {
  RULES_BLOCK_ERROR_KIND,
  RULES_BLOCK_ID,
  RULES_BLOCK_MARKERS,
  type RulesBlockId,
  RulesBlockError,
  removeRulesBlock,
  writeRulesBlock,
} from "./rules-block.ts";
import type { InstallEnv } from "./types.ts";
import type { InstallTargetId } from "../runtime/host-facts.ts";

// ----- Target mapping -------------------------------------------------------

/**
 * The agent-instruction file `target`'s host reads at the vault root, or
 * null when the host has no entry in `HOST_INSTRUCTION_PRECEDENCE` - a
 * NAMED SKIP: such a target installs its adapter but no instruction step,
 * and the plan says so rather than guessing a file. Derived from the
 * table, so the checker and the installer can never disagree about which
 * file a host reads; if the table grows, this follows it.
 */
export function instructionBlockTargetFor(target: InstallTargetId): string | null {
  const files = (HOST_INSTRUCTION_PRECEDENCE as Readonly<Record<string, readonly string[]>>)[
    target
  ];
  return files?.[0] ?? null;
}

/**
 * The named skip both install lanes record when `target` maps no
 * agent-instruction file in `HOST_INSTRUCTION_PRECEDENCE`: one owner for
 * the sentence the plan's post note, the uninstall payload's
 * `skipped_reason` and the apply payload's `instruction_block` skip all
 * carry, so the two JSON receipts cannot drift apart.
 */
export function instructionStepNoPrecedenceReason(target: InstallTargetId): string {
  return `${target} reads no agent-instruction file in HOST_INSTRUCTION_PRECEDENCE`;
}

// ----- Plan -----------------------------------------------------------------

export interface InstructionBlockPlan {
  /** The vault-root file the step would rewrite. */
  readonly path: string;
  /** Whether the file exists today; false means apply would create it. */
  readonly exists: boolean;
  /** Whether applying would change the file's bytes. */
  readonly changed: boolean;
  /** Unified diff of the rewrite; empty when `changed` is false. */
  readonly diff: string;
  /**
   * The caveat or named note the consent render owes the operator, or
   * null when the step is unremarkable. The gemini-cli reading caveat
   * and the absent-file creation note land here.
   */
  readonly note: string | null;
}

/**
 * Plan notes keyed by instruction file, not by target: the caveat is
 * about the FILE (how its host resolves it), and two targets mapping to
 * one file must render the same honest sentence.
 */
const FILE_PLAN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  "GEMINI.md":
    "gemini-cli reading GEMINI.md is name-implied only; upstream context.fileName can rename " +
    "the surface, so the write follows the declared table and the readiness probe audits " +
    "what the host actually sees",
});

/** The plan note for a file the apply would create. */
function creationNote(name: string): string {
  return `creates ${name} at the vault root; the file becomes visible to the host agent and the vault indexer`;
}

/** Plan for one instruction file, by name. Pure read plus diff render. */
function planForFile(env: InstallEnv, name: string): InstructionBlockPlan {
  const path = join(env.vault, name);
  let exists: boolean;
  let before: string;
  try {
    // The checker's posture: lstat first, refuse a link before any read.
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new RulesBlockError(
        `${path} is a symbolic link - the installer refuses to follow symlinks, because a ` +
          "write through a link lands outside the file the write-back contract audits",
        RULES_BLOCK_ERROR_KIND.symlink,
        path,
      );
    }
    exists = true;
    before = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof RulesBlockError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      exists = false;
      before = "";
    } else {
      throw new RulesBlockError(
        `${path} could not be read: ${reasonOf(err)}`,
        RULES_BLOCK_ERROR_KIND.unreadable,
        path,
        { cause: err },
      );
    }
  }
  let after: string;
  try {
    after = insertManagedBlock(before, CANONICAL_WRITEBACK_BLOCK_BODY, usageBlockOpts());
  } catch (err) {
    // A malformed pair of the block's own spelling refuses the plan the
    // same way the write would; broken markers are a fix-by-hand state,
    // never a repair the installer performs (the readiness probe is the
    // surface that grades it `malformed-block`).
    if (err instanceof ManagedBlockError) {
      throw new RulesBlockError(
        `${path}: ${err.message} - fix or remove the broken block; the installer refuses ` +
          "to write into a file with malformed markers",
        RULES_BLOCK_ERROR_KIND.markers,
        path,
        { cause: err },
      );
    }
    throw err;
  }
  const changed = after !== before;
  const notes: string[] = [];
  const fileNote = FILE_PLAN_NOTES[name];
  if (fileNote !== undefined) notes.push(fileNote);
  if (!exists) notes.push(creationNote(name));
  return {
    path,
    exists,
    changed,
    diff: changed ? renderUnifiedDiff(before, after, path) : "",
    note: notes.length > 0 ? notes.join("; ") : null,
  };
}

/** One line an fs error message, so a multi-line reason stays one detail. */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

/**
 * Plan the instruction step for `target` against the vault `env` names.
 * Pure: reads the candidate file, renders what apply would write, writes
 * nothing, records nothing. A target with no precedence entry has no
 * plan - the caller renders the named skip from
 * {@link instructionBlockTargetFor} instead.
 */
export function planInstructionBlock(
  env: InstallEnv,
  target: InstallTargetId,
): InstructionBlockPlan {
  const name = instructionBlockTargetFor(target);
  if (name === null) {
    throw new RulesBlockError(
      `${target} installs no agent-instruction file: HOST_INSTRUCTION_PRECEDENCE has no ` +
        "entry for it, so there is no instruction step to plan",
      RULES_BLOCK_ERROR_KIND.invalidPlan,
      target,
    );
  }
  return planForFile(env, name);
}

/** The usage block's markers, as the editor's option shape. */
function usageBlockOpts(): BlockOpts {
  const markers = RULES_BLOCK_MARKERS[RULES_BLOCK_ID.usage];
  return { beginMarker: markers.begin, endMarker: markers.end };
}

// ----- Apply ----------------------------------------------------------------

export interface InstructionBlockApplyOptions {
  /** Plan the write and touch nothing; refusals still fire. */
  readonly dryRun?: boolean;
  /** Override the hand-edit refusal and write the canonical body. */
  readonly force?: boolean;
  /** The plan the consent verdict was rendered from. Required. */
  readonly approved: InstructionBlockPlan;
}

export interface InstructionBlockApplyResult {
  /** The exclusive-create backup of the prior bytes; null when none was taken. */
  readonly backupPath: string | null;
  /** True when the apply changed the file's bytes (or would, under `dryRun`). */
  readonly changed: boolean;
  /**
   * True when the apply CREATED the file: it did not exist when the plan
   * was re-derived. A first install takes no backup (there are no prior
   * bytes), so `backupPath === null` cannot distinguish "created" from
   * "already current" - the CLI's post-apply line branches on this field.
   */
  readonly created: boolean;
}

/**
 * Apply the approved instruction plan: re-derive it from the live disk
 * and refuse unless it still holds, then write through the shared rules
 * block writer and record the ownership lock.
 *
 * The preview binding: the apply recomputes the plan and every compared
 * field (`path`, `exists`, `changed`, `diff`) must equal the approved
 * one, else the on-disk bytes moved since consent and the refusal is
 * `preview-drift` - the write of an unapproved rewrite is never a
 * fallback. A plan naming anything but the vault-root agent-instruction
 * file it claims is refused as `invalid-plan`.
 *
 * The hand-edit safety net rides the writer: a block diverged from the
 * canonical body on a file newer than the lock's `applied_at` refuses
 * with `user-modified-block` unless `force`; with no lock record at all,
 * every diverged block refuses too, which is what protects a manually
 * pasted docs snippet - `--force` is the documented upgrade path, and the
 * backup it takes is the undo path.
 *
 * A successful non-dry-run apply records the lock entry even when nothing
 * changed: the apply ran under consent and found or left the canonical
 * block, so uninstall can find the pair it owns. `dryRun` runs the same
 * refusals and writes nothing - no file change, no backup, no lock.
 */
export function applyInstructionBlock(
  env: InstallEnv,
  opts: InstructionBlockApplyOptions,
): InstructionBlockApplyResult {
  const approved = opts.approved;
  const name = basename(approved.path);
  if (
    !(AGENT_INSTRUCTION_FILES as ReadonlyArray<string>).includes(name) ||
    approved.path !== join(env.vault, name)
  ) {
    throw new RulesBlockError(
      `the approved plan names ${approved.path}, which is not the vault-root agent-instruction ` +
        `file ${name} for this vault; refusing to apply a plan that was not derived here`,
      RULES_BLOCK_ERROR_KIND.invalidPlan,
      approved.path,
    );
  }
  const fresh = planForFile(env, name);
  if (
    fresh.exists !== approved.exists ||
    fresh.changed !== approved.changed ||
    fresh.diff !== approved.diff
  ) {
    throw new RulesBlockError(
      `${approved.path} changed since the plan was approved; the apply refuses to write ` +
        "anything but the approved bytes. Re-run `o2b install --target <host>` to refresh " +
        "the plan, then apply again",
      RULES_BLOCK_ERROR_KIND.previewDrift,
      approved.path,
    );
  }
  const stored = readInstructionBlockLock(env.vault).files[name];
  const parsedAt = stored === undefined ? Number.NaN : Date.parse(stored.applied_at);
  const installedAtMs = Number.isFinite(parsedAt) ? parsedAt : null;
  const result = writeRulesBlock(
    approved.path,
    RULES_BLOCK_ID.usage,
    CANONICAL_WRITEBACK_BLOCK_BODY,
    {
      dryRun: opts.dryRun ?? false,
      force: opts.force ?? false,
      installedAtMs,
    },
  );
  if (!opts.dryRun) {
    recordInstructionBlock(env.vault, name, {
      block_id: RULES_BLOCK_ID.usage,
      begin_marker: RULES_BLOCK_MARKERS.usage.begin,
      applied_at: env.now.toISOString(),
    });
  }
  return {
    backupPath: result.backupPath,
    changed: result.changed,
    created: result.changed && !fresh.exists,
  };
}

// ----- Uninstall ------------------------------------------------------------

export interface InstructionBlockUninstallOptions {
  /** Plan the removal and touch nothing. */
  readonly dryRun?: boolean;
}

export interface InstructionBlockUninstallResult {
  /** True when the file's bytes changed: the pair existed and is gone. */
  readonly removed: boolean;
}

/**
 * Remove the usage block pair from one instruction file, the reverse of
 * {@link applyInstructionBlock}. The removal goes through the shared
 * writer's remove: only the pair this tool owns is rewritten away,
 * operator bytes preserved, the file itself never removed. A file with
 * no pair of that spelling is a NAMED SKIP (`removed: false`), and a
 * stale lock entry is cleared either way so the lock never claims a pair
 * that is gone. Malformed markers refuse - uninstall never repairs - and
 * symbolic links refuse before any read.
 */
export function uninstallInstructionBlock(
  env: InstallEnv,
  name: string,
  opts: InstructionBlockUninstallOptions = {},
): InstructionBlockUninstallResult {
  const path = join(env.vault, name);
  const result = removeRulesBlock(path, RULES_BLOCK_ID.usage, opts);
  if (!opts.dryRun) clearInstructionBlock(env.vault, name);
  return { removed: result.removed };
}

// ----- Ownership lock -------------------------------------------------------

/** The lock file this installer records its owned blocks in. */
export const INSTRUCTION_BLOCK_LOCK_FILE = "instruction-block.lock.json";

/** The one schema the lock parses. A different number refuses. */
const INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION = 1;

export interface InstructionBlockLockEntry {
  /** The block id whose fence this file carries. Always `usage` today. */
  readonly block_id: RulesBlockId;
  /** The begin marker recorded at apply time, for audit. */
  readonly begin_marker: string;
  /** When this installer last wrote (or confirmed) the block, ISO 8601. */
  readonly applied_at: string;
}

export interface InstructionBlockLock {
  readonly schema_version: 1;
  /** Instruction file basename to its ownership entry. */
  readonly files: Record<string, InstructionBlockLockEntry>;
}

/** The lock's path in `vault`'s derived store. */
export function instructionBlockLockPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, INSTRUCTION_BLOCK_LOCK_FILE);
}

/**
 * Read the ownership lock. An absent file is the empty schema-1 document
 * - nothing owns a block yet - never an error, because uninstall must be
 * able to run before any install. A symbolic link refuses (a redirected
 * lock would read state this vault never wrote); corrupted JSON, a
 * non-object document and an unsupported schema version refuse with the
 * path in the message, the same posture the install manifest's parser
 * holds.
 */
export function readInstructionBlockLock(vault: string): InstructionBlockLock {
  const path = instructionBlockLockPath(vault);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION, files: {} };
    }
    throw new RulesBlockError(
      `${path} could not be stat'ed: ${reasonOf(err)}`,
      RULES_BLOCK_ERROR_KIND.unreadable,
      path,
      { cause: err },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new RulesBlockError(
      `${path} is a symbolic link - the lock refuses to read through links, because a ` +
        "redirected lock would report ownership this vault never recorded",
      RULES_BLOCK_ERROR_KIND.symlink,
      path,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new RulesBlockError(
      `${path} could not be read: ${reasonOf(err)}`,
      RULES_BLOCK_ERROR_KIND.unreadable,
      path,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `instruction-block lock is corrupted JSON: ${path}\nOriginal error: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`instruction-block lock is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  const sv = obj["schema_version"];
  if (sv !== INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION) {
    throw new Error(
      `instruction-block lock schema_version ${sv} not supported (expected ` +
        `${INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION}): ${path}`,
    );
  }
  const files = (obj["files"] ?? {}) as Record<string, InstructionBlockLockEntry>;
  if (typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`instruction-block lock files field is not an object: ${path}`);
  }
  return { schema_version: INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION, files };
}

/**
 * Record (or replace) one file's ownership entry and write the lock
 * atomically. The derived store is created on demand; the write is the
 * shared atomic writer's, so a crash leaves either the previous lock or
 * the new one.
 */
export function recordInstructionBlock(
  vault: string,
  name: string,
  entry: InstructionBlockLockEntry,
): void {
  const current = readInstructionBlockLock(vault);
  writeInstructionBlockLock(vault, {
    schema_version: INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION,
    files: { ...current.files, [name]: entry },
  });
}

/**
 * Drop one file's ownership entry. A name the lock never recorded is a
 * quiet no-op: uninstall of an install that never recorded must stay a
 * skip, not an error.
 */
export function clearInstructionBlock(vault: string, name: string): void {
  const current = readInstructionBlockLock(vault);
  if (!(name in current.files)) return;
  const files = { ...current.files };
  delete files[name];
  writeInstructionBlockLock(vault, {
    schema_version: INSTRUCTION_BLOCK_LOCK_SCHEMA_VERSION,
    files,
  });
}

function writeInstructionBlockLock(vault: string, lock: InstructionBlockLock): void {
  const path = instructionBlockLockPath(vault);
  // The atomic writer creates the parent directory with the write; the
  // explicit mkdir mirrors the install manifest's posture so a read-only
  // store fails here, at the named call, rather than inside the writer.
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(lock, null, 2) + "\n");
}
