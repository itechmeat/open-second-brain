/**
 * Open-decisions morning-brief section (write-side-trust wave, Lane E,
 * Task 10).
 *
 * The brief surfaces (CLI verb + MCP tool) render this section so a
 * parked question resurfaces until somebody closes it. Render-ONLY, and
 * deliberately so: the trigger brief marks its records delivered so a
 * prompt shows once per cooldown window, but an open decision is a
 * standing question with no cooldown - showing it every morning is the
 * point, so there is no write step here at all.
 *
 * The section renders the open records oldest-first (the longest-parked
 * question is the one most overdue for a decision), capped, and never
 * renders an unreadable directory as an empty one: unreadable records
 * are named inside the section, the same contract
 * `renderTriggerQueueFailures` holds for triggers.
 */

import { listOpenDecisions, OPEN_DECISION_STATUS } from "./open-store.ts";
import type { OpenDecisionRecord } from "./open-store.ts";

export const OPEN_DECISIONS_BRIEF_CAP = 5;

/** Heading of the open-decisions section. */
export const OPEN_DECISIONS_HEADING = "## Open decisions";

/** Heading of the block naming records the store could not read. */
export const UNREADABLE_OPEN_DECISIONS_HEADING = "## Unreadable open decisions";

export interface OpenDecisionsBriefSection {
  /** Rendered Markdown section, or "" when nothing surfaces. */
  readonly text: string;
  /** The open records rendered, oldest first, capped. */
  readonly records: ReadonlyArray<OpenDecisionRecord>;
  /** Records that named themselves and could not be parsed, by path. */
  readonly unreadable: ReadonlyArray<{ path: string; reason: string }>;
}

export interface OpenDecisionsBriefOptions {
  /** Max open records rendered; defaults to {@link OPEN_DECISIONS_BRIEF_CAP}. */
  readonly cap?: number;
}

/** Render the open-decisions section. Read-only. */
export function renderOpenDecisionsBriefSection(
  vault: string,
  opts: OpenDecisionsBriefOptions = {},
): OpenDecisionsBriefSection {
  const listed = listOpenDecisions(vault, { status: OPEN_DECISION_STATUS.open });
  const records = listed.records.slice(0, Math.max(0, opts.cap ?? OPEN_DECISIONS_BRIEF_CAP));
  if (records.length === 0 && listed.unreadable.length === 0) {
    return { text: "", records: [], unreadable: [] };
  }
  const lines = [OPEN_DECISIONS_HEADING, ""];
  for (const record of records) {
    lines.push(`- ${record.question} (${record.id})`);
  }
  if (listed.unreadable.length > 0) {
    lines.push("", UNREADABLE_OPEN_DECISIONS_HEADING, "");
    for (const entry of listed.unreadable) lines.push(`- ${entry.reason}`);
  }
  return { text: lines.join("\n"), records, unreadable: listed.unreadable };
}
