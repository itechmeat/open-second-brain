/**
 * Repo-scoped ADR candidate reader for the architecture notes
 * (salience-lifecycle-enrichment, unit 6 / t_041c571f).
 *
 * `Brain/decisions/candidates/` is a VAULT-GLOBAL store: the commit miner
 * (`git/decisions.ts`) writes one candidate per decision-shaped commit of
 * every repository the vault has ingested, and stamps each one with the
 * `repo_key` it came from. The architect derives the same key from the
 * project it is scanning, so the join is exact - and it is the only thing
 * that keeps one repository's key-decisions note from listing another
 * repository's drafts.
 *
 * Read-only and deterministic: candidates are ordered by filename in
 * codepoint order, never by directory order (which no filesystem
 * promises) and never by a locale collator. A candidate whose frontmatter
 * is missing a field is REPORTED with that field named as unrecorded, not
 * skipped - a hand-edited draft that lost its sha is exactly the note an
 * operator needs to see in the list.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { compareStable } from "./scan.ts";

/** Where the commit miner puts its drafts, relative to the vault root. */
export const DECISION_CANDIDATES_DIR = ["Brain", "decisions", "candidates"] as const;

/** One ADR candidate, as the key-decisions note needs it. */
export interface DecisionCandidateFact {
  /** Absolute path of the candidate note. */
  readonly path: string;
  /** Vault-relative, extension-less path - the wikilink target. */
  readonly link: string;
  /** The candidate's own heading, or its filename when it has none. */
  readonly title: string;
  /** The commit sha the candidate is identified by, when it records one. */
  readonly sha: string | null;
  /** Deterministic signal ids that made the commit decision-shaped. */
  readonly signals: ReadonlyArray<string>;
}

/** The first ATX heading of a candidate body, without its marker. */
function headingOf(body: string): string | null {
  for (const line of body.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

/** A frontmatter value read as a non-empty string, or null. */
function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A frontmatter value read as a string list. */
function listField(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  const single = stringField(value);
  return single === null ? [] : [single];
}

/**
 * Every ADR candidate in the vault whose `repo_key` is `repoKey`, in a
 * stable order. A vault with no candidate directory yields an empty list;
 * that is an ordinary state, not a failure.
 */
export function listRepoDecisionCandidates(
  vault: string,
  repoKey: string,
): ReadonlyArray<DecisionCandidateFact> {
  const dir = join(vault, ...DECISION_CANDIDATES_DIR);
  if (!existsSync(dir)) return Object.freeze([]);

  const facts: DecisionCandidateFact[] = [];
  for (const name of readdirSync(dir).toSorted(compareStable)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    const [metadata, body] = parseFrontmatter(path);
    if (stringField(metadata["repo_key"]) !== repoKey) continue;
    const stem = name.slice(0, -".md".length);
    facts.push(
      Object.freeze({
        path,
        link: `${DECISION_CANDIDATES_DIR.join("/")}/${stem}`,
        title: headingOf(body) ?? stem,
        sha: stringField(metadata["sha"]),
        signals: Object.freeze(listField(metadata["signals"])),
      }),
    );
  }
  return Object.freeze(facts);
}
