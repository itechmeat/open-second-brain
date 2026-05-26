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
import { join } from "node:path";

import { extractWikilinks, listVaultBasenames, parseFrontmatter } from "../vault.ts";
import { resolveVaultScope } from "../vault-scope/index.ts";
import { buildBacklinkIndex } from "./backlinks.ts";
import { parseLogDay } from "./log.ts";
import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BRAIN_GUARDRAIL_DEFAULTS,
  BrainConfigError,
  loadBrainConfigDetailed,
} from "./policy.ts";
import { computeTrustVerdict } from "./trust/compute-trust-verdict.ts";
import {
  computeVerificationDelta,
  type VerificationDeltaSummaryCounts,
} from "./trust/compute-verification-delta.ts";
import { checkInstructionFileCeiling } from "./trust/instruction-file-ceiling.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";
import {
  BrainDoubleShapeError,
  BrainStatusFolderMismatchError,
  parsePreference,
  parseRetired,
} from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { findSimilarPairs, tokenise } from "./similarity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainConfig,
} from "./types.ts";
import { normaliseWikilinkTarget, parseArtifactRef } from "./wikilink.ts";

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
  /**
   * Wall clock used by age-based lints (`low-evidence-confirmed`,
   * `pinned-without-recent-evidence`). Defaults to `new Date()`.
   * Tests pin this for determinism.
   */
  readonly now?: Date;
  /**
   * Optional precomputed dream summary (v0.10.16). When supplied,
   * the doctor runs the verification-delta helper and folds the
   * counts into the trust verdict. When omitted, verification
   * defaults to all-zero counts and the trust verdict is computed
   * against doctor signals alone.
   */
  readonly dreamSummary?: import("./dream.ts").DreamRunSummary;
  /**
   * Optional resolved guardrail config (v0.10.16). When omitted,
   * `BRAIN_GUARDRAIL_DEFAULTS` are used. Drives the
   * instruction-file-ceiling check.
   */
  readonly guardrails?: import("./types.ts").ResolvedBrainGuardrailConfig;
}

/**
 * Aggregate verdict introduced in v0.10.16. Compresses doctor errors,
 * dream warnings, and verification-delta counts into one of three
 * states an operator can act on at a glance.
 */
export type TrustVerdict = "clean" | "watch" | "investigate";

/**
 * Compact counts attached to a `RunDoctorResult` so callers can render
 * a one-line "verification delta: X drift, Y regression, Z missing"
 * summary without re-walking the vault. Full per-entry detail lives
 * on the trust-layer `operator_summary` composer.
 */
export interface VerificationDeltaSummary {
  readonly confirmed: number;
  readonly drift: number;
  readonly regression: number;
  readonly missing_evidence: number;
}

/**
 * Warning entry produced by the instruction-file-ceiling helper
 * (v0.10.16). Doctor surfaces these as a parallel array so the
 * trust verdict has structured input without having to grep the
 * generic `warnings` list.
 */
export interface InstructionFileCeilingWarning {
  /** Vault-relative path of the offending instruction file. */
  readonly path: string;
  /** Observed line count. */
  readonly lines: number;
  /** Configured ceiling at the time of the check. */
  readonly ceiling: number;
}

/**
 * Per-check uncertainty entry. Distinct from `warnings` / `errors`:
 * these are sub-operations the doctor attempted but cannot claim
 * completed cleanly (e.g. an instruction-file the doctor could not
 * read, a verification step that timed out). Empty on every clean
 * run. v0.10.16 extension point.
 */
export interface DoctorUncertainEntry {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export interface RunDoctorResult {
  readonly warnings: ReadonlyArray<DoctorIssue>;
  readonly errors: ReadonlyArray<DoctorIssue>;
  /**
   * Aggregate trust verdict (v0.10.16). Absent when the trust helper
   * was not invoked; consumers of `runDoctor` that only need the
   * legacy warning / error stream can ignore the field.
   */
  readonly trust_verdict?: TrustVerdict;
  /**
   * Counts of verification-delta states for the most recent dream
   * cycle. Absent when verification did not run.
   */
  readonly verification_delta_summary?: VerificationDeltaSummary;
  /**
   * Warnings emitted by the instruction-file-ceiling helper. Empty
   * when the helper did not run or no tracked file exceeded the
   * configured ceiling.
   */
  readonly instruction_file_warnings?: ReadonlyArray<InstructionFileCeilingWarning>;
  /**
   * Sub-operations the doctor attempted but could not fully verify.
   * Empty on every clean run; populated when an uncertainty-surfacing
   * helper is invoked.
   */
  readonly uncertain?: ReadonlyArray<DoctorUncertainEntry>;
}

// ----- Entry point ----------------------------------------------------------

export function runDoctor(
  vault: string,
  opts: RunDoctorOptions = {},
): RunDoctorResult {
  const issues: DoctorIssue[] = [];

  const dirs = brainDirs(vault);
  if (!existsSync(dirs.brain)) {
    // No Brain layer present is not an error here — `o2b brain init`
    // is the right command, but a vault without Brain is allowed in
    // v0.9. Return clean. v0.10.16: emit the new trust-layer fields
    // with their clean / empty defaults for shape symmetry with the
    // normal-return path.
    return Object.freeze({
      warnings: Object.freeze([]),
      errors: Object.freeze([]),
      trust_verdict: "clean" as TrustVerdict,
      instruction_file_warnings: Object.freeze([]),
    });
  }

  // 1. Config schema check.
  checkConfig(vault, issues);
  // 1b (v0.10.9). Vault scope hygiene: path-style entries that point at
  // nothing on disk are typically typos. Only fires when the operator
  // actually declared the `vault.ignore_paths` block (we never warn
  // about defaults — a built-in entry like `.git` may legitimately be
  // absent in a fresh vault).
  checkVaultIgnore(vault, issues);

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

  // 8. Broken-backlinks lint — any preference / retired / log entry
  //    that wikilinks to a Brain artifact id (`pref-...`, `ret-...`,
  //    `sig-...`) whose file no longer exists. Surfaces at warning
  //    severity: a dangling reference is a real data-hygiene problem
  //    but doesn't block the dream loop, so the digest / cron want
  //    to see it without failing the run.
  checkBrokenBacklinks(vault, issues, knownBasenames);

  // 9. Hygiene lints — duplicate prefs, low-evidence confirmed, pinned
  //    without recent evidence, malformed apply-evidence ranges,
  //    orphan apply-evidence artifacts. Each is non-blocking (warning
  //    severity) and config/clock dependent. We swallow per-lint
  //    failures so one broken scan doesn't mask the others.
  const now = opts.now ?? new Date();
  let cfg;
  try {
    cfg = loadBrainConfigDetailed(vault).config;
  } catch {
    cfg = undefined;
  }
  // Build snapshots once and feed every new lint that needs them.
  // Each `try` boundary is per-lint so one broken read doesn't mask
  // others, but we don't re-parse the same files five times anymore.
  const prefRecords = readAllPreferenceRecords(vault);
  const logRecords = readAllLogRecords(vault);
  if (cfg) {
    try {
      checkDuplicatePreferences(prefRecords, issues);
    } catch { /* doctor never throws */ }
    try {
      checkLowEvidenceConfirmed(prefRecords, issues, cfg, now);
    } catch { /* doctor never throws */ }
    try {
      checkPinnedWithoutRecentEvidence(prefRecords, issues, cfg, now);
    } catch { /* doctor never throws */ }
  }
  try {
    checkMalformedEvidenceRange(logRecords, issues);
  } catch { /* doctor never throws */ }
  try {
    checkOrphanEvidence(vault, logRecords, issues);
  } catch { /* doctor never throws */ }

  // Partition by severity. Stable sort preserves discovery order which
  // is convenient for tests asserting on `path`+`code`.
  const warnings = issues.filter((i) => i.severity === "warning");
  const errors = issues.filter((i) => i.severity === "error");

  // v0.10.16 trust layer. Each computation is best-effort: a failure
  // in a helper must not poison the legacy warning / error stream.
  const guardrails = opts.guardrails ?? BRAIN_GUARDRAIL_DEFAULTS;
  let instructionWarnings: ReadonlyArray<InstructionFileCeilingWarning> = [];
  try {
    instructionWarnings = checkInstructionFileCeiling(vault, {
      maxLines: guardrails.instruction_file_max_lines,
    });
  } catch { /* doctor never throws */ }

  let verificationCounts: VerificationDeltaSummaryCounts | undefined;
  if (opts.dreamSummary !== undefined) {
    try {
      const delta = computeVerificationDelta(vault, opts.dreamSummary);
      verificationCounts = delta.summary;
    } catch { /* doctor never throws */ }
  }

  const trustVerdict: TrustVerdict = computeTrustVerdict({
    doctorWarnings: warnings,
    doctorErrors: errors,
    dreamWarnings: opts.dreamSummary?.warnings ?? [],
    verification: verificationCounts ?? {
      confirmed: 0,
      drift: 0,
      regression: 0,
      missing_evidence: 0,
    },
  });

  return Object.freeze({
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
    trust_verdict: trustVerdict,
    ...(verificationCounts !== undefined
      ? { verification_delta_summary: verificationCounts }
      : {}),
    instruction_file_warnings: instructionWarnings,
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

// ----- Vault-scope check ---------------------------------------------------

/**
 * v0.10.9 hygiene lint: surface path-style entries in
 * `vault.ignore_paths` that do not resolve to anything on disk. Such
 * entries are typically typos — they look like exclusions but cannot
 * fire. Bare-name rules are skipped (a missing `.git` directory is
 * not an error).
 *
 * Only runs when the operator declared the block themselves; the
 * built-in default set may legitimately list paths that do not exist
 * in a given vault.
 */
function checkVaultIgnore(vault: string, issues: DoctorIssue[]): void {
  let scope;
  try {
    scope = resolveVaultScope(vault);
  } catch {
    // `checkConfig` already reports the malformed/unreadable _brain.yaml.
    // Do not let this follow-on lint mask the primary config issue.
    return;
  }
  if (scope.source !== "_brain.yaml") return;
  for (const rule of scope.rules) {
    if (rule.kind !== "path") continue;
    if (existsSync(join(vault, rule.raw))) continue;
    issues.push({
      severity: "warning",
      code: "vault-ignore-missing-path",
      message:
        `vault.ignore_paths entry '${rule.raw}' does not exist in this vault`,
    });
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
      } else if (err instanceof BrainDoubleShapeError) {
        // Dual-shape collision is operator-actionable — hand-edit
        // the file. Surface as warning, not error, so the dream
        // loop still proceeds for the rest of the vault.
        issues.push({
          severity: "warning",
          code: "frontmatter-double-shape",
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
      } else if (err instanceof BrainDoubleShapeError) {
        issues.push({
          severity: "warning",
          code: "frontmatter-double-shape",
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
 * Build the universe of valid wikilink targets inside `Brain/`. The
 * doctor pass is scoped to Brain content; cross-layer wikilinks
 * pointing at user-authored notes outside Brain/ are out of scope
 * and stay accepted.
 *
 * Set is keyed by basename (without `.md`) so Obsidian's basename
 * match works.
 */
function checkBrokenBacklinks(
  vault: string,
  issues: DoctorIssue[],
  knownBasenames: ReadonlySet<string>,
): void {
  // Only attempt the check when there's something to scan — an empty
  // Brain layer naturally has no backlinks, and `buildBacklinkIndex`
  // would already return an empty map, but we save the parse pass.
  if (knownBasenames.size === 0) return;
  const index = buildBacklinkIndex(vault);
  for (const [target, refs] of index) {
    // We only flag references whose target *should* live in this
    // Brain (i.e. an artifact id we manage). Wikilinks pointing
    // outside the Brain layer are user prose and not our concern.
    if (!/^(pref|ret|sig)-/.test(target)) continue;
    if (knownBasenames.has(target)) continue;
    const sources = Array.from(new Set(refs.map((r) => r.source))).sort();
    issues.push({
      severity: "warning",
      code: "broken-backlinks",
      message:
        `[[${target}]] is referenced by ${sources.length} source(s) but no file with that ` +
        `basename exists under Brain/: ${sources.join(", ")}`,
    });
  }
}

// ----- Hygiene lints (§11) -------------------------------------------------

const JACCARD_DUPLICATE_THRESHOLD = 0.7;

interface PreferenceRecord {
  readonly path: string;
  readonly pref: import("./types.ts").BrainPreference;
}

interface LogRecord {
  readonly date: string;
  readonly entries: ReadonlyArray<import("./log.ts").BrainLogEntry>;
}

/**
 * Build a single pre-parsed snapshot of `Brain/preferences/` so the
 * three pref-walking lints don't each re-parse the directory.
 * Files that fail to parse are silently omitted — schema errors are
 * already reported by {@link checkPreferences}.
 */
function readAllPreferenceRecords(vault: string): ReadonlyArray<PreferenceRecord> {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: PreferenceRecord[] = [];
  for (const name of readdirSync(dirs.preferences)) {
    if (!name.endsWith(".md") || !name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, name);
    try {
      out.push({ path, pref: parsePreference(path) });
    } catch {
      // schema error — reported by checkPreferences
    }
  }
  return out;
}

/**
 * Build a single pre-parsed snapshot of `Brain/log/` so the two
 * log-walking lints don't each re-parse the directory.
 */
function readAllLogRecords(vault: string): ReadonlyArray<LogRecord> {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return [];
  const out: LogRecord[] = [];
  for (const name of readdirSync(dirs.log)) {
    if (!name.endsWith(".md")) continue;
    const date = name.slice(0, -".md".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    try {
      out.push({ date, entries: parseLogDay(vault, date).entries });
    } catch {
      // parse error — surfaced separately by checkLogs
    }
  }
  return out;
}

/**
 * `duplicate-preferences`: pairwise jaccard similarity of `principle`
 * tokens within each `(topic, scope)` bucket of confirmed/quarantine
 * prefs. Pairs with similarity ≥ `JACCARD_DUPLICATE_THRESHOLD` are
 * flagged. Unconfirmed and retired prefs are excluded — they're
 * meant to be replaced or already are.
 */
function checkDuplicatePreferences(
  records: ReadonlyArray<PreferenceRecord>,
  issues: DoctorIssue[],
): void {
  const entries = [];
  for (const { pref } of records) {
    if (
      pref.status !== BRAIN_PREFERENCE_STATUS.confirmed &&
      pref.status !== BRAIN_PREFERENCE_STATUS.quarantine
    ) continue;
    entries.push({
      id: pref.id,
      // Same-scope-undefined falls in its own bucket. Mirrors the
      // §12 merge-candidate detector exactly — both surfaces stay
      // in sync via the shared walker.
      bucketKey: `${pref.topic}\x00${pref.scope ?? ""}`,
      tokens: tokenise(pref.principle),
      source: pref,
    });
  }
  const pairs = findSimilarPairs(entries, { threshold: JACCARD_DUPLICATE_THRESHOLD });
  for (const pair of pairs) {
    const a = pair.a.source;
    issues.push({
      severity: "warning",
      code: "duplicate-preferences",
      message:
        `[[${pair.a.id}]] and [[${pair.b.id}]] in topic '${a.topic}'` +
        `${a.scope ? ` (scope: ${a.scope})` : ""}` +
        ` look like duplicates (jaccard ${pair.jaccard.toFixed(2)} of principle tokens).` +
        " Consider merging.",
    });
  }
}

/**
 * `low-evidence-confirmed`: a confirmed pref whose `applied_count` is
 * still at or below `low_max_applied` long after its trial window
 * (`unconfirmed_window_days`). Catches prefs that promoted on the
 * minimum evidence but never saw real use — candidates for review.
 */
function checkLowEvidenceConfirmed(
  records: ReadonlyArray<PreferenceRecord>,
  issues: DoctorIssue[],
  cfg: BrainConfig,
  now: Date,
): void {
  const cutoffMs = now.getTime() - cfg.dream.unconfirmed_window_days * 24 * 3600 * 1000;
  for (const { pref } of records) {
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    if (pref.applied_count > cfg.confidence.low_max_applied) continue;
    if (!pref.confirmed_at) continue;
    const confirmedMs = Date.parse(pref.confirmed_at);
    if (!Number.isFinite(confirmedMs)) continue;
    if (confirmedMs >= cutoffMs) continue;
    issues.push({
      severity: "warning",
      code: "low-evidence-confirmed",
      message:
        `[[${pref.id}]] is confirmed but applied_count=${pref.applied_count} ≤ ` +
        `low_max_applied=${cfg.confidence.low_max_applied} after ${cfg.dream.unconfirmed_window_days}+ days.` +
        " The rule hasn't seen real use — review or retire.",
    });
  }
}

/**
 * `pinned-without-recent-evidence`: a pinned pref whose
 * `last_evidence_at` is null or older than `stale_evidence_days`. The
 * pin protects the rule from automatic retire, but the data shows it
 * isn't actively backed — alert the user.
 */
function checkPinnedWithoutRecentEvidence(
  records: ReadonlyArray<PreferenceRecord>,
  issues: DoctorIssue[],
  cfg: BrainConfig,
  now: Date,
): void {
  const cutoffMs = now.getTime() - cfg.retire.stale_evidence_days * 24 * 3600 * 1000;
  for (const { pref } of records) {
    if (!pref.pinned) continue;
    if (!pref.last_evidence_at) {
      issues.push({
        severity: "warning",
        code: "pinned-without-recent-evidence",
        message:
          `[[${pref.id}]] is pinned but has never received apply-evidence.` +
          " Confirm the pin is intentional.",
      });
      continue;
    }
    const lastMs = Date.parse(pref.last_evidence_at);
    if (!Number.isFinite(lastMs)) continue;
    if (lastMs >= cutoffMs) continue;
    issues.push({
      severity: "warning",
      code: "pinned-without-recent-evidence",
      message:
        `[[${pref.id}]] is pinned but last_evidence_at=${pref.last_evidence_at} is older than ` +
        `stale_evidence_days=${cfg.retire.stale_evidence_days}. Pin may be outdated.`,
    });
  }
}

/**
 * `malformed-evidence-range`: walks every `apply-evidence` event,
 * runs the artifact wikilink through {@link parseArtifactRef}, and
 * flags any malformed range suffix (`:abc-def`, `:120-100`, etc.).
 * The event itself remains valid — only the range is malformed.
 */
function checkMalformedEvidenceRange(
  records: ReadonlyArray<LogRecord>,
  issues: DoctorIssue[],
): void {
  for (const { entries } of records) {
    for (const e of entries) {
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      const artifact = e.body["artifact"];
      if (typeof artifact !== "string") continue;
      const parsed = parseArtifactRef(artifact);
      if (parsed.malformedRange) {
        issues.push({
          severity: "warning",
          code: "malformed-evidence-range",
          message:
            `apply-evidence at ${e.timestamp} references artifact ${parsed.raw}` +
            ` with malformed range '${parsed.rangeText}'.` +
            " Use `[[file:N-N]]` (inclusive, 1-based) or `[[file:N]]`.",
        });
      }
    }
  }
}

/**
 * `orphan-evidence`: walks every `apply-evidence` event and verifies
 * the artifact wikilink resolves to some file in the vault. Obsidian
 * wikilinks resolve by basename; we use the cheap basename-only
 * walker from `vault.ts` (no frontmatter parse).
 *
 * This is the only doctor lint that walks the entire vault (not just
 * `Brain/`). It's an on-demand check; doctor isn't called per-turn.
 */
function checkOrphanEvidence(
  vault: string,
  records: ReadonlyArray<LogRecord>,
  issues: DoctorIssue[],
): void {
  let basenames: ReadonlySet<string>;
  try {
    basenames = listVaultBasenames(vault);
  } catch {
    return;
  }
  for (const { entries } of records) {
    for (const e of entries) {
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      const artifact = e.body["artifact"];
      if (typeof artifact !== "string") continue;
      const target = parseArtifactRef(artifact).target;
      if (!target) continue;
      if (basenames.has(target)) continue;
      issues.push({
        severity: "warning",
        code: "orphan-evidence",
        message:
          `apply-evidence at ${e.timestamp} references artifact [[${target}]]` +
          " but no file with that basename exists in the vault.",
      });
    }
  }
}

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
