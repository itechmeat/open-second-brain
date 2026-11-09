/**
 * Pinned context: the transient current-task scratchpad at
 * `Brain/pinned.md`, read, written, appended, cleared or batch-edited by
 * the `brain_pinned_context` tool.
 *
 * Every mutation is a read-modify-write of one file, and several agents
 * share it. The atomic rename only guarantees that no reader sees a torn
 * file; it says nothing about a second writer that read the same "before"
 * state, so two concurrent appends used to lose one of them. Every write
 * therefore runs under the per-file sync lock (`pinned.md.lock`) and
 * re-reads the current content inside it, the same discipline as the
 * preference transaction (`preference-txn.ts`). The lock waits rather
 * than refusing: a pinned write is short, and a refusal would hand the
 * agent a retry for what is only ordinary contention.
 *
 * On a store-only machine (task 2.10) pinned context is the pinned
 * register of the store (`store/fold-pinned.ts`): reads come from it,
 * every commit is one `pinned-set` or `pinned-clear` record, the lock is
 * device-local and nothing under `Brain/` changes.
 *
 * Under the brain store dual-write flag every committed state is also
 * appended to the store as a full-text `pinned-set` (or a `pinned-clear`),
 * with the authority of the process's origin (see `store/dual-write.ts`).
 */

import { legacyVaultOf } from "./no-vault.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { pinnedRecord } from "../store/dual-write-records.ts";
import { authorityFromOrigin, isDualWriteEnabled } from "../store/dual-write.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { configuredStore, readEntitiesOf } from "../store/read/store-entities.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { storesStateDir } from "../store/store-paths.ts";
import { routeWrite } from "../store/store-write.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { pinnedTextIsPrivate } from "../store/reference-privacy.ts";
import { sanitiseTextField } from "../redactor.ts";
import { brainPinnedPath } from "./paths.ts";
import { acquireLockSyncWithRetry } from "./sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export const MAX_PINNED_CONTEXT_LEN = 20_000;

export interface PinnedContext {
  readonly path: string;
  readonly present: boolean;
  readonly content: string;
}

export function readPinnedContext(vault: string | null): PinnedContext {
  if (pinnedStoreOnly(vault)) return { path: pinnedLocation(vault), ...readStorePinned() };
  const path = brainPinnedPath(legacyVaultOf(vault, "readPinnedContext"));
  if (!existsSync(path)) {
    return { path, present: false, content: "" };
  }
  return {
    path,
    present: true,
    content: readFileSync(path, "utf8").trimEnd(),
  };
}

/**
 * The vault identity guard of a pinned write; with no vault the store
 * write checks the store identity instead (design D14 item 13).
 */
function guardPinnedWrite(vault: string | null): void {
  if (vault !== null) assertVaultIdentityForWrite(vault);
}

/** Whether pinned context for `vault` lives in the store only (task 2.10). */
function pinnedStoreOnly(vault: string | null): boolean {
  // No vault means store-only too (design D14).
  return vault === null || isStoreOnly({ vault });
}

/**
 * The pinned register this machine reads and writes: `private` when it
 * holds that partition, `shared` otherwise (FORMAT.md, "Pinned context").
 * The one rule the reported name and the read follow.
 */
function pinnedPartition(store: StoreInspection | null = configuredStore()): "private" | "shared" {
  return store !== null && store.partitions.has("private") ? "private" : "shared";
}

/**
 * Prefix of the name a store-only machine reports for its pinned context:
 * `store:<partition>/pinned`, the register the text lives in. It is a name,
 * not a file path, so no result hands a caller a legacy `Brain/` path for
 * text that was never written there.
 */
const PINNED_STORE_NAME_PREFIX = "store:";

/** Where the pinned context of `vault` lives: the register, or the legacy file. */
function pinnedLocation(vault: string | null): string {
  return pinnedStoreOnly(vault)
    ? `${PINNED_STORE_NAME_PREFIX}${pinnedPartition()}/pinned`
    : brainPinnedPath(legacyVaultOf(vault, "pinnedLocation"));
}

function readStorePinned(): { present: boolean; content: string } {
  const store = configuredStore();
  if (store === null) return { present: false, content: "" };
  const content = readEntitiesOf(store).pinned.get(pinnedPartition(store))?.content ?? null;
  return content === null
    ? { present: false, content: "" }
    : { present: true, content: content.trimEnd() };
}

/**
 * Write the pinned text: `Brain/pinned.md` plus the dual write on an
 * unswitched machine, the record only once switched. `namesPrivate` is
 * judged lazily, only when a record is built.
 */
function commitPinned(
  vault: string | null,
  content: string | null,
  namesPrivate: () => boolean,
): void {
  routeWrite({
    legacy: () => {
      const text = content ?? "";
      atomicWriteFileSync(
        brainPinnedPath(legacyVaultOf(vault, "commitPinned")),
        text.length > 0 ? `${text}\n` : "",
      );
    },
    store: () => pinnedRecord(content, authorityFromOrigin(), namesPrivate()),
    context: { vault },
  });
}

/**
 * Run `fn` holding the pinned file's sync lock. Whatever `fn` reads of the
 * current content it must read INSIDE this call, or the lock protects
 * nothing. Once switched the lock lives in the device-local state, so
 * taking it writes nothing under `Brain/`.
 */
function withPinnedLock<T>(vault: string | null, fn: () => T): T {
  const target = pinnedStoreOnly(vault)
    ? join(storesStateDir(processDirsEnv()), "pinned")
    : brainPinnedPath(legacyVaultOf(vault, "withPinnedLock"));
  const handle = acquireLockSyncWithRetry(target);
  try {
    return fn();
  } finally {
    handle.release();
  }
}

export function writePinnedContext(vault: string | null, content: unknown): PinnedContext {
  const normalised = normalisePinnedContentNoTruncate(content);
  // Vault-identity write guard (Unit J) BEFORE the lock, as clear and the
  // batch path do: a refused vault gets no lock file and no lock wait.
  guardPinnedWrite(vault);
  return withPinnedLock(vault, () => commitPinnedContent(vault, normalised, "write"));
}

export function appendPinnedContext(vault: string | null, content: unknown): PinnedContext {
  const incoming = normalisePinnedContentNoTruncate(content);
  if (incoming.length === 0) return readPinnedContext(vault);

  guardPinnedWrite(vault);
  return withPinnedLock(vault, () => {
    const current = readPinnedContext(vault).content;
    const next = current.length > 0 ? `${current}\n\n${incoming}` : incoming;
    return commitPinnedContent(vault, next, "append");
  });
}

/**
 * Budget-checked commit shared by the single-operation `write`/`append`
 * paths. Over-budget input is rejected with a structured
 * {@link PinnedBatchError} (`budget_exceeded`) BEFORE any write, mirroring
 * the batch path — never silently truncated to fake a successful write.
 * The agent gets back the byte sizes and a consolidation hint so it can
 * shrink the content and retry (the same consolidate-then-retry contract
 * the batch `operations` mode and Hermes' native memory store use).
 */
function commitPinnedContent(
  vault: string | null,
  normalised: string,
  operation: "write" | "append",
): PinnedContext {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  guardPinnedWrite(vault);
  assertWithinPinnedBudget(normalised, operation);
  const path = pinnedLocation(vault);
  // Brain store write (dual write behind the flag on an unswitched
  // machine), inside the pinned lock so the store sees replacements in the
  // order the file did.
  commitPinned(vault, normalised, () => pinnedTextIsPrivate(vault, normalised));
  return { path, present: true, content: normalised };
}

export function clearPinnedContext(vault: string | null): PinnedContext {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  guardPinnedWrite(vault);
  const path = pinnedLocation(vault);
  return withPinnedLock(vault, () => {
    // A clear goes where a set of the text it clears goes, so it lands in
    // the same partition register as that set. The text is read only for
    // the dual write: with the flag off a clear never depends on reading
    // the old file, and one that cannot be read is judged private (fail
    // closed), never shared.
    let namesPrivate = true;
    if (pinnedStoreOnly(vault) || isDualWriteEnabled()) {
      try {
        namesPrivate = pinnedTextIsPrivate(vault, readPinnedContext(vault).content);
      } catch {
        namesPrivate = true;
      }
    }
    commitPinned(vault, null, () => namesPrivate);
    return { path, present: true, content: "" };
  });
}

/**
 * Normalise pinned-context input WITHOUT the length cap. The budget is
 * enforced separately and explicitly so over-budget input is rejected
 * (`budget_exceeded`) instead of being silently truncated to look like a
 * successful write. Sanitisation (redaction, control-char stripping,
 * NFC) still applies.
 */
function normalisePinnedContentNoTruncate(content: unknown): string {
  return sanitiseTextField(content, { maxLen: Number.POSITIVE_INFINITY }).trim();
}

/**
 * Hint surfaced on every `budget_exceeded` rejection: tells the agent how
 * to recover (shrink/consolidate, then retry — optionally via the atomic
 * batch `operations` mode so consolidate+rewrite happen in one call).
 */
const BUDGET_HINT =
  "consolidate or shorten the content below the budget and retry; the atomic `operations` batch mode can clear/replace and rewrite in a single call";

/**
 * Reject over-budget pinned content with a structured signal before any
 * write. Shared by the single-operation commit and the batch projection
 * so both surfaces enforce the budget identically. `operation` is
 * `"batch"` for the ordered-operations path.
 */
function assertWithinPinnedBudget(content: string, operation: "write" | "append" | "batch"): void {
  if (content.length <= MAX_PINNED_CONTEXT_LEN) return;
  throw new PinnedBatchError(
    "budget_exceeded",
    -1,
    `pinned context ${operation} of ${content.length} chars exceeds the ${MAX_PINNED_CONTEXT_LEN} budget`,
    {
      operation,
      length: content.length,
      budget: MAX_PINNED_CONTEXT_LEN,
      over_by: content.length - MAX_PINNED_CONTEXT_LEN,
      hint: BUDGET_HINT,
    },
  );
}

// ----- Atomic batch operations (t_c492e539) --------------------------------

/**
 * Ordered pinned-context mutation. Mirrors the single-operation surface
 * (`write` / `append` / `clear`) plus a targeted `replace` that swaps an
 * exact text segment. The batch is projected entirely in memory and only
 * the final state is written, so any invalid op aborts with zero disk
 * mutation.
 */
export type PinnedOperation =
  | { readonly op: "write"; readonly content?: unknown }
  | { readonly op: "append"; readonly content?: unknown }
  | { readonly op: "clear" }
  | { readonly op: "replace"; readonly find?: unknown; readonly replace?: unknown };

export type PinnedBatchErrorCode =
  | "invalid_operation"
  | "replace_target_missing"
  | "budget_exceeded";

/**
 * All-or-nothing failure for {@link applyPinnedOperations}. Thrown before
 * any write happens, so the on-disk pinned file is guaranteed unchanged.
 * Carries machine-readable detail (offending op index, budget sizes) so
 * the MCP layer can surface a structured error instead of opaque prose.
 */
export class PinnedBatchError extends Error {
  readonly code: PinnedBatchErrorCode;
  /** Index of the offending operation; `-1` for batch-level failures. */
  readonly index: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PinnedBatchErrorCode,
    index: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PinnedBatchError";
    this.code = code;
    this.index = index;
    this.details = details;
  }
}

export interface PinnedBatchResult extends PinnedContext {
  /** Number of operations applied (== operations.length on success). */
  readonly applied: number;
  /** Terminal success marker: the write committed, do not re-call. */
  readonly done: true;
}

/**
 * Apply an ordered batch of pinned-context operations atomically.
 *
 * Every operation is validated and projected against an in-memory copy of
 * the current content; the file is written exactly once, at the end, only
 * if every operation and the final budget check pass. A malformed op, an
 * absent `replace` target, or an over-budget final projection throws
 * {@link PinnedBatchError} and leaves `Brain/pinned.md` byte-for-byte
 * unchanged.
 *
 * Carries the same vault-identity guard as the single-operation surface.
 * Both modes are the one `brain_pinned_context` tool writing the one
 * file, so a batch that wrote where a single `write` refused would make
 * the guard a property of the argument shape rather than of the vault.
 */
export function applyPinnedOperations(
  vault: string | null,
  operations: ReadonlyArray<PinnedOperation>,
): PinnedBatchResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  guardPinnedWrite(vault);
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PinnedBatchError("invalid_operation", -1, "operations must be a non-empty array");
  }

  return withPinnedLock(vault, () => {
    // Projected from the content read under the lock, so a batch never
    // overwrites a write that landed between its read and its commit.
    let projected = readPinnedContext(vault).content;
    operations.forEach((operation, index) => {
      projected = projectPinnedOperation(projected, operation, index);
    });

    assertWithinPinnedBudget(projected, "batch");

    const path = pinnedLocation(vault);
    commitPinned(vault, projected, () => pinnedTextIsPrivate(vault, projected));
    return {
      path,
      present: true,
      content: projected,
      applied: operations.length,
      done: true as const,
    };
  });
}

function projectPinnedOperation(
  current: string,
  operation: PinnedOperation,
  index: number,
): string {
  const op = (operation as { readonly op?: unknown } | null | undefined)?.op;
  switch (op) {
    case "write":
      return normalisePinnedContentNoTruncate((operation as { content?: unknown }).content);
    case "append": {
      const incoming = normalisePinnedContentNoTruncate(
        (operation as { content?: unknown }).content,
      );
      if (incoming.length === 0) return current;
      return current.length > 0 ? `${current}\n\n${incoming}` : incoming;
    }
    case "clear":
      return "";
    case "replace": {
      const find = (operation as { find?: unknown }).find;
      if (typeof find !== "string" || find.length === 0) {
        throw new PinnedBatchError(
          "invalid_operation",
          index,
          `operation ${index}: replace requires a non-empty string 'find'`,
        );
      }
      if (!current.includes(find)) {
        throw new PinnedBatchError(
          "replace_target_missing",
          index,
          `operation ${index}: replace target not found in current pinned context`,
          { find },
        );
      }
      const replacement = normalisePinnedContentNoTruncate(
        (operation as { replace?: unknown }).replace,
      );
      return current.split(find).join(replacement);
    }
    default:
      throw new PinnedBatchError(
        "invalid_operation",
        index,
        `operation ${index}: unknown op '${String(op)}' (expected write|append|clear|replace)`,
      );
  }
}
