/**
 * A4 (t_f79b4fe0): write-time conflict advisory seam.
 *
 * Two advisories live here, both built to the same shape: computed
 * AROUND an operator-facing feedback write, never gating it, returned as
 * a structured value the CLI and MCP surfaces render, and recorded under
 * its own log-event kind so what fired stays countable.
 *
 *   - {@link adviseIncomingFeedback} - the incoming principle resembles a
 *     confirmed same-scope preference (t_f79b4fe0).
 *   - {@link adviseUnroutableCapture} - the capture resolved NO scope, so
 *     it lands in the one bucket scoped recall never reaches
 *     (signals-that-survive, unit 4 / t_75597bb9).
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
import { nextCommandField, requireNextStep, type NextCommandField } from "./next-step.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "./types.ts";

/** Extension every Brain corpus document on disk carries. */
const MARKDOWN_EXT = ".md";

/** Bucket key standing for "carries no scope", shared with `adviseOnIncoming`. */
const UNSCOPED_BUCKET = "";

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

/** The Markdown documents in `dir`, or nothing when it does not exist. */
function markdownNames(dir: string): ReadonlyArray<string> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(MARKDOWN_EXT));
}

/**
 * Every confirmed preference in the vault. A corrupt / mis-foldered
 * preference file is skipped (that is the doctor's concern, not the write
 * path's).
 */
function loadConfirmedPrefs(vault: string): PreferenceForContradiction[] {
  const dir = brainDirs(vault).preferences;
  const out: PreferenceForContradiction[] = [];
  for (const name of markdownNames(dir)) {
    let pref;
    try {
      pref = parsePreference(join(dir, name));
    } catch {
      continue;
    }
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    out.push(pref);
  }
  return out;
}

/**
 * Load the confirmed preferences in the incoming signal's scope bucket.
 * Scope-bucket loading only: preferences in a different scope (and every
 * non-confirmed preference) are dropped here rather than compared.
 */
function loadConfirmedScopePrefs(
  vault: string,
  scope: string | undefined,
): PreferenceForContradiction[] {
  const bucketKey = scope ?? UNSCOPED_BUCKET;
  return loadConfirmedPrefs(vault).filter((pref) => (pref.scope ?? UNSCOPED_BUCKET) === bucketKey);
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

// ----- Unroutable-capture routing hint (unit 4, t_75597bb9) ----------------

/**
 * The routing signal a capture can be missing. Written once: it is the
 * signal frontmatter field, the flag name the exit command carries, and
 * the value the hint reports as absent.
 */
export const ROUTING_SIGNAL_FIELD = "scope";

/**
 * Registry code the routing hint's forward pointer resolves through. The
 * hint NAMES no command itself - the surfaces resolve this code, so the
 * exit is the registry's structural CLI string on every stream.
 */
export const CAPTURE_ROUTING_HINT_CODE = "capture-scope-absent";

/**
 * Resolved at module scope on purpose. This hint's whole value is telling
 * an operator how to route the capture, so an unregistered code is
 * registry drift rather than a case to handle: it fails at import instead
 * of inside the advisory it was meant to explain (see `next-step.ts`).
 */
const CAPTURE_ROUTING_HINT_STEP = requireNextStep(CAPTURE_ROUTING_HINT_CODE);

/** One scope slug the vault already uses, with the documents carrying it. */
export interface ScopeCandidate {
  readonly scope: string;
  /** Documents observed with this scope: its document frequency. */
  readonly documents: number;
}

/**
 * The routing hint surfaced to the feedback response / CLI output.
 * Present only when the capture resolved no scope AND the vault holds a
 * scope corpus to suggest from.
 */
export interface CaptureRoutingHint {
  /** The routing signal the capture lacked. */
  readonly missing_signal: string;
  /** Diagnostic code the surfaces resolve the forward pointer through. */
  readonly code: string;
  /** Non-empty, ranked by document frequency then slug. */
  readonly candidates: ReadonlyArray<ScopeCandidate>;
}

/**
 * The additive JSON key both machine-readable surfaces carry the hint
 * in, plus its forward pointer already resolved.
 *
 * Named and composed once for the same reason `NEXT_COMMAND_KEY` is: the
 * CLI `--json` renderer and its MCP twin must not drift on a spelling or
 * on which fields ride along. A consumer that learns the shape from one
 * surface reads it on the other.
 */
export const CAPTURE_ROUTING_HINT_KEY = "routing_hint";

export type CaptureRoutingHintField = {
  readonly [CAPTURE_ROUTING_HINT_KEY]?: CaptureRoutingHint & NextCommandField;
};

/** Absent case: no hint contributes no key whatsoever. */
const NO_CAPTURE_ROUTING_HINT: CaptureRoutingHintField = Object.freeze({});

/**
 * Resolve a hint into the object to spread onto a machine-readable
 * response. `null` yields the empty object, so the key is ABSENT rather
 * than present-and-null.
 */
export function captureRoutingHintField(hint: CaptureRoutingHint | null): CaptureRoutingHintField {
  if (hint === null) return NO_CAPTURE_ROUTING_HINT;
  return Object.freeze({
    [CAPTURE_ROUTING_HINT_KEY]: Object.freeze({ ...hint, ...nextCommandField(hint.code) }),
  });
}

export interface AdviseUnroutableCaptureParams {
  /**
   * The capture's effective scope (already resolved against
   * `feedback.default_scope`). Absent / blank is the unroutable case.
   */
  readonly scope?: string;
  /** Agent identity stamped on the hint log event. */
  readonly agent: string;
  /** Injected clock for a deterministic log timestamp. Defaults to now. */
  readonly now?: Date;
}

/**
 * Document frequency of every scope slug the vault declares.
 *
 * Two sources, both frontmatter: confirmed preferences (the rules scoped
 * recall actually reaches) and the OPEN signal inbox. The inbox is what
 * "recent" means structurally here - `inbox/processed/` is the archive
 * the dream pass has already consumed - so recency needs no window
 * constant and no clock.
 *
 * A corrupt signal is skipped, exactly as the conflict advisory skips a
 * corrupt preference - but the skip is REPORTED. Its scope is precisely
 * what could not be read, so it cannot be counted; leaving it silent
 * would change a ranking the operator reads with nothing to explain why.
 */
function countScopeDocuments(vault: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const tally = (scope: string | undefined): void => {
    const slug = scope?.trim();
    if (!slug) return;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  };
  for (const pref of loadConfirmedPrefs(vault)) tally(pref.scope);
  const inbox = brainDirs(vault).inbox;
  for (const name of markdownNames(inbox)) {
    const path = join(inbox, name);
    try {
      tally(parseSignal(path).scope);
    } catch (err) {
      process.stderr.write(
        `warning: capture routing hint skipped unreadable signal ${path}: ${
          (err as Error).message
        }\n`,
      );
    }
  }
  return counts;
}

/**
 * Compute the routing hint for a capture that resolved no scope. Returns
 * `null` when the capture IS routable, and when the vault has no scope
 * corpus to suggest from - an empty candidate list would be prose that
 * names nothing, which is the dead end this unit removes rather than adds.
 *
 * Never throws: any failure is reported as a stderr warning and returns
 * `null`, so the surrounding feedback write is never affected.
 */
export function adviseUnroutableCapture(
  vault: string,
  params: AdviseUnroutableCaptureParams,
): CaptureRoutingHint | null {
  if (params.scope?.trim()) return null;
  try {
    const candidates = [...countScopeDocuments(vault)]
      .map(([scope, documents]) => Object.freeze({ scope, documents }))
      .toSorted((a, b) => b.documents - a.documents || a.scope.localeCompare(b.scope));
    if (candidates.length === 0) return null;

    const result: CaptureRoutingHint = Object.freeze({
      missing_signal: ROUTING_SIGNAL_FIELD,
      code: CAPTURE_ROUTING_HINT_STEP.code,
      candidates: Object.freeze(candidates),
    });

    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(params.now ?? new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.captureRoutingHint,
        agent: params.agent,
        body: {
          missing_signal: result.missing_signal,
          // One bullet per eligible scope: slug + the document frequency
          // that ranked it, so the rate of unrouted captures AND what
          // they could have been routed to are both countable later.
          candidates: result.candidates.map((c) => `${c.scope} documents=${c.documents}`),
          agent: params.agent,
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append capture-routing-hint log failed: ${(err as Error).message}\n`,
      );
    }

    return result;
  } catch (err) {
    // Hint computation is best-effort and NEVER blocks the write.
    process.stderr.write(
      `warning: capture routing hint computation failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}
