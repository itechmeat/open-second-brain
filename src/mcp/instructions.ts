/**
 * Server-supplied instructions returned in `initialize.instructions`.
 *
 * The Brain observing-memory layer is the canonical writable surface:
 * four writer tools (`brain_feedback`, `brain_apply_evidence`,
 * `brain_note`, `brain_pinned_context`) plus the read-only `brain_context` reader live on the
 * always-loaded writer scope; the remaining `brain_*` surface ships on
 * the deferred full server.
 */

import { TOOL_SCOPE, type ToolScope } from "./tool-contract.ts";

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
}

/** Separator between the identity sentence and every paragraph after it. */
const PARAGRAPH_BREAK = "\n\n";

const WRITER_INSTRUCTIONS = `Open Second Brain — always-loaded MCP surface.

Five tools live here (four writers + one reader; the server's name is
preserved for backward compatibility with existing client configs):
  - brain_feedback        — record one new taste signal the user just expressed.
  - brain_apply_evidence  — record applied | violated | outdated against an
                            active preference for an artifact this turn produced.
  - brain_note            — record one narrative milestone (release shipped,
                            PR merged, fact discovered) that fits neither
                            category.
  - brain_pinned_context  — read/write/append/clear Brain/pinned.md for
                            current-task facts that should survive context
                            rotation without becoming permanent preferences.
  - brain_context         — pull the current Brain/active.md body plus
                            pinned context and active-preference counts.
                            Read-only. Use at session
                            start when the host runtime lacks a SessionStart
                            hook (Cursor, Aider, raw Claude API). Runtimes that
                            already inject active.md via a hook can skip this.

The remaining Brain surface lives on the sibling "open-second-brain"
MCP server (deferred), including additional read-only, analytics,
maintenance, and workflow tools beyond the always-loaded writer set.
Use ToolSearch to discover and reach it.

Prefer the writer-server copies of brain_feedback / brain_apply_evidence /
brain_note / brain_pinned_context over any duplicate exposed by the full server — both call the same
handler, but the writer copy is always available without ToolSearch.`;

const CATALOG_INSTRUCTIONS = `Open Second Brain — two-pass catalog MCP surface.

This server advertises a compact first-pass tool set: the capability
diagnostic, the five always-loaded Brain writers/readers, and
tool_hydrate. Every other Open Second Brain tool stays CALLABLE via
tools/call — it is only omitted from tools/list to keep schema tokens
out of your prompt until needed.

Second pass: call tool_hydrate with no arguments to get the compact
catalog (name, one-line description, group) of every tool in this
process, then call tool_hydrate with names: [...] to fetch the full
input/output schemas for the tools you actually need. After hydration,
invoke those tools directly by name through tools/call — no further
registration step exists or is needed.

Do not invent substitute workflows for a capability you cannot see:
hydrate the catalog first; the tool is almost certainly already here.`;

/**
 * The body every scope other than writer and catalog carries.
 *
 * Deliberately terse (token-diet): per-tool detail lives in the tool
 * descriptions and docs/mcp.md; this text carries only the contract that
 * cannot be read off the schemas.
 */
const FULL_INSTRUCTIONS =
  "Memory contract: call brain_feedback once per taste signal the " +
  "user expresses; brain_apply_evidence right after producing a " +
  "durable artifact a preference in `Brain/preferences/` scopes to " +
  "(result: applied | violated | outdated); brain_note for narrative " +
  "milestones that fit neither; brain_pinned_context for current-task " +
  "facts that must survive context rotation. brain_context " +
  "bootstraps a session when the host injects no active.md hook. " +
  "Skip Brain calls for casual chat, exploration, and trivial edits - " +
  "a misrecorded signal is worse than a missed one." +
  PARAGRAPH_BREAK +
  "Consolidated read views: brain_brief (view: morning | daily | " +
  "weekly | monthly | operator | digest), brain_analytics (view: " +
  "timeline | attention_flows | belief_evolution | concept_synthesis), " +
  "schema_inspect (view: graph | lint | stats | orphans | " +
  "explain_type | active_pack | packs). The per-view predecessor " +
  "names still resolve via tools/call as deprecated aliases." +
  PARAGRAPH_BREAK +
  "Preview budget: a large result may arrive as a JSON envelope with " +
  "`preview_truncated: true` and an `artifact_id`; fetch the full " +
  "payload with brain_artifact_get only when the preview is not " +
  "enough.";

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
 * The body each scope carries after the identity line.
 *
 * A total map rather than a chain of `if`s: a scope added to
 * {@link TOOL_SCOPE} without a body here fails to compile, which is the
 * only reason the omission that this function used to carry - two of three
 * scopes returning before `agent` was read - could not recur.
 */
const SCOPE_BODIES: Readonly<Record<ToolScope, string>> = Object.freeze({
  [TOOL_SCOPE.full]: FULL_INSTRUCTIONS,
  [TOOL_SCOPE.writer]: WRITER_INSTRUCTIONS,
  [TOOL_SCOPE.catalog]: CATALOG_INSTRUCTIONS,
});

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
  const body = SCOPE_BODIES[opts.scope ?? TOOL_SCOPE.full];
  return identityLine(opts.agent) + PARAGRAPH_BREAK + body;
}
