/**
 * Frontmatter-tags hygiene detector (trust-surface-hardening wave;
 * kanban t_11ee559f, doctor half).
 *
 * Informational audit over the frontmatter `tags:` field - the one
 * place the inline body-tags detector (`tags.ts`) explicitly scopes
 * out. Existing vault content cannot be refused retroactively at the
 * composers, so this detector reports what the write-time gate would
 * have rejected: entries failing the ONE shared tag rule
 * (`src/core/tags.ts`, {@link isObsidianTagValue} - consumed, never a
 * local copy). The inline-array, block-sequence, and scalar spellings
 * of the field all parse to a list of values through the shared
 * frontmatter reader; every value is judged, empty entries skipped
 * (no value, no finding - the inline detector's skip-empty polarity).
 *
 * One finding class, `severity: "info"`, `proposed_action: "review"`,
 * grouped per distinct value across the vault (one mechanical story,
 * one rename): `malformed` - a stored value Obsidian's own tag rule
 * cannot parse, so the entry is invisible to tag queries and the
 * properties editor. Detection-only; the detector never mutates
 * anything and never auto-fixes. Opt-in like the inline detector:
 * registered in `HYGIENE_DETECTOR_IDS`, excluded from
 * `DEFAULT_SCAN_IDS` (a loosely-tagged legacy vault is exactly the
 * vault that has these, and the default sweep should not drown in
 * them uninvited).
 *
 * Targets run [documents..., tag value] so the shared finding-id hash
 * stays unique per finding (one value can live on several documents,
 * and one document can carry several distinct values).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listVaultNotePaths, parseFrontmatterText } from "../../../vault.ts";
import { isObsidianTagValue } from "../../../tags.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

/** The one frontmatter field this detector audits. */
const TAGS_FIELD = "tags";

/**
 * One mechanical story behind every finding, stated in evidence - the RULE
 * half of it. The VALUE half is prepended by the finding itself, so the
 * reason an operator reads names both (`"foo bar" is not a parseable ...`).
 * Exported for the test that pins that composition.
 */
export const MALFORMED_REASON =
  "is not a parseable Obsidian tag value: must start with a letter or underscore and contain only letters, numbers, dashes, underscores, or slashes (never only digits)";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The field's values for one document, whatever spelling stored them. */
function frontmatterTagValues(vault: string, path: string): string[] {
  const content = readFileSync(join(vault, path), "utf8");
  const [metadata] = parseFrontmatterText(content);
  const field = metadata[TAGS_FIELD];
  if (Array.isArray(field)) return field.filter((v) => v !== "");
  if (typeof field === "string" && field !== "") return [field];
  return [];
}

export function detectFrontmatterTags(vault: string): ReadonlyArray<HygieneFinding> {
  // value -> vault-relative paths carrying it, insertion-ordered then sorted.
  const docsByValue = new Map<string, string[]>();
  for (const path of listVaultNotePaths(vault)) {
    for (const value of frontmatterTagValues(vault, path)) {
      if (isObsidianTagValue(value)) continue;
      const paths = docsByValue.get(value) ?? [];
      paths.push(path);
      docsByValue.set(value, paths);
    }
  }

  const findings: HygieneFinding[] = [];
  for (const value of [...docsByValue.keys()].toSorted(compareStrings)) {
    const targets = [...docsByValue.get(value)!.toSorted(compareStrings), value];
    findings.push(
      Object.freeze({
        id: hygieneFindingId("frontmatter-tags", targets),
        detector: "frontmatter-tags" as const,
        severity: "info" as const,
        title: `Malformed frontmatter tag: ${JSON.stringify(value)} is not a parseable tag value`,
        targets: Object.freeze(targets),
        proposed_action: "review" as const,
        evidence: Object.freeze({
          class: "malformed",
          field: TAGS_FIELD,
          tag: value,
          reason: `${JSON.stringify(value)} ${MALFORMED_REASON}`,
        }),
      }),
    );
  }
  return Object.freeze(findings);
}
