/**
 * Session Knowledge Synthesis tools (t_325a7e4a, t_635a3ea5, t_6a201155).
 *
 * Registered through the brain-tools.ts aggregator. Every tool here is
 * agent-driven or read-only: the kernel validates and stores already-
 * extracted structure or reads existing edges, and never calls an LLM.
 */

import {
  appendSessionSummary,
  getSessionSummary,
  listSessionSummaries,
  SessionSummaryError,
  type SessionSummaryDigest,
} from "../../core/brain/session-summary.ts";
import {
  saveSessionCheckpoint,
  SessionCheckpointError,
  type CheckpointSignalInput,
  type SessionCheckpointResult,
} from "../../core/brain/session-checkpoint.ts";
import { IdempotencyPayloadMismatchError } from "../../core/brain/idempotency-ledger.ts";
import { resolveAgentName } from "../../core/config.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import type { BrainSignalSign } from "../../core/brain/types.ts";
import {
  traceIdeaLineage,
  IdeaLineageError,
  type IdeaLineageResult,
} from "../../core/brain/idea-lineage.ts";
import { decomposeNoteHistory } from "../../core/brain/note-history.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";

const SUMMARY_TOOL = "brain_session_summary";

function requiredSessionId(args: Record<string, unknown>): string {
  const value = args["session_id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${SUMMARY_TOOL}: session_id is required`);
  }
  return value.trim();
}

function stringArrayArg(
  args: Record<string, unknown>,
  name: string,
): ReadonlyArray<string> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MCPError(INVALID_PARAMS, `${SUMMARY_TOOL}: ${name} must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
}

function serializeDigest(digest: SessionSummaryDigest): Record<string, unknown> {
  return {
    id: digest.id,
    session_id: digest.sessionId,
    request: digest.request,
    decisions: digest.decisions,
    learnings: digest.learnings,
    next_steps: digest.nextSteps,
    created_at: digest.createdAt,
    ...(digest.host !== undefined ? { host: digest.host } : {}),
  };
}

async function toolBrainSessionSummary(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = args["operation"];
  if (operation !== "write" && operation !== "get" && operation !== "list") {
    throw new MCPError(INVALID_PARAMS, `${SUMMARY_TOOL}: operation must be write|get|list`);
  }

  if (operation === "write") {
    const sessionId = requiredSessionId(args);
    const request = args["request"];
    const decisions = stringArrayArg(args, "decisions");
    const learnings = stringArrayArg(args, "learnings");
    const nextSteps = stringArrayArg(args, "next_steps");
    const host = args["host"];
    const sourceTurnIds = stringArrayArg(args, "source_turn_ids");
    try {
      const digest = appendSessionSummary(ctx.vault, {
        sessionId,
        ...(typeof request === "string" ? { request } : {}),
        ...(decisions !== undefined ? { decisions } : {}),
        ...(learnings !== undefined ? { learnings } : {}),
        ...(nextSteps !== undefined ? { nextSteps } : {}),
        ...(typeof host === "string" ? { host } : {}),
        ...(sourceTurnIds !== undefined ? { sourceTurnIds } : {}),
      });
      return { written: true, digest: serializeDigest(digest) };
    } catch (error) {
      if (error instanceof SessionSummaryError) {
        throw new MCPError(INVALID_PARAMS, error.message);
      }
      throw error;
    }
  }

  if (operation === "get") {
    const sessionId = requiredSessionId(args);
    const digest = getSessionSummary(ctx.vault, sessionId);
    return digest === null ? { found: false } : { found: true, digest: serializeDigest(digest) };
  }

  // operation === "list"
  const sessionIdRaw = args["session_id"];
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim().length > 0
      ? sessionIdRaw.trim()
      : undefined;
  const digests = listSessionSummaries(ctx.vault, sessionId !== undefined ? { sessionId } : {});
  return { count: digests.length, digests: digests.map(serializeDigest) };
}

const CHECKPOINT_TOOL = "brain_session_checkpoint";

/** Parse the `signals` array into checkpoint signal inputs. Only STRUCTURAL
 * problems (not-an-array, an item that is not an object, a mistyped
 * scalar) are protocol errors here. SEMANTIC validity — a bad sign, a
 * missing topic / principle — is deliberately passed through so the kernel
 * attempts the write and collects the failure as a `partial` item (status
 * "mixed"), rather than aborting the whole batch. */
function parseCheckpointSignals(
  args: Record<string, unknown>,
): ReadonlyArray<CheckpointSignalInput> {
  const value = args["signals"];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, `${CHECKPOINT_TOOL}: signals must be an array`);
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new MCPError(INVALID_PARAMS, `${CHECKPOINT_TOOL}: signals[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const topic = typeof item["topic"] === "string" ? item["topic"] : "";
    const principle = typeof item["principle"] === "string" ? item["principle"] : "";
    // Sign passed through verbatim; the writer rejects an out-of-enum value
    // and the kernel surfaces it as a `partial` item.
    const sign = item["signal"] as BrainSignalSign;
    const scope = typeof item["scope"] === "string" ? item["scope"] : undefined;
    const rawText = typeof item["raw"] === "string" ? item["raw"] : undefined;
    const source = stringArrayField(item["source"], `signals[${index}].source`);
    return {
      topic,
      signal: sign,
      principle,
      ...(scope !== undefined ? { scope } : {}),
      ...(rawText !== undefined ? { raw: rawText } : {}),
      ...(source !== undefined ? { source } : {}),
    } satisfies CheckpointSignalInput;
  });
}

function stringArrayField(value: unknown, name: string): ReadonlyArray<string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new MCPError(INVALID_PARAMS, `${CHECKPOINT_TOOL}: ${name} must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
}

function serializeCheckpoint(result: SessionCheckpointResult): Record<string, unknown> {
  return {
    status: result.status,
    session_id: result.sessionId,
    deduped: result.deduped,
    signals: result.signals.map((s) => ({ id: s.id, path: s.path, deduped: s.deduped })),
    summary: result.summary === null ? null : { id: result.summary.id },
    diary_written: result.diaryWritten,
    partial: result.partial.map((p) => ({
      kind: p.kind,
      ...(p.index !== undefined ? { index: p.index } : {}),
      ...(p.topic !== undefined ? { topic: p.topic } : {}),
      reason: p.reason,
    })),
  };
}

async function toolBrainSessionCheckpoint(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionIdRaw = args["session_id"];
  if (typeof sessionIdRaw !== "string" || sessionIdRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${CHECKPOINT_TOOL}: session_id is required`);
  }
  const agentArg = typeof args["agent"] === "string" ? args["agent"] : null;
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
  const signals = parseCheckpointSignals(args);
  const request = typeof args["request"] === "string" ? args["request"] : undefined;
  const decisions = stringArrayField(args["decisions"], "decisions");
  const learnings = stringArrayField(args["learnings"], "learnings");
  const nextSteps = stringArrayField(args["next_steps"], "next_steps");
  const sourceTurnIds = stringArrayField(args["source_turn_ids"], "source_turn_ids");
  const host = typeof args["host"] === "string" ? args["host"] : undefined;
  const diary = typeof args["diary"] === "string" ? args["diary"] : undefined;

  try {
    const result = saveSessionCheckpoint(ctx.vault, {
      sessionId: sessionIdRaw.trim(),
      agent,
      signals,
      ...(request !== undefined ? { request } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
      ...(learnings !== undefined ? { learnings } : {}),
      ...(nextSteps !== undefined ? { nextSteps } : {}),
      ...(sourceTurnIds !== undefined ? { sourceTurnIds } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(diary !== undefined ? { diary } : {}),
    });
    return serializeCheckpoint(result);
  } catch (error) {
    if (
      error instanceof SessionCheckpointError ||
      error instanceof IdempotencyPayloadMismatchError
    ) {
      throw new MCPError(INVALID_PARAMS, error.message);
    }
    throw error;
  }
}

const LINEAGE_TOOL = "brain_idea_lineage";

function serializeLineage(result: IdeaLineageResult): Record<string, unknown> {
  return {
    root: result.root,
    nodes: result.nodes,
    edges: result.edges,
    truncated: result.truncated,
  };
}

function toolBrainIdeaLineage(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${LINEAGE_TOOL}: id is required`);
  }
  const maxDepthRaw = args["max_depth"];
  let maxDepth: number | undefined;
  if (maxDepthRaw !== undefined && maxDepthRaw !== null) {
    if (typeof maxDepthRaw !== "number" || !Number.isInteger(maxDepthRaw) || maxDepthRaw < 1) {
      throw new MCPError(INVALID_PARAMS, `${LINEAGE_TOOL}: max_depth must be a positive integer`);
    }
    maxDepth = maxDepthRaw;
  }
  try {
    return serializeLineage(
      traceIdeaLineage(ctx.vault, { id: idRaw.trim() }, maxDepth !== undefined ? { maxDepth } : {}),
    );
  } catch (error) {
    if (error instanceof IdeaLineageError) {
      throw new MCPError(INVALID_PARAMS, error.message);
    }
    throw error;
  }
}

const HISTORY_TOOL = "brain_note_history";

function toolBrainNoteHistory(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const pathRaw = args["path"];
  if (typeof pathRaw !== "string" || pathRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${HISTORY_TOOL}: path is required`);
  }
  const gapHours = positiveIntArg(args, "gap_hours");
  const maxCount = positiveIntArg(args, "max_count");
  const result = decomposeNoteHistory(ctx.vault, pathRaw.trim(), {
    ...(gapHours !== undefined ? { gapHours } : {}),
    ...(maxCount !== undefined ? { maxCount } : {}),
  });
  return {
    note_path: result.notePath,
    available: result.available,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    commit_count: result.commitCount,
    phases: result.phases,
  };
}

function positiveIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MCPError(INVALID_PARAMS, `${HISTORY_TOOL}: ${name} must be a positive integer`);
  }
  return value;
}

export const SYNTHESIS_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: SUMMARY_TOOL,
    description:
      "Session-scoped structured digest over request/decisions/learnings/next_steps. write stores agent-extracted categories; get returns a session's latest digest; list returns all (optionally one session). Append-only, deduped; an all-empty digest is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["write", "get", "list"],
          description: "Tool operation.",
        },
        session_id: {
          type: "string",
          description: "Session id (required for write/get; optional scope for list).",
        },
        request: {
          type: "string",
          description: "write: one-line statement of the session's goal.",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "write: decisions made this session.",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "write: things learned this session.",
        },
        next_steps: {
          type: "array",
          items: { type: "string" },
          description: "write: follow-up actions.",
        },
        source_turn_ids: {
          type: "array",
          items: { type: "string" },
          description: "write: turn ids the digest was distilled from (lineage edges).",
        },
        host: { type: "string", description: "write: originating runtime (claude, codex, ...)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainSessionSummary,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: CHECKPOINT_TOOL,
    description:
      "Batch-save a whole session's signals + a decisions/learnings/next_steps summary + optional diary in one idempotent round-trip, keyed by session_id. A same-content retry dedupes; a different-content retry is payload_mismatch. Items needing review return in `partial` (status 'mixed'), never dropped.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id; the idempotency key." },
        agent: { type: "string", description: "Identity stamped on written signals (optional)." },
        signals: {
          type: "array",
          description: "Extracted memories to persist as signals.",
          items: {
            type: "object",
            properties: {
              topic: { type: "string", description: "Stable kebab-slug topic." },
              signal: {
                type: "string",
                enum: ["positive", "negative"],
                description: "positive = rule to follow; negative = to avoid.",
              },
              principle: { type: "string", description: "One-line rule formulation." },
              scope: { type: "string", description: "Soft category (optional)." },
              raw: { type: "string", description: "Verbatim source quote (optional)." },
              source: {
                type: "array",
                items: { type: "string" },
                description: "Wikilinks to triggering artifacts (optional).",
              },
            },
            required: ["topic", "signal", "principle"],
            additionalProperties: false,
          },
        },
        request: { type: "string", description: "One-line session goal." },
        decisions: { type: "array", items: { type: "string" }, description: "Decisions made." },
        learnings: { type: "array", items: { type: "string" }, description: "Things learned." },
        next_steps: { type: "array", items: { type: "string" }, description: "Follow-up actions." },
        source_turn_ids: {
          type: "array",
          items: { type: "string" },
          description: "Turn ids the summary was distilled from.",
        },
        host: { type: "string", description: "Originating runtime (claude, codex, ...)." },
        diary: { type: "string", description: "Optional narrative diary line for the Brain log." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    handler: toolBrainSessionCheckpoint,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: LINEAGE_TOOL,
    description:
      "Read-only provenance tracer: how a derived artifact was reached, as an observation -> synthesis -> conclusion graph. A ctn_ id walks the sourceRefs graph; a pref-/ret- id adapts belief-evolution. Cycle-guarded, depth-bounded; an unknown id errors.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Continuity record id (ctn_...) or preference id (pref-.../ret-...).",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          description: "Maximum backward hops from the artifact (default 8).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainIdeaLineage,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: HISTORY_TOOL,
    description:
      "Decompose a note's git history into episodic phases, split when the gap between commits exceeds gap_hours (default 72) - deterministic and language-agnostic. Each phase carries subjects, dates, authors. Missing repo: available=false; no commits: zero phases. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative note path (git pathspec)." },
        gap_hours: {
          type: "integer",
          minimum: 1,
          description: "Inter-commit gap that starts a new phase (default 72).",
        },
        max_count: {
          type: "integer",
          minimum: 1,
          description: "Bound the walk to the newest N commits touching the path.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolBrainNoteHistory,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);
