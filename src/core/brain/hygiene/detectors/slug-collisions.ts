/**
 * Slug-collisions detector (search/diagnostics/vault-hygiene wave;
 * kanban t_7bad7ad8).
 *
 * The write path cannot clobber: allocation runs the exclusive-create
 * suffix ladder (`allocateAndCreate`, `src/core/brain/paths.ts`) and
 * caller-named writes refuse occupied destinations. What an operator
 * sees anyway is the RESIDUE - `topic.md` next to `topic-2.md` with no
 * explanation that both were one intended slug. This detector names
 * those groups: read-only over what landed, one `info` finding per
 * same-stem group within a directory, `review` proposed action. It
 * never re-runs allocation logic and never mutates anything.
 *
 * Grouping rule: within each directory, pages group by their slug stem
 * - `slugify(basename-without-.md)` with a trailing allocation-ladder
 * suffix stripped. The stem is the inverse of `collisionCandidateName`
 * (`paths.ts`): attempt 1 is the bare base, attempts 2..n append
 * `-2`, `-3`, … as canonical decimals, so only unpadded numbers >= 2
 * count as ladder suffixes (`topic-1` and `topic-02` are distinct
 * intended slugs). Cross-directory same-stem is NOT a collision - Open Second Brain
 * never flattens paths on write. Brain-prefix allocations (pref-,
 * sig-, cap-, ret-) enter via their final basenames, without parsing
 * the prefix off. Lost-race `-2` pairs are reported deliberately: a
 * lost race and an accidental duplicate look identical from disk, and
 * the evidence mtimes let the operator decide.
 *
 * A group is reported only when its bare-base member (attempt 1) is
 * present: the ladder cannot produce `-2` without first finding the bare
 * base occupied, so `chapter-2.md` beside `chapter-3.md` is a numbered
 * series, not a collision. Date-named notes (`2026-09-10.md`) are whole
 * slugs, never a `2026-09` stem with a `-10` attempt, so a month of
 * daily notes reports nothing.
 *
 * Accepted imprecision: a file whose slug ends in bare digits (e.g. an
 * `unnamed-<hash>` fallback with an all-digit hash, or a note literally
 * named `report-42`) is grouped with the file named by its stripped
 * stem when that file exists. Distinguishing those from real ladder
 * continuations would mean re-running allocation logic here - the one
 * thing this detector refuses to do - so the group is reported at `info`
 * and the operator decides.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { listVaultNotePaths, slugify } from "../../../vault.ts";
import { pathStem } from "../../../fs-utils.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

/** A group smaller than this is one page under one stem - no collision. */
export const COLLISION_GROUP_MIN_SIZE = 2;

/**
 * First SUFFIXED ladder attempt: `collisionCandidateName` ladders the
 * bare base at attempt 1 and appends `-2`, `-3`, … from attempt 2 on.
 */
const LADDER_MIN_ATTEMPT = 2;

/** The bare-base attempt: the ladder's first try, with no suffix. */
const LADDER_BASE_ATTEMPT = 1;

/** A calendar-date slug (`YYYY-MM-DD`): a whole name, never stem plus attempt. */
const DATE_SLUG_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Suffix run the ladder appends: `-<attempt>`. */
const LADDER_SUFFIX_RE = /-([0-9]+)$/;

/** Directory label in evidence/title for pages at the vault root. */
const VAULT_ROOT_DIRECTORY = ".";

/**
 * A note name parsed against the allocation ladder: the slug stem it
 * was allocated under and the attempt it encodes - 1 for the bare base,
 * `n` for `-n`. Names that are not ladder continuations (`topic-1`,
 * zero-padded `topic-02`, suffix runs the ladder cannot emit) parse as
 * attempt 1 under their whole slug.
 */
interface SlugLadderParts {
  readonly stem: string;
  readonly attempt: number;
}

function splitLadderSuffix(slug: string): SlugLadderParts {
  const whole = { stem: slug, attempt: LADDER_BASE_ATTEMPT };
  if (DATE_SLUG_RE.test(slug)) return whole;
  const match = LADDER_SUFFIX_RE.exec(slug);
  if (match === null) return whole;
  const suffix = match[1]!;
  const attempt = Number.parseInt(suffix, 10);
  if (attempt < LADDER_MIN_ATTEMPT) return whole;
  if (suffix.length > 1 && suffix.startsWith("0")) return whole;
  return { stem: slug.slice(0, match.index) || slug, attempt };
}

/** One group member: where it landed and which ladder attempt it encodes. */
interface StemMember {
  readonly path: string;
  readonly attempt: number;
}

interface SlugStemGroup {
  readonly directory: string;
  readonly stem: string;
  readonly members: StemMember[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group vault-relative note paths by (directory, slug stem). Both levels
 * are plain string keys; the returned list is sorted by directory then
 * stem so the finding order is deterministic regardless of walk order.
 */
function collectStemGroups(notes: ReadonlyArray<string>): SlugStemGroup[] {
  const byDirectory = new Map<string, Map<string, StemMember[]>>();
  for (const note of notes) {
    const segments = note.split("/");
    const directory = segments.length > 1 ? segments.slice(0, -1).join("/") : VAULT_ROOT_DIRECTORY;
    const { stem, attempt } = splitLadderSuffix(slugify(pathStem(note)));
    const stems = byDirectory.get(directory) ?? new Map();
    const members = stems.get(stem) ?? [];
    members.push({ path: note, attempt });
    stems.set(stem, members);
    byDirectory.set(directory, stems);
  }
  const groups: SlugStemGroup[] = [];
  for (const [directory, stems] of byDirectory) {
    for (const [stem, members] of stems) groups.push({ directory, stem, members });
  }
  return groups.toSorted(
    (a, b) => compareStrings(a.directory, b.directory) || compareStrings(a.stem, b.stem),
  );
}

/**
 * One finding per same-stem group of >= 2 pages within a directory that
 * includes the bare base.
 * Targets run in ladder order - the bare base first, then `-2`, `-3`,
 * …, ties broken by path - the order the allocation ladder produced
 * them in. Evidence carries the stem, the directory, and one mtime per
 * member in target order - the lost-race story lives in those mtimes.
 */
export function detectSlugCollisions(vault: string): ReadonlyArray<HygieneFinding> {
  const findings: HygieneFinding[] = [];
  for (const group of collectStemGroups(listVaultNotePaths(vault))) {
    if (group.members.length < COLLISION_GROUP_MIN_SIZE) continue;
    if (!group.members.some((member) => member.attempt === LADDER_BASE_ATTEMPT)) continue;
    const targets = group.members
      .toSorted((a, b) => a.attempt - b.attempt || compareStrings(a.path, b.path))
      .map((member) => member.path);
    findings.push(
      Object.freeze({
        id: hygieneFindingId("slug-collisions", targets),
        detector: "slug-collisions" as const,
        severity: "info" as const,
        title: `${targets.length} notes share the slug stem "${group.stem}" in ${group.directory}/`,
        targets: Object.freeze(targets),
        proposed_action: "review" as const,
        evidence: Object.freeze({
          stem: group.stem,
          directory: group.directory,
          mtimes: Object.freeze(
            targets.map((target) => statSync(join(vault, target)).mtime.toISOString()),
          ),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}
