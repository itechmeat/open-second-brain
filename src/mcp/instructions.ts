/**
 * Server-supplied instructions returned in `initialize.instructions`.
 *
 * The Brain observing-memory layer is the canonical writable surface:
 * four writer tools (`brain_feedback`, `brain_apply_evidence`,
 * `brain_note`, `brain_pinned_context`) plus the read-only `brain_context` reader live on the
 * always-loaded writer scope; the remaining `brain_*` surface ships on
 * the deferred full server.
 */

import { PAY_MEMORY_SPENDING_JSON_REL } from "../core/pay-memory/paths.ts";
import type { ToolScope } from "./tools.ts";

export interface BuildInstructionsOpts {
  /** Resolved agent identity (e.g. "hermes-vps-agent"). */
  readonly agent: string;
  /** Vault path — reserved for future per-vault customisation. */
  readonly vault?: string;
  /** When "writer", return the trimmed writer-surface text. */
  readonly scope?: ToolScope;
}

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

The remaining Brain surface (digest, query, doctor, backlinks, search,
Pay Memory tools, vault_health, second_brain_status, second_brain_query,
and the scheduled learning pass) lives on the sibling
"open-second-brain" MCP server (deferred). Use ToolSearch to reach it.

Prefer the writer-server copies of brain_feedback / brain_apply_evidence /
brain_note / brain_pinned_context over any duplicate exposed by the full server — both call the same
handler, but the writer copy is always available without ToolSearch.`;

export function buildInstructions(opts: BuildInstructionsOpts | string): string {
  // Legacy call-site compat: plain string → full-surface branch.
  const agent = typeof opts === "string" ? opts : opts.agent;
  const scope = typeof opts === "string" ? undefined : opts.scope;

  if (scope === "writer") return WRITER_INSTRUCTIONS;

  // Deliberately terse (token-diet): per-tool detail lives in the tool
  // descriptions and docs/mcp.md; this text carries only the contract
  // that cannot be read off the schemas.
  return (
    `You are @${agent} on this Open Second Brain vault. ` +
    "Always log under this identity; do not invent or change the name.\n\n" +
    "Memory contract: call brain_feedback once per taste signal the " +
    "user expresses; brain_apply_evidence right after producing a " +
    "durable artifact a preference in `Brain/preferences/` scopes to " +
    "(result: applied | violated | outdated); brain_note for narrative " +
    "milestones that fit neither; brain_pinned_context for current-task " +
    "facts that must survive context rotation. brain_context " +
    "bootstraps a session when the host injects no active.md hook. " +
    "Skip Brain calls for casual chat, exploration, and trivial edits - " +
    "a misrecorded signal is worse than a missed one.\n\n" +
    "Consolidated read views: brain_brief (view: morning | daily | " +
    "weekly | monthly | operator | digest), brain_analytics (view: " +
    "timeline | attention_flows | belief_evolution | concept_synthesis), " +
    "schema_inspect (view: graph | lint | stats | orphans | " +
    "explain_type | active_pack | packs). The per-view predecessor " +
    "names still resolve via tools/call as deprecated aliases.\n\n" +
    "Preview budget: a large result may arrive as a JSON envelope with " +
    "`preview_truncated: true` and an `artifact_id`; fetch the full " +
    "payload with brain_artifact_get only when the preview is not " +
    "enough.\n\n" +
    "Pay Memory tools persist payment memory, never execute payments. " +
    "payment_memory_init bootstraps once per vault; approval sequence: " +
    "payment_policy_check (against " +
    `\`${PAY_MEMORY_SPENDING_JSON_REL}\`) → payment_request_approval → ` +
    "poll payment_request_status → run `pay` → payment_receipt_append → " +
    "asset_capture → payment_request_consume; payment_report_generate " +
    "aggregates a date's receipts."
  );
}
