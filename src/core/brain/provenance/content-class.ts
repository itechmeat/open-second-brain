/**
 * The content class - what kind of process produced a page's text.
 *
 * ## One member, because there is exactly one decision
 *
 * `content_class` is the sibling of `origin_channel`
 * (`src/core/origin-channel.ts`) on a different axis: the channel says
 * which process put a record in the vault, the class says what kind of
 * material the record carries. The vocabulary is closed and holds ONE
 * member, `prompt-derived` - text an agent produced from a prompt. One
 * member is enough because the stamp exists for exactly one decision:
 * shared exports leave such pages out by default (the guard seam in
 * `src/core/egress/guard.ts`), and a per-verb operator override names
 * them back in. A second member would need a second decision, and no
 * second decision is implemented; the vocabulary grows the day one is.
 *
 * ## Server-derived, like the channel it sits beside
 *
 * The class is stamped by the writer that knows the material is
 * prompt-derived, never named by the caller that sends it. Creation
 * stamps it when the write arrives over the MCP transport (an agent
 * dictated the page), and the deterministic generation pipelines - the
 * session import and the in-process report writers - stamp their own
 * output. Operator-authored CLI writes stay unmarked. A caller-supplied
 * key is dropped at the merge: a class a caller could name would be the
 * same unverifiable claim a caller-named channel would be, and the
 * census that pins the channel (`origin-channel-census.test.ts`) is why
 * this module's spellings avoid that field's every spelling.
 *
 * ## No backfill, and absence is a meaning
 *
 * Pages written before this shipped carry no key and are NOT rewritten
 * to add one, for the same reason the channel is not backfilled: a stamp
 * applied by a later pass describes the pass, not the writer. Absence
 * reads as unmarked, and the era boundary is documented rather than
 * migrated - a pre-stamp page keeps exporting exactly as it did.
 *
 * ## A closed vocabulary meeting a hand editor
 *
 * On disk the key is frontmatter an operator can edit. The narrowing
 * guard refuses unknown values where a stamp is RESOLVED (a write path
 * cannot be talked into inventing a class), while the read side treats
 * any value other than the reserved member as unmarked rather than
 * throwing: a page marked by hand with a spelling this build does not
 * know is not evidence of anything, and inventing an exclusion for it
 * would let one typo silently hide pages from every shared export.
 * Hand-set scoping already has a key - `visibility` - and this axis is
 * not a second one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import type { FrontmatterMap } from "../../types.ts";
import { ORIGIN_CHANNEL, type OriginChannelStamp } from "../../origin-channel.ts";
import { parseFrontmatterText } from "../../vault.ts";

/**
 * The closed vocabulary. `prompt-derived` names material an agent
 * produced from a prompt: session imports, MCP note writes, and the
 * in-process generation pipelines. The value is an on-disk spelling and
 * is load-bearing; it deliberately shares no substring with the origin
 * channel's field or values, so the two axes cannot be folded by a grep.
 */
export const CONTENT_CLASS = Object.freeze({
  promptDerived: "prompt-derived",
} as const);

export type ContentClass = (typeof CONTENT_CLASS)[keyof typeof CONTENT_CLASS];

/**
 * The membership list, exported so a refusal can NAME the vocabulary
 * instead of restating it - the same rule `ORIGIN_CHANNELS` follows.
 */
export const CONTENT_CLASSES: ReadonlyArray<ContentClass> = Object.freeze(
  Object.values(CONTENT_CLASS),
);

/**
 * The on-disk key. One constant because the stamp, the reserved-update
 * guard and the egress filter all spell it; a key that drifted between
 * them would be a key no reader could query on.
 */
export const CONTENT_CLASS_FIELD = "content_class";

/** Takes `unknown`: a value can arrive from frontmatter or a caller. */
export function isContentClass(value: unknown): value is ContentClass {
  return typeof value === "string" && (CONTENT_CLASSES as ReadonlyArray<string>).includes(value);
}

/** Raised by {@link resolveContentClass} for a value outside the vocabulary. */
export class ContentClassValueError extends Error {
  constructor(value: unknown) {
    super(
      `resolveContentClass: ${JSON.stringify(value)} is not a content class; ` +
        `the vocabulary is ${CONTENT_CLASSES.join(", ")}. A class is stamped by the ` +
        "writer that knows the material, never named by a caller.",
    );
    this.name = "ContentClassValueError";
  }
}

/**
 * The strict read: the class, or a named refusal. Write paths resolving
 * a class they are about to stamp go through here, so an internal
 * mistake surfaces by name instead of inventing an on-disk value.
 */
export function resolveContentClass(value: unknown): ContentClass {
  if (!isContentClass(value)) throw new ContentClassValueError(value);
  return value;
}

/**
 * The read side: the class a page carries, or `null` when it is
 * unmarked. Absence is the pre-stamp era and reads as unmarked; a value
 * outside the vocabulary reads as unmarked too (see the module
 * docblock). Never throws - this reads a disk an operator can edit.
 */
export function readContentClass(meta: FrontmatterMap): ContentClass | null {
  const value = meta[CONTENT_CLASS_FIELD];
  return isContentClass(value) ? value : null;
}

/**
 * The creation stamp for a write whose server-derived channel is known:
 * `prompt-derived` for material that arrived over the MCP transport,
 * `null` - stay unmarked, write no key - for everything else.
 *
 * The channel is the ONLY input. A CLI write and an unclaimed process
 * are the same answer, because the question is about the material, and
 * the channel is the one fact the process cannot be lied to about.
 */
export function contentClassCreationStamp(channel: OriginChannelStamp): ContentClass | null {
  return channel === ORIGIN_CHANNEL.mcpTool ? CONTENT_CLASS.promptDerived : null;
}

/**
 * Drop a caller-named class from frontmatter about to be written. Used
 * at the creation merge so a caller cannot forge the key on the way in;
 * the stamp (when there is one) is merged after it and wins regardless,
 * and on an unmarked write the key is simply absent - the honest byte.
 */
export function withoutCallerContentClass(frontmatter: FrontmatterMap): FrontmatterMap {
  if (frontmatter[CONTENT_CLASS_FIELD] === undefined) return frontmatter;
  const rest = { ...frontmatter };
  delete rest[CONTENT_CLASS_FIELD];
  return rest;
}

/**
 * Stamp `content_class: prompt-derived` onto a page an in-process
 * pipeline has just written.
 *
 * This exists for the generation writers whose bytes are composed by
 * their own writer function (the signal writer, for one, renders its
 * frontmatter internally and exposes no extension point), so the stamp
 * cannot ride the frontmatter map the way it does in `createNote`. It is
 * still a CREATION-time stamp: the caller invokes it on the same run
 * that wrote the page, the line is inserted as text so every other byte
 * of the just-written document survives untouched, the write is atomic,
 * and a page already carrying the class is a no-op. A file without a
 * frontmatter block is a named refusal rather than a silent miss - the
 * one state where the stamp could be quietly lost is the one state this
 * refuses to paper over.
 */
export function stampPromptDerivedLine(abs: string): void {
  const text = readFileSync(abs, "utf8");
  if (!text.startsWith("---\n")) {
    throw new Error(`stampPromptDerivedLine: ${abs} has no frontmatter block to stamp`);
  }
  const close = text.indexOf("\n---\n", 4);
  if (close < 0) {
    throw new Error(`stampPromptDerivedLine: ${abs} has an unterminated frontmatter block`);
  }
  if (readContentClass(parseFrontmatterText(text)[0]) !== null) return;
  const line = `${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n`;
  atomicWriteFileSync(abs, `${text.slice(0, close + 1)}${line}${text.slice(close + 1)}`);
}

/**
 * Whether the page at `vault`-relative `relPath` carries the reserved
 * class. The predicate the export verbs hand to the guard's
 * `egressContentClassSplit`: one page, one frontmatter read. A page that
 * cannot be read (deleted between collection and the split, or never a
 * page at all) reads as unmarked - the split omits what it can PROVE is
 * marked, and everything else stays on the export path it was on.
 */
export function isPromptDerivedPage(vault: string, relPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(vault, relPath), "utf8");
  } catch {
    return false;
  }
  return readContentClass(parseFrontmatterText(text)[0]) === CONTENT_CLASS.promptDerived;
}

/** How deep {@link treeCarriesPromptDerived} descends before it stops. */
const TREE_SEARCH_DEPTH = 8;

/**
 * Whether a JSON-shaped tree carries the reserved class anywhere - the
 * tripwire the transcript export walks each streamed record through.
 * Transcript records have no frontmatter and carry no class today, and
 * the day a producer adds one this is what keeps the corpus from
 * silently shipping (or silently emptying): the record is omitted and
 * named, or the export refuses. Depth-bounded so a pathological tree
 * cannot turn the check into a walk of unbounded cost; a class marker
 * deeper than that is not a record shape, it is data.
 */
export function treeCarriesPromptDerived(value: unknown, depth = 0): boolean {
  if (depth > TREE_SEARCH_DEPTH) return false;
  if (Array.isArray(value))
    return value.some((entry) => treeCarriesPromptDerived(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // The key names the field; a bare string elsewhere in the tree is
    // content, not a claim about itself.
    if (readContentClass(record as FrontmatterMap) !== null) return true;
    return Object.values(record).some((entry) => treeCarriesPromptDerived(entry, depth + 1));
  }
  return false;
}
