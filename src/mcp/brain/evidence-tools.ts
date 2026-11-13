/**
 * The evidence and observation tools (task 3.19): `brain_apply_evidence`,
 * `brain_observed_use` and `brain_note`, the three record writers of the
 * feedback family that are not the capture lane or the dream. Split
 * from `feedback-tools.ts`; registration happens through that module's
 * registry, which preserves the public FEEDBACK_TOOLS surface.
 */

import { resolve } from "node:path";
import { resolveAgentName } from "../../core/config.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
  type AppendApplyEvidenceInput,
} from "../../core/brain/apply-evidence.ts";
import { BRAIN_ROLES } from "../../core/brain/trust/role.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { BRAIN_APPLY_RESULT, type BrainApplyResult } from "../../core/brain/types.ts";
import { appendBrainNote } from "../../core/brain/note.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextVault, type ServerContext } from "../tool-contract.ts";
import { refuseAgentClaim } from "./agent-claim.ts";
import {
  emitObservedUse,
  isObservedUseVerdict,
  type ObservedUseEntry,
} from "../../core/brain/observed-use.ts";
import { coerceStr } from "../coerce.ts";
import { toolPath } from "./device-path.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";

// ----- brain_review_candidates --------------------------------------------

export async function toolBrainApplyEvidence(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // `null` on a server with no vault: the writes are store records (D14).
  const vault = contextVault(ctx);
  const prefId = coerceStr(args, "pref_id", true)!;
  const artifact = coerceStr(args, "artifact", true)!;
  const resultRaw = coerceStr(args, "result", true)!;
  if (
    resultRaw !== BRAIN_APPLY_RESULT.applied &&
    resultRaw !== BRAIN_APPLY_RESULT.violated &&
    resultRaw !== BRAIN_APPLY_RESULT.outdated
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'result' must be 'applied', 'violated', or 'outdated'`,
    );
  }
  const agentArg = coerceStr(args, "agent", false);
  const note = coerceStr(args, "note", false);
  const outcomeRaw = coerceStr(args, "outcome", false);
  if (
    outcomeRaw !== null &&
    outcomeRaw !== "success" &&
    outcomeRaw !== "failure" &&
    outcomeRaw !== "unknown"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'outcome' must be 'success', 'failure', or 'unknown'`,
    );
  }

  // The evidence row names who applied the rule; a token caller cannot
  // file that attribution under another agent's name.
  refuseAgentClaim(ctx.requestIdentity, agentArg, "brain_apply_evidence");
  const agent =
    normalizeAgentArgument(agentArg) ??
    ctx.requestIdentity?.agent ??
    resolveAgentName(ctx.configPath ?? undefined);

  const input: AppendApplyEvidenceInput = {
    pref_id: prefId,
    artifact,
    result: resultRaw as BrainApplyResult,
    agent,
    ...(outcomeRaw !== null ? { outcome: outcomeRaw } : {}),
    ...(note ? { note } : {}),
  };

  // Surface BrainPreferenceNotFoundError as a tool-level error envelope
  // (isError: true) rather than an MCP protocol error. The design doc
  // says "not an error condition" — the agent should see an informative
  // payload that explains what to do next, not a JSON-RPC error frame.
  // v0.10.16: assert applier role at the MCP boundary so the structural
  // permission gate fires before any I/O.
  // A preference the caller may not read is refused as a missing one,
  // before anything is written.
  const readable = readableAtContextReachOrUndefined(ctx);
  try {
    const res = appendApplyEvidence(vault, input, {
      role: BRAIN_ROLES.applier,
      ...(readable !== undefined ? { readable } : {}),
    });
    return {
      logged_at: res.logged_at,
      // With no vault the log is a store shard, named as the store names it.
      log_path: vault === null ? res.log_path : toolPath(ctx, res.log_path),
      absolute_log_path: vault === null ? res.log_path : resolve(res.log_path),
      agent,
    };
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      // Re-throw as a non-MCPError so `server.handleToolsCall` packs it
      // into a `toolError` envelope (isError: true, single-text content).
      throw new Error(exc.message, { cause: exc });
    }
    throw exc;
  }
}

// ----- brain_observed_use (t_65588d8b) -------------------------------------

/**
 * Record session-end observed-use verdicts (USED / IGNORED / CONTRADICTED)
 * per injected memory, mirroring `brain_apply_evidence`: the host supplies
 * already-structured verdicts (no LLM in the kernel), which are folded into
 * the observed-reuse ranking signal. The kernel only stores and aggregates.
 */
export async function toolBrainObservedUse(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawEntries = args["entries"];
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new MCPError(INVALID_PARAMS, "argument 'entries' must be a non-empty array");
  }
  const entries: ObservedUseEntry[] = rawEntries.map((raw, i) => {
    if (raw === null || typeof raw !== "object") {
      throw new MCPError(INVALID_PARAMS, `entries[${i}] must be an object`);
    }
    const e = raw as Record<string, unknown>;
    const id = typeof e["id"] === "string" ? e["id"].trim() : "";
    if (id === "") throw new MCPError(INVALID_PARAMS, `entries[${i}].id is required`);
    const verdict = e["verdict"];
    if (!isObservedUseVerdict(verdict)) {
      throw new MCPError(
        INVALID_PARAMS,
        `entries[${i}].verdict must be 'USED', 'IGNORED', or 'CONTRADICTED'`,
      );
    }
    const path = typeof e["path"] === "string" && e["path"] !== "" ? e["path"] : undefined;
    return { id, verdict, ...(path ? { path } : {}) };
  });

  const host = coerceStr(args, "host", false) ?? "mcp";
  const sessionId = coerceStr(args, "session_id", false) ?? undefined;
  const turnId = coerceStr(args, "turn_id", false) ?? undefined;
  const record = emitObservedUse(ctx.vault, {
    host,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    entries,
  });
  return {
    recorded: entries.length,
    record_id: record.id,
    created_at: record.createdAt,
  };
}

// ----- brain_note (§32B, v0.10.8) ------------------------------------------

/**
 * Append one narrative-milestone line to today's Brain log. Agents
 * record release / merged-PR / discovered-fact lines under the `note`
 * event kind in `Brain/log/<today>.md` (and the JSONL sidecar).
 *
 * The body lives in `appendBrainNote` so the CLI verb (`o2b brain
 * note`) and this MCP handler share one code path. Validation errors
 * land in MCP's `INVALID_PARAMS` envelope here; the CLI wrapper
 * pre-validates usage shape and surfaces the same condition as exit 2.
 */
export async function toolBrainNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // `null` on a server with no vault: the writes are store records (D14).
  const vault = contextVault(ctx);
  const rawText = coerceStr(args, "text", true)!;
  const agentArg = coerceStr(args, "agent", false);
  // A token caller's log line is attributed to the token's agent; a
  // claim on somebody else's name is refused before anything is written.
  refuseAgentClaim(ctx.requestIdentity, agentArg, "brain_note");

  let res;
  try {
    res = appendBrainNote({
      vault: vault,
      text: rawText,
      ...(agentArg ? { agent: agentArg } : {}),
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    });
  } catch (err) {
    // `appendBrainNote` throws one validation error ("text is required");
    // any other failure is an I/O / filesystem fault from `appendLogEvent`
    // and must not be reported as a client-side INVALID_PARAMS.
    const message = (err as Error).message ?? String(err);
    const code = message.startsWith("brain_note:") ? INVALID_PARAMS : INTERNAL_ERROR;
    throw new MCPError(code, message);
  }
  return {
    logged_at: res.logged_at,
    log_path: res.log_path,
    absolute_log_path: res.absolute_log_path,
    agent: res.agent,
  };
}
