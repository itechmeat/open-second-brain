/**
 * The pinned-context tool family (task 3.19): `brain_pinned_context`
 * with its operation coercion, the serialization a read or a batch
 * answers through, and the append helper the active-digest tool reuses.
 * Split from `context-tools.ts`; registration happens through that
 * module's registry, which preserves the public CONTEXT_TOOLS surface.
 */

import {
  PinnedBatchError,
  applyPinnedOperations,
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
  type PinnedBatchResult,
  type PinnedContext,
  type PinnedOperation,
} from "../../core/brain/pinned.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextVault, type ServerContext } from "../tool-contract.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { deliveryView } from "./reach-events.ts";
import { toolPath } from "./device-path.ts";

export type PinnedContextOperation = "read" | "write" | "append" | "clear";

export function coercePinnedContextOperation(
  args: Record<string, unknown>,
): PinnedContextOperation {
  const operation = coerceStr(args, "operation", false) ?? "read";
  if (
    operation !== "read" &&
    operation !== "write" &&
    operation !== "append" &&
    operation !== "clear"
  ) {
    throw unknownOperationError(
      "brain_pinned_context operation must be one of: read, write, append, clear",
    );
  }
  return operation;
}

/**
 * The scratchpad body as THIS request may receive it (delivery-trust,
 * lane A): stored text, so at remote reach it is shaped through the
 * request's delivery binding - fenced, naming the scratchpad file's own
 * derived provenance - and at local reach the stored bytes untouched. An
 * absent scratchpad has no body to fence. `delivery` may be handed in by
 * a caller that already holds the request's binding, so one request
 * keeps one frontmatter cache.
 */
export function shapedPinnedContent(
  ctx: ServerContext,
  pinned: PinnedContext,
  delivery: ReturnType<typeof deliveryView> = deliveryView(ctx),
): string {
  if (!pinned.present || pinned.content.length === 0) return pinned.content;
  return delivery.shape(pinned.content, toolPath(ctx, pinned.path));
}

export function serializePinnedContext(
  ctx: ServerContext,
  pinned: PinnedContext,
  operation?: PinnedContextOperation,
  done?: boolean,
  opts?: { shapeBody?: boolean; delivery?: ReturnType<typeof deliveryView> },
): Record<string, unknown> {
  return {
    ...(operation ? { operation } : {}),
    present: pinned.present,
    path: toolPath(ctx, pinned.path),
    absolute_path: pinned.path,
    // Only a READ shapes the body (delivery-trust, lane A). A write or
    // batch confirmation echoes bytes the caller just authored - the
    // terminal-ack contract stays byte-stable; the delivery contract is
    // about handing stored text to a caller that did not write it.
    content:
      opts?.shapeBody === true
        ? shapedPinnedContent(ctx, pinned, opts.delivery ?? deliveryView(ctx))
        : pinned.content,
    // Terminal/idempotent marker on successful writes so the agent does
    // not redundantly re-call after the store already committed.
    ...(done ? { done: true } : {}),
  };
}

export async function toolBrainPinnedContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (args["operations"] !== undefined) {
    return runPinnedContextBatch(ctx, args["operations"]);
  }
  const operation = coercePinnedContextOperation(args);
  if (operation === "read") {
    return serializePinnedContext(ctx, readPinnedContext(contextVault(ctx)), operation, undefined, {
      shapeBody: true,
    });
  }
  let pinned: PinnedContext;
  try {
    if (operation === "write") {
      pinned = writePinnedContext(contextVault(ctx), coerceStr(args, "content", true)!);
    } else if (operation === "append") {
      pinned = appendPinnedContext(contextVault(ctx), coerceStr(args, "content", true)!);
    } else {
      pinned = clearPinnedContext(contextVault(ctx));
    }
  } catch (err) {
    throw pinnedBatchErrorToMcp(err);
  }
  return serializePinnedContext(ctx, pinned, operation, true);
}

/**
 * Map a core {@link PinnedBatchError} (budget-exceeded, malformed op,
 * absent replace target) onto a structured INVALID_PARAMS so the agent
 * gets a machine-readable rejection — `code`, offending `index`, byte
 * sizes, and a consolidation hint — instead of an opaque message or, for
 * over-budget writes, a fake truncated success. Non-pinned errors pass
 * through unchanged.
 */
export function pinnedBatchErrorToMcp(err: unknown): unknown {
  if (err instanceof PinnedBatchError) {
    return new MCPError(INVALID_PARAMS, `brain_pinned_context: ${err.message}`, {
      code: err.code,
      index: err.index,
      ...err.details,
    });
  }
  return err;
}

/**
 * Atomic ordered-operations mode for `brain_pinned_context`. The whole
 * batch is validated and projected in memory by the core; a malformed op,
 * absent replace target, or over-budget final state aborts with zero
 * writes and surfaces as a structured INVALID_PARAMS error.
 */
export function runPinnedContextBatch(
  ctx: ServerContext,
  operationsRaw: unknown,
): Record<string, unknown> {
  let result: PinnedBatchResult;
  try {
    result = applyPinnedOperations(
      contextVault(ctx),
      operationsRaw as ReadonlyArray<PinnedOperation>,
    );
  } catch (err) {
    throw pinnedBatchErrorToMcp(err);
  }
  return {
    ...serializePinnedContext(ctx, result, undefined, true),
    operations_applied: result.applied,
  };
}

export function appendPinnedToContextContent(activeContent: string, pinnedContent: string): string {
  if (pinnedContent.length === 0) return activeContent;
  const pinnedBlock = `## Pinned context\n\n${pinnedContent}`;
  const trimmedActive = activeContent.trimEnd();
  if (trimmedActive.length === 0) return `${pinnedBlock}\n`;
  return `${trimmedActive}\n\n${pinnedBlock}\n`;
}
