/**
 * `o2b brain trigger <scan|list|ack|dismiss|act|suppress|unsuppress|history>`
 * (Workspace Insight Suite, t_cd1fee79): the grounded proactive trigger
 * queue with its anti-nag lifecycle.
 */

import { defaultConfigPath, resolveTriggerCooldownDays } from "../../../core/config.ts";
import { scanTriggers } from "../../../core/brain/triggers/scan.ts";
import {
  readTriggers,
  transitionTrigger,
  unreadableTriggerJson,
  type TriggerAction,
  type UnreadableTrigger,
} from "../../../core/brain/triggers/store.ts";
import {
  isTriggerStatus,
  TRIGGER_STATUS,
  TRIGGER_TERMINAL_STATUSES,
  type TriggerRecord,
} from "../../../core/brain/triggers/types.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

/**
 * Verb to lifecycle action, stated exhaustively.
 *
 * This was a nested ternary whose final arm was `act`, so every verb
 * that was not `ack` or `dismiss` acted on the trigger - safe only for
 * as long as nobody added a verb to the accepted list without also
 * amending the ternary. An explicit map has no fallback arm to route
 * into: a verb missing from here is not a transition verb at all.
 */
const VERB_TO_ACTION: Readonly<Record<string, TriggerAction>> = Object.freeze({
  ack: "acknowledge",
  dismiss: "dismiss",
  act: "act",
  suppress: "suppress",
  unsuppress: "unsuppress",
});

/**
 * Every accepted verb, in the order the usage string lists them: the
 * read verbs around the transition verbs, which are taken from
 * {@link VERB_TO_ACTION} so the two can never disagree.
 */
const TRIGGER_VERBS: ReadonlyArray<string> = Object.freeze([
  "scan",
  "list",
  ...Object.keys(VERB_TO_ACTION),
  "history",
]);

const USAGE = `usage: o2b brain trigger <${TRIGGER_VERBS.join("|")}> [id] [--status S] [--json]`;

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
    suppressed_at: record.suppressedAt,
    suppressed_from: record.suppressedFrom,
    occurrences: record.occurrences,
    last_seen_at: record.lastSeenAt,
  };
}

function printTrigger(record: TriggerRecord): void {
  ok(`${record.id} [${record.effectiveStatus}] (${record.urgency}) ${record.reason}`);
}

/**
 * Report the records the store could not read.
 *
 * The count prints whether or not any exist, exactly like the suppressed
 * total: "unreadable: 0" is the surface stating that it looked, which is
 * what stops an omitted line from reading as a clean queue.
 */
function printUnreadable(unreadable: ReadonlyArray<UnreadableTrigger>): void {
  ok(`unreadable: ${unreadable.length}`);
  for (const entry of unreadable) ok(entry.error.message);
}

export async function cmdBrainTrigger(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !TRIGGER_VERBS.includes(action)) return fail(USAGE);
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
          unreadable: result.unreadable.map(unreadableTriggerJson),
        });
        return 0;
      }
      ok(
        `candidates: ${result.candidates}, created: ${result.created.length}, skipped: ${result.skipped.length}`,
      );
      for (const record of result.created) printTrigger(record);
      // A scan that walked around a broken record is not a clean scan.
      printUnreadable(result.unreadable);
      return 0;
    }

    if (action === "list" || action === "history") {
      const statusFlag = normalizeFlagString(flags["status"]);
      if (statusFlag !== null && !isTriggerStatus(statusFlag)) {
        return fail(`unknown trigger status: ${statusFlag}`);
      }
      // One unfiltered pass: `list` reports the suppressed total from it
      // so the operator sees what is silenced without having to ask, and
      // the status filter is then applied to the same records.
      const scan = readTriggers(vault, { now });
      const all = scan.records;
      const suppressed = all.filter((r) => r.effectiveStatus === TRIGGER_STATUS.suppressed).length;
      let records = statusFlag !== null ? all.filter((r) => r.effectiveStatus === statusFlag) : all;
      if (action === "history") {
        records = records.filter((r) => TRIGGER_TERMINAL_STATUSES.has(r.effectiveStatus));
      } else if (statusFlag === null) {
        records = records.filter((r) => !TRIGGER_TERMINAL_STATUSES.has(r.effectiveStatus));
      }
      if (json) {
        okJson({
          ok: true,
          triggers: records.map(triggerJson),
          ...(action === "list" ? { suppressed } : {}),
          unreadable: scan.unreadable.map(unreadableTriggerJson),
        });
        return 0;
      }
      if (action === "list") ok(`suppressed: ${suppressed}`);
      printUnreadable(scan.unreadable);
      if (records.length === 0) {
        // Said AFTER the unreadable report, so "no open triggers" can
        // never be the only thing an operator reads about a queue that
        // held something nobody could parse.
        ok(action === "history" ? "no trigger history" : "no open triggers");
        return 0;
      }
      for (const record of records) printTrigger(record);
      return 0;
    }

    const verb = VERB_TO_ACTION[action];
    // Unreachable while TRIGGER_VERBS is the union of the read verbs and
    // this map's keys, and stated rather than assumed so that adding a
    // verb to one without the other is a usage error, not a transition.
    if (verb === undefined) return fail(USAGE);
    const id = positional[0];
    if (!id) return fail(`brain trigger ${action} requires a trigger id`);
    const record = transitionTrigger(vault, id, verb, { now });
    if (json) okJson({ ok: true, trigger: triggerJson(record) });
    else printTrigger(record);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
