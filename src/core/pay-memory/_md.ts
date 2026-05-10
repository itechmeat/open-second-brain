/**
 * Shared Markdown / frontmatter rendering helpers used by every Pay Memory
 * artifact writer (receipt, asset, report, approval). Internal to the
 * `pay-memory/` directory — not re-exported from the package barrel.
 *
 * Centralises:
 *   - the `_(not provided)_` placeholder string used in body templates,
 *   - inline-code rendering with backtick sanitisation,
 *   - wikilink construction with bracket sanitisation,
 *   - ISO-Z timestamp emission for `created` / `approved_at` / etc.,
 *   - `FrontmatterMap` accessors (`putIfPresent`, `frontmatterStr`).
 */

import type { FrontmatterMap, FrontmatterValue } from "../types.ts";

export const NOT_PROVIDED = "_(not provided)_";

/** Strip a trailing `.md` (case-insensitive) from a wikilink target. */
export function stripMarkdownExt(target: string): string {
  return target.replace(/\.md$/i, "");
}

/**
 * Drop `[`/`]` from a wikilink target so they cannot prematurely close
 * the surrounding `[[ ... ]]`. These characters are never legal in vault
 * paths anyway.
 */
export function sanitizeWikilinkTarget(target: string): string {
  return target.replace(/[[\]]/g, "");
}

/**
 * Render an Obsidian wikilink for `target`, stripping `.md` and any bare
 * `[`/`]`. Idempotent on already-sanitised inputs.
 */
export function wikiLink(target: string): string {
  return `[[${stripMarkdownExt(sanitizeWikilinkTarget(target.trim()))}]]`;
}

/**
 * Wrap `value` in inline-code backticks, replacing embedded backticks with
 * the visually similar grave-accent placeholder so the surrounding span
 * stays balanced.
 */
export function formatCode(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return NOT_PROVIDED;
  return `\`${trimmed.replace(/`/g, "ˋ")}\``;
}

/** Current wall-clock time as `YYYY-MM-DDTHH:MM:SSZ`. */
export function nowIsoZ(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Set `meta[key] = value.trim()` only when `value` is a non-empty string.
 * Used by writers that emit optional frontmatter fields conditionally so
 * the report aggregator can rely on "key present ⇒ relevant".
 */
export function putIfPresent(
  meta: FrontmatterMap,
  key: string,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) return;
  const trimmed = String(value).trim();
  if (!trimmed) return;
  meta[key] = trimmed as FrontmatterValue;
}

/**
 * Read a frontmatter field as a string. Arrays are joined with `, `;
 * `null` / `undefined` collapse to `""`.
 */
export function frontmatterStr(value: FrontmatterValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
