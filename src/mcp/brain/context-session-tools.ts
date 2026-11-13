/**
 * `brain_write_session` (task 3.19): the interactive write-session
 * lifecycle a caller drives operation by operation, answered in the
 * same JSON envelopes the CLI prints. Split from `context-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public CONTEXT_TOOLS surface.
 */

import { resolveAgentName } from "../../core/config.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import {
  WriteSessionRequestError,
  type WriteSessionRequestReason,
  abandonSession,
  approveSession,
  openArtifactSession,
  sessionEnvelope,
} from "../../core/brain/write-session/engine.ts";
import { dispatchSubmit, openPanelSession } from "../../core/brain/write-session/panel.ts";
import { listWriteSessions, readWriteSession } from "../../core/brain/write-session/store.ts";
import type { WriteSessionEnvelope } from "../../core/brain/write-session/types.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { cursorOffsetArg } from "./pagination.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { TOOL_ERROR_CODE, type ToolErrorCode } from "../tool-error-codes.ts";
import { type ServerContext } from "../tool-contract.ts";
import { coerceStr, coerceInt, unknownOperationError } from "../coerce.ts";

export async function toolBrainWriteSession(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = coerceStr(args, "op", true)!;
  const sessionId = coerceStr(args, "session_id", false);
  const requireSessionId = (): string => {
    if (!sessionId) {
      throw new MCPError(INVALID_PARAMS, `brain_write_session: op '${op}' requires session_id`, {
        code: TOOL_ERROR_CODE.sessionIdRequired,
      });
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
          throw new MCPError(INVALID_PARAMS, `unknown write-session: ${id}`, {
            code: WRITE_SESSION_REASON_CODE["unknown-session"],
          });
        }
        return asRecord(sessionEnvelope(probe.session));
      }
      case "list": {
        const limit = coerceInt(args, "limit", 100, 1, 500);
        const offset = cursorOffsetArg("brain_write_session", args);
        const sessions = listWriteSessions(ctx.vault, new Date().toISOString());
        const page = pageSlice(sessions, offset, limit);
        return {
          // `total` counts every session in the list across pages; the
          // page itself is `sessions`.
          total: page.total,
          sessions: page.items.map((rec) => asRecord(sessionEnvelope(rec))),
          next_cursor: page.next_cursor,
        };
      }
      default:
        throw unknownOperationError(
          `brain_write_session: op must be open|submit|approve|abandon|status|list, got '${op}'`,
        );
    }
  } catch (err) {
    if (err instanceof WriteSessionRequestError) {
      // Preserve the {code, path, message} boundary contract: the
      // structured list rides MCPError's data slot, the message stays
      // human-readable prose.
      throw new MCPError(INVALID_PARAMS, err.message, writeSessionErrorData(err));
    }
    throw err;
  }
}

/**
 * The wire code for each session refusal the engine names. Total over the
 * core union, so a new reason fails the type check until it is mapped.
 */
export const WRITE_SESSION_REASON_CODE: Readonly<Record<WriteSessionRequestReason, ToolErrorCode>> =
  Object.freeze({
    "unknown-session": TOOL_ERROR_CODE.writeSessionUnknown,
    "terminal-session": TOOL_ERROR_CODE.writeSessionTerminal,
  });

/**
 * `data` for a request failure: the structured error list when there is
 * one, the precise code when the engine named a reason, nothing otherwise
 * - an absent code is filled by the boundary's `invalid_params` default.
 */
export function writeSessionErrorData(
  err: WriteSessionRequestError,
): Readonly<Record<string, unknown>> | undefined {
  const data = {
    ...(err.errors.length > 0 ? { errors: err.errors } : {}),
    ...(err.reason !== undefined ? { code: WRITE_SESSION_REASON_CODE[err.reason] } : {}),
  };
  return Object.keys(data).length > 0 ? data : undefined;
}

export function asRecord(envelope: WriteSessionEnvelope): Record<string, unknown> {
  return { ...envelope };
}
