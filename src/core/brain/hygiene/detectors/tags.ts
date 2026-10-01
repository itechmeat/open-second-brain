/**
 * Tags hygiene detector (search/diagnostics/vault-hygiene wave; kanban
 * t_c8508241).
 *
 * Informational audit over INLINE BODY tags - the prose a reader sees.
 * Frontmatter `tags:` arrays are OUT of scope (recorded refusal):
 * list-field parsing is a different reader than TAG_RE-over-prose, so
 * "vault-wide" means inline body tags only. Scope is likewise prose
 * only: the body is split off with the shared frontmatter reader and
 * code fences / inline-code spans are stripped with the shared
 * cleaning, so the audit sees exactly the text the index extracts
 * from - a token inside a fence is invisible to both and reported by
 * neither. Detection-only lint half of board sibling t_11ee559f
 * (write-time tag syntax validation); the shared rule this detector
 * consumes lives in `src/core/tags.ts` and is that task's seam.
 *
 * Three finding classes, all `severity: "info"`, `proposed_action:
 * "review"`:
 *
 *  - `malformed` - body `#...` tokens the looser Obsidian-compatible
 *    rule accepts but the shared index rule (TAG_RE) rejects. A
 *    malformed token is not an error Obsidian flags: it is silently
 *    absent from the link table (index-side loss), so the diff is
 *    REPORTED here and TAG_RE itself is not widened this wave
 *    (recorded refusal: an index-semantics change with reindex gating
 *    does not ride a hygiene wave).
 *  - `inconsistent` - the same tag differing by case or hierarchy
 *    depth (`#Foo` vs `#foo`, `#a/b` vs `#a`), grouped into one
 *    finding per family: case variants share a lowercased key,
 *    hierarchy variants are slash-boundary prefixes of each other,
 *    and both relations chain (`#x`, `#x/y`, `#x/y/z` is one family).
 *  - `orphan` - a tag value on exactly one document with no
 *    cross-document sharing. Sharing is judged on the lowercased
 *    value (case counts as sharing), and family members are excluded
 *    - their cross-document story is the inconsistent finding's job.
 *
 * Findings are computed from prose re-extraction, not from the links
 * table: the table by construction cannot hold the malformed tags this
 * detector exists to find. Targets run [documents..., tag token]; the
 * tag token is part of the target set so the shared finding-id hash
 * stays unique per finding (a document can carry several distinct tag
 * findings). Read-only; never mutates anything.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listVaultNotePaths, parseFrontmatterText } from "../../../vault.ts";
import { extractTagValues, stripCode } from "../../../tags.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

/**
 * The looser Obsidian-compatible rule, per the documented Obsidian tag
 * syntax: letters, numbers, underscores, hyphens, and slashes, with at
 * least one non-numeric character. Boundary and value charset are the
 * shared rule's own; only the letter/underscore ONSET is relaxed - so
 * `#2024notes` and `#3d-print` are accepted here while the index rule
 * rejects them. A value may not BEGIN with a slash (an empty first
 * nested-tag segment is no tag in Obsidian either).
 */
export const OBSIDIAN_TAG_RE = /(^|[^\w/])#([\w-][\w\-/]*)/g;

/** Obsidian requires at least one non-numeric character; so does the index rule, by its onset. */
const PURE_NUMERIC_RE = /^[0-9]+$/;

/** One mechanical story behind every malformed finding, stated in evidence. */
const MALFORMED_REASON =
  "accepted by the documented Obsidian tag rule but rejected by the index tag rule (TAG_RE); the index will never match it";

/** A tag token as it appears in prose: the value with its leading `#`. */
function tagToken(value: string): string {
  return `#${value}`;
}

/** Per-document tag facts, extracted over the same cleaned prose the index sees. */
interface DocumentTags {
  readonly path: string;
  /** Tag values the index rule captures, deduplicated, raw spelling preserved. */
  readonly values: ReadonlySet<string>;
  /** Values the looser Obsidian rule accepts but the index rule rejects. */
  readonly malformed: ReadonlySet<string>;
}

function collectDocumentTags(vault: string, path: string): DocumentTags {
  const content = readFileSync(join(vault, path), "utf8");
  const [, body] = parseFrontmatterText(content);
  const cleaned = stripCode(body);
  const values = new Set(extractTagValues(cleaned));
  const malformed = new Set<string>();
  for (const match of cleaned.matchAll(OBSIDIAN_TAG_RE)) {
    const value = match[2] ?? "";
    if (value === "" || PURE_NUMERIC_RE.test(value)) continue;
    if (!values.has(value)) malformed.add(value);
  }
  return { path, values, malformed };
}

/** Case-insensitive tag key: the lowercased value without its `#`. */
function lowerKey(value: string): string {
  return value.toLowerCase();
}

/**
 * Minimal union-find over tag keys so case and hierarchy relations
 * chain into one family (`#x` + `#x/y` + `#X/y/z` collapses once).
 */
class KeyFamilies {
  private readonly parent = new Map<string, string>();

  find(start: string): string {
    const seen: string[] = [];
    let root = start;
    for (;;) {
      const parentKey = this.parent.get(root);
      if (parentKey === undefined || parentKey === root) break;
      seen.push(root);
      root = parentKey;
    }
    for (const key of seen) this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function detectTags(vault: string): ReadonlyArray<HygieneFinding> {
  const documents = listVaultNotePaths(vault).map((path) => collectDocumentTags(vault, path));

  // Vault-wide aggregates, keyed for the three finding classes.
  const malformedDocs = new Map<string, string[]>();
  const spellings = new Map<string, Set<string>>();
  const docsByKey = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const value of document.malformed) {
      const paths = malformedDocs.get(value) ?? [];
      paths.push(document.path);
      malformedDocs.set(value, paths);
    }
    for (const value of document.values) {
      const key = lowerKey(value);
      const variants = spellings.get(key) ?? new Set<string>();
      variants.add(tagToken(value));
      spellings.set(key, variants);
      const paths = docsByKey.get(key) ?? new Set<string>();
      paths.add(document.path);
      docsByKey.set(key, paths);
    }
  }

  const findings: HygieneFinding[] = [];

  // Malformed: one finding per distinct rejected token, targets running
  // [documents..., token].
  for (const value of [...malformedDocs.keys()].toSorted(compareStrings)) {
    const token = tagToken(value);
    const targets = [...malformedDocs.get(value)!.toSorted(compareStrings), token];
    findings.push(
      Object.freeze({
        id: hygieneFindingId("tags", targets),
        detector: "tags" as const,
        severity: "info" as const,
        title: `Malformed tag: the index will never match ${token}`,
        targets: Object.freeze(targets),
        proposed_action: "review" as const,
        evidence: Object.freeze({ class: "malformed", tag: token, reason: MALFORMED_REASON }),
      }),
    );
  }

  // Inconsistent: families chained by case and slash-boundary prefix
  // relations; a family qualifies when it holds several keys or several
  // spellings of one key.
  const families = new KeyFamilies();
  const keys = new Set(docsByKey.keys());
  for (const key of keys) {
    let slash = key.indexOf("/");
    while (slash > 0) {
      const prefix = key.slice(0, slash);
      if (keys.has(prefix)) families.union(key, prefix);
      slash = key.indexOf("/", slash + 1);
    }
  }
  const familyMembers = new Map<string, string[]>();
  for (const key of keys) {
    const root = families.find(key);
    const members = familyMembers.get(root) ?? [];
    members.push(key);
    familyMembers.set(root, members);
  }
  const familyKeys = new Set<string>();
  for (const members of familyMembers.values()) {
    const variants = new Set<string>();
    const paths = new Set<string>();
    for (const key of members) {
      for (const spelling of spellings.get(key)!) variants.add(spelling);
      for (const path of docsByKey.get(key)!) paths.add(path);
    }
    if (members.length < 2 && variants.size < 2) continue;
    for (const key of members) familyKeys.add(key);
    const familyKey = members.toSorted(compareStrings)[0]!;
    const sortedVariants = [...variants].toSorted(compareStrings);
    const targets = [...[...paths].toSorted(compareStrings), tagToken(familyKey)];
    findings.push(
      Object.freeze({
        id: hygieneFindingId("tags", targets),
        detector: "tags" as const,
        severity: "info" as const,
        title: `Inconsistent tag spellings: ${sortedVariants.join(" vs ")}`,
        targets: Object.freeze(targets),
        proposed_action: "review" as const,
        evidence: Object.freeze({
          class: "inconsistent",
          variants: Object.freeze(sortedVariants),
          key: tagToken(familyKey),
        }),
      }),
    );
  }

  // Orphan: one document, one spelling, no family. A key with several
  // spellings is already an inconsistent family; a key on several
  // documents is shared.
  for (const key of [...docsByKey.keys()].toSorted(compareStrings)) {
    if (familyKeys.has(key)) continue;
    const paths = docsByKey.get(key)!;
    if (paths.size !== 1) continue;
    const variants = spellings.get(key)!;
    if (variants.size !== 1) continue;
    const token = [...variants][0]!;
    const targets = [[...paths][0]!, token];
    findings.push(
      Object.freeze({
        id: hygieneFindingId("tags", targets),
        detector: "tags" as const,
        severity: "info" as const,
        title: `Orphan tag ${token} appears on only one document`,
        targets: Object.freeze(targets),
        proposed_action: "review" as const,
        evidence: Object.freeze({ class: "orphan", tag: token }),
      }),
    );
  }

  return Object.freeze(findings);
}
