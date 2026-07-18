/**
 * A4 (t_f79b4fe0): write-time conflict advisory seam.
 *
 * When an operator records a feedback signal, this seam compares the
 * incoming principle against confirmed same-scope preferences and, when a
 * near-duplicate is found, returns a non-blocking advisory naming the
 * resembling preference ids. The advisory is surfaced in the feedback
 * response / CLI output and logged under a dedicated event kind.
 *
 * Two invariants, straight from the design doc:
 *
 *   - The write ALWAYS proceeds. This helper runs AROUND the write and
 *     never gates it. Advisory computation is best-effort: a failure
 *     (e.g. an unreadable preferences dir) degrades to a visible stderr
 *     warning and a `null` result, never a swallowed exception and never a
 *     failed feedback call.
 *   - The advisory fires only on the operator-facing feedback path, NOT
 *     inside `routeExtractedFacts`, so the extracted-fact path and the
 *     feedback path never double-fire on a single write.
 *
 * Only the incoming signal's scope bucket is read (confirmed preferences
 * whose scope matches the incoming scope; an unscoped signal compares
 * against the unscoped bucket), mirroring `detectContradictions`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { adviseOnIncoming, type PreferenceForContradiction } from "./health/contradiction.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "./types.ts";

/** One resembling preference: its id and the incoming-vs-confirmed jaccard. */
export interface WriteConflictEvidence {
  readonly pref_id: string;
  readonly jaccard: number;
}

/**
 * The advisory surfaced to the feedback response / CLI output. Present
 * only when at least one confirmed same-scope preference clears the
 * similarity threshold.
 */
export interface WriteConflictAdvisory {
  /** The scope bucket compared against; `null` for the unscoped bucket. */
  readonly scope: string | null;
  /** Non-empty, sorted by descending similarity then id. */
  readonly conflicts: ReadonlyArray<WriteConflictEvidence>;
}

export interface AdviseIncomingFeedbackParams {
  /** The incoming feedback principle to compare. */
  readonly principle: string;
  /** The signal's effective scope (already resolved against the default). */
  readonly scope?: string;
  /** Agent identity stamped on the advisory log event. */
  readonly agent: string;
  /** Injected clock for a deterministic log timestamp. Defaults to now. */
  readonly now?: Date;
}

/**
 * Load the confirmed preferences in the incoming signal's scope bucket.
 * Scope-bucket loading only: preferences in a different scope (and every
 * non-confirmed preference) are dropped here rather than compared. A
 * corrupt / mis-foldered preference file is skipped (that is the doctor's
 * concern, not the write path's).
 */
function loadConfirmedScopePrefs(
  vault: string,
  scope: string | undefined,
): PreferenceForContradiction[] {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const bucketKey = scope ?? "";
  const out: PreferenceForContradiction[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    let pref;
    try {
      pref = parsePreference(join(dir, name));
    } catch {
      continue;
    }
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    if ((pref.scope ?? "") !== bucketKey) continue;
    out.push(pref);
  }
  return out;
}

/**
 * Compute (and log) the write-time conflict advisory for an incoming
 * feedback signal. Returns the advisory when a confirmed same-scope
 * preference resembles the incoming principle, otherwise `null`.
 *
 * Never throws: any failure is reported as a stderr warning and returns
 * `null`, so the surrounding feedback write is never affected.
 */
export function adviseIncomingFeedback(
  vault: string,
  params: AdviseIncomingFeedbackParams,
): WriteConflictAdvisory | null {
  try {
    const prefs = loadConfirmedScopePrefs(vault, params.scope);
    const advisory = adviseOnIncoming(params.principle, params.scope, prefs);
    if (advisory === null) return null;

    const result: WriteConflictAdvisory = {
      scope: advisory.scope,
      conflicts: advisory.conflicts.map((c) => ({ pref_id: c.prefId, jaccard: c.jaccard })),
    };

    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(params.now ?? new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.writeConflictAdvisory,
        agent: params.agent,
        body: {
          scope: advisory.scope ?? "(unscoped)",
          // One bullet per resembling preference: wikilink + similarity, so
          // the audit row is both human-readable and grep-friendly.
          conflicts: result.conflicts.map(
            (c) => `[[${c.pref_id}]] jaccard=${c.jaccard.toFixed(3)}`,
          ),
          agent: params.agent,
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append write-conflict-advisory log failed: ${(err as Error).message}\n`,
      );
    }

    return result;
  } catch (err) {
    // Advisory computation is best-effort and NEVER blocks the write.
    process.stderr.write(
      `warning: write-conflict advisory computation failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}
