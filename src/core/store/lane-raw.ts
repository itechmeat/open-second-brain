/**
 * The raw text of a lane entry (design D8 of change `store-hardening`).
 *
 * A lane file written whole on a store-only machine read back changed: a
 * page without frontmatter gained an empty one, `'123'` turned into a
 * number, CRLF line ends and the formatting of a JSON file were lost. A
 * `lane-entry` record now keeps the file's text in an optional `raw`
 * field when its fields and text do not reproduce it, and a reader
 * serves it only when it parses back to the record's own fields and
 * text. The writer's privacy judge is the only judge of `raw`, exactly
 * as it is the only judge of `text`; the read-side check only proves the
 * raw parses back.
 */

import { parseFrontmatterText, formatFrontmatter } from "../vault.ts";
import { canonicalJson } from "../integrity/digest.ts";
import type { FrontmatterMap } from "../types.ts";

/**
 * A lane file's text as an entry's fields and text: a page's frontmatter
 * and body, a JSON object as the fields, anything else (malformed JSON
 * included, which the legacy writer also writes as it is) as text.
 */
export function laneTextParts(
  path: string,
  text: string,
): { fields: Record<string, unknown>; body: string } {
  if (path.endsWith(".md")) {
    const [frontmatter, rest] = parseFrontmatterText(text);
    return { fields: frontmatter, body: rest };
  }
  if (path.endsWith(".json")) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { fields: {}, body: text };
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, body: "" };
    }
  }
  return { fields: {}, body: text };
}

/**
 * The store branch of `readLaneText` today: `.md` renders the frontmatter,
 * a `.json` with empty text renders the fields, anything else is the text.
 */
export function renderLaneText(
  path: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): string {
  if (path.endsWith(".md")) {
    return formatFrontmatter(fields as FrontmatterMap, text);
  }
  if (path.endsWith(".json") && text === "") {
    return `${JSON.stringify(fields, null, 2)}\n`;
  }
  return text;
}

/**
 * Whether `raw` parses back to these fields and this text: the parts
 * {@link laneTextParts} makes of it equal them.
 */
export function rawParsesBack(
  path: string,
  raw: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): boolean {
  const parts = laneTextParts(path, raw);
  return parts.body === text && canonicalJson(parts.fields) === canonicalJson(fields);
}

/**
 * The file's text byte for byte to write into the record: `raw` when it is
 * defined, differs from the rendering, and parses back; otherwise
 * `undefined`.
 */
export function rawToKeep(
  path: string,
  raw: string | undefined,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (renderLaneText(path, fields, text) === raw) return undefined;
  if (!rawParsesBack(path, raw, fields, text)) return undefined;
  return raw;
}

/**
 * The one row the write-time privacy judge reads: the fields and the text,
 * plus `raw` when defined.
 */
export function lanePrivacyRow(
  fields: Readonly<Record<string, unknown>>,
  text: string,
  raw?: string,
): Record<string, unknown> {
  return raw === undefined ? { fields, text } : { fields, text, raw };
}
