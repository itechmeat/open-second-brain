/**
 * Frontmatter invariants of the three Brain record kinds.
 *
 * One reason to change: the record schema. Required fields, ISO-8601
 * timestamps, wikilink targets, the id-to-filename agreement, id
 * uniqueness across the store, and the classification of a parse
 * failure into a doctor code all follow from it.
 */

import { join } from "node:path";

import { extractWikilinks } from "../../vault.ts";
import { BrainParseError } from "../parse-error.ts";
import { brainDirs } from "../paths.ts";
import { BrainStatusFolderMismatchError, parsePreference, parseRetired } from "../preference.ts";
import { parseSignal } from "../signal.ts";
import { principleNeedsRepair } from "../text/sanitize-principle.ts";
import type { DoctorIssue } from "../types.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import type { DoctorCheck } from "./check.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import { readSweptDir, SWEEP_ORIGIN, type SweptPath } from "./unreadable-path.ts";

// ----- Signal check ---------------------------------------------------------

export const signalCheck: DoctorCheck = {
  failSoft: false,
  run({ vault, idIndex }, { issues, uncertain }) {
    const dirs = brainDirs(vault);
    const swept = recordSweep("signal", uncertain);
    for (const dir of [dirs.inbox, dirs.processed]) {
      forEachBrainFile(dir, "sig-", swept, (path, filename) => {
        try {
          const sig = parseSignal(path);
          registerId(idIndex, sig.id, path);
          checkIso(path, "created_at", sig.created_at, issues);
          const expectedId = filename.slice(0, -".md".length);
          if (sig.id !== expectedId) {
            issues.push({
              severity: "warning",
              code: "id-filename-mismatch",
              path,
              message: `signal id '${sig.id}' differs from filename basename '${expectedId}'`,
            });
          }
        } catch (err) {
          issues.push({
            severity: "error",
            code: "signal-invalid",
            path,
            message: (err as Error).message ?? String(err),
          });
        }
      });
    }
  },
};

// ----- Preference check -----------------------------------------------------

export const preferenceCheck: DoctorCheck = {
  failSoft: false,
  run({ vault, idIndex, knownBasenames }, { issues, uncertain }) {
    const dirs = brainDirs(vault);
    forEachBrainFile(dirs.preferences, "pref-", recordSweep("preference", uncertain), (path) => {
      try {
        const pref = parsePreference(path);
        registerId(idIndex, pref.id, path);
        checkIso(path, "created_at", pref.created_at, issues);
        checkIso(path, "unconfirmed_until", pref.unconfirmed_until, issues);
        if (pref.confirmed_at !== null) {
          checkIso(path, "confirmed_at", pref.confirmed_at, issues);
        }
        if (pref.last_evidence_at !== null) {
          checkIso(path, "last_evidence_at", pref.last_evidence_at, issues);
        }
        // Status invariant — the parser already enforces the canonical
        // values via the enum; a non-canonical value would have thrown
        // BrainStatusFolderMismatchError, caught below. Reaching here
        // means the status is valid; nothing more to check.
        checkWikilinks(path, "evidenced_by", pref.evidenced_by, knownBasenames, issues);
        if (pref.supersedes) {
          checkWikilinks(path, "supersedes", [pref.supersedes], knownBasenames, issues);
        }
        // Principle corruption (token-diet, t_40eb1de7): leaked tool-call
        // fragments or escape-amplified quote chains written before the
        // sanitizing write seam shipped. `o2b brain upgrade --apply`
        // repairs these in place.
        if (principleNeedsRepair(pref.principle)) {
          issues.push({
            severity: "warning",
            code: "principle-corrupted",
            path,
            message:
              "principle carries leaked tool-call fragments or escape-amplified quotes; run `o2b brain upgrade --apply` to repair",
          });
        }
      } catch (err) {
        classifyParseError(err, path, "preference", issues);
      }
    });
  },
};

// ----- Retired check --------------------------------------------------------

export const retiredCheck: DoctorCheck = {
  failSoft: false,
  run({ vault, idIndex, knownBasenames }, { issues, uncertain }) {
    const dirs = brainDirs(vault);
    forEachBrainFile(dirs.retired, "ret-", recordSweep("retired", uncertain), (path) => {
      try {
        const ret = parseRetired(path);
        registerId(idIndex, ret.id, path);
        checkIso(path, "created_at", ret.created_at, issues);
        checkIso(path, "retired_at", ret.retired_at, issues);
        if (ret.last_evidence_at !== null) {
          checkIso(path, "last_evidence_at", ret.last_evidence_at, issues);
        }
        checkWikilinks(path, "evidenced_by", ret.evidenced_by, knownBasenames, issues);
        checkWikilinks(path, "retired_by", [ret.retired_by], knownBasenames, issues);
        if (ret.superseded_by) {
          checkWikilinks(path, "superseded_by", [ret.superseded_by], knownBasenames, issues);
        }
      } catch (err) {
        classifyParseError(err, path, "retired", issues);
      }
    });
  },
};

// ----- Duplicate id ---------------------------------------------------------

/**
 * Two distinct files claiming one frontmatter id. Reads the index the
 * three record checks filled, so it has to run after them.
 */
export const duplicateIdCheck: DoctorCheck = {
  failSoft: false,
  run({ idIndex }, { issues }) {
    for (const [id, paths] of idIndex.entries()) {
      if (paths.length > 1) {
        issues.push({
          severity: "error",
          code: "duplicate-id",
          message: `duplicate id '${id}' across files: ${paths.join(", ")}`,
        });
      }
    }
  },
};

// ----- Helpers --------------------------------------------------------------

function registerId(idIndex: Map<string, string[]>, id: string, path: string): void {
  const list = idIndex.get(id);
  if (list) list.push(path);
  else idIndex.set(id, [path]);
}

/** Subsystem name a record sweep reports an unreadable directory under. */
const RECORD_SITE = "brain.doctor.records";

/** What a record kind's checks can no longer claim, as one clause. */
function recordSweep(kind: string, uncertain: DoctorUncertainEntry[]): SweptPath {
  return {
    site: RECORD_SITE,
    consequence:
      `no ${kind} record in it was validated, so a malformed one - or an id it duplicates - ` +
      "is missing from this report",
    uncertain,
  };
}

/**
 * Iterate the `<prefix>*.md` files directly inside `dir` (non-recursive),
 * invoking `cb(path, filename)` for each. Absent `dir` is a no-op - the
 * per-kind checks all treat a missing Brain subdirectory as "nothing to
 * check", not an error.
 *
 * A directory that exists and cannot be listed is neither: these checks
 * are the pass's structural core and do not fail soft, so an unreadable
 * `Brain/preferences` used to end the run with no findings whatsoever.
 * It is now the same uncertainty every other sweep reports.
 */
function forEachBrainFile(
  dir: string,
  prefix: string,
  swept: SweptPath,
  cb: (path: string, filename: string) => void,
): void {
  const entries = readSweptDir(dir, swept, SWEEP_ORIGIN.root);
  if (entries === null) return;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith(prefix)) continue;
    cb(join(dir, entry.name), entry.name);
  }
}

/** Record kinds whose parse failures this module classifies. */
type ParsedRecordKind = "preference" | "retired";

const PREFERENCE_MISSING_FIELD_CODE = "preference-missing-field";
const PREFERENCE_INVALID_CODE = "preference-invalid";
const RETIRED_MISSING_FIELD_CODE = "retired-missing-field";
const RETIRED_INVALID_CODE = "retired-invalid";
const ISO_INVALID_CODE = "iso-invalid";

/**
 * The parse-failure codes, per record kind, written out.
 *
 * These four used to be built by concatenating the kind onto a suffix,
 * which meant they appeared nowhere in this module as readable strings -
 * so the doctor's own code population could not be enumerated from its
 * source, and the exit census (`tests/core/brain/doctor-exit-census.test.ts`)
 * could not see them to demand a classification.
 */
const PARSE_ERROR_CODES: Readonly<
  Record<ParsedRecordKind, { readonly missingField: string; readonly invalid: string }>
> = Object.freeze({
  preference: Object.freeze({
    missingField: PREFERENCE_MISSING_FIELD_CODE,
    invalid: PREFERENCE_INVALID_CODE,
  }),
  retired: Object.freeze({
    missingField: RETIRED_MISSING_FIELD_CODE,
    invalid: RETIRED_INVALID_CODE,
  }),
});

/** Which of the three parse-failure codes `msg` from `kind` reports. */
function parseErrorCode(kind: ParsedRecordKind, msg: string): string {
  if (/missing field/.test(msg)) return PARSE_ERROR_CODES[kind].missingField;
  if (/ISO-8601/i.test(msg)) return ISO_INVALID_CODE;
  return PARSE_ERROR_CODES[kind].invalid;
}

/**
 * Classify a parse-time error into a `DoctorIssue` and push it. Shared by
 * the preference and retired checks, which previously carried
 * byte-identical copies of this regex-based classification - a change to
 * a parser's error wording would otherwise reclassify issues in one path
 * without the other noticing.
 *
 * A {@link BrainParseError} - which both parsers now raise, and which
 * `BrainStatusFolderMismatchError` extends - reports its location from
 * the `path` field and its prose from `detail`, which carries none. The
 * human renderer appends ` (<path>)` from the issue's own field, so a
 * message that embedded the path as well named the file twice on every
 * parse-error line: prose carrying data the record already holds. An
 * untyped throw (a frontmatter read, a vocabulary guard owned by another
 * module) keeps its message verbatim against the walked path - that
 * message is not ours to shorten.
 *
 * What changed for a caller that prints `(exc as Error).message` bare,
 * stated exactly: a throw site whose message already carried the path
 * composes the same sentence as before, the status-folder mismatch
 * included (it supplies its own composition, keeping the location inside
 * the `(path=…, status=…, folder=…)` group). The four optional-field
 * helpers in `preference.ts` carried no location at all and now do -
 * a gain, and the only wording change in the set.
 */
function classifyParseError(
  err: unknown,
  path: string,
  kindPrefix: ParsedRecordKind,
  issues: DoctorIssue[],
): void {
  if (err instanceof BrainStatusFolderMismatchError) {
    issues.push({
      severity: "warning",
      code: "status-folder-mismatch",
      path: err.path,
      message: err.detail,
    });
    return;
  }
  const typed = err instanceof BrainParseError ? err : null;
  const msg = typed ? typed.detail : ((err as Error).message ?? String(err));
  issues.push({
    severity: "error",
    code: parseErrorCode(kindPrefix, msg),
    path: typed ? typed.path : path,
    message: msg,
  });
}

// ISO-8601 UTC: YYYY-MM-DDTHH:MM:SS(.fff)?Z. Lenient — we accept the
// shorter date-only form too (created_at is sometimes a date-only string
// in hand-authored signals).
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;

function checkIso(path: string, field: string, value: string, issues: DoctorIssue[]): void {
  if (!ISO_RE.test(value)) {
    issues.push({
      severity: "error",
      code: ISO_INVALID_CODE,
      path,
      message: `field '${field}' is not a valid ISO-8601 timestamp: ${JSON.stringify(value)}`,
    });
    return;
  }
  // Confirm the calendar date is real (Date.parse accepts garbage on
  // some engines — but verifying via Date round-trip catches it).
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    issues.push({
      severity: "error",
      code: ISO_INVALID_CODE,
      path,
      message: `field '${field}' could not be parsed as a date: ${JSON.stringify(value)}`,
    });
  }
}

function checkWikilinks(
  path: string,
  field: string,
  values: ReadonlyArray<string>,
  knownBasenames: ReadonlySet<string>,
  issues: DoctorIssue[],
): void {
  for (const raw of values) {
    if (!raw) continue;
    // Extract any wikilinks via the shared parser. A bare `[[target]]`
    // produces one match; an already-stripped basename produces zero,
    // in which case we treat the raw string itself as the candidate.
    const matches = extractWikilinks(raw);
    const candidates = matches.length > 0 ? matches : [raw];
    for (const candidate of candidates) {
      const target = normaliseWikilinkTarget(candidate);
      if (!target) continue;
      if (!knownBasenames.has(target)) {
        issues.push({
          severity: "warning",
          code: "broken-wikilink",
          path,
          // no-dead-ends, task 12: the field and the target ride as
          // fields as well as inside the sentence, so a consumer acts on
          // values rather than on a regex over prose. The message is
          // unchanged - the human surface still reads it.
          field,
          target,
          message: `field '${field}' references missing basename '${target}'`,
        });
      }
    }
  }
}
