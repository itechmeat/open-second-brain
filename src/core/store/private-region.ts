/**
 * The `<private>` region test every brain store dual write shares: whether
 * a text, or any string a record body carries at any depth, has a
 * `<private>` region or the placeholder a stripped one leaves. A record
 * whose text holds one goes to `private` only, whatever else its writer
 * judged. Kept apart from `reference-privacy.ts`, which judges the pages a
 * record names, so the dual-write entry point can apply it to every record
 * without importing the page judges (and the record builders they use).
 */

import { PRIVATE_REGION_PLACEHOLDER, privateRegionTexts } from "../redactor.ts";

/**
 * Whether `text` carries a `<private>` region, or the placeholder a
 * stripped one leaves (the shared redactor strips regions this way, so a
 * writer that sanitised its text still carries the mark).
 */
export function textCarriesPrivateRegion(text: string): boolean {
  return text.includes(PRIVATE_REGION_PLACEHOLDER) || privateRegionTexts(text).length > 0;
}

/**
 * Whether any string `value` carries, at any depth, has a `<private>`
 * region or the placeholder a stripped one leaves
 * ({@link textCarriesPrivateRegion}). A value nested deeper than the walk
 * goes cannot be judged in full and counts as carrying one. Used for every
 * dual-written record body, so a record whose text holds a region goes to
 * `private` only whatever its writer judged.
 */
export function valueCarriesPrivateRegion(value: unknown): boolean {
  const strings = rowStrings(value, new Set());
  return strings === null || strings.texts.some(textCarriesPrivateRegion);
}

/**
 * Deepest container nesting {@link rowStrings} walks. A row nested deeper
 * cannot be judged in full, so its judges fail closed.
 */
const ROW_WALK_MAX_DEPTH = 32;

/**
 * Every string `row` carries, at any depth (`texts`), and those outside an
 * `opaque` field (`references`). `null` when the row nests deeper than
 * {@link ROW_WALK_MAX_DEPTH} and so cannot be judged in full.
 */
export function rowStrings(
  row: unknown,
  opaque: ReadonlySet<string>,
): { readonly texts: string[]; readonly references: string[] } | null {
  const references: string[] = [];
  const texts: string[] = [];
  // Iterative, so a deeply nested row cannot overflow the stack.
  const stack: Array<readonly [unknown, number, boolean]> = [[row, 0, false]];
  while (stack.length > 0) {
    const [value, depth, isOpaque] = stack.pop()!;
    if (typeof value === "string") {
      texts.push(value);
      if (!isOpaque) references.push(value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (depth >= ROW_WALK_MAX_DEPTH) return null;
    if (Array.isArray(value)) {
      for (const child of value) stack.push([child, depth + 1, isOpaque]);
      continue;
    }
    for (const [field, child] of Object.entries(value)) {
      stack.push([child, depth + 1, isOpaque || opaque.has(field)]);
    }
  }
  return { texts, references };
}
