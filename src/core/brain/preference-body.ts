/**
 * The body of a preference page (task 2.10): what the preference writer
 * renders from its input (`## Origin`, the recent evidence sections, the
 * `## How to apply` guidance), the `## Retired` section a retire appends,
 * and the rule that tells the prose a body holds beyond its fields (the
 * fold's `text` field, FORMAT.md "Preferences") from a body the fields
 * alone render. A leaf of the preference writer (`preference.ts`), so the
 * page views (`memory-pages.ts`) rebuild a page's body without importing
 * the writer.
 */

import type { FrontmatterMap } from "../types.ts";
import { pageText, PREFERENCE_TEXT_FIELD } from "./preference-store.ts";
import type { BrainEvidenceSummary } from "./types.ts";

/** What {@link renderPreferenceBody} renders a body from. */
export interface PreferenceBodyInput {
  readonly evidenced_by: ReadonlyArray<string>;
  readonly recentApplied?: ReadonlyArray<BrainEvidenceSummary>;
  readonly recentViolated?: ReadonlyArray<BrainEvidenceSummary>;
  readonly howToApply?: string;
}

/** What {@link appendRetiredSection} states about a retire. */
export interface RetiredSectionInput {
  readonly now: Date;
  readonly retired_by: string;
  readonly superseded_by?: string;
  readonly user_rejected_reason?: string;
}

/**
 * Render the preference body. Sections are emitted **only when they
 * have real content** — v0.10.1 removes the always-empty placeholder
 * blocks (`_(no evidence yet)_`, `_(not provided)_`) that the v0.9.x
 * shape used to ship. Principle text is intentionally NOT duplicated:
 * frontmatter is the single source for that field.
 *
 * Sections, in order:
 *
 *   - `## Origin` — wikilinks from `evidenced_by` (one bullet each).
 *     Omitted when the array is empty (e.g. `--force-confirmed`).
 *   - `## Recent applications` — last N `apply-evidence applied` rows,
 *     newest first. Each bullet: `[[artifact]] — ts (agent) — note`.
 *     Omitted when zero.
 *   - `## Recent violations` — same shape for `violated` / `outdated`.
 *     Omitted when zero.
 *   - `## How to apply` — only when `howToApply` is non-empty prose
 *     supplied by the caller; never auto-filled.
 *
 * If all sections are skipped, the body is empty and {@link
 * writeFrontmatterAtomic} writes a frontmatter-only file.
 */
export function renderPreferenceBody(input: PreferenceBodyInput): string {
  const sections: string[] = [];

  if (input.evidenced_by.length > 0) {
    const block: string[] = ["## Origin", ""];
    for (const ev of input.evidenced_by) block.push(`- ${ev}`);
    sections.push(block.join("\n"));
  }

  if (input.recentApplied && input.recentApplied.length > 0) {
    sections.push(renderEvidenceSection("Recent applications", input.recentApplied));
  }

  if (input.recentViolated && input.recentViolated.length > 0) {
    sections.push(renderEvidenceSection("Recent violations", input.recentViolated));
  }

  const guidance = input.howToApply?.trim();
  if (guidance) {
    const normalised = guidance.replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
    sections.push(["## How to apply", "", normalised].join("\n"));
  }

  return sections.join("\n\n");
}

function renderEvidenceSection(heading: string, rows: ReadonlyArray<BrainEvidenceSummary>): string {
  const lines: string[] = [`## ${heading}`, ""];
  for (const ev of rows) {
    const parts: string[] = [`- ${ev.artifact}`, `— ${ev.timestamp}`];
    if (ev.agent) parts.push(`(${ev.agent})`);
    if (ev.result === "violated" || ev.result === "outdated") {
      parts.push(`[${ev.result}]`);
    }
    if (ev.note) parts.push(`— ${ev.note.replace(/\s+/g, " ").trim()}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

export function appendRetiredSection(
  body: string,
  reason: string,
  opts: RetiredSectionInput,
): string {
  const trimmed = body.trimEnd();
  const block: string[] = [
    "",
    "",
    "## Retired",
    "",
    `Reason: \`${reason}\``,
    `Retired at: ${opts.now.toISOString()}`,
    `Retired by: ${opts.retired_by}`,
  ];
  if (opts.superseded_by?.trim()) {
    block.push(`Superseded by: ${opts.superseded_by.trim()}`);
  }
  if (opts.user_rejected_reason?.trim()) {
    // Multi-line user prose: collapse internal newlines so the rendered
    // block stays a flat bullet list. Long-form context belongs in the
    // log entry, not in the retired body.
    const reasonLine = opts.user_rejected_reason.trim().replace(/\s+/g, " ");
    block.push(`User reason: ${reasonLine}`);
  }
  return trimmed + block.join("\n") + "\n";
}

/**
 * The body a preference page carries when nothing but its fields wrote it:
 * the `## Origin` section the writer renders from `evidenced_by`, and for a
 * retired page the `## Retired` section the retire writes (and no
 * `## Origin`, as the retire renders it). A page whose
 * body is exactly this holds no prose of its own.
 */
export function derivedPreferenceBody(meta: FrontmatterMap, retired: boolean): string {
  // Derived fields sit on a page under their `_` names.
  const field = (name: string): unknown => meta[name] ?? meta[`_${name}`];
  const evidence = field("evidenced_by");
  const evidenced_by = Array.isArray(evidence) ? evidence.map(String) : [];
  if (!retired) return renderPreferenceBody({ evidenced_by });
  // A retire re-renders the body from the page's un-prefixed fields, and a
  // page carries `evidenced_by` under its derived `_` name, so a retired
  // page has no `## Origin` list: only the `## Retired` section.
  const body = "";
  const text = (name: string): string | undefined => {
    const value = field(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const retiredAt = Date.parse(text("retired_at") ?? "");
  const reason = text("retired_reason");
  if (reason === undefined || !Number.isFinite(retiredAt)) return body;
  const supersededBy = text("superseded_by");
  const userReason = text("user_rejected_reason");
  return appendRetiredSection(body, reason, {
    now: new Date(retiredAt),
    retired_by: text("retired_by") ?? "",
    ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
    ...(userReason !== undefined ? { user_rejected_reason: userReason } : {}),
  });
}

/**
 * The body of a preference page rebuilt from the fold: the fold's `text`
 * when a writer left prose, else {@link derivedPreferenceBody}. A retire
 * keeps the prose (only the page writer re-rendered the body), so a
 * retired preference's prose gets the `## Retired` section appended unless
 * it already carries one, as an imported retired page does.
 */
export function preferencePageBody(
  meta: FrontmatterMap,
  text: string | null,
  retired: boolean,
): string {
  if (text === null) return derivedPreferenceBody(meta, retired);
  if (!retired || /^## Retired$/m.test(text)) return text;
  const derived = derivedPreferenceBody(meta, true);
  const at = derived.indexOf("## Retired");
  return at === -1 ? text : `${text.trimEnd()}\n\n${derived.slice(at)}`;
}

/**
 * The prose a preference page body carries beyond its fields (task 2.10,
 * FORMAT.md "Preferences"): the body itself when it differs from
 * {@link derivedPreferenceBody}, `null` when the fields alone render it.
 * What a writer of a page body, and the migration's preference import,
 * store as the `text` field, so no prose is lost when the page goes.
 */
export function preferencePageProse(
  meta: FrontmatterMap,
  body: string,
  retired: boolean,
): string | null {
  // The evidence sections are the writer's render of the log, refreshed
  // on every write: they are no prose, so they never become `text` (a
  // frozen copy would then hide every later render).
  const text = pageText(withoutEvidenceSections(body));
  if (text === "") return null;
  return text === pageText(derivedPreferenceBody(meta, retired)) ? null : text;
}

/** Headings of the sections the writer renders from the log. */
const EVIDENCE_HEADINGS: ReadonlySet<string> = new Set([
  "## Recent applications",
  "## Recent violations",
]);

/** `body` without its `## Recent applications` / `## Recent violations` sections. */
function withoutEvidenceSections(body: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("## ")) skipping = EVIDENCE_HEADINGS.has(line.trimEnd());
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * `fields` of a page write with the page body's prose as `text`
 * ({@link preferencePageProse}); `null` when the body carries none, so a
 * rewrite to a fields-only body clears prose an earlier write left.
 */
export function withPreferenceProse(
  fields: Readonly<Record<string, unknown>>,
  meta: FrontmatterMap,
  body: string,
  retired = false,
): Record<string, unknown> {
  return { ...fields, [PREFERENCE_TEXT_FIELD]: preferencePageProse(meta, body, retired) };
}
