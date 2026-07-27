/**
 * Brain-managed wikilink targets that resolve to no file.
 *
 * The record checks validate the links a record DECLARES in its
 * frontmatter; this one reads the backlink index, so it also sees the
 * references buried in body prose and in the log.
 */

import { buildBacklinkIndex } from "../backlinks.ts";
import { brainDirs } from "../paths.ts";
import { isBrainArtifactId } from "../wikilink.ts";
import type { DoctorCheck } from "./check.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import { reportSweptFailure, sweptFailurePath, SWEEP_ORIGIN } from "./unreadable-path.ts";

/**
 * 8. Broken-backlinks lint — any preference / retired / log entry
 *    that wikilinks to a Brain artifact id (`pref-...`, `ret-...`,
 *    `sig-...`) whose file no longer exists. Surfaces at warning
 *    severity: a dangling reference is a real data-hygiene problem
 *    but doesn't block the dream loop, so the digest / cron want
 *    to see it without failing the run.
 */
export const brokenBacklinkCheck: DoctorCheck = {
  failSoft: false,
  run({ vault, knownBasenames }, { issues, uncertain }) {
    // Only attempt the check when there's something to scan — an empty
    // Brain layer naturally has no backlinks, and `buildBacklinkIndex`
    // would already return an empty map, but we save the parse pass.
    if (knownBasenames.size === 0) return;
    const index = buildIndex(vault, uncertain);
    if (index === null) return;
    for (const [target, refs] of index) {
      // We only flag references whose target *should* live in this
      // Brain (i.e. an artifact id we manage). Wikilinks pointing
      // outside the Brain layer are user prose and not our concern.
      if (!isBrainArtifactId(target)) continue;
      if (knownBasenames.has(target)) continue;
      const sources = Array.from(new Set(refs.map((r) => r.source))).toSorted();
      issues.push({
        severity: "warning",
        code: "broken-backlinks",
        // no-dead-ends, task 12. This issue has no `path` - the whole
        // finding is that no file with this basename exists - so before
        // these fields the referencing sources were reachable only by
        // splitting the tail of the sentence on ", ". The message keeps
        // them too; the human surface is unchanged.
        target,
        sources,
        message:
          `[[${target}]] is referenced by ${sources.length} source(s) but no file with that ` +
          `basename exists under Brain/: ${sources.join(", ")}`,
      });
    }
  },
};

/** Subsystem name the backlink index reports an unreadable path under. */
const BACKLINK_SITE = "brain.doctor.brokenBacklinks";

/**
 * The backlink index, or `null` plus the reason there is none.
 *
 * The index walks the record directories and the log through a shared
 * builder, so a directory it cannot read arrives here as a throw. This
 * check does not fail soft - a backlink index the doctor mis-reads
 * leaves the report wrong rather than incomplete - so before this the
 * throw ended the pass, with every finding already collected lost with
 * it. A directory that was not read is a different statement from a
 * store whose links are all resolvable, and it is the one this makes.
 */
function buildIndex(
  vault: string,
  uncertain: DoctorUncertainEntry[],
): ReturnType<typeof buildBacklinkIndex> | null {
  try {
    return buildBacklinkIndex(vault);
  } catch (err) {
    reportSweptFailure(
      sweptFailurePath(err, brainDirs(vault).brain),
      "backlink index build failed",
      err,
      {
        site: BACKLINK_SITE,
        consequence:
          "no backlink in the store was resolved, so a reference to a deleted artifact is " +
          "missing from this report",
        uncertain,
      },
      SWEEP_ORIGIN.root,
    );
    return null;
  }
}
