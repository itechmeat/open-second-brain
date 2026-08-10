import { resolveTriggerCooldownDays } from "../../../core/config.ts";
import { buildMorningBrief } from "../../../core/brain/morning-brief.ts";
import {
  deliverBriefTriggers,
  renderTriggerBriefSection,
} from "../../../core/brain/triggers/brief.ts";
import {
  readTriggerQueueFailures,
  renderTriggerQueueFailures,
  unreadableTriggerJson,
} from "../../../core/brain/triggers/store.ts";
import { parseOptionalNumberFlag } from "../../coerce.ts";
import { brainVerbContext, fail, localTimeFields, parse } from "../helpers.ts";

/**
 * `o2b brain morning-brief` - render a read-only session-start summary:
 * top confirmed preferences, recent reconcile open questions, and recent
 * notes. Bounded by the shared recall char budget.
 */
export async function cmdBrainMorningBrief(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "top-k": { type: "string" },
    "lookback-days": { type: "string" },
    "max-chars-per-memory": { type: "string" },
    "max-total-chars": { type: "string" },
  });

  const { config, vault } = brainVerbContext(flags);

  // Positive-integer validation mirroring the MCP tool's
  // coercePositiveInteger, so the CLI and MCP surfaces share semantics.
  const positiveInt = (name: string): { value: number | null; error: string | null } => {
    const parsed = parseOptionalNumberFlag(flags, name);
    if (parsed.error) return parsed;
    if (parsed.value !== null && (!Number.isInteger(parsed.value) || parsed.value < 1)) {
      return { value: null, error: `--${name} must be a positive integer` };
    }
    return parsed;
  };

  const topKFlag = positiveInt("top-k");
  if (topKFlag.error) return fail(topKFlag.error);
  const lookbackFlag = positiveInt("lookback-days");
  if (lookbackFlag.error) return fail(lookbackFlag.error);
  const perMemFlag = positiveInt("max-chars-per-memory");
  if (perMemFlag.error) return fail(perMemFlag.error);
  const totalFlag = positiveInt("max-total-chars");
  if (totalFlag.error) return fail(totalFlag.error);

  let brief;
  try {
    brief = buildMorningBrief(vault, {
      now: new Date(),
      topK: topKFlag.value ?? 10,
      lookbackDays: lookbackFlag.value ?? 7,
      ...(perMemFlag.value !== null ? { maxCharsPerMemory: perMemFlag.value } : {}),
      ...(totalFlag.value !== null ? { maxTotalChars: totalFlag.value } : {}),
    });
  } catch (exc) {
    return fail(`morning-brief failed: ${(exc as Error).message ?? exc}`);
  }

  // Pending-trigger section (t_cd1fee79): renders only when a trigger
  // scan has produced surfaceable triggers; included triggers are
  // marked delivered so the same prompt shows once per cooldown window.
  //
  // Still fail-soft - a broken queue must not cost the operator the rest
  // of the brief - but no longer silent. The bare catch this replaces set
  // the section to null, so a refusal rendered exactly like an empty
  // queue: the one outcome the anti-nag ledger exists to rule out.
  const now = new Date();
  const triggerFailures = readTriggerQueueFailures(vault, now);
  let queueError = triggerFailures.queueError;
  let triggerSection;
  try {
    triggerSection = renderTriggerBriefSection(vault, {
      now,
      cooldownDays: resolveTriggerCooldownDays(config),
    });
  } catch (exc) {
    triggerSection = null;
    queueError = (exc as Error).message ?? String(exc);
  }

  // Delivery is the store mutation: do it BEFORE emitting output so a
  // failed write cannot follow a successful-looking response.
  if (triggerSection !== null && triggerSection.triggers.length > 0) {
    deliverBriefTriggers(vault, triggerSection, now);
  }
  if (flags["json"]) {
    const payload = {
      ...brief,
      ...(triggerSection !== null && triggerSection.triggers.length > 0
        ? {
            triggers: triggerSection.triggers.map((t) => ({
              id: t.id,
              kind: t.kind,
              urgency: t.urgency,
              reason: t.reason,
            })),
          }
        : {}),
      ...(triggerFailures.unreadable.length > 0
        ? { triggers_unreadable: triggerFailures.unreadable.map(unreadableTriggerJson) }
        : {}),
      ...(queueError !== null ? { trigger_queue_error: queueError } : {}),
    };
    process.stdout.write(
      JSON.stringify({ ...payload, ...localTimeFields(config) }, null, 2) + "\n",
    );
  } else {
    const failureText = renderTriggerQueueFailures({
      unreadable: triggerFailures.unreadable,
      queueError,
    });
    const sections = [
      brief.text,
      triggerSection !== null ? triggerSection.text : "",
      failureText,
    ].filter((section) => section !== "");
    // The placeholder stands for a brief with nothing in it, so it must
    // not stand in for one whose trigger queue could not be read.
    process.stdout.write(
      (sections.length > 0 ? sections.join("\n\n") : "(nothing to surface)") + "\n",
    );
  }
  return 0;
}
