/**
 * What a caller is told when the vault is frozen, and where the refusal
 * is recorded (who-wrote-what, Task C, Override 2).
 *
 * The freeze itself lives in `assertVaultIdentityForWrite`, below the
 * Brain log module in the import graph. That guard therefore cannot
 * append the event that says a write was refused - the edge back would
 * close a cycle paid for by every consumer in the tree. So the record is
 * made at the one seam that already knows both the refusal and who
 * caused it: the MCP tool-dispatch boundary, which sees the thrown
 * `VaultFrozenError`, the tool name, and the resolved agent identity.
 *
 * That is the right place for a second reason as well. The event is the
 * AGENT-facing audit trail, and the agent side is the side a fleet
 * freeze exists to hold: an operator lifting a freeze wants to know what
 * kept trying to write while it was on.
 *
 * ## The refusal is structured, not prose
 *
 * A caller that can only regex a sentence cannot act on it. The `data`
 * payload carries the four facts an agent needs - when the freeze was
 * set, by whom, why, and the one command that lifts it - in the same
 * shape `./reach-refusal.ts` uses for the boundary it guards.
 *
 * ## Recording never fails the refusal
 *
 * The write was already refused; the event is the record of it. A log
 * append that throws must not turn a clean refusal into an internal
 * error, so the append is best-effort and its failure is reported to the
 * caller as an `audit_reason` on the same payload rather than swallowed.
 * The refusal itself is the load-bearing answer.
 */

import { appendLogEvent } from "../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../core/brain/types.ts";
import { isoSecond } from "../core/brain/time.ts";
import { VaultFrozenError } from "../core/brain/freeze-marker.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";

/** The refusal token, named in the message and carried in `data`. */
export const VAULT_FROZEN_REFUSAL = "vault_frozen";

/** The structured payload attached to the refusal, for machine callers. */
export interface VaultFrozenData {
  readonly code: typeof VAULT_FROZEN_REFUSAL;
  readonly tool: string;
  readonly frozen_at: string;
  readonly by: string;
  readonly reason: string;
  readonly next_command: string;
  /** Why the refusal reached no `write-refused` event, when it did not. */
  readonly audit_reason?: string;
}

/**
 * Record one `write-refused` event, and report why when it could not be
 * recorded.
 *
 * Returns `null` on success and the reason on failure; see the module
 * docblock for why a failure here is reported rather than raised.
 */
function recordRefusal(
  vault: string,
  tool: string,
  agent: string,
  err: VaultFrozenError,
): string | null {
  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.writeRefused,
      body: {
        tool,
        agent,
        reason: err.reason,
        frozen_at: err.frozen_at,
      },
    });
    return null;
  } catch (exc) {
    return exc instanceof Error ? exc.message : String(exc);
  }
}

/**
 * Re-raise a frozen-vault refusal ahead of any generic error mapping.
 *
 * The tool handlers wrap an unrecognised throw in an `INTERNAL_ERROR`
 * MCPError, which is right for an I/O fault and wrong for this: a freeze
 * is a state an operator asked for, and a caller told "internal error"
 * learns neither that nor the command that lifts it. A converter calls
 * this first so the typed refusal reaches the dispatch seam, which is
 * where it becomes the structured refusal and the `write-refused` event.
 *
 * A no-op for every other error, so a call site pays one `instanceof`.
 */
export function rethrowVaultFrozen(err: unknown): void {
  if (err instanceof VaultFrozenError) throw err;
}

/**
 * Turn a {@link VaultFrozenError} into the refusal a caller receives,
 * recording it on the way through.
 *
 * The caller's identity is passed as a THUNK because resolving it can
 * itself throw on an unreadable config, and a broken config must not
 * replace the freeze refusal with a different error - the freeze is what
 * actually stopped the write. An unresolvable identity is recorded under
 * {@link UNRESOLVED_AGENT}, which is a named absence rather than a guess.
 */
export function vaultFrozenRefusal(
  vault: string,
  tool: string,
  err: VaultFrozenError,
  resolveAgent: () => string,
): MCPError {
  let agent: string;
  try {
    agent = resolveAgent();
  } catch {
    agent = UNRESOLVED_AGENT;
  }
  const auditReason = recordRefusal(vault, tool, agent, err);
  const message =
    `${tool}: refused (${VAULT_FROZEN_REFUSAL}). ${err.notice.detail}. ` +
    "Every content write in this vault is refused until the freeze is lifted; " +
    "this refusal was recorded in the Brain log.";
  const data: VaultFrozenData = Object.freeze({
    code: VAULT_FROZEN_REFUSAL,
    tool,
    frozen_at: err.frozen_at,
    by: err.by,
    reason: err.reason,
    next_command: err.next_command,
    ...(auditReason !== null ? { audit_reason: auditReason } : {}),
  });
  return new MCPError(INVALID_PARAMS, message, data);
}

/**
 * Recorded as the caller when the server's own identity resolution
 * fails. A token, not a plausible name: an agent field that reads like a
 * real identity but was invented is worse than one that says it is
 * missing.
 */
export const UNRESOLVED_AGENT = "unresolved";
