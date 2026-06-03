/**
 * Morning-brief integration (Workspace Insight Suite, t_cd1fee79).
 *
 * The brief surfaces (CLI verb + MCP tool) render this section and
 * then mark the included triggers delivered, so the same prompt is
 * shown at most once per cooldown window. The section only renders
 * when surfaceable triggers exist - vaults that never ran a trigger
 * scan keep a byte-identical brief.
 */

import { briefTriggers, markTriggersDelivered } from "./store.ts";
import type { TriggerRecord } from "./types.ts";

export const TRIGGER_BRIEF_CAP = 5;

export interface TriggerBriefSection {
  /** Rendered Markdown section, or "" when nothing surfaces. */
  readonly text: string;
  readonly triggers: ReadonlyArray<TriggerRecord>;
}

export interface TriggerBriefOptions {
  readonly now: Date;
  readonly cooldownDays: number;
  readonly cap?: number;
}

/** Render the pending-triggers section. Read-only. */
export function renderTriggerBriefSection(
  vault: string,
  opts: TriggerBriefOptions,
): TriggerBriefSection {
  const triggers = briefTriggers(vault, {
    now: opts.now,
    cap: opts.cap ?? TRIGGER_BRIEF_CAP,
    cooldownDays: opts.cooldownDays,
  });
  if (triggers.length === 0) return Object.freeze({ text: "", triggers: Object.freeze([]) });
  const lines = ["## Pending triggers", ""];
  for (const trigger of triggers) {
    lines.push(`- [${trigger.urgency}] ${trigger.reason} (${trigger.id})`);
  }
  return Object.freeze({ text: lines.join("\n"), triggers });
}

/** Stamp the surfaced triggers delivered (write step, after render). */
export function deliverBriefTriggers(vault: string, section: TriggerBriefSection, now: Date): void {
  markTriggersDelivered(
    vault,
    section.triggers.map((t) => t.id),
    { now },
  );
}
