/**
 * Dangling `merged_into:` pointers (t_ff8bb8a8).
 *
 * A page that was de-canonicalised points at its canonical through a
 * `merged_into:` field, and every duplicate detector asks the
 * pointer-presence question (`isMergeResolved`, GitHub #180) - so a page
 * whose canonical was later deleted is excluded from dedup candidacy
 * forever, and nothing named why. `o2b brain lint --consolidate` walks
 * the same chains, but a DANGLING terminal resolves silently there
 * (`resolveCanonicalId` returns it without throwing); only CYCLE, DEPTH
 * and a malformed intermediate throw and surface as unresolvable links.
 * The dangling class is the one this check owns, and it is
 * deliberately the ONLY one it reports: the throwing classes already
 * have a visible surface in lint's unresolved list, and a second code
 * for them would duplicate a finding an operator can already see.
 *
 * The finding is reporting-only. The repair is a content judgement -
 * re-point the page at a surviving canonical, remove the pointer to
 * un-merge, or restore the deleted canonical - which is recorded as an
 * exclusion row in `doctor-exits.ts` rather than as a next command, and
 * no fixer exists for it.
 *
 * The check has its own read pass over `Brain/preferences/` and
 * `Brain/retired/`, the pointer namespace: the shared context holds
 * parsed preference records only (the retired records are not on it at
 * all), and what this check needs is the set of pointer-carrying page
 * ids in both directories, which nothing else resolves. Unreadable
 * directories degrade per the sweep-sink convention: named in the
 * uncertain stream with what consequently went unaudited, never
 * silently empty. Per-file read and parse failures stay silent here,
 * exactly as in the record snapshots - a file whose frontmatter is
 * wrong is already a finding of the record checks, and a chain through
 * it ends at that file, which exists.
 */

import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";
import { pageIdToPath, readMergedInto, reportMergeChain } from "../page-meta/page-id.ts";
import type { DoctorCheck } from "./check.ts";
import { readSweptDir, SWEEP_ORIGIN, type SweptPath } from "./unreadable-path.ts";
import type { DoctorIssue } from "../types.ts";

/** Stable code: a `merged_into:` pointer whose target has no file. */
export const MERGE_CHAIN_DANGLING_CODE = "merge-chain-dangling";

/** Subsystem name the check reports an unreadable directory under. */
const MERGE_CHAIN_SITE = "brain.doctor.mergeChain";

/** Filename prefix of a preference page; also its page-id prefix. */
const PREFERENCE_ID_PREFIX = "pref-";

/** Filename prefix of a retired page; also its page-id prefix. */
const RETIRED_ID_PREFIX = "ret-";

/** Extension every Brain record file carries. */
const MARKDOWN_EXT = ".md";

/** The frontmatter field the merge graph lives in. */
const MERGED_INTO_FIELD = "merged_into";

/** What one dangling pointer leaves the operator unable to do. */
const DEDUP_EXCLUSION_CONSEQUENCE =
  "this page is excluded from dedup candidacy until the pointer is resolved";

export const mergeChainDanglingCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues, uncertain }) {
    const dirs = brainDirs(vault);
    const swept: SweptPath = {
      site: MERGE_CHAIN_SITE,
      consequence:
        "no merged_into pointer under it was read, so a page whose canonical is gone can be " +
        "missing from this report",
      uncertain,
    };
    const carriers = [
      ...scanPointerCarriers(dirs.preferences, swept),
      ...scanPointerCarriers(dirs.retired, swept),
    ];

    // One finding per dangling POINTER, keyed by the page that carries it
    // and the target it names. Walking each carrier's full chain re-derives
    // a carrier's own finding from every upstream walk, so the key is what
    // keeps the report to the set of pointers that are actually dead.
    const reported = new Set<string>();
    const findings: DoctorIssue[] = [];
    for (const id of carriers) {
      const report = reportMergeChain(vault, id);
      // DEPTH/CYCLE/MALFORMED are lint's unresolvable classes; a resolved
      // chain is a merge that finished. Only a dead terminal is ours.
      if (report.outcome !== "dangling") continue;
      // A dangling verdict on a one-id walk means the start page carries no
      // pointer at all - there is no pointer of ours to name.
      if (report.visited.length < 2) continue;
      const carrier = report.visited[report.visited.length - 2]!;
      const target = report.at;
      const key = `${carrier} ${target}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const path = pageIdToPath(vault, carrier);
      findings.push({
        severity: "warning",
        code: MERGE_CHAIN_DANGLING_CODE,
        ...(path !== null ? { path } : {}),
        field: MERGED_INTO_FIELD,
        target,
        message:
          `merged_into -> ${target}, but no file exists for ${target}; ` +
          DEDUP_EXCLUSION_CONSEQUENCE,
      });
    }
    // Discovery order follows the scan, which follows the directory reads;
    // sorting by the named page keeps the report stable regardless.
    findings.sort(
      (a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.target!.localeCompare(b.target!),
    );
    issues.push(...findings);
  },
};

/**
 * The ids of the pages in `dir` that carry a `merged_into:` pointer.
 *
 * Directory-shaped failures go to the sweep sink and read as none;
 * file-shaped ones - a page that will not parse - are omitted, on the
 * records.ts convention that a schema error is the record checks'
 * finding to report and a vanished file is a race the next pass reads
 * differently.
 */
function scanPointerCarriers(dir: string, swept: SweptPath): ReadonlyArray<string> {
  const entries = readSweptDir(dir, swept, SWEEP_ORIGIN.root);
  if (entries === null) return [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(MARKDOWN_EXT)) continue;
    const id = entry.name.slice(0, -MARKDOWN_EXT.length);
    if (!id.startsWith(PREFERENCE_ID_PREFIX) && !id.startsWith(RETIRED_ID_PREFIX)) continue;
    try {
      const [meta] = parseFrontmatter(join(dir, entry.name));
      if (readMergedInto(meta) !== null) ids.push(id);
    } catch {
      // schema error — reported by the preference/retired record checks
    }
  }
  return ids;
}
