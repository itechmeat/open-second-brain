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

import { STANDING_RULES_MAX_CHARS_MAX } from "./standing-rules.ts";

// ---------- Axes ----------

/** The three scope axes a rule file can be keyed on. */
export const SCOPED_RULE_AXIS = Object.freeze({
  project: "project",
  harness: "harness",
  host: "host",
} as const);

export type ScopedRuleAxis = (typeof SCOPED_RULE_AXIS)[keyof typeof SCOPED_RULE_AXIS];

/**
 * The axes in render order, which is also the drop priority under the cap:
 * the index is the priority, so the host file drops first.
 */
export const SCOPED_RULE_AXES: ReadonlyArray<ScopedRuleAxis> = Object.freeze([
  SCOPED_RULE_AXIS.project,
  SCOPED_RULE_AXIS.harness,
  SCOPED_RULE_AXIS.host,
]);

export function isScopedRuleAxis(value: unknown): value is ScopedRuleAxis {
  return typeof value === "string" && (SCOPED_RULE_AXES as ReadonlyArray<string>).includes(value);
}

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

const NON_KEY_RUN = /[^\p{L}\p{N}]+/gu;

/**
 * File key for one scope value: NFC, lowercase, every run of characters
 * that are not a Unicode letter or digit becomes one `-`, leading and
 * trailing dashes removed, capped at {@link SCOPED_RULE_KEY_MAX_CHARS}
 * code units (never half of a surrogate pair), `null` when nothing is left. No language is
 * enumerated, so a name with no Latin character still keys.
 */
export function scopedRuleKey(value: string): string | null {
  const folded = value.normalize("NFC").toLowerCase().replace(NON_KEY_RUN, "-");
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
