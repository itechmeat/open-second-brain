/**
 * Server-supplied instructions returned in `initialize.instructions`.
 *
 * Two independent facts assemble here and nowhere else: WHO this agent
 * is on this vault, and WHAT this runtime actually left callable. The
 * identity line answers the first and refuses in its own way when the
 * config cannot be read; `instruction-segments.ts` answers the second
 * and renders the body from the live capability report.
 *
 * The Brain observing-memory layer is the canonical writable surface:
 * four writer tools (`brain_feedback`, `brain_apply_evidence`,
 * `brain_note`, `brain_pinned_context`) plus the read-only
 * `brain_context` reader live on the always-loaded writer scope; the
 * remaining `brain_*` surface ships on the deferred full server.
 */

import { PARAGRAPH_BREAK, renderScopeBody } from "./instruction-segments.ts";
import { TOOL_SCOPE, type ToolCapabilityReport, type ToolScope } from "./tool-contract.ts";

export interface BuildInstructionsOpts {
  /**
   * Resolved agent identity (e.g. "hermes-vps-agent"), or the error
   * explaining why it could not be resolved.
   *
   * The error form exists because the identity comes from the plugin
   * config, and a config that is present but unreadable has no identity in
   * it to state. Substituting one would be the worst available answer: the
   * instructions tell the agent to always log under the name they carry,
   * so a guessed name is a standing instruction to write under it. The
   * refusal is rendered in its place instead, naming the file.
   */
  readonly agent: string | Error;
  /** Which surface's body follows the identity line. Defaults to full. */
  readonly scope?: ToolScope;
  /**
   * What this runtime left callable, as the server's own evaluator
   * computed it.
   *
   * Required rather than optional: a default of "assume everything is
   * available" is exactly the wrong answer this parameter exists to
   * remove, and it would be indistinguishable at the call site from a
   * runtime that really does have everything. The server holds the
   * report on the instance from construction, so there is no caller that
   * would have to invent one.
   */
  readonly capabilities: ToolCapabilityReport;
}

/**
 * The opening identity sentence of every scope's instructions.
 *
 * Both branches are an instruction, not a report: the resolved branch says
 * which name to log under, and the unresolved branch says that there is
 * none and that the writers will refuse until the named file is fixed - so
 * an agent reading it does not go looking for a name to supply by hand.
 * The error carries its own remedy (`ConfigReadError` renders the chmod),
 * so nothing is assembled here.
 */
function identityLine(agent: string | Error): string {
  if (typeof agent === "string") {
    return (
      `You are @${agent} on this Open Second Brain vault. ` +
      "Always log under this identity; do not invent or change the name."
    );
  }
  return (
    "Your identity on this Open Second Brain vault is UNRESOLVED: " +
    `${agent.message} Until it is readable, every tool that writes under an ` +
    "identity refuses and names that file; do not substitute a name of your " +
    "own. The read-only diagnostics (vault_health, second_brain_status) " +
    "still answer and report the same condition."
  );
}

/**
 * Build the `initialize.instructions` block for one server process.
 *
 * Every scope opens with the identity line. The writer scope is the
 * always-loaded surface and its four writers are exactly the
 * identity-bearing ones, so the surface where the name matters most was
 * the one that used to omit it; the catalog scope hydrates into the same
 * writers.
 */
export function buildInstructions(opts: BuildInstructionsOpts): string {
  const scope = opts.scope ?? TOOL_SCOPE.full;
  return identityLine(opts.agent) + PARAGRAPH_BREAK + renderScopeBody(scope, opts.capabilities);
}
