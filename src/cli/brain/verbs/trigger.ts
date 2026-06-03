/**
 * `o2b brain trigger <scan|list|ack|dismiss|act|history>` (Workspace
 * Insight Suite, t_cd1fee79): the grounded proactive trigger queue
 * with its anti-nag lifecycle.
 */

import { defaultConfigPath, resolveTriggerCooldownDays } from "../../../core/config.ts";
import { scanTriggers } from "../../../core/brain/triggers/scan.ts";
import {
  listTriggers,
  transitionTrigger,
  type TriggerAction,
} from "../../../core/brain/triggers/store.ts";
import { isTriggerStatus, type TriggerRecord } from "../../../core/brain/triggers/types.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const TERMINAL = new Set(["acted", "dismissed", "expired"]);

function triggerJson(record: TriggerRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.effectiveStatus,
    urgency: record.urgency,
    reason: record.reason,
    suggested_action: record.suggestedAction,
    source_artifacts: record.sourceArtifacts,
    cooldown_key: record.cooldownKey,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    delivered_at: record.deliveredAt,
    resolved_at: record.resolvedAt,
  };
}

function printTrigger(record: TriggerRecord): void {
  ok(`${record.id} [${record.effectiveStatus}] (${record.urgency}) ${record.reason}`);
}

export async function cmdBrainTrigger(argv: string[]): Promise<number> {
  const action = argv[0];
  const actions = ["scan", "list", "ack", "dismiss", "act", "history"];
  if (!action || !actions.includes(action)) {
    return fail(
      "usage: o2b brain trigger <scan|list|ack|dismiss|act|history> [id] [--status S] [--json]",
    );
  }
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    status: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;
  const now = new Date();

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

    if (action === "scan") {
      const cooldownDays = resolveTriggerCooldownDays(config);
      const result = scanTriggers(vault, { now, cooldownDays });
      if (json) {
        okJson({
          ok: true,
          candidates: result.candidates,
          created: result.created.map(triggerJson),
          skipped: result.skipped.map((s) => ({ cooldown_key: s.cooldownKey, reason: s.reason })),
        });
        return 0;
      }
      ok(
        `candidates: ${result.candidates}, created: ${result.created.length}, skipped: ${result.skipped.length}`,
      );
      for (const record of result.created) printTrigger(record);
      return 0;
    }

    if (action === "list" || action === "history") {
      const statusFlag = normalizeFlagString(flags["status"]);
      if (statusFlag !== null && !isTriggerStatus(statusFlag)) {
        return fail(`unknown trigger status: ${statusFlag}`);
      }
      let records = listTriggers(vault, {
        now,
        ...(statusFlag !== null ? { status: statusFlag } : {}),
      });
      if (action === "history") {
        records = records.filter((r) => TERMINAL.has(r.effectiveStatus));
      } else if (statusFlag === null) {
        records = records.filter((r) => !TERMINAL.has(r.effectiveStatus));
      }
      if (json) {
        okJson({ ok: true, triggers: records.map(triggerJson) });
        return 0;
      }
      if (records.length === 0) {
        ok(action === "history" ? "no trigger history" : "no open triggers");
        return 0;
      }
      for (const record of records) printTrigger(record);
      return 0;
    }

    // ack / dismiss / act
    const id = positional[0];
    if (!id) return fail(`brain trigger ${action} requires a trigger id`);
    const verb: TriggerAction =
      action === "ack" ? "acknowledge" : action === "dismiss" ? "dismiss" : "act";
    const record = transitionTrigger(vault, id, verb, { now });
    if (json) okJson({ ok: true, trigger: triggerJson(record) });
    else printTrigger(record);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
