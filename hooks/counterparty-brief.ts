#!/usr/bin/env -S bun
/**
 * UserPromptSubmit hook: the opt-in counterparty brief (dated commitments,
 * t_43b0a379).
 *
 * When `counterparty_brief_enabled` is set (default OFF) AND the operator
 * declared a `counterparty_brief_triggers` vocabulary (machine-local main
 * config), the first prompt of a session that names exactly one canonical
 * counterparty and carries a trigger token injects a small dated brief of
 * shareable facts about that person as `additionalContext`. The decision
 * core is src/core/brain/counterparty-brief.ts; this entry script only
 * wires the payload, the flag, the ledger and the envelope:
 *
 *   - OPT-IN and INERT-BY-DEFAULT: the flag is checked first (byte-identical
 *     no-op when off), and an empty trigger vocabulary stays inert - the
 *     requirement is documented in hooks/README.md, and nothing ships a
 *     natural-language word list.
 *   - ONCE PER SESSION: the injection ledger records the delivered entity
 *     id after the stdout write; a later prompt of the same session emits
 *     nothing. A payload without a real session id neither emits nor
 *     records: suppression is impossible without a session, and an
 *     unrecordable brief would repeat on every prompt.
 *   - SHAREABLE-ONLY: the core excludes pages whose visibility carries the
 *     reserved token regardless of reach, because a hook-injected block
 *     leaves the machine; withheld pages contribute nothing and are not
 *     counted.
 *   - FAIL-OPEN FOR THE SESSION: every path exits 0; the shared process
 *     ceiling arms against a hung vault, and any internal error is
 *     silence, never a blocked prompt.
 *   - AUDITED: one structured audit line per decision (counts and reasons
 *     only - never the prompt text or the brief content) lands in the
 *     LOCAL hook-audit trail; the line counts the pages the brief could
 *     not read, so a degraded walk is visible instead of silent.
 *
 * Contract mirrors recall-inject.ts: stdin is the hook payload JSON; the
 * vault is resolved from the environment/config, not the payload; stdout,
 * when present, is the standard `hookSpecificOutput.additionalContext`
 * envelope.
 */

import {
  defaultConfigPath,
  resolveCounterpartyBriefEnabled,
  resolveCounterpartyBriefTriggers,
  resolveVault,
} from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import {
  buildCounterpartyBrief,
  renderCounterpartyBrief,
} from "../src/core/brain/counterparty-brief.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import {
  isRealSessionId,
  readBriefDelivered,
  recordBriefDelivered,
} from "./lib/injection-ledger.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

/** Runtime identity on the audit record. */
const HOOK_ACTOR = "counterparty-brief";

/**
 * One best-effort audit line per decision. Never throws and never records
 * the prompt text or the brief content - only the decision, its reason,
 * the matched entity id and bounded counts.
 */
function audit(vault: string, ok: boolean, details: Record<string, unknown>): void {
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: HOOK_ACTOR,
      action: "counterparty_brief_decision",
      target: "UserPromptSubmit",
      ok,
      details,
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF is an immediate no-op, no process
  // ceiling armed, no payload read, no output - byte-identical to before.
  if (!resolveCounterpartyBriefEnabled()) return;

  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => {
      if (auditVault !== null) {
        audit(auditVault, false, { decision: "error", reason: "hook_ceiling_exceeded" });
      }
    },
  });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    const hookEventName =
      typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
        ? payload.hook_event_name
        : "UserPromptSubmit";
    // Default-closed: only an additionalContext-eligible event may emit.
    if (!isContextEventName(hookEventName)) return;

    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

    const vault = resolveVault();
    if (vault === null) return;
    auditVault = vault;

    const triggers = resolveCounterpartyBriefTriggers(defaultConfigPath());
    // Inert without an operator-declared vocabulary - the safe direction,
    // disclosed in hooks/README.md rather than doctor-surfaced.
    if (triggers.length === 0) {
      audit(vault, false, { decision: "abstain", reason: "no_triggers" });
      return;
    }

    const sessionId = isRealSessionId(payload.session_id) ? payload.session_id : null;
    // A sessionless host gets neither a brief nor a ledger write: the
    // once-per-session promise cannot be kept without a session, and an
    // unrecordable brief would repeat on every prompt.
    if (sessionId === null) {
      audit(vault, false, { decision: "abstain", reason: "no_session" });
      return;
    }

    let delivered: string | null = null;
    try {
      delivered = readBriefDelivered(vault, sessionId);
    } catch {
      delivered = null;
    }
    if (delivered !== null) {
      audit(vault, false, { decision: "abstain", reason: "already_delivered", entity: delivered });
      return;
    }

    const brief = buildCounterpartyBrief(vault, { text: prompt, triggers, now: new Date() });
    // A typed abstention names its cause, so the audit line says WHY the
    // brief did not fire instead of one blanket reason.
    if ("abstain" in brief) {
      audit(vault, false, { decision: "abstain", reason: brief.abstain });
      return;
    }
    const rendered = renderCounterpartyBrief(brief);
    if (rendered === "") {
      audit(vault, false, {
        decision: "abstain",
        reason: "empty_brief",
        entity: brief.entityId,
        skipped_reads: brief.skippedReads,
      });
      return;
    }

    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: rendered } }) + "\n",
    );
    // Recorded after the write: a failed record costs one repeat, never a
    // lost brief, and leaves evidence on the audit line either way.
    let recorded = false;
    try {
      recorded = recordBriefDelivered(vault, sessionId, brief.entityId);
    } catch {
      recorded = false;
    }
    audit(vault, true, {
      decision: "emit",
      entity: brief.entityId,
      items: brief.items.length,
      skipped_reads: brief.skippedReads,
      recorded,
    });
  } catch {
    // Never crash the runtime; the prompt submission must proceed regardless
    // of any hook misbehaviour. The failure still lands on the audit trail
    // once the vault is known - one line per decision, the error path
    // included, the same record the process ceiling writes on expiry.
    if (auditVault !== null) {
      audit(auditVault, false, { decision: "error", reason: "internal_error" });
    }
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Last-resort silence: everything inside the ceiling is already caught
  // and audited above; a throw before the vault resolves has nothing to
  // audit and must never block the prompt.
});
