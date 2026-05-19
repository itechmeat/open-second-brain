/**
 * Server-supplied instructions returned in `initialize.instructions`.
 *
 * In v0.9.0 the wording shifts from a single event-log-centric flow to
 * the Brain observing-memory layer. Six new `brain_*` tools are the
 * canonical writable surface; `event_log_append` and
 * `second_brain_capture` are no longer advertised to agents (their
 * handlers remain on disk for shell-side use).
 */

import type { ToolScope } from "./tools.ts";

export interface BuildInstructionsOpts {
  /** Resolved agent identity (e.g. "hermes-vps-agent"). */
  readonly agent: string;
  /** Vault path — reserved for future per-vault customisation. */
  readonly vault?: string;
  /** When "writer", return the trimmed writer-surface text. */
  readonly scope?: ToolScope;
}

const WRITER_INSTRUCTIONS = `Open Second Brain — writer surface (always-loaded).

Three tools live here:
  - brain_feedback        — record one new taste signal the user just expressed.
  - brain_apply_evidence  — record applied | violated | outdated against an
                            active preference for an artifact this turn produced.
  - brain_note            — record one narrative milestone (release shipped,
                            PR merged, fact discovered) that fits neither
                            category.

The remaining Brain surface (digest, query, doctor, backlinks, search,
Pay Memory tools, vault_health, second_brain_status, second_brain_query,
and the scheduled learning pass) lives on the sibling
"open-second-brain" MCP server (deferred). Use ToolSearch to reach it.

Prefer the writer-server copies of brain_feedback / brain_apply_evidence /
brain_note over any duplicate exposed by the full server — both call the same
handler, but the writer copy is always available without ToolSearch.`;

export function buildInstructions(opts: BuildInstructionsOpts | string): string {
  // Legacy call-site compat: plain string → full-surface branch.
  const agent = typeof opts === "string" ? opts : opts.agent;
  const scope = typeof opts === "string" ? undefined : opts.scope;

  if (scope === "writer") return WRITER_INSTRUCTIONS;

  return (
    `You are @${agent} on this Open Second Brain vault. ` +
    "Always log under this identity; do not invent or change the name.\n\n" +
    "Brain tools are the agent-facing writable surface (design doc §9).\n" +
    "  - brain_feedback — call once per taste signal the user (or a " +
    "teammate agent) expresses: corrections (\"don't do X\"), stated " +
    "preferences (\"use A instead of B\"), or process rules that " +
    "should outlast the current turn. With `force_confirmed: true` " +
    "the preference is created directly (skipping the dream trial " +
    "window).\n" +
    "  - brain_apply_evidence — call right after you produce a " +
    "durable artifact (code shipped, config / instruction edited, " +
    "content drafted) and at least one preference in " +
    "`Brain/preferences/` scopes to that artifact. Record " +
    "`result: applied | violated` per (preference, artifact) pair.\n" +
    "  - brain_dream — runs the deterministic learning pass " +
    "(clusters signals, promotes preferences, retires stale rules). " +
    "Usually scheduled via cron, not invoked interactively.\n" +
    "  - brain_digest — read-only summary of the last activity " +
    "window. Default format is Markdown; pass `format: \"json\"` for " +
    "programmatic use.\n" +
    "  - brain_query — read-only lookup by `preference`, `topic`, " +
    "or `since` (exactly one). Use this to discover applicable rules " +
    "before calling `brain_apply_evidence`.\n" +
    "  - brain_doctor — invariant / schema health check. With " +
    "`strict: true`, warnings demote the `ok` flag.\n\n" +
    "Skip Brain calls for casual chat, exploration without a stated " +
    "rule, read-only inspection, and trivial edits. A misrecorded " +
    "signal is worse than a missed one — the dream pass surfaces " +
    "real patterns from repeat events, so prefer precision over " +
    "coverage.\n\n" +
    "Other tools: second_brain_status (config status), " +
    "vault_health (verify vault), second_brain_query (look up legacy " +
    "AI Wiki / Daily notes — read-only).\n\n" +
    "Pay Memory tools record paid agent actions as inspectable Markdown:\n" +
    "  - payment_memory_init bootstraps the layout and writes the " +
    "spending policy template (run once per vault).\n" +
    "  - payment_policy_check evaluates a prospective paid call against " +
    "`AI Wiki/policies/spending.json` (allowed / approval_required / denied).\n" +
    "  - payment_request_approval creates a pending-payment-request the " +
    "user must approve before you run `pay`; payment_request_status polls " +
    "for approval; payment_request_consume links the eventual receipt.\n" +
    "  - payment_receipt_append saves a Markdown receipt for one paid " +
    "API call (`raw_output` is redacted before persisting).\n" +
    "  - asset_capture saves a generated asset note linked back to its " +
    "source receipt.\n" +
    "  - payment_report_generate aggregates a date's receipts into a " +
    "Markdown report.\n" +
    "These tools never execute payments — they only persist memory. " +
    "When an approval workflow is in use, the recommended sequence " +
    "is: payment_policy_check → payment_request_approval → poll " +
    "payment_request_status → run `pay` → payment_receipt_append → " +
    "asset_capture → payment_request_consume."
  );
}
