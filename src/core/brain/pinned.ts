import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sanitiseTextField } from "../redactor.ts";
import { brainPinnedPath } from "./paths.ts";

export const MAX_PINNED_CONTEXT_LEN = 20_000;

export interface PinnedContext {
  readonly path: string;
  readonly present: boolean;
  readonly content: string;
}

export function readPinnedContext(vault: string): PinnedContext {
  const path = brainPinnedPath(vault);
  if (!existsSync(path)) {
    return { path, present: false, content: "" };
  }
  return {
    path,
    present: true,
    content: readFileSync(path, "utf8").trimEnd(),
  };
}

export function writePinnedContext(vault: string, content: unknown): PinnedContext {
  const path = brainPinnedPath(vault);
  const normalised = normalisePinnedContent(content);
  atomicWriteFileSync(path, normalised.length > 0 ? `${normalised}\n` : "");
  return { path, present: true, content: normalised };
}

export function appendPinnedContext(vault: string, content: unknown): PinnedContext {
  const incoming = normalisePinnedContent(content);
  if (incoming.length === 0) return readPinnedContext(vault);

  const current = readPinnedContext(vault).content;
  const next = current.length > 0 ? `${current}\n\n${incoming}` : incoming;
  return writePinnedContext(vault, next);
}

export function clearPinnedContext(vault: string): PinnedContext {
  const path = brainPinnedPath(vault);
  atomicWriteFileSync(path, "");
  return { path, present: true, content: "" };
}

function normalisePinnedContent(content: unknown): string {
  return sanitiseTextField(content, {
    maxLen: MAX_PINNED_CONTEXT_LEN,
  }).trim();
}

/**
 * Like {@link normalisePinnedContent} but WITHOUT the length cap. Used by
 * the batch path so over-budget input is rejected explicitly
 * (`budget_exceeded`) instead of being silently truncated to look like a
 * successful write. Single-operation callers keep the capped helper for
 * byte-identical behaviour.
 */
function normalisePinnedContentNoTruncate(content: unknown): string {
  return sanitiseTextField(content, { maxLen: Number.POSITIVE_INFINITY }).trim();
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
 */
export function applyPinnedOperations(
  vault: string,
  operations: ReadonlyArray<PinnedOperation>,
): PinnedBatchResult {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PinnedBatchError("invalid_operation", -1, "operations must be a non-empty array");
  }

  let projected = readPinnedContext(vault).content;
  operations.forEach((operation, index) => {
    projected = projectPinnedOperation(projected, operation, index);
  });

  if (projected.length > MAX_PINNED_CONTEXT_LEN) {
    throw new PinnedBatchError(
      "budget_exceeded",
      -1,
      `pinned context batch result of ${projected.length} chars exceeds the ${MAX_PINNED_CONTEXT_LEN} budget`,
      { projected_length: projected.length, budget: MAX_PINNED_CONTEXT_LEN },
    );
  }

  const path = brainPinnedPath(vault);
  atomicWriteFileSync(path, projected.length > 0 ? `${projected}\n` : "");
  return { path, present: true, content: projected, applied: operations.length, done: true };
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
