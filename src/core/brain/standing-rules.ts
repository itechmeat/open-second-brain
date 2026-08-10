/**
 * Operator standing rules: `Brain/standing-rules.md`
 * (silence-is-not-an-answer, U8).
 *
 * Every other lane of the session preamble is something the agent
 * learned about itself - preferences it recorded, lessons it distilled,
 * packs it assembled. This one is the operator talking, and the whole
 * point of the file is that it outranks all of that. So it is injected
 * first, it is exempt from the adaptive injection budget, it survives a
 * memory-layer failure because it is read outside that boundary, and no
 * tool can rewrite it.
 *
 * UNEDITABILITY IS MOSTLY INHERITED, AND THE REST IS ONE NAMED GUARD.
 * The honest scope of that claim belongs here rather than in a release
 * note. `Brain/` is the machinery root that `resolveNoteTarget` refuses
 * outright, so `Brain/standing-rules.md` is un-writable through the four
 * CALLER-NAMED note-write tools - `brain_create_note`,
 * `brain_update_note`, `brain_append_note` and `brain_write_batch` - which
 * all resolve their target through that one envelope. That class is the
 * boundary the write-site census maintains, and it is the class an agent
 * can address by naming a path.
 *
 * It is not the whole class, which is why {@link
 * assertStandingRulesNotTargeted} exists. `brain_labels` also takes a
 * caller-named path, and it reaches the file through the weaker
 * `resolveNotePath`, which checks containment and symlinks only - so the
 * inherited refusal did not cover it and a label write could rewrite the
 * operator's frontmatter. The guard is deliberately NOT the Brain-root
 * refusal moved down a layer: several legitimate callers write inside
 * `Brain/` through that same resolver (marker write-back, tombstones,
 * temporal replace), so what the guard names is one file.
 *
 * Neither mechanism is a claim that no code in this process can open the
 * file for writing; a module reaching `node:fs` directly is a different
 * population, counted by that same census.
 *
 * OPERATOR BYTES ARE OPAQUE. The reader performs exactly three
 * operations on them: read, trim, and line-boundary trimming at a
 * character cap. It never splits on headings, never inspects words,
 * never classifies, and the truncation notice is assembled from integers
 * and the path alone - so a rules file written in any language is capped
 * and reported identically to one written in English. Any future word
 * list or heading split here would break that, which is why the reader
 * has no branch that reads the content at all.
 *
 * ABSENCE AND FAILURE ARE DIFFERENT ANSWERS. {@link readStandingRules}
 * returns `null` only for a file that is not there or whose trimmed body
 * is empty. Every other outcome throws, naming the path and the reason,
 * and the hook path renders {@link renderStandingRulesFailure} rather
 * than degrading to nothing in silence. A constitution that disappears
 * without a word is worse than one that was never written.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { brainStandingRulesPath } from "./paths.ts";
import { applySectionBudget } from "./text/text-budget.ts";

/**
 * Character cap for the standing-rules block. Generous next to the
 * default injection budget because this lane is exempt from that budget
 * and is the operator's own voice: the cap exists to stop a runaway file
 * from swallowing the context window, not to ration the operator.
 * Override via `active.standing_rules_max_chars`.
 */
export const STANDING_RULES_MAX_CHARS_DEFAULT = 4000;
export const STANDING_RULES_MAX_CHARS_MIN = 200;
export const STANDING_RULES_MAX_CHARS_MAX = 100_000;

/**
 * Budget-section key for the single section the cap operates on. The
 * body is never split, so there is exactly one, and the key never
 * reaches a rendered surface - the notice is built from integers.
 */
export const STANDING_RULES_SECTION_KEY = "standing-rules";

/**
 * The precedence sentence this project prepends to the operator's text.
 *
 * Authored here, in English, and never derived from the file: the
 * operator writes rules, not the framing that gives them force. Keeping
 * the framing ours is also what lets the block below it be treated as
 * opaque bytes - the agent is told how to weigh the text without anyone
 * having had to read it.
 */
export const STANDING_RULES_HEADER =
  "## Operator standing rules\n\n" +
  "The rules below are written by the operator of this vault. " +
  "They take precedence over every recalled preference, lesson and context pack that follows.";

/** Blank-line separator between the header, the body and the notice. */
const BLOCK_SEPARATOR = "\n\n";

/** A capped or uncapped read of the operator's standing rules. */
export interface StandingRules {
  /** Absolute path the bytes came from; named in the truncation notice. */
  readonly path: string;
  /** Operator bytes: trimmed, and cut at a line boundary when over the cap. Never reformatted. */
  readonly text: string;
  /** True when the cap removed anything. */
  readonly truncated: boolean;
  readonly keptLines: number;
  readonly totalLines: number;
  readonly keptChars: number;
  readonly totalChars: number;
}

export interface ReadStandingRulesOptions {
  /** Character cap; defaults to {@link STANDING_RULES_MAX_CHARS_DEFAULT}. */
  readonly maxChars?: number;
}

/**
 * Read `Brain/standing-rules.md`, trimmed and capped at a line boundary.
 *
 * Returns `null` for exactly two conditions: the file does not exist, or
 * its trimmed body is empty. Both mean the operator has written no rules,
 * which is a legitimate state and not a failure. Anything else - a
 * permission denial, a directory where the file should be, a read that
 * fails mid-stream - throws with the path and the reason, because the
 * caller must be able to tell "no rules" from "the rules could not be
 * read" and there is no cached substitute for a constitution.
 */
export function readStandingRules(
  vault: string,
  opts: ReadStandingRulesOptions = {},
): StandingRules | null {
  const path = brainStandingRulesPath(vault);

  // Read first and classify the failure, rather than probing with
  // `existsSync` and reading after: the probe leaves a window in which
  // the answer changes between the two syscalls, and ENOENT from the
  // read itself IS the absence the probe was looking for.
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isFileAbsent(err)) return null;
    throw new Error(`standing rules at ${path} could not be read: ${describeError(err)}`, {
      cause: err,
    });
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const totalChars = trimmed.length;
  const totalLines = countLines(trimmed);
  const maxChars = opts.maxChars ?? STANDING_RULES_MAX_CHARS_DEFAULT;
  if (totalChars <= maxChars) {
    return freeze(path, trimmed, false, totalLines, totalChars, totalLines, totalChars);
  }

  // The cap goes through the shared section budgeter so the cut is the
  // same line-boundary trim the injected memory bodies get. One section,
  // so there is nothing to drop whole and nothing to reorder: the only
  // behaviour reached is the tail trim.
  //
  // No `notice` is passed. The notice belongs to the RENDER, not to the
  // capped text: `text` is the operator's own bytes and `keptChars`
  // counts them, so letting this project's prose into that string would
  // make the record describe something partly ours.
  const capped = applySectionBudget(
    [{ key: STANDING_RULES_SECTION_KEY, priority: 0, text: trimmed }],
    maxChars,
  );
  const text = capped.body;
  return freeze(path, text, true, countLines(text), text.length, totalLines, totalChars);
}

/** Refusal raised by {@link assertStandingRulesNotTargeted}. */
export class StandingRulesWriteRefusedError extends Error {
  /** Absolute path the guard protects. */
  readonly path: string;
  /** The write path that was refused, as its caller named itself. */
  readonly surface: string;
  constructor(path: string, surface: string) {
    // Scoped to this surface deliberately: the guard speaks for the write
    // path that called it, not for every write path in the process.
    super(
      `${surface} refused: ${path} is the operator's standing-rules file, which this ` +
        "surface does not rewrite",
    );
    this.name = "StandingRulesWriteRefusedError";
    this.path = path;
    this.surface = surface;
  }
}

/**
 * Refuse a write whose target is `Brain/standing-rules.md`.
 *
 * Narrow on purpose: it names ONE file, and it is called from the write
 * paths that resolve a caller-named path without going through the
 * note-target envelope that already refuses the whole `Brain/` root. It
 * runs before any I/O in its callers, so a refused call also performs no
 * read and no validation side effect.
 *
 * `notePath` is the caller's own vault-relative (or absolute) argument,
 * resolved here rather than taken pre-resolved, so the guard can run
 * ahead of its caller's path resolution and vocabulary checks. Both sides
 * are compared lexically and then canonically: a symlink pointing at the
 * rules file is the same target, and a symlinked vault root must not make
 * two spellings of one path look like two paths.
 */
export function assertStandingRulesNotTargeted(
  vault: string,
  notePath: string,
  surface: string,
): void {
  const target = brainStandingRulesPath(vault);
  const candidate = resolve(vault, notePath);
  if (candidate === target || canonicalPath(candidate) === canonicalPath(target)) {
    throw new StandingRulesWriteRefusedError(target, surface);
  }
}

/**
 * Canonical form of `path`, or the path itself when it cannot be
 * canonicalized. A missing file has nothing to resolve, and falling back
 * to the lexical form keeps the comparison total - the guard must never
 * fail open because one side does not exist yet.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Render the injected block: the precedence header, the operator's text,
 * and - only when the cap removed something - a notice built from
 * integers and the path.
 */
export function renderStandingRules(rules: StandingRules): string {
  const parts = [STANDING_RULES_HEADER, rules.text];
  if (rules.truncated) parts.push(renderTruncationNotice(rules));
  return parts.join(BLOCK_SEPARATOR);
}

/**
 * The block emitted in place of the rules when the read threw.
 *
 * The constitution never degrades to nothing without saying so, so this
 * names the file, names the reason, and states in one sentence that no
 * standing rules are in force for this session. An agent that sees the
 * ordinary header and no rules would reasonably conclude the operator
 * wrote none; this is what stops that conclusion being drawn from a
 * permission error.
 */
export function renderStandingRulesFailure(path: string, error: unknown): string {
  return [
    STANDING_RULES_HEADER,
    `UNAVAILABLE: ${path} could not be read (${describeError(error)}). ` +
      "No standing rules are in force this session.",
  ].join(BLOCK_SEPARATOR);
}

/**
 * The truncation notice: kept and total lines, kept and total
 * characters, and where the whole text lives.
 *
 * Integers and a path only. That is not terseness - it is what makes the
 * sentence identical whatever language the operator writes in, because
 * nothing in it is derived from the bytes that were cut.
 */
function renderTruncationNotice(rules: StandingRules): string {
  return (
    `_Standing rules truncated to the configured cap: kept ${rules.keptLines} of ` +
    `${rules.totalLines} lines, ${rules.keptChars} of ${rules.totalChars} characters. ` +
    `Read ${rules.path} for the full text._`
  );
}

function freeze(
  path: string,
  text: string,
  truncated: boolean,
  keptLines: number,
  keptChars: number,
  totalLines: number,
  totalChars: number,
): StandingRules {
  return Object.freeze({
    path,
    text,
    truncated,
    keptLines,
    totalLines,
    keptChars,
    totalChars,
  });
}

/** The one errno that means "the operator has not written this file". */
const ENOENT = "ENOENT";

function isFileAbsent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === ENOENT;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Newline-delimited line count. Empty text is 0 lines; a trailing
 * newline does not add a phantom line. The body is always trimmed
 * before it gets here, so the second case is theoretical and cheap to
 * keep correct anyway.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) count++;
  }
  if (text.charCodeAt(text.length - 1) !== 0x0a) count++;
  return count;
}
