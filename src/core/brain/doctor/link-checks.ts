/**
 * Brain-managed wikilink targets that resolve to no file.
 *
 * The record checks validate the links a record DECLARES in its
 * frontmatter; this one reads the backlink index, so it also sees the
 * references buried in body prose and in the log.
 */

import { buildBacklinkIndex } from "../backlinks.ts";
import { isBrainArtifactId } from "../wikilink.ts";
import type { DoctorCheck } from "./check.ts";

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
  run({ vault, knownBasenames }, { issues }) {
    // Only attempt the check when there's something to scan — an empty
    // Brain layer naturally has no backlinks, and `buildBacklinkIndex`
    // would already return an empty map, but we save the parse pass.
    if (knownBasenames.size === 0) return;
    const index = buildBacklinkIndex(vault);
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
