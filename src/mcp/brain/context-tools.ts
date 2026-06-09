/**
 * Context assembly: write sessions, pinned scratchpad, session bootstrap, context packing, receipts, presets, and pre-compress/pre-compact surfaces.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveAgentName, resolveSearchFocusContextPack } from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import { readActiveSessionFocus } from "../../core/search/session-focus.ts";
import { brainActivePath, brainDirs } from "../../core/brain/paths.ts";
import { regenerateActive, type RegenerateActiveResult } from "../../core/brain/active.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { readVaultInstructionFile } from "../../core/brain/vault-instruction-file.ts";
import { packContext } from "../../core/brain/context-pack.ts";
import { buildPreCompressPack } from "../../core/brain/pre-compress-pack.ts";
import {
  getContextReceipt,
  isContextReceiptTrigger,
  listContextReceipts,
  summarizeContextReceipt,
  type ContextReceiptOptions,
} from "../../core/brain/context-receipts.ts";
import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  suggestContextPreset,
  type ContextPresetCurrentConfig,
} from "../../core/brain/context-presets.ts";
import { extractPreCompactRecords } from "../../core/brain/pre-compact-extract.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import {
  WriteSessionRequestError,
  abandonSession,
  approveSession,
  openArtifactSession,
  sessionEnvelope,
} from "../../core/brain/write-session/engine.ts";
import { dispatchSubmit, openPanelSession } from "../../core/brain/write-session/panel.ts";
import { listWriteSessions, readWriteSession } from "../../core/brain/write-session/store.ts";
import type { WriteSessionEnvelope } from "../../core/brain/write-session/types.ts";
import {
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
  type PinnedContext,
} from "../../core/brain/pinned.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr, coerceStrList, coerceBool, coerceInt } from "../coerce.ts";
import {
  coercePositiveInteger,
  optionalPositiveInt,
  optionalStringArg,
  requiredStringArg,
  telemetryOptionsFromArgs,
  vaultRelativeSafe,
} from "./shared.ts";

/**
 * One agent-facing surface for the write-session kernel: `op`
 * discriminates the lifecycle operation, `kind` (open only) picks
 * artifact vs panel. Envelopes are the same JSON the CLI prints -
 * status, step, prompt, errors, attempts_left, expires_at, target.
 * Structured request failures surface as INVALID_PARAMS with the
 * machine-readable error list in the message.
 */
async function toolBrainWriteSession(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = coerceStr(args, "op", true)!;
  const sessionId = coerceStr(args, "session_id", false);
  const requireSessionId = (): string => {
    if (!sessionId) {
      throw new MCPError(INVALID_PARAMS, `brain_write_session: op '${op}' requires session_id`);
    }
    return sessionId;
  };
  try {
    switch (op) {
      case "open": {
        const kind = coerceStr(args, "kind", false) ?? "artifact";
        const agent =
          normalizeAgentArgument(coerceStr(args, "agent", false) ?? null) ??
          resolveAgentName(ctx.configPath ?? undefined);
        const requireReview = args["require_review"] === true;
        if (kind === "panel") {
          const topic = coerceStr(args, "topic", true)!;
          const personasRaw = args["personas"];
          const personas = Array.isArray(personasRaw)
            ? personasRaw.filter((x): x is string => typeof x === "string")
            : undefined;
          const target = coerceStr(args, "target", false);
          return asRecord(
            openPanelSession(ctx.vault, {
              agent,
              topic,
              requireReview,
              ...(personas && personas.length > 0 ? { personas } : {}),
              ...(target ? { targetPath: target } : {}),
            }),
          );
        }
        if (kind !== "artifact") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_write_session: kind must be 'artifact' or 'panel', got '${kind}'`,
          );
        }
        const target = coerceStr(args, "target", true)!;
        const intent = coerceStr(args, "intent", false) ?? "create";
        if (intent !== "create" && intent !== "overwrite" && intent !== "merge") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_write_session: intent must be create|overwrite|merge, got '${intent}'`,
          );
        }
        const schemaType = coerceStr(args, "schema_type", false);
        const prompt = coerceStr(args, "prompt", false);
        const retryCap = args["retry_cap"];
        return asRecord(
          openArtifactSession(ctx.vault, {
            agent,
            targetPath: target,
            intent,
            requireReview,
            ...(schemaType ? { schemaType } : {}),
            ...(prompt ? { prompt } : {}),
            ...(typeof retryCap === "number" ? { retryCap } : {}),
          }),
        );
      }
      case "submit": {
        const id = requireSessionId();
        const text = coerceStr(args, "text", true)!;
        return asRecord(dispatchSubmit(ctx.vault, { sessionId: id, text }));
      }
      case "approve":
        return asRecord(approveSession(ctx.vault, { sessionId: requireSessionId() }));
      case "abandon":
        return asRecord(abandonSession(ctx.vault, { sessionId: requireSessionId() }));
      case "status": {
        const id = requireSessionId();
        const probe = readWriteSession(ctx.vault, id, new Date().toISOString());
        if (probe.error !== null) throw new MCPError(INVALID_PARAMS, probe.error);
        if (probe.session === null) {
          throw new MCPError(INVALID_PARAMS, `unknown write-session: ${id}`);
        }
        return asRecord(sessionEnvelope(probe.session));
      }
      case "list": {
        const limit = coerceInt(args, "limit", 100, 1, 500);
        const sessions = listWriteSessions(ctx.vault, new Date().toISOString());
        return {
          total: sessions.length,
          sessions: sessions.slice(0, limit).map((rec) => asRecord(sessionEnvelope(rec))),
        };
      }
      default:
        throw new MCPError(
          INVALID_PARAMS,
          `brain_write_session: op must be open|submit|approve|abandon|status|list, got '${op}'`,
        );
    }
  } catch (err) {
    if (err instanceof WriteSessionRequestError) {
      // Preserve the {code, path, message} boundary contract: the
      // structured list rides MCPError's data slot, the message stays
      // human-readable prose.
      throw new MCPError(
        INVALID_PARAMS,
        err.message,
        err.errors.length > 0 ? { errors: err.errors } : undefined,
      );
    }
    throw err;
  }
}

function asRecord(envelope: WriteSessionEnvelope): Record<string, unknown> {
  return { ...envelope };
}

// ----- brain_context (v0.10.10) --------------------------------------------

type PinnedContextOperation = "read" | "write" | "append" | "clear";

function coercePinnedContextOperation(args: Record<string, unknown>): PinnedContextOperation {
  const operation = coerceStr(args, "operation", false) ?? "read";
  if (
    operation !== "read" &&
    operation !== "write" &&
    operation !== "append" &&
    operation !== "clear"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_pinned_context operation must be one of: read, write, append, clear",
    );
  }
  return operation;
}

function serializePinnedContext(
  ctx: ServerContext,
  pinned: PinnedContext,
  operation?: PinnedContextOperation,
): Record<string, unknown> {
  return {
    ...(operation ? { operation } : {}),
    present: pinned.present,
    path: vaultRelativeSafe(ctx.vault, pinned.path),
    absolute_path: pinned.path,
    content: pinned.content,
  };
}

async function toolBrainPinnedContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = coercePinnedContextOperation(args);
  let pinned: PinnedContext;
  if (operation === "read") {
    pinned = readPinnedContext(ctx.vault);
  } else if (operation === "write") {
    pinned = writePinnedContext(ctx.vault, coerceStr(args, "content", true)!);
  } else if (operation === "append") {
    pinned = appendPinnedContext(ctx.vault, coerceStr(args, "content", true)!);
  } else {
    pinned = clearPinnedContext(ctx.vault);
  }
  return serializePinnedContext(ctx, pinned, operation);
}

function appendPinnedToContextContent(activeContent: string, pinnedContent: string): string {
  if (pinnedContent.length === 0) return activeContent;
  const pinnedBlock = `## Pinned context\n\n${pinnedContent}`;
  const trimmedActive = activeContent.trimEnd();
  if (trimmedActive.length === 0) return `${pinnedBlock}\n`;
  return `${trimmedActive}\n\n${pinnedBlock}\n`;
}

type BrainContextCounts = RegenerateActiveResult["counts"];

const EMPTY_CONTEXT_COUNTS: BrainContextCounts = {
  confirmed: 0,
  quarantine: 0,
  retired_recent: 0,
  most_applied_30d: 0,
};

/**
 * Read-only pull-bootstrap of `Brain/active.md` + the active-preference
 * counts. Built for runtimes that have no `SessionStart` hook (Cursor,
 * Aider, raw Claude API): one tool call gives the agent the same
 * shortcut card the SessionStart-aware runtimes get injected
 * automatically.
 *
 * Behaviour matrix:
 *   - Brain/ absent           → present:false, content:"", zero counts.
 *   - Brain/ present, active.md absent → call regenerateActive (idempotent)
 *                                        and read the regenerated file.
 *   - Brain/ present, active.md fresh  → idempotent regenerate is a no-op
 *                                        rewrite; the on-disk body is
 *                                        returned verbatim.
 */
async function toolBrainContext(ctx: ServerContext): Promise<Record<string, unknown>> {
  const dirs = brainDirs(ctx.vault);
  const activePath = brainActivePath(ctx.vault);
  const pinned = readPinnedContext(ctx.vault);
  if (!existsSync(dirs.brain)) {
    return {
      vault_path: ctx.vault,
      present: false,
      active_path: activePath,
      content: "",
      counts: EMPTY_CONTEXT_COUNTS,
      generated_at: null,
      pinned: serializePinnedContext(ctx, pinned),
    };
  }

  let counts: BrainContextCounts = EMPTY_CONTEXT_COUNTS;
  let error: string | undefined;
  try {
    counts = regenerateActive(ctx.vault).counts;
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  // After a successful regenerateActive, active.md is guaranteed to
  // exist (the function either wrote it or confirmed an equal body
  // already on disk). A read failure here is an unrelated filesystem
  // race, not a missing-file branch — handle it in the same `error`
  // slot the regenerate failure uses.
  let content = "";
  let generatedAt: string | null = null;
  if (!error) {
    try {
      content = readFileSync(activePath, "utf8");
      const [meta] = parseFrontmatter(activePath);
      const v = meta["generated_at"];
      if (typeof v === "string" && v.trim().length > 0) {
        generatedAt = v;
      }
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
      content = "";
      generatedAt = null;
    }
  }
  content = appendPinnedToContextContent(content, pinned.content);

  // Optional vault-root instruction file (v0.10.17). Absent file =
  // field omitted so hosts that strip unknown fields stay
  // byte-identical. Read errors are silently swallowed - this is a
  // best-effort enrichment, not a hard contract.
  let vaultInstruction: ReturnType<typeof readVaultInstructionFile> = null;
  try {
    vaultInstruction = readVaultInstructionFile(ctx.vault);
  } catch {
    vaultInstruction = null;
  }

  return {
    vault_path: ctx.vault,
    present: true,
    active_path: activePath,
    content,
    counts,
    generated_at: generatedAt,
    pinned: serializePinnedContext(ctx, pinned),
    ...(error ? { error } : {}),
    ...(vaultInstruction
      ? {
          vault_instruction: {
            path: vaultInstruction.path,
            content: vaultInstruction.content,
            lines: vaultInstruction.lines,
          },
        }
      : {}),
  };
}

// ----- brain_digest --------------------------------------------------------

const PINNED_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["present", "path", "absolute_path", "content"],
  properties: {
    operation: { type: "string", enum: ["read", "write", "append", "clear"] },
    present: { type: "boolean" },
    path: { type: "string" },
    absolute_path: { type: "string" },
    content: { type: "string" },
  },
  additionalProperties: false,
};

const BRAIN_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["vault_path", "present", "active_path", "content", "counts", "generated_at", "pinned"],
  properties: {
    vault_path: { type: "string" },
    present: { type: "boolean" },
    active_path: { type: "string" },
    content: { type: "string" },
    counts: {
      type: "object",
      required: ["confirmed", "quarantine", "retired_recent", "most_applied_30d"],
      properties: {
        confirmed: { type: "integer" },
        quarantine: { type: "integer" },
        retired_recent: { type: "integer" },
        most_applied_30d: { type: "integer" },
      },
      additionalProperties: false,
    },
    generated_at: {},
    pinned: PINNED_CONTEXT_OUTPUT_SCHEMA,
  },
};

export const CONTEXT_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_write_session",
    description:
      "Provider-agnostic Brain write sessions (artifact and decision-panel kinds): open returns a generation prompt, submit validates the text, only clean artifacts commit. Correction loop, retry cap, collision guard, optional operator review. The calling agent generates; the Brain never does.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["open", "submit", "approve", "abandon", "status", "list"],
          description: "Lifecycle operation.",
        },
        kind: {
          type: "string",
          enum: ["artifact", "panel"],
          description: "Session kind for op=open. Defaults to artifact.",
        },
        session_id: {
          type: "string",
          description: "Session id (`ws-...`) for submit/approve/abandon/status.",
        },
        target: {
          type: "string",
          description:
            "Vault-relative commit target under Brain/ (artifact open; optional panel override). Reserved namespaces are refused.",
        },
        text: {
          type: "string",
          description:
            "Generated text for op=submit: the full artifact, a persona answer, or the synthesis.",
        },
        topic: { type: "string", description: "Decision topic (panel open)." },
        personas: {
          type: "array",
          items: { type: "string" },
          description:
            "Persona slugs to convene in order (panel open). Defaults to every loaded persona.",
        },
        schema_type: {
          type: "string",
          description: "Schema-pack page type the artifact must declare (artifact open).",
        },
        intent: {
          type: "string",
          enum: ["create", "overwrite", "merge"],
          description:
            "Commit intent against an existing target (artifact open). Default create - never overwrites.",
        },
        prompt: { type: "string", description: "Custom generation instruction (artifact open)." },
        require_review: {
          type: "boolean",
          description: "Park the validated artifact at needs-review until an operator approves.",
        },
        retry_cap: { type: "number", description: "Failed submits allowed per step (default 3)." },
        limit: {
          type: "number",
          description: "Max sessions returned by op=list (default 100, cap 500).",
        },
        agent: { type: "string", description: "Agent identity override (open)." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    handler: toolBrainWriteSession,
  },
  {
    name: "brain_pinned_context",
    description:
      "Read, write, append, or clear the transient current-task scratchpad at `Brain/pinned.md`. Use for facts that should survive context rotation but should not become permanent preferences.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "append", "clear"],
          description: "Operation to perform. Defaults to read.",
        },
        content: {
          type: "string",
          description: "Pinned context body for write/append operations.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: PINNED_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainPinnedContext,
  },
  {
    name: "brain_context",
    description:
      "Pull the current Brain/active.md body, pinned current-task context, and active-preference counts. Use at session start when SessionStart hook is unavailable (Cursor, Aider, raw Claude API). Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: BRAIN_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainContext,
  },
]);
