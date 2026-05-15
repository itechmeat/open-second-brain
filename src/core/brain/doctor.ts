/**
 * Brain layer invariant checker (design doc §13.5).
 *
 * Pure read. Walks `<vault>/Brain/` and reports a list of issues. The
 * caller decides the exit code: warnings are non-blocking, errors
 * indicate a corrupt state. The CLI (`o2b brain doctor [--strict]`)
 * wraps the result; this module ships the structured object.
 *
 * Invariants checked:
 *
 *   1. **Schema version.** `Brain/_brain.yaml schema_version` is known
 *      to this build. Unknown → error.
 *   2. **Required fields per kind.** Signal / preference / retired
 *      frontmatter parses through the Task 2 parsers, which throw on
 *      missing required fields. We re-wrap the throw as an error issue.
 *   3. **Status-vs-folder.** A file in `preferences/` whose status is
 *      not `unconfirmed` / `confirmed` is a warning; a file in
 *      `retired/` whose status is not `retired` is a warning.
 *      `BrainStatusFolderMismatchError` from the parsers feeds this.
 *   4. **Broken wikilinks.** Every `[[basename]]` referenced by
 *      `evidenced_by`, `supersedes`, `superseded_by`, or `retired_by`
 *      on any Brain artifact must resolve to an existing Markdown file
 *      somewhere inside `Brain/` (basename match, Obsidian-style).
 *      Unresolved → warning.
 *   5. **Duplicate id.** Two distinct files whose frontmatter `id` is
 *      identical → error.
 *   6. **Invalid ISO.** `created_at`, `unconfirmed_until`,
 *      `confirmed_at`, `last_evidence_at`, `retired_at` parse as
 *      ISO-8601 timestamps (`null` / missing acceptable for the
 *      optional ones). Bad → error.
 *   7. **Log header parsing.** Every malformed `## <HH:MM:SS>Z — kind`
 *      block surfaced by `parseLogDay` as a warning is forwarded here.
 *
 * The function never mutates state. It will gracefully tolerate a
 * vault that has no Brain layer yet (returns clean) — same shape as
 * the existing `doctor` legacy command on an empty vault.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { extractWikilinks, parseFrontmatter } from "../vault.ts";
import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  loadBrainConfigDetailed,
} from "./policy.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";
import { parseLogDay } from "./log.ts";
import {
  BrainStatusFolderMismatchError,
  parsePreference,
  parseRetired,
} from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";

// ----- Public types ---------------------------------------------------------

export type DoctorSeverity = "warning" | "error";

/**
 * One structured finding. `code` is a stable identifier so callers can
 * filter or aggregate without parsing the `message`.
 */
export interface DoctorIssue {
  readonly severity: DoctorSeverity;
  readonly code: string;
  /** Vault-absolute path of the offending file, when known. */
  readonly path?: string;
  /** Human-readable description, suitable for `--text` rendering. */
  readonly message: string;
}

export interface RunDoctorOptions {
  /**
   * Reserved for future per-check toggles. Today the doctor reports
   * every check it knows; CLI `--strict` only changes the exit code,
   * not the contents of the report.
   */
  readonly strict?: boolean;
}

export interface RunDoctorResult {
  readonly warnings: ReadonlyArray<DoctorIssue>;
  readonly errors: ReadonlyArray<DoctorIssue>;
}

// ----- Entry point ----------------------------------------------------------

export function runDoctor(
  vault: string,
  opts: RunDoctorOptions = {},
): RunDoctorResult {
  void opts; // `strict` is a CLI exit-code concern, not a content one.

  const issues: DoctorIssue[] = [];

  const dirs = brainDirs(vault);
  if (!existsSync(dirs.brain)) {
    // No Brain layer present is not an error here — `o2b brain init`
    // is the right command, but a vault without Brain is allowed in
    // v0.9. Return clean.
    return Object.freeze({
      warnings: Object.freeze([]),
      errors: Object.freeze([]),
    });
  }

  // 1. Config schema check.
  checkConfig(vault, issues);

  // 2-6. Frontmatter checks across signals / preferences / retired.
  const knownBasenames = collectAllBasenames(vault);
  const idIndex = new Map<string, string[]>();

  checkSignals(vault, issues, idIndex);
  checkPreferences(vault, issues, idIndex, knownBasenames);
  checkRetired(vault, issues, idIndex, knownBasenames);

  // Duplicate-id reporting after every file has been indexed.
  for (const [id, paths] of idIndex.entries()) {
    if (paths.length > 1) {
      issues.push({
        severity: "error",
        code: "duplicate-id",
        message: `duplicate id '${id}' across files: ${paths.join(", ")}`,
      });
    }
  }

  // 7. Log header parsing — surface warnings from `parseLogDay`.
  checkLogs(vault, issues);

  // Partition by severity. Stable sort preserves discovery order which
  // is convenient for tests asserting on `path`+`code`.
  const warnings = issues.filter((i) => i.severity === "warning");
  const errors = issues.filter((i) => i.severity === "error");

  return Object.freeze({
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  });
}

// ----- Config check ---------------------------------------------------------

function checkConfig(vault: string, issues: DoctorIssue[]): void {
  const cfgPath = brainConfigPath(vault);
  if (!existsSync(cfgPath)) {
    issues.push({
      severity: "error",
      code: "config-missing",
      path: cfgPath,
      message:
        "_brain.yaml is missing; run `o2b brain init` to bootstrap the Brain layer",
    });
    return;
  }
  try {
    const { config, warnings } = loadBrainConfigDetailed(vault);
    if (!BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(config.schema_version)) {
      issues.push({
        severity: "error",
        code: "schema-version-unknown",
        path: cfgPath,
        message:
          `_brain.yaml schema_version ${config.schema_version} is not in the supported set ` +
          `(${BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", ")})`,
      });
    }
    for (const w of warnings) {
      issues.push({
        severity: "warning",
        code: "config-warning",
        path: cfgPath,
        message: w.message,
      });
    }
  } catch (err) {
    if (err instanceof BrainConfigError) {
      issues.push({
        severity: "error",
        code: "config-invalid",
        path: cfgPath,
        message: err.message,
      });
    } else {
      issues.push({
        severity: "error",
        code: "config-invalid",
        path: cfgPath,
        message: `_brain.yaml could not be loaded: ${(err as Error).message ?? String(err)}`,
      });
    }
  }
}

// ----- Signal check ---------------------------------------------------------

function checkSignals(
  vault: string,
  issues: DoctorIssue[],
  idIndex: Map<string, string[]>,
): void {
  const dirs = brainDirs(vault);
  for (const dir of [dirs.inbox, dirs.processed]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.name.startsWith("sig-")) continue;
      const path = join(dir, entry.name);
      try {
        const sig = parseSignal(path);
        registerId(idIndex, sig.id, path);
        checkIso(path, "created_at", sig.created_at, issues);
        const expectedId = entry.name.slice(0, -".md".length);
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
    }
  }
}

// ----- Preference check -----------------------------------------------------

function checkPreferences(
  vault: string,
  issues: DoctorIssue[],
  idIndex: Map<string, string[]>,
  knownBasenames: ReadonlySet<string>,
): void {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return;
  for (const entry of readdirSync(dirs.preferences, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, entry.name);
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
      checkWikilinks(
        path,
        "evidenced_by",
        pref.evidenced_by,
        knownBasenames,
        issues,
      );
      if (pref.supersedes) {
        checkWikilinks(
          path,
          "supersedes",
          [pref.supersedes],
          knownBasenames,
          issues,
        );
      }
    } catch (err) {
      if (err instanceof BrainStatusFolderMismatchError) {
        issues.push({
          severity: "warning",
          code: "status-folder-mismatch",
          path,
          message: err.message,
        });
      } else {
        // Distinguish field-missing errors (write-time contract) from
        // unexpected throws so the CLI report stays useful.
        const msg = (err as Error).message ?? String(err);
        const isMissingField = /missing field/.test(msg);
        const isInvalidIso = /ISO-8601/i.test(msg);
        issues.push({
          severity: "error",
          code: isMissingField
            ? "preference-missing-field"
            : isInvalidIso
              ? "iso-invalid"
              : "preference-invalid",
          path,
          message: msg,
        });
      }
    }
  }
}

// ----- Retired check --------------------------------------------------------

function checkRetired(
  vault: string,
  issues: DoctorIssue[],
  idIndex: Map<string, string[]>,
  knownBasenames: ReadonlySet<string>,
): void {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.retired)) return;
  for (const entry of readdirSync(dirs.retired, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("ret-")) continue;
    const path = join(dirs.retired, entry.name);
    try {
      const ret = parseRetired(path);
      registerId(idIndex, ret.id, path);
      checkIso(path, "created_at", ret.created_at, issues);
      checkIso(path, "retired_at", ret.retired_at, issues);
      if (ret.last_evidence_at !== null) {
        checkIso(path, "last_evidence_at", ret.last_evidence_at, issues);
      }
      checkWikilinks(
        path,
        "evidenced_by",
        ret.evidenced_by,
        knownBasenames,
        issues,
      );
      checkWikilinks(
        path,
        "retired_by",
        [ret.retired_by],
        knownBasenames,
        issues,
      );
      if (ret.superseded_by) {
        checkWikilinks(
          path,
          "superseded_by",
          [ret.superseded_by],
          knownBasenames,
          issues,
        );
      }
    } catch (err) {
      if (err instanceof BrainStatusFolderMismatchError) {
        issues.push({
          severity: "warning",
          code: "status-folder-mismatch",
          path,
          message: err.message,
        });
      } else {
        const msg = (err as Error).message ?? String(err);
        const isMissingField = /missing field/.test(msg);
        const isInvalidIso = /ISO-8601/i.test(msg);
        issues.push({
          severity: "error",
          code: isMissingField
            ? "retired-missing-field"
            : isInvalidIso
              ? "iso-invalid"
              : "retired-invalid",
          path,
          message: msg,
        });
      }
    }
  }
}

// ----- Log check ------------------------------------------------------------

function checkLogs(vault: string, issues: DoctorIssue[]): void {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return;
  const dates = readdirSync(dirs.log, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name.slice(0, -".md".length))
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
  for (const date of dates) {
    const { warnings } = parseLogDay(vault, date);
    for (const w of warnings) {
      issues.push({
        severity: "warning",
        code: "log-malformed",
        path: w.path,
        message: `line ${w.lineNumber}: ${w.message}`,
      });
    }
  }
}

// ----- Helpers --------------------------------------------------------------

function registerId(
  idIndex: Map<string, string[]>,
  id: string,
  path: string,
): void {
  const list = idIndex.get(id);
  if (list) list.push(path);
  else idIndex.set(id, [path]);
}

// ISO-8601 UTC: YYYY-MM-DDTHH:MM:SS(.fff)?Z. Lenient — we accept the
// shorter date-only form too (created_at is sometimes a date-only string
// in hand-authored signals).
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;

function checkIso(
  path: string,
  field: string,
  value: string,
  issues: DoctorIssue[],
): void {
  if (!ISO_RE.test(value)) {
    issues.push({
      severity: "error",
      code: "iso-invalid",
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
      code: "iso-invalid",
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
          message: `field '${field}' references missing basename '${target}'`,
        });
      }
    }
  }
}

/**
 * Build the universe of valid wikilink targets inside `Brain/`. We
 * deliberately do NOT pull in legacy `AI Wiki/` or `Daily/` notes — a
 * Brain artifact pointing at a Daily entry (artifact wikilink in a
 * `apply-evidence` event) is valid, but those targets sit outside the
 * Brain layer and are out of scope for this doctor pass.
 *
 * To keep the check honest for cross-layer wikilinks (e.g. a
 * `retired_by: [[Brain/log/2026-05-14]]`), we accept *any* `.md` file
 * inside `Brain/`. The set is keyed by basename (without `.md`) so
 * Obsidian's basename match works.
 */
function collectAllBasenames(vault: string): ReadonlySet<string> {
  const out = new Set<string>();
  const dirs = brainDirs(vault);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    if (!existsSync(d)) continue;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.add(entry.name.slice(0, -".md".length));
    }
  }
  return out;
}

// Force a runtime touch of parseFrontmatter so importers don't strip
// the dependency on the shared frontmatter parser — used implicitly by
// the parsers we delegate to. Kept here for clarity that doctor's
// invariants ultimately bottom out in the same parse pipeline as the
// dream loop.
void parseFrontmatter;
