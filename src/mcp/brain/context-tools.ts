/**
 * Context assembly: write sessions, pinned scratchpad, session bootstrap, context packing, receipts, presets, and pre-compress/pre-compact surfaces.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveAgentName } from "../../core/config.ts";
import { brainActivePath, brainDirs, brainStandingRulesPath } from "../../core/brain/paths.ts";
import {
  readStandingRules,
  renderStandingRules,
  renderStandingRulesFailure,
  type StandingRules,
} from "../../core/brain/standing-rules.ts";
import { loadBrainConfig, resolveStandingRulesMaxChars } from "../../core/brain/policy.ts";
import type { BrainConfig } from "../../core/brain/types.ts";
import {
  regenerateActive,
  renderActive,
  type RegenerateActiveResult,
} from "../../core/brain/active.ts";
import { resolveOwnerScopeDelivery } from "../../core/brain/preferences-collect.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { readVaultInstructionFile } from "../../core/brain/vault-instruction-file.ts";
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
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr, coerceInt } from "../coerce.ts";
import { vaultRelativeSafe } from "./shared.ts";

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
  done?: boolean,
): Record<string, unknown> {
  return {
    ...(operation ? { operation } : {}),
    present: pinned.present,
    path: vaultRelativeSafe(ctx.vault, pinned.path),
    absolute_path: pinned.path,
    content: pinned.content,
    // Terminal/idempotent marker on successful writes so the agent does
    // not redundantly re-call after the store already committed.
    ...(done ? { done: true } : {}),
  };
}

async function toolBrainPinnedContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (args["operations"] !== undefined) {
    return runPinnedContextBatch(ctx, args["operations"]);
  }
  const operation = coercePinnedContextOperation(args);
  if (operation === "read") {
    return serializePinnedContext(ctx, readPinnedContext(ctx.vault), operation);
  }
  let pinned: PinnedContext;
  try {
    if (operation === "write") {
      pinned = writePinnedContext(ctx.vault, coerceStr(args, "content", true)!);
    } else if (operation === "append") {
      pinned = appendPinnedContext(ctx.vault, coerceStr(args, "content", true)!);
    } else {
      pinned = clearPinnedContext(ctx.vault);
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
function pinnedBatchErrorToMcp(err: unknown): unknown {
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
function runPinnedContextBatch(
  ctx: ServerContext,
  operationsRaw: unknown,
): Record<string, unknown> {
  let result: PinnedBatchResult;
  try {
    result = applyPinnedOperations(ctx.vault, operationsRaw as ReadonlyArray<PinnedOperation>);
  } catch (err) {
    throw pinnedBatchErrorToMcp(err);
  }
  return {
    ...serializePinnedContext(ctx, result, undefined, true),
    operations_applied: result.applied,
  };
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
 *   - Brain/ absent           → present:false, zero counts, and content
 *                               carrying the standing-rules block or the
 *                               statement that it could not be read (empty
 *                               for the ordinary case, where there is no
 *                               such file either).
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

  // The operator's standing rules, resolved before anything else this
  // surface assembles - INCLUDING the no-Brain return below. `brain_context`
  // is the pull-mode twin of the SessionStart hook, so the constitution has
  // to lead the content here for exactly the reason it leads the injected
  // payload: on the error branch further down, which zeroes `content` and
  // would otherwise hand a runtime the memory layer's failure and none of
  // the rules that still govern it, and equally on the branch that reports
  // `Brain/` as absent. That probe answers false for a directory it cannot
  // TRAVERSE as well as one that is not there, and it was the one return
  // path that said nothing at all about the rules - the last silent answer
  // on a surface where every other path either carries the block or states
  // why it could not be read.
  const standing = readStandingBlock(ctx.vault);

  if (!existsSync(dirs.brain)) {
    return {
      vault_path: ctx.vault,
      present: false,
      active_path: activePath,
      content: prependStandingBlock(standing, ""),
      counts: EMPTY_CONTEXT_COUNTS,
      generated_at: null,
      pinned: serializePinnedContext(ctx, pinned),
      ...standingRulesField(ctx, standing),
    };
  }

  let counts: BrainContextCounts = EMPTY_CONTEXT_COUNTS;
  let error: string | undefined;
  try {
    // The SHARED file is regenerated unscoped, always. `active.md` is one
    // file for the whole vault - injected into every agent's SessionStart
    // by `hooks/active-inject.ts` and regenerated unscoped by the
    // `osb://preferences/active` resource - so narrowing the WRITE to this
    // caller would make it thrash and could drop an agent's own memories
    // from its session start (context-integrity-gates, A3).
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
  // Owner-scope isolation (context-integrity-gates, Unit A) applies to
  // what this ONE caller is handed, not to what is on disk. This surface
  // takes no arguments, so `ServerContext.agentName` is its only source of
  // identity, and the gate decides whether it narrows: `enforcedScope` is
  // non-null only under `fail`, so the branch is dead on a default vault
  // and the delivered bytes stay the file's own. The re-render reuses the
  // stamp already on disk so the scoped view names the same generation the
  // shared file does.
  if (!error) {
    const delivery = resolveOwnerScopeDelivery(ctx.vault, ctx.agentName);
    if (delivery.enforcedScope !== null) {
      const scoped = renderActive(ctx.vault, {
        agentScope: delivery.enforcedScope,
        ...(generatedAt !== null ? { generatedAt } : {}),
      });
      content = scoped.document;
      counts = scoped.counts;
    }
  }

  content = prependStandingBlock(standing, content);
  content = appendPinnedToContextContent(content, pinned.content);

  // Optional vault-root instruction file (v0.10.17). Absent file =
  // field omitted so hosts that strip unknown fields stay
  // byte-identical.
  //
  // A THROW IS NOT AN ABSENCE. This used to be `catch { null }`, which
  // put an operator configuration error - an absolute path, a `..`
  // segment, an empty name - and an unreadable file on the same wire as
  // a vault that simply has no instruction file: the field vanished and
  // nothing said why. The reason now rides its own key, so the
  // enrichment stays best-effort without being silent.
  let vaultInstruction: ReturnType<typeof readVaultInstructionFile> = null;
  let vaultInstructionError: string | undefined;
  try {
    vaultInstruction = readVaultInstructionFile(ctx.vault);
  } catch (err) {
    vaultInstructionError = (err as Error)?.message ?? String(err);
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
    ...standingRulesField(ctx, standing),
    ...(vaultInstruction
      ? {
          vault_instruction: {
            path: vaultInstruction.path,
            content: vaultInstruction.content,
            lines: vaultInstruction.lines,
          },
        }
      : {}),
    ...(vaultInstructionError !== undefined
      ? { vault_instruction_error: vaultInstructionError }
      : {}),
  };
}

/**
 * The standing-rules block and the record behind it, or neither.
 *
 * The two travel together because the response reports them in two
 * different places - the block is prepended to `content`, the record
 * becomes the `standing_rules` key - and a read that FAILED produces a
 * block but no record: there is no path/content/truncated triple to
 * report for bytes nobody could read, and the block itself is what says
 * so in words the agent will read.
 */
interface StandingBlock {
  readonly text: string;
  readonly rules: StandingRules | null;
}

const NO_STANDING_BLOCK: StandingBlock = Object.freeze({ text: "", rules: null });

function readStandingBlock(vault: string): StandingBlock {
  const path = brainStandingRulesPath(vault);
  let cfg: BrainConfig | null = null;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    // A `_brain.yaml` this surface cannot read resolves the cap to its
    // default; the config failure itself surfaces through the `error`
    // slot that the regenerate arm above already populates.
  }
  try {
    const rules = readStandingRules(vault, { maxChars: resolveStandingRulesMaxChars(cfg) });
    if (rules === null) return NO_STANDING_BLOCK;
    return Object.freeze({ text: renderStandingRules(rules), rules });
  } catch (err) {
    return Object.freeze({ text: renderStandingRulesFailure(path, err), rules: null });
  }
}

/**
 * The optional `standing_rules` key, or nothing.
 *
 * Both return shapes spread it from here so the two cannot disagree about
 * when the key appears. It is omitted for a vault whose operator wrote no
 * rules AND for a read that failed - the failure has no path/content/
 * truncated triple to report, and the block inside `content` is what says
 * so in words.
 */
function standingRulesField(ctx: ServerContext, standing: StandingBlock): Record<string, unknown> {
  if (standing.rules === null) return {};
  return {
    standing_rules: {
      path: vaultRelativeSafe(ctx.vault, standing.rules.path),
      content: standing.rules.text,
      truncated: standing.rules.truncated,
    },
  };
}

/** Put the standing block at the head of the content, or leave it alone. */
function prependStandingBlock(standing: StandingBlock, content: string): string {
  if (standing.text.length === 0) return content;
  const trimmed = content.trimStart();
  return trimmed.length === 0 ? `${standing.text}\n` : `${standing.text}\n\n${trimmed}`;
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
    done: { type: "boolean" },
    operations_applied: { type: "integer" },
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
    // Declared but deliberately NOT required: a vault whose operator has
    // written no standing rules omits the key entirely, exactly as the
    // vault-instruction field does, so hosts that strip unknown fields
    // stay byte-identical on the common path.
    standing_rules: {
      type: "object",
      required: ["path", "content", "truncated"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        truncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
    // Present only when the instruction-file read failed; see the
    // "a throw is not an absence" note on the handler.
    vault_instruction_error: { type: "string" },
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
      "Read, write, append, or clear the transient current-task scratchpad at `Brain/pinned.md`. Use for facts that should survive context rotation but should not become permanent preferences. Pass `operations` to apply an ordered batch atomically (all-or-nothing).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "append", "clear"],
          description:
            "Single operation to perform. Defaults to read. Ignored when `operations` is given.",
        },
        content: {
          type: "string",
          description: "Pinned context body for write/append operations.",
        },
        operations: {
          type: "array",
          description:
            "Ordered batch applied atomically; any invalid op aborts the whole batch with no write.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["write", "append", "clear", "replace"],
                description: "What this step does to the pinned body.",
              },
              content: { type: "string", description: "Body for write/append ops." },
              find: { type: "string", description: "Exact segment to locate for a replace op." },
              replace: { type: "string", description: "Replacement text for a replace op." },
            },
            required: ["op"],
            additionalProperties: false,
          },
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
