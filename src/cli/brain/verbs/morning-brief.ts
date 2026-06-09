import { resolveTriggerCooldownDays } from "../../../core/config.ts";
import { buildMorningBrief } from "../../../core/brain/morning-brief.ts";
import {
  deliverBriefTriggers,
  renderTriggerBriefSection,
} from "../../../core/brain/triggers/brief.ts";
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
  // optionalPositiveInt, so the CLI and MCP surfaces share semantics.
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
  const now = new Date();
  let triggerSection;
  try {
    triggerSection = renderTriggerBriefSection(vault, {
      now,
      cooldownDays: resolveTriggerCooldownDays(config),
    });
  } catch {
    triggerSection = null;
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
    };
    process.stdout.write(
      JSON.stringify({ ...payload, ...localTimeFields(config) }, null, 2) + "\n",
    );
  } else {
    const base = brief.text.length > 0 ? brief.text : "(nothing to surface)";
    const text =
      triggerSection !== null && triggerSection.text !== ""
        ? `${base}\n\n${triggerSection.text}`
        : base;
    process.stdout.write(text + "\n");
  }
  return 0;
}
