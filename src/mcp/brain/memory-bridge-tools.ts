/**
 * Host memory-write bridge tool: `brain_memory_bridge` (t_5e06b572).
 *
 * The Hermes memory provider's `on_memory_write` hook calls this tool to
 * persist a native built-in-memory write into the vault as a durable
 * `host_memory_write` continuity record. It is a deliberate v1.x surface
 * addition (recorded in tests/mcp/brain-tools-parity.test.ts); hidden tools
 * are banned by the 1.0.0 sweep, so it is advertised normally but kept OUT
 * of the provider's curated MEMORY_TOOLS list — the Hermes agent never sees
 * it, only the on_memory_write hook calls it via the bridge.
 *
 * The handler is thin glue: it coerces arguments and delegates to the
 * deterministic `recordHostMemoryWrite(s)` core, mapping a typed
 * {@link HostMemoryWriteError} onto a structured INVALID_PARAMS. A single
 * write is the only shape the host ever sends (it decomposes batches
 * host-side); the optional `operations` array reuses the same atomic
 * continuity substrate for any multi-record caller.
 */

import {
  HostMemoryWriteError,
  recordHostMemoryWrite,
  recordHostMemoryWrites,
  type HostMemoryWriteInput,
} from "../../core/brain/host-memory-write.ts";
import type { ContinuityRecord } from "../../core/brain/continuity/types.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr } from "../coerce.ts";

function coerceMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, "brain_memory_bridge: metadata must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function coerceOperation(value: unknown, index: number): HostMemoryWriteInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_memory_bridge: operations[${index}] must be an object`,
    );
  }
  const op = value as Record<string, unknown>;
  return {
    action: coerceStr(op, "action", true)!,
    target: coerceStr(op, "target", true)!,
    content: coerceStr(op, "content", true)!,
    ...(op["metadata"] !== undefined ? { metadata: coerceMetadata(op["metadata"]) } : {}),
  };
}

function serialize(records: ReadonlyArray<ContinuityRecord>): Record<string, unknown> {
  return {
    recorded: true,
    kind: "host_memory_write",
    count: records.length,
    ids: records.map((record) => record.id),
  };
}

function hostMemoryWriteErrorToMcp(err: unknown): unknown {
  if (err instanceof HostMemoryWriteError) {
    return new MCPError(INVALID_PARAMS, `brain_memory_bridge: ${err.message}`, {
      code: err.code,
      ...(err.index !== undefined ? { index: err.index } : {}),
    });
  }
  return err;
}

async function toolBrainMemoryBridge(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    if (args["operations"] !== undefined) {
      const raw = args["operations"];
      if (!Array.isArray(raw)) {
        throw new MCPError(INVALID_PARAMS, "brain_memory_bridge: operations must be an array");
      }
      const inputs = raw.map((entry, index) => coerceOperation(entry, index));
      return serialize(recordHostMemoryWrites(ctx.vault, inputs));
    }
    const single: HostMemoryWriteInput = {
      action: coerceStr(args, "action", true)!,
      target: coerceStr(args, "target", true)!,
      content: coerceStr(args, "content", true)!,
      ...(args["metadata"] !== undefined ? { metadata: coerceMetadata(args["metadata"]) } : {}),
    };
    return serialize([recordHostMemoryWrite(ctx.vault, single)]);
  } catch (err) {
    throw hostMemoryWriteErrorToMcp(err);
  }
}

const MEMORY_BRIDGE_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["recorded", "kind", "count", "ids"],
  properties: {
    recorded: { type: "boolean" },
    kind: { type: "string" },
    count: { type: "integer" },
    ids: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

export const MEMORY_BRIDGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_memory_bridge",
    description:
      "Host memory bridge: persist a Hermes built-in memory write (action add|replace, target memory|user) into the vault as a durable host_memory_write continuity record. Called by the provider on_memory_write hook; pass `operations` for an atomic batch.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace"], description: "Host write action." },
        target: { type: "string", enum: ["memory", "user"], description: "Host write target." },
        content: { type: "string", description: "The memory entry content." },
        metadata: {
          type: "object",
          description: "Optional host provenance (write_origin, session_id, tool_name, …).",
        },
        operations: {
          type: "array",
          description:
            "Optional ordered batch applied atomically; any invalid entry aborts the whole batch with no write.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace"] },
              target: { type: "string", enum: ["memory", "user"] },
              content: { type: "string" },
              metadata: { type: "object" },
            },
            required: ["action", "target", "content"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    outputSchema: MEMORY_BRIDGE_OUTPUT_SCHEMA,
    handler: toolBrainMemoryBridge,
  },
]);
