/**
 * The one truncation note of the session start digest.
 *
 * The digest is assembled from lanes that each fit a budget: the pinned
 * context, the active preferences, the lessons. Each lane used to end in
 * a note of its own, and the payload as a whole was cut again to the
 * host's context limit with a third note, so a reader could get three
 * notes, none of which said what was missing in total. Now each lane is
 * budgeted WITHOUT a note and records what it cut on the injection meter;
 * the payload ends in this one note, built from those records: how many
 * characters were kept of how many, how many rule lines and sections of
 * the preference set, how much of the pinned context and how many
 * lessons are not shown, and the one call that returns the full set.
 *
 * The note opens with the same words the lane notes did, so a reader (or
 * a test) that looks for "Injection truncated to budget" still finds it.
 * Integers and fixed words only: no vault text crosses into the note.
 */

import type { BodyCut } from "../brain/active-budget.ts";

/** Which lane a cut belongs to. */
export type DigestCutSource = "active-body" | "lessons-body" | "pinned-context";

/** One lane's cut, as the meter records it. */
export interface DigestCut extends BodyCut {
  readonly source: DigestCutSource;
}

/** Opening words, shared with the earlier per-lane notices. */
export const DIGEST_CUT_NOTE_OPEN = "_Injection truncated to budget:";

/** The call that returns the full preference set and the whole pinned context. */
const FULL_SET_CALL = "Call `brain_context` for the full preference set and the pinned context";

/** Where the lessons live in full; `brain_context` does not return them. */
const LESSONS_POINTER = ", and read the `osb://lessons` resource for every lesson";

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The note, or "" when nothing was cut. */
export function renderDigestCutNote(cuts: ReadonlyArray<DigestCut>): string {
  if (cuts.length === 0) return "";
  const of = (source: DigestCutSource): DigestCut | undefined =>
    cuts.find((c) => c.source === source);
  const kept = cuts.reduce((sum, c) => sum + c.keptChars, 0);
  const total = cuts.reduce((sum, c) => sum + c.totalChars, 0);
  const missing: string[] = [];
  const active = of("active-body");
  if (active !== undefined) {
    const rules = active.itemsTotal - active.itemsKept;
    if (rules > 0)
      missing.push(
        `${rules} of ${active.itemsTotal} rule ${plural(active.itemsTotal, "line", "lines")}`,
      );
    if (active.sectionsDropped > 0)
      missing.push(
        `${active.sectionsDropped} of ${active.sectionsTotal} ${plural(active.sectionsTotal, "section", "sections")}`,
      );
  }
  const pinned = of("pinned-context");
  if (pinned !== undefined) {
    missing.push(
      `${pinned.totalChars - pinned.keptChars} of ${pinned.totalChars} characters of pinned context`,
    );
  }
  const lessons = of("lessons-body");
  if (lessons !== undefined && lessons.itemsTotal - lessons.itemsKept > 0) {
    missing.push(
      `${lessons.itemsTotal - lessons.itemsKept} of ${lessons.itemsTotal} ${plural(lessons.itemsTotal, "lesson", "lessons")}`,
    );
  }
  const counted =
    ` kept ${kept} of ${total} characters.` +
    (missing.length > 0 ? ` Not shown: ${missing.join(", ")}.` : "");
  const pointer = lessons !== undefined ? `${FULL_SET_CALL}${LESSONS_POINTER}` : FULL_SET_CALL;
  return `${DIGEST_CUT_NOTE_OPEN}${counted} ${pointer}._`;
}

const CUT_SOURCES: ReadonlySet<string> = new Set(["active-body", "lessons-body", "pinned-context"]);
const CUT_FIELDS = [
  "keptChars",
  "totalChars",
  "itemsKept",
  "itemsTotal",
  "sectionsDropped",
  "sectionsTotal",
] as const;

/**
 * The cuts a serialized list holds, or [] for anything else. The memory
 * lanes' cuts are kept beside the last-good copy of the memory context,
 * so a payload served from that copy ends in the note its own run wrote.
 */
export function parseDigestCuts(text: string | null): DigestCut[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (cut): cut is DigestCut =>
        cut !== null &&
        typeof cut === "object" &&
        CUT_SOURCES.has((cut as Record<string, unknown>)["source"] as string) &&
        CUT_FIELDS.every((field) => Number.isInteger((cut as Record<string, unknown>)[field])),
    );
  } catch {
    return [];
  }
}

/**
 * The most characters the note of a fresh payload can take: every lane
 * cut and every number seven digits wide (a digest of ten million
 * characters, past any vault this repository has met). The payload's
 * room is cut by this much before the lanes are budgeted, so the note
 * never pushes the payload past the host's limit and never needs a cut
 * of its own; the rest of the room goes to rules.
 */
export const DIGEST_CUT_NOTE_RESERVE: number = (() => {
  const wide = 9_999_999;
  const cut = (source: DigestCutSource): DigestCut => ({
    source,
    keptChars: wide,
    totalChars: wide,
    itemsKept: 0,
    itemsTotal: wide,
    sectionsDropped: wide,
    sectionsTotal: wide,
  });
  return renderDigestCutNote([
    cut("active-body"),
    { ...cut("pinned-context"), keptChars: 0 },
    cut("lessons-body"),
  ]).length;
})();
