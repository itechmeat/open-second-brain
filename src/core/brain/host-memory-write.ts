/**
 * Host memory-write bridge core (t_5e06b572).
 *
 * Persists a Hermes built-in memory-tool write into the vault as a durable
 * `host_memory_write` continuity record, so the vault becomes the backing
 * store for native host memory instead of relying on the agent to call
 * `brain_*` explicitly.
 *
 * VERIFIED HOST CONTRACT (Hermes c253b0738 — do not re-derive from memory):
 *   - `MemoryProvider.on_memory_write(action, target, content, metadata=None)`
 *     (agent/memory_provider.py); the manager dispatches it once per write.
 *   - Providers NEVER receive a batch: the builtin tool accepts an
 *     `operations[]` array but Hermes DECOMPOSES it host-side and calls the
 *     hook once per op (agent/tool_executor.py, agent/agent_runtime_helpers.py).
 *   - Only `action ∈ {add, replace}` are bridged; `remove` is filtered out
 *     host-side and never reaches a provider.
 *   - `target ∈ {memory, user}` ("memory" = agent notes, "user" = profile facts).
 *   - The hook returns nothing; the manager swallows exceptions. Explicit
 *     rejection here is for the in-process callers and tests, not the host.
 *
 * This kernel is deterministic and provider-agnostic: it never calls an LLM
 * and parses no natural language — it maps already-structured fields. The
 * `operations` batch helper exists so the (host-decomposed) single writes and
 * any future multi-record caller share one validated, atomic substrate
 * (`appendContinuityRecords`), not because the host ever sends a batch.
 */

import { appendContinuityRecord, appendContinuityRecords } from "./continuity/store.ts";
import type { AppendContinuityRecordInput, ContinuityRecord } from "./continuity/types.ts";

export const HOST_MEMORY_WRITE_KIND = "host_memory_write" as const;

/** Actions Hermes bridges to providers. `remove` is filtered out host-side. */
const BRIDGED_ACTIONS = Object.freeze(new Set(["add", "replace"]));
/** Targets the builtin memory tool writes to. */
const KNOWN_TARGETS = Object.freeze(new Set(["memory", "user"]));

export type HostMemoryWriteErrorCode = "invalid_action" | "invalid_target" | "empty_content";

/**
 * A malformed/unsupported host payload. Carries a machine-readable `code`
 * and the offending batch `index` (when raised from the batch path) so the
 * MCP layer can surface a structured rejection instead of a vague failure.
 */
export class HostMemoryWriteError extends Error {
  readonly code: HostMemoryWriteErrorCode;
  readonly index?: number;

  constructor(code: HostMemoryWriteErrorCode, message: string, index?: number) {
    super(message);
    this.name = "HostMemoryWriteError";
    this.code = code;
    if (index !== undefined) this.index = index;
  }
}

export interface HostMemoryWriteInput {
  /** Verified host action; only `add`/`replace` are accepted. */
  readonly action: string;
  /** Verified host target; only `memory`/`user` are accepted. */
  readonly target: string;
  /** The memory entry content. */
  readonly content: string;
  /** Optional structured provenance from the host (write_origin, session_id, …). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** ISO timestamp override; defaults to now. Records are sharded by month. */
  readonly createdAt?: string;
}

/**
 * Validate one host write and project it to a continuity append input.
 * Throws {@link HostMemoryWriteError} on a malformed/unsupported payload
 * BEFORE any disk mutation, so callers can rely on all-or-nothing semantics.
 */
function toAppendInput(input: HostMemoryWriteInput, index?: number): AppendContinuityRecordInput {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (!BRIDGED_ACTIONS.has(action)) {
    throw new HostMemoryWriteError(
      "invalid_action",
      `action must be 'add' or 'replace' (got '${input.action}'); 'remove' is not bridged by the host`,
      index,
    );
  }
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!KNOWN_TARGETS.has(target)) {
    throw new HostMemoryWriteError(
      "invalid_target",
      `target must be 'memory' or 'user' (got '${input.target}')`,
      index,
    );
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new HostMemoryWriteError("empty_content", "content must be a non-empty string", index);
  }

  const metadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : undefined;

  return {
    kind: HOST_MEMORY_WRITE_KIND,
    createdAt: input.createdAt ?? new Date().toISOString(),
    payload: {
      action,
      target,
      content: input.content,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

/**
 * Persist a single host memory write as a `host_memory_write` continuity
 * record. Throws on a malformed payload, writing nothing.
 */
export function recordHostMemoryWrite(
  vault: string,
  input: HostMemoryWriteInput,
): ContinuityRecord {
  return appendContinuityRecord(vault, toAppendInput(input));
}

/**
 * Persist a batch of host memory writes atomically through the shared
 * continuity batch substrate. EVERY input is validated first; one malformed
 * entry aborts the whole batch with zero writes (the on-disk log is left
 * unchanged). Single-month batches are fully atomic — see
 * {@link appendContinuityRecords} for the cross-shard boundary.
 */
export function recordHostMemoryWrites(
  vault: string,
  inputs: ReadonlyArray<HostMemoryWriteInput>,
): ReadonlyArray<ContinuityRecord> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new HostMemoryWriteError("empty_content", "operations must be a non-empty array");
  }
  const appendInputs = inputs.map((input, index) => toAppendInput(input, index));
  return appendContinuityRecords(vault, appendInputs);
}
