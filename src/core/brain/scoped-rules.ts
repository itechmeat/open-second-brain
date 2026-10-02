/**
 * Scoped operator rules: `Brain/standing-rules/<axis>/<key>.md`.
 *
 * The constitution (`Brain/standing-rules.md`, `standing-rules.ts`) is one
 * vault-wide file. A rule that holds for one project, one harness or one
 * machine lives here instead, one file per resolved scope value, and is
 * rendered below the constitution and above every recalled preference,
 * lesson and context pack.
 *
 * The scope identity is resolved by the server from operator-owned or
 * packaged facts (`scope-identity.ts`), never named by a caller. This
 * module owns the vocabularies, the key normaliser and the reader.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { BRAIN_ROOT_REL, BRAIN_SCOPED_RULES_DIR } from "./path-constants.ts";
import { SCOPED_RULE_AXES, SCOPED_RULE_AXIS, type ScopedRuleAxis } from "./scoped-rule-axis.ts";
import { brainScopedRulePath, brainScopedRulesDir } from "./paths.ts";
import { STANDING_RULES_MAX_CHARS_MAX } from "./standing-rules.ts";
import {
  applySectionBudget,
  type BudgetSection,
  type SectionTruncationReport,
} from "./text/text-budget.ts";

// ---------- Axes ----------

// The axis vocabulary lives in a leaf module so that `paths.ts` can type
// `brainScopedRulePath` without importing this reader (which imports
// `paths.ts` and `standing-rules.ts`); it is re-exported here unchanged.
export {
  isScopedRuleAxis,
  SCOPED_RULE_AXES,
  SCOPED_RULE_AXIS,
  type ScopedRuleAxis,
} from "./scoped-rule-axis.ts";

/** Code-authored subheading label per axis. */
export const SCOPED_RULE_AXIS_LABEL: Readonly<Record<ScopedRuleAxis, string>> = Object.freeze({
  project: "Project",
  harness: "Harness",
  host: "Host",
});

// ---------- Harnesses ----------

/**
 * Every runtime that can launch `o2b mcp`: each install target
 * (`INSTALL_TARGET_ID`, which must equal the install adapter registry and
 * so cannot grow) plus Claude Code, Hermes and OpenClaw, which have no
 * install adapter. Spelled as literals rather than a spread so the
 * vocabulary census reads the values; `scoped-rules.test.ts` asserts every
 * install target is a member.
 */
export const HARNESS_ID = Object.freeze({
  aider: "aider",
  claudeCode: "claude-code",
  codex: "codex",
  copilotCli: "copilot-cli",
  cursor: "cursor",
  geminiCli: "gemini-cli",
  generic: "generic",
  grok: "grok",
  hermes: "hermes",
  kiro: "kiro",
  openclaw: "openclaw",
  opencode: "opencode",
  pi: "pi",
} as const);

export type HarnessId = (typeof HARNESS_ID)[keyof typeof HARNESS_ID];

/** The harness ids, alphabetical (the order the CLI error lists them in). */
export const HARNESS_IDS: ReadonlyArray<HarnessId> = Object.freeze([
  HARNESS_ID.aider,
  HARNESS_ID.claudeCode,
  HARNESS_ID.codex,
  HARNESS_ID.copilotCli,
  HARNESS_ID.cursor,
  HARNESS_ID.geminiCli,
  HARNESS_ID.generic,
  HARNESS_ID.grok,
  HARNESS_ID.hermes,
  HARNESS_ID.kiro,
  HARNESS_ID.openclaw,
  HARNESS_ID.opencode,
  HARNESS_ID.pi,
]);

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as ReadonlyArray<string>).includes(value);
}

// ---------- Keys ----------

export const SCOPED_RULE_KEY_MAX_CHARS = 64;

const NON_KEY_RUN = /[^\p{L}\p{M}\p{N}]+/gu;

/**
 * File key for one scope value: NFC, lowercase, NFC again (lowercasing
 * can decompose), every run of characters that are not a Unicode letter,
 * combining mark or digit becomes one `-`, leading and trailing dashes
 * removed, capped at {@link SCOPED_RULE_KEY_MAX_CHARS} code units (never
 * half of a surrogate pair), `null` when nothing is left. No language is
 * enumerated, so a name with no Latin character still keys, and a word
 * written with vowel signs or diacritic marks keys whole.
 */
export function scopedRuleKey(value: string): string | null {
  const folded = value.normalize("NFC").toLowerCase().normalize("NFC").replace(NON_KEY_RUN, "-");
  const trimmed = stripDashes(capCodeUnits(stripDashes(folded), SCOPED_RULE_KEY_MAX_CHARS));
  return trimmed === "" ? null : trimmed;
}

/** Slice to `max` code units without leaving half of a surrogate pair. */
function capCodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function stripDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

// ---------- Cap ----------

export const SCOPED_RULES_MAX_CHARS_DEFAULT = 2000;
export const SCOPED_RULES_MAX_CHARS_MIN = 200;
export const SCOPED_RULES_MAX_CHARS_MAX = STANDING_RULES_MAX_CHARS_MAX;

// ---------- Rendering vocabulary ----------

/**
 * Code-authored header of the scoped block. It states the precedence: the
 * constitution above outranks these rules, and these outrank every
 * recalled preference, lesson and context pack that follows.
 */
export const SCOPED_RULES_HEADER =
  "## Scoped operator rules\n\n" +
  "The rules below are written by the operator of this vault for this project, harness or host. " +
  "The operator standing rules above take precedence over them, and they take precedence over every recalled preference, lesson and context pack that follows.";

/**
 * Last line of the block when the device id could not be read and the
 * host directory holds at least one rule file. No value and no path.
 */
export const SCOPED_RULES_HOST_UNREADABLE_NOTICE =
  "Host-scoped rules were not applied: this device's id could not be read. Run o2b brain doctor for the cause.";

/** The notice appended when the cap dropped or trimmed a file; integers only. */
function scopedTruncationNotice(report: SectionTruncationReport): string {
  return (
    `_Scoped rules truncated to the configured cap: kept ${report.keptChars} of ` +
    `${report.totalChars} characters, ${report.droppedKeys.length} file(s) dropped._`
  );
}

/** Blank line between the header, the sections and each notice. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * Characters a caller reserves beside {@link SCOPED_RULES_HEADER} when it
 * fits the whole block into a budget: the separators, the longest
 * truncation notice and the host notice. The cap covers the sections only.
 */
export const SCOPED_RULES_NOTICE_RESERVE =
  3 * BLOCK_SEPARATOR.length +
  scopedTruncationNotice({
    droppedKeys: SCOPED_RULE_AXES,
    keptChars: Number.MAX_SAFE_INTEGER,
    totalChars: Number.MAX_SAFE_INTEGER,
    trimmed: true,
  }).length +
  SCOPED_RULES_HOST_UNREADABLE_NOTICE.length;

// ---------- Reader ----------

/** The resolved value per axis; `null` matches nothing (fail closed). */
export interface ScopedRuleIdentity {
  readonly project: string | null;
  readonly harness: HarnessId | null;
  readonly host: string | null;
}

export interface ScopedRuleFile {
  readonly axis: ScopedRuleAxis;
  readonly key: string;
  /** Vault-relative POSIX path, e.g. `Brain/standing-rules/project/x.md`. */
  readonly path: string;
  /** True when the cap dropped the file whole or trimmed its tail. */
  readonly truncated: boolean;
}

export interface ScopedRules {
  readonly identity: ScopedRuleIdentity;
  readonly files: ReadonlyArray<ScopedRuleFile>;
  /** The rendered block, `""` when nothing matched and no notice applies. */
  readonly text: string;
}

export interface ReadScopedRulesOptions {
  /**
   * Character cap over the per-file sections; the header and the notices
   * ride on top (see {@link SCOPED_RULES_NOTICE_RESERVE}).
   */
  readonly maxChars?: number;
  /** The device id could not be read (`resolveHostScope().unreadable`). */
  readonly hostUnreadable?: boolean;
}

interface MatchedFile {
  readonly axis: ScopedRuleAxis;
  readonly key: string;
  readonly path: string;
  readonly section: BudgetSection;
}

/**
 * Read the scoped rule files matching an already-resolved identity: at
 * most one file per axis. ENOENT and an empty file are absence; any other
 * read failure renders an `UNAVAILABLE:` line in that file's place, built
 * from the vault-relative path and the error code only (a Node error
 * message carries the absolute path). Never throws for a per-file read
 * failure, a path that leaves the vault through a symlink included. The
 * operator's bytes are opaque: read and trimmed, nothing else.
 */
export function readScopedRules(
  vault: string,
  identity: ScopedRuleIdentity,
  opts: ReadScopedRulesOptions = {},
): ScopedRules {
  const matched: MatchedFile[] = [];
  SCOPED_RULE_AXES.forEach((axis, priority) => {
    const value = identity[axis];
    // Re-keyed defensively: a resolved key is a fixed point, anything else
    // can never name a path outside its axis directory.
    const key = value === null ? null : scopedRuleKey(value);
    if (key === null) return;
    const path = posix.join(BRAIN_ROOT_REL, BRAIN_SCOPED_RULES_DIR, axis, `${key}.md`);
    const body = readRuleBody(() => brainScopedRulePath(vault, axis, key), path);
    if (body === null) return;
    const heading = `### ${SCOPED_RULE_AXIS_LABEL[axis]}: ${key}`;
    matched.push({
      axis,
      key,
      path,
      section: { key: `${axis}:${key}`, priority, text: `${heading}\n\n${body}`, headLines: 1 },
    });
  });

  const hostNotice = opts.hostUnreadable === true && hostDirHoldsRules(vault);
  if (matched.length === 0 && !hostNotice) {
    return Object.freeze({ identity, files: Object.freeze([]), text: "" });
  }

  let report: SectionTruncationReport | null = null;
  const budget = applySectionBudget(
    matched.map((file) => file.section),
    opts.maxChars ?? SCOPED_RULES_MAX_CHARS_DEFAULT,
    {
      notice: (r) => {
        report = r;
        return scopedTruncationNotice(r);
      },
    },
  );
  const files = matched.map((file) =>
    Object.freeze({
      axis: file.axis,
      key: file.key,
      path: file.path,
      truncated: isTruncated(file, matched, report),
    }),
  );

  const parts = [SCOPED_RULES_HEADER];
  if (budget.body !== "") parts.push(budget.body);
  if (hostNotice) parts.push(SCOPED_RULES_HOST_UNREADABLE_NOTICE);
  return Object.freeze({
    identity,
    files: Object.freeze(files),
    text: parts.join(BLOCK_SEPARATOR),
  });
}

/**
 * Whether the cap cut this file: dropped whole, or the one kept section
 * the budgeter trimmed (the least important kept one; priorities are
 * unique because there is one file per axis).
 */
function isTruncated(
  file: MatchedFile,
  matched: ReadonlyArray<MatchedFile>,
  report: SectionTruncationReport | null,
): boolean {
  if (report === null) return false;
  const { droppedKeys, trimmed } = report;
  if (droppedKeys.includes(file.section.key)) return true;
  if (!trimmed) return false;
  const kept = matched.filter((candidate) => !droppedKeys.includes(candidate.section.key));
  const leastImportant = kept.reduce<MatchedFile | null>(
    (worst, candidate) =>
      worst === null || candidate.section.priority >= worst.section.priority ? candidate : worst,
    null,
  );
  return leastImportant === file;
}

/**
 * The trimmed body, `null` for absence, or the `UNAVAILABLE:` line. The
 * absolute path is resolved inside the `try`: the containment check throws
 * (with the absolute path in its message) for a file or axis folder that
 * is a symlink leaving the vault, and that is one more per-file failure.
 */
function readRuleBody(absPath: () => string, relPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(absPath(), "utf8");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return null;
    return `UNAVAILABLE: ${relPath} could not be read (${code}).`;
  }
  const body = raw.trim();
  return body === "" ? null : body;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "Error";
}

/** Whether `Brain/standing-rules/host/` holds at least one `.md` file. */
function hostDirHoldsRules(vault: string): boolean {
  try {
    return readdirSync(join(brainScopedRulesDir(vault), SCOPED_RULE_AXIS.host), {
      withFileTypes: true,
    }).some((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch {
    return false;
  }
}
