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
import { fencedLineMask } from "./source-links.ts";
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
  // The `## Origin` list renders `evidenced_by` on a retired page too, so
  // the list a page shows always equals the field (FORMAT.md
  // "Preferences"), whatever wrote the page: then the `## Retired` section.
  const body = renderPreferenceBody({ evidenced_by });
  if (!retired) return body;
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
  // The evidence list under `## Origin` is the render of `evidenced_by`,
  // never prose, live or retired: it is rendered from the field here, so a
  // write that changes the list (a dream refresh, a merge, a doctor repair)
  // needs no prose write, and a list prose stored by an earlier release is
  // replaced, every other line kept.
  const listed = withOriginList(text, meta);
  if (!retired) return listed;
  if (sectionsOf(listed).sections.some((section) => section.key === RETIRED_HEADING)) {
    return listed;
  }
  const derived = derivedPreferenceBody(meta, true);
  const at = derived.indexOf(RETIRED_HEADING);
  return at === -1 ? listed : `${listed.trimEnd()}\n\n${derived.slice(at)}`;
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
  // The derived parts are the writer's render of fields and of the log
  // (the evidence list under `## Origin`, the recent evidence sections),
  // refreshed on every write: they are no prose, so they never become
  // `text` (a frozen copy would then hide every later render). Prose
  // under `## Origin` (an imported page's own words) stays.
  const text = proseOf(body);
  if (text === "") return null;
  return text === proseOf(derivedPreferenceBody(meta, retired)) ? null : text;
}

/** `body` without its derived parts, as `text` stores it. */
function proseOf(body: string): string {
  return pageText(withoutSections(withoutOriginList(body), EVIDENCE_HEADINGS));
}

const ORIGIN_HEADING = "## Origin";
const RETIRED_HEADING = "## Retired";

/** Headings of the sections the writer renders from the log. */
const EVIDENCE_HEADINGS: ReadonlySet<string> = new Set([
  "## Recent applications",
  "## Recent violations",
]);

/** One bullet of the writer's evidence list: a bare wikilink, nothing else on the line. */
const EVIDENCE_BULLET_RE = /^ {0,3}[-*+][ \t]+\[\[[^\]\n]+\]\][ \t]*$/;

/** An ATX heading of level 1 or 2 (up to three spaces of indent): a section boundary. */
const SECTION_HEADING_RE = /^ {0,3}#{1,2}(?:[ \t]|$)/;

interface Section {
  /** The heading as one normalised line (`## Origin`); `null` for the lead before the first heading. */
  readonly key: string | null;
  /** Index of the section's first line (its heading) and one past its last. */
  readonly start: number;
  readonly end: number;
}

/**
 * `body` cut at its level 1 and 2 headings. A line inside a fenced code
 * block (backtick or tilde, up to three spaces of indent; the rule every
 * section reader shares, `fencedLineMask`) is content, never a heading:
 * an example page in a rule's guidance neither opens nor ends a section.
 */
function sectionsOf(body: string): {
  readonly lines: string[];
  readonly fenced: boolean[];
  readonly sections: Section[];
} {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const fenced = fencedLineMask(lines);
  const starts: Array<{ key: string | null; start: number }> = [];
  for (const [i, line] of lines.entries()) {
    const heading = !fenced[i] && SECTION_HEADING_RE.test(line);
    if (heading || i === 0) starts.push({ key: heading ? headingKey(line) : null, start: i });
  }
  const sections = starts.map((s, n) => ({ ...s, end: starts[n + 1]?.start ?? lines.length }));
  return { lines, fenced, sections };
}

/** A heading line as one normalised line: no indent, no closing `#`s, single spaces. */
function headingKey(line: string): string {
  return line
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/[ \t]+/g, " ");
}

function joined(lines: ReadonlyArray<string>): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `body` without the sections whose heading is in `headings`; every other line kept as it is. */
function withoutSections(body: string, headings: ReadonlySet<string>): string {
  const { lines, sections } = sectionsOf(body);
  return joined(
    sections
      .filter((section) => section.key === null || !headings.has(section.key))
      .flatMap((section) => lines.slice(section.start, section.end)),
  );
}

/**
 * The lines of a `## Origin` section without its evidence bullets (the
 * writer's list); every other line (prose, an annotated bullet, a fenced
 * example) kept. `null` when nothing but blank lines would remain under
 * the heading: the section was only the list.
 */
function originRest(
  lines: ReadonlyArray<string>,
  fenced: ReadonlyArray<boolean>,
  section: Section,
) {
  const rest: string[] = [];
  for (let i = section.start + 1; i < section.end; i++) {
    if (!fenced[i] && EVIDENCE_BULLET_RE.test(lines[i]!)) continue;
    rest.push(lines[i]!);
  }
  return rest.some((line) => line.trim() !== "") ? rest : null;
}

/** `body` without the evidence list of its `## Origin` sections (a section that was only the list goes). */
function withoutOriginList(body: string): string {
  const { lines, fenced, sections } = sectionsOf(body);
  const out: string[] = [];
  for (const section of sections) {
    if (section.key !== ORIGIN_HEADING) {
      out.push(...lines.slice(section.start, section.end));
      continue;
    }
    const rest = originRest(lines, fenced, section);
    if (rest !== null) out.push(lines[section.start]!, ...rest);
  }
  return joined(out);
}

/**
 * Prose `text` with the evidence list of `meta` under its `## Origin`
 * heading: the list goes right below the first such heading, ahead of
 * the section's own prose, and a list in the prose is replaced. Prose with
 * no such heading gets the section first, where the writer renders it;
 * an empty list leaves no bullet (and no section that held only bullets).
 */
function withOriginList(text: string, meta: FrontmatterMap): string {
  const evidence = meta["evidenced_by"] ?? meta["_evidenced_by"];
  const bullets = (Array.isArray(evidence) ? evidence.map(String) : []).map((ev) => `- ${ev}`);
  const { lines, fenced, sections } = sectionsOf(text);
  const first = sections.findIndex((section) => section.key === ORIGIN_HEADING);
  if (first === -1) {
    if (bullets.length === 0) return text;
    return `${[ORIGIN_HEADING, "", ...bullets].join("\n")}\n\n${text.replace(/^\n+/, "")}`;
  }
  const out: string[] = [];
  for (const [n, section] of sections.entries()) {
    if (section.key !== ORIGIN_HEADING) {
      out.push(...lines.slice(section.start, section.end));
      continue;
    }
    const rest = originRest(lines, fenced, section);
    const list = n === first ? bullets : [];
    if (list.length === 0 && rest === null) continue;
    const body = rest === null ? [] : trimBlankEdges(rest);
    out.push(
      lines[section.start]!,
      "",
      ...list,
      ...(list.length > 0 && body.length > 0 ? [""] : []),
      ...body,
      "",
    );
  }
  return joined(out).replace(/\n+$/, text.endsWith("\n") ? "\n" : "");
}

/** `lines` without the blank lines at either end. */
function trimBlankEdges(lines: ReadonlyArray<string>): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return lines.slice(from, to);
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
