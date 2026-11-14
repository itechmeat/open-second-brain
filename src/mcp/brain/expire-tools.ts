/**
 * `brain_expire` (task 3.19): the post-creation expiration mutation,
 * addressed by id rather than by the vault-relative path a lifecycle
 * action takes. Split from `feedback-tools.ts`; registration happens
 * through that module's registry, which preserves the public
 * FEEDBACK_TOOLS surface.
 */

import {
  ExpirationTargetNotFoundError,
  ExpirationValueError,
  InvalidExpirationTargetError,
  setExpiration,
} from "../../core/brain/expiration-set.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import { type ServerContext } from "../tool-contract.ts";
import { refuseAgentClaim } from "./agent-claim.ts";
import { codeForError } from "../tool-error-codes.ts";
import { coerceStr } from "../coerce.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";

// ----- brain_write_session (Agent Write Contract Suite, v0.41.0) ------------

/**
 * Post-creation expiration mutation (unit 3c).
 *
 * A tool of its own rather than an action on `brain_lifecycle`, and the
 * reason is how each addresses its subject: every `brain_lifecycle`
 * action takes a vault-relative PATH and runs it through a note-path
 * envelope, while a signal or preference is addressed by id and lives
 * under the `Brain/` root that envelope exists to refuse. Folding them
 * together would mean carving an exception into that refusal.
 */
export const EXPIRE_TOOL = "brain_expire";

export async function toolBrainExpire(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  const expires = coerceStr(args, "expires", true)!;
  const agent = coerceStr(args, "agent", false);
  // The expiration's audit stamp names who set it; a token caller cannot
  // sign another agent's name to it.
  refuseAgentClaim(ctx.requestIdentity, agent, "brain_expire");
  // A token caller that omits `agent` still stamps its own name: the
  // audit log would otherwise record the writer's DEFAULT_AGENT instead
  // of the credential's agent.
  const effectiveAgent = agent ?? ctx.requestIdentity?.agent;
  // A record the caller may not read is refused as an unknown id, before
  // anything is written.
  const readable = readableAtContextReachOrUndefined(ctx);
  try {
    const res = setExpiration(ctx.vault, id, expires, {
      ...(effectiveAgent ? { agent: effectiveAgent } : {}),
      ...(readable !== undefined ? { readable } : {}),
    });
    return {
      id: res.id,
      kind: res.kind,
      path: res.path,
      expiration: res.expiration,
      previous: res.previous,
      changed: res.changed,
    };
  } catch (err) {
    // Each of the three is the caller's fault and each has a different
    // next move: fix the date, fix the id, or use a surface that takes a
    // path. They keep their own class name as the reported code, read
    // from the boundary registry's classification rather than `err.name`.
    if (
      err instanceof ExpirationValueError ||
      err instanceof ExpirationTargetNotFoundError ||
      err instanceof InvalidExpirationTargetError
    ) {
      throw new MCPError(INVALID_PARAMS, `${EXPIRE_TOOL}: ${err.message}`, {
        code: codeForError(err),
      });
    }
    if (err instanceof MCPError) throw err;
    throw new MCPError(
      INTERNAL_ERROR,
      `${EXPIRE_TOOL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
