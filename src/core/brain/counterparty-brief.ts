/**
 * The counterparty brief core (dated commitments, t_43b0a379).
 *
 * One deterministic question: given a prompt, an operator-declared trigger
 * vocabulary and a vault, is there exactly ONE canonical counterparty the
 * prompt names, and if so, what dated, shareable facts does the vault hold
 * about them. The hook (hooks/counterparty-brief.ts) renders the answer
 * into a UserPromptSubmit `additionalContext` envelope; this module knows
 * nothing about hooks.
 *
 * Every refusal is a typed abstention, never a weaker match:
 *   - an empty trigger list abstains as `no_trigger` (the hook is inert
 *     without a vocabulary the operator declared);
 *   - a prompt carrying no trigger token abstains as `no_trigger`
 *     (deterministic WHOLE-token containment - a trigger never fires
 *     inside a longer word; the tokens are the operator's, in the
 *     operator's language; nothing here ships a natural-language
 *     word list, the standing refusal in status-scope.ts and
 *     visibility.ts);
 *   - zero canonical-scope entity matches abstain as `no_match`, and
 *     several as `ambiguous` (the exactly-one rule: a brief that fires
 *     on a weak match injects the wrong person's facts, so anything
 *     weaker than one confident match is silence).
 *
 * Items are shareable-only and dated: open pledges promised to the entity
 * (due-sorted, through `listPledges`) first, then recent preference pages
 * whose bodies anchor the entity, under named caps. A page whose
 * `visibility:` carries the reserved token is excluded REGARDLESS of the
 * caller's reach, because a hook-injected block leaves the machine; the
 * rule covers the counterparty's own entity page too, so a private record
 * can neither match nor block a match. An item drawn from two pages (a
 * pledge and the source it cites) inherits `strictestVisibilityOf`, so
 * disjoint token sets drop the item. A page the `readable` predicate
 * refuses contributes nothing and is not counted - identical to absent.
 *
 * Both walks are bounded: the preference walk reads at most
 * {@link BRIEF_PAGE_READ_CAP} pages and the pledge walk keeps at most
 * {@link BRIEF_PLEDGE_READ_CAP} and parses at most
 * {@link BRIEF_PLEDGE_SCAN_CAP}, each in the vault's stable (code-unit)
 * name order, so the hook's worst-case latency is bounded by the cap and
 * not by the size of the vault. The preference walk counts a page it
 * cannot read (`skippedReads` plus a typed degradation notice) - never
 * swallowed; the pledge walk inherits the family's soft-parse discipline
 * instead, so an unreadable or unparseable pledge page withholds its item
 * and drops out of the counterparty filter silently - the bounded window,
 * not the skip count, is the pledge walk's contract. The pledge walk's two
 * ceilings are separate on purpose: the kept window counts only the pages
 * the brief keeps, so a long tail of completed promises cannot crowd an
 * open one out, while the scan ceiling above it bounds the pages the walk
 * PARSES - the dropped ones included - so the filesystem work cannot grow
 * with the size of the pledge directory.
 *
 * Dates are dates: an item's date is a `YYYY-MM-DD` day, taken from a
 * pledge's due date or from the day a preference page was created. A value
 * that is not a calendar date renders as `undated`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { posix } from "node:path";

import { anchorEntityForms } from "./atomic-facts.ts";
import { type EntityLexiconHandle, type ValidateEntityLabelOptions } from "./entities/canonical.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { resolveEntityLexicon } from "./entities/lexicon.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./entities/status-scope.ts";
import type { BrainEntity } from "./entities/types.ts";
import { readLifecycleState } from "./lifecycle/tombstone.ts";
import { BRAIN_PREFERENCES_REL } from "./path-constants.ts";
import { validateIsoDate } from "./paths.ts";
import {
  listPledges,
  isSourcePage,
  normalizePledgeSource,
  pledgeRel,
  type PledgeListItem,
} from "./pledges.ts";
import { neutralizeSingleLine, untrustedFramingHeader } from "./untrusted-source.ts";
import {
  REMOTE_DENY_VISIBILITY_TOKEN,
  pageVisibility,
  strictestVisibilityOf,
} from "../graph/visibility.ts";
import {
  DEGRADATION_CODE,
  emitDegradationNotice,
  type DegradationNotice,
} from "../integrity/degradation.ts";
import { parseFrontmatterTextWithNotices, parseFrontmatterWithNotices } from "../vault.ts";

/**
 * The most items one brief may carry. Three dated lines is the injection
 * budget the hook contract promises ("at most three"); everything past it
 * stays in the vault, where search can still reach it.
 */
export const DEFAULT_BRIEF_ITEM_LIMIT = 3;

/** Per-item character cap (code points) on the rendered fact text. */
export const BRIEF_ITEM_CHAR_CAP = 280;

/**
 * Total character budget (code points) across the item texts. Once the
 * budget is spent - or the next item would not fit whole - the walk stops.
 * The budget is a backstop above the structural ceiling
 * (`DEFAULT_BRIEF_ITEM_LIMIT * (BRIEF_ITEM_CHAR_CAP + 1)`), so the item
 * limit - not the budget - is what normally clips a brief; a caller that
 * raises the limit past the ceiling hands the clipping to the budget.
 */
export const BRIEF_CHAR_BUDGET = 900;

/**
 * Page-read cap on the preference walk (the morning-brief discipline): at
 * most this many preference pages are read per brief, in the vault's
 * stable name order, before the walk gives up. The cap bounds the hook's
 * worst-case latency on a large vault; recency orders what was read.
 */
export const BRIEF_PAGE_READ_CAP = 24;

/**
 * Kept-window cap on the pledge walk, the same discipline as
 * {@link BRIEF_PAGE_READ_CAP} and the same value: at most this many pledge
 * pages the brief KEEPS, in the vault's stable name order. The cap bounds
 * the hook's worst-case latency on a large pledge directory - the arm used
 * to read every page in `Brain/pledges/` before the item limit applied,
 * while the sibling preference walk was already capped. Counted after the
 * fulfilled filter, so a completed promise spends no window an open one
 * needs; the pages the walk PARSES are bounded separately, by
 * {@link BRIEF_PLEDGE_SCAN_CAP}.
 */
export const BRIEF_PLEDGE_READ_CAP = 24;

/**
 * Scan ceiling on the pledge walk: at most this many pledge pages the walk
 * may PARSE, the pages it parses and then drops included. The kept window
 * ({@link BRIEF_PLEDGE_READ_CAP}) counts only the pages the brief keeps, so
 * without a scan ceiling a long tail of completed promises would make the
 * walk's filesystem work grow with the size of `Brain/pledges/` even though
 * it keeps nothing. The ceiling sits above the kept window, so the window
 * still has room to fill before the scan budget runs out.
 */
export const BRIEF_PLEDGE_SCAN_CAP = 96;

/** The length of the `YYYY-MM-DD` head of a date or timestamp. */
const ISO_DATE_HEAD_LENGTH = 10;

/**
 * The separator a POSIX-joined vault path never carries. A stored path
 * that carries it was spelled for another platform, so it names a path
 * the vault never wrote.
 */
const WINDOWS_PATH_SEPARATOR = "\\";

/**
 * A Windows drive-letter absolute path, in either separator spelling. A
 * stored vault path is POSIX-joined by convention, so a drive letter can
 * only mean a path outside the vault.
 */
const DRIVE_LETTER_PATH_RE = /^[A-Za-z]:[\\/]/u;

/** The degradation site the preference walk reports its read failures at. */
const DEGRADATION_SITE = "brain.counterpartyBrief.preferenceWalk";

/** One dated, shareable fact about the counterparty. */
export interface CounterpartyBriefItem {
  /** The item's date (`YYYY-MM-DD`): a pledge's due date, or the day a preference page was created; "" when undated. */
  readonly date: string;
  /** The bounded fact text (a pledge title, or a preference's principle). */
  readonly text: string;
  /** Vault-relative POSIX path of the page the fact is shown from. */
  readonly sourceRel: string;
}

/**
 * A typed abstention: the core's refusal, naming its cause. The reason
 * travels to the hook's audit line, so a prompt that named nobody stays
 * distinguishable from a prompt that named two.
 */
export type CounterpartyBriefAbstention = {
  readonly abstain: "no_trigger" | "no_match" | "ambiguous";
};

/** A brief for exactly one counterparty, or the typed abstention. */
export interface CounterpartyBrief {
  readonly entityId: string;
  readonly entityName: string;
  readonly items: ReadonlyArray<CounterpartyBriefItem>;
  /** Preference pages the walk could not read. Counted, never swallowed. */
  readonly skippedReads: number;
  /** One typed degradation notice per unreadable page. */
  readonly notices: ReadonlyArray<DegradationNotice>;
}

export interface CounterpartyBriefInput {
  /** The prompt text (or any text) the counterparty and trigger are read from. */
  readonly text: string;
  /** The operator-declared trigger vocabulary (machine-local config). */
  readonly triggers: ReadonlyArray<string>;
  /** Injected clock for the pledge listing's due math. */
  readonly now: Date;
  /**
   * May the caller read the vault page at this vault-relative path? A page
   * the predicate refuses contributes nothing and is not counted:
   * identical to absent.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The most items the brief may carry. Defaults to
   * {@link DEFAULT_BRIEF_ITEM_LIMIT}; a caller may raise it, and the
   * character budget then becomes the binding clip.
   */
  readonly itemLimit?: number;
}

/** The one normalization the trigger containment compares through. */
function normalizeToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * One Unicode letter-or-number run: the unit a trigger token matches
 * WHOLE. The segmentation is letter/number aware, so a non-ASCII word
 * stays one token and a trigger never matches inside a longer word.
 */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * The tokens of a normalized string, in order. A string that holds no
 * letter and no number holds no token at all.
 */
function tokenize(normalized: string): ReadonlyArray<string> {
  return normalized.match(TOKEN_RE) ?? [];
}

/**
 * Does the prompt carry the trigger's tokens, whole? A one-token trigger
 * matches a whole token of the prompt; a trigger the operator spelled
 * with a space names a SEQUENCE and matches a contiguous run of the
 * prompt's tokens. Nothing matches inside a longer word: "meet" fires on
 * "meet", never on "homeet" or "meetup".
 */
function promptCarriesTrigger(promptTokens: ReadonlyArray<string>, trigger: string): boolean {
  const triggerTokens = tokenize(trigger);
  if (triggerTokens.length === 0) return false;
  if (triggerTokens.length === 1) return promptTokens.includes(triggerTokens[0]!);
  for (let start = 0; start + triggerTokens.length <= promptTokens.length; start += 1) {
    const held = triggerTokens.every((token, offset) => promptTokens[start + offset] === token);
    if (held) return true;
  }
  return false;
}

/** A vault-relative POSIX path from an absolute one, whatever the host separator. */
function vaultRel(vault: string, abs: string): string {
  return relative(vault, abs).split(sep).join("/");
}

/**
 * Code-unit string order: the same order on every host, where
 * `localeCompare` varies with the host locale and would make the read
 * window - and with it the brief - depend on where the process runs.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Clip to the per-item cap on code points, so astral letters stay whole. */
function clipText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= BRIEF_ITEM_CHAR_CAP) return text;
  return `${codePoints.slice(0, BRIEF_ITEM_CHAR_CAP).join("")}…`;
}

/** The length of a string in code points, the unit the budget is specified in. */
function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * The one character-budget predicate, used by both arms: the next item's
 * text must fit WHOLE inside what is left of the budget. Tested before the
 * push, so a brief never carries more text than the budget allows.
 */
function fitsCharBudget(spent: number, text: string): boolean {
  return spent + codePointLength(text) <= BRIEF_CHAR_BUDGET;
}

/**
 * The `YYYY-MM-DD` day of a date or timestamp, or "" when the head is not a
 * valid calendar date. Soft by design: a hand-edited value degrades to an
 * undated item instead of crashing the walk, exactly like an undated
 * pledge. Only the head is read, so a value carrying extra characters
 * (a timestamp's time part, a forged second line) cannot widen the day.
 */
function isoDateHead(value: unknown): string {
  if (typeof value !== "string") return "";
  const head = value.trim().slice(0, ISO_DATE_HEAD_LENGTH);
  try {
    validateIsoDate(head);
    return head;
  } catch {
    return "";
  }
}

/**
 * Does the entity page carry the reserved visibility token? The check is
 * reach-independent, like the preference arm's: a hook-injected block
 * leaves the machine, so a private record may neither match nor block a
 * match. The gate FAILS CLOSED, the same discipline the pledge-source
 * gate applies: a page that cannot be read, or whose frontmatter parse
 * reports dropped lines, is treated as carrying the token - an unreadable
 * record is not shareable, so it may neither match nor block a match.
 */
function entityCarriesReservedToken(entity: BrainEntity): boolean {
  let text: string;
  try {
    text = readFileSync(entity.path, "utf8");
  } catch {
    return true;
  }
  const [meta, , notices] = parseFrontmatterTextWithNotices(text);
  if (notices.length > 0) return true;
  return pageVisibility(meta).includes(REMOTE_DENY_VISIBILITY_TOKEN);
}

/**
 * The exactly-one canonical entity the text names, or the abstention it
 * earned. Canonical scope only (`entityStatusInScope` - a quarantined
 * record never holds an identity a read resolves to), anchored by name or
 * alias through the shared occurrence kernel with the vault's
 * store-learned lexicon (resolved by the caller and threaded in, so the
 * brief reads the derived artifact once). An entity page the caller's
 * view refuses is treated as absent, so a withheld record can neither
 * match nor block a match; the same holds for an entity page carrying
 * the reserved visibility token, whatever the caller's reach. Zero
 * shareable matches abstain as `no_match`, more than one as `ambiguous`.
 */
function matchExactlyOneEntity(
  vault: string,
  input: CounterpartyBriefInput,
  lexicon: EntityLexiconHandle | null,
): BrainEntity | CounterpartyBriefAbstention {
  const trimmed = input.text.trim();
  if (trimmed === "") return { abstain: "no_match" };
  const matched: BrainEntity[] = [];
  for (const entity of buildEntityIndex(vault).entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    if (input.readable !== undefined && !input.readable(vaultRel(vault, entity.path))) continue;
    if (anchorEntityForms(trimmed, [entity.name, ...entity.aliases], { lexicon }).length === 0) {
      continue;
    }
    matched.push(entity);
  }
  // The reserved-token gate is applied AFTER the matching, so only the
  // pages that actually matched are read for it - and it removes a private
  // record from the set instead of letting it block the match beside it.
  const shareable = matched.filter((entity) => !entityCarriesReservedToken(entity));
  if (shareable.length === 1) return shareable[0]!;
  return { abstain: shareable.length === 0 ? "no_match" : "ambiguous" };
}

/**
 * The stored pledge source as the vault-relative path it names, or null
 * when the stored value escapes the vault.
 *
 * A stored vault path is POSIX-joined by convention, so a stored source
 * that carries a backslash separator was spelled for another platform:
 * it is refused before anything is read from it, whatever it would
 * resolve to. So is a source that is absolute in ANY spelling - a drive
 * letter (Windows) or a POSIX root - and so is one that still escapes
 * after normalization. The value is normalized exactly as the writers
 * normalize it, so the check and the read that follows agree on one
 * path.
 */
function pledgeSourceWithinVault(stored: string): string | null {
  if (stored.includes(WINDOWS_PATH_SEPARATOR)) return null;
  const source = normalizePledgeSource(stored);
  if (source.length === 0) return null;
  if (DRIVE_LETTER_PATH_RE.test(source)) return null;
  if (posix.isAbsolute(source)) return null;
  if (source.startsWith("..")) return null;
  return source;
}

/**
 * True when the absolute path names an existing regular file - the
 * predicate the pledge writers use for a cited source. A path that
 * cannot be stat'ed at all (a missing page, a directory, a path whose
 * parent is a file) is not a page, and the caller fails closed on it.
 */
function isRegularFile(abs: string): boolean {
  try {
    return isSourcePage(abs);
  } catch {
    return false;
  }
}

/**
 * One pledge item, or null when the item is not shareable. The item is
 * drawn from TWO pages - the pledge page and the source it cites - so the
 * strictest visibility of the two governs: either carrying the reserved
 * token, or two non-empty token sets that share nothing, drops the item
 * (the folded list is exactly the reserved token then). The pledge page's
 * OWN frontmatter is read with the notices its parse produced: a page whose
 * parse reports a dropped line - a hand edit that corrupted the
 * `visibility:` key - cannot be shown to be shareable, so the gate fails
 * closed and withholds the item. A source page the
 * `readable` predicate refuses withholds the whole item: a pledge citing
 * bytes the caller cannot see is not shown second-hand. The stored source
 * is normalized exactly as the writers normalize it before anything is
 * read from it, and an item whose source escapes the vault is dropped -
 * the walk never reads, nor renders, a path from outside the vault, in any
 * spelling (a backslash separator, a drive letter, a POSIX root, a `..`
 * escape). The cited source must also EXIST as a regular page inside the
 * vault: a source that was renamed, deleted or never written cannot be
 * shown to be shareable, so the item is withheld exactly like an
 * unreadable one. A cited source that cannot be read (or whose frontmatter
 * parse reports dropped lines) withholds the item too: the gate decides
 * whether the item may leave the machine, so it fails closed, the same
 * discipline the preference walk applies to its own pages. The item names
 * the cited source page, which is where the promise was read.
 */
function pledgeItem(
  vault: string,
  pledge: PledgeListItem,
  readable: ((rel: string) => boolean) | undefined,
): CounterpartyBriefItem | null {
  const [meta, , pledgeNotices] = parseFrontmatterWithNotices(pledge.path);
  // The pledge page decides whether its OWN item may leave the machine, so
  // the gate fails closed: a frontmatter parse that reports a dropped line
  // (a hand edit that corrupted the `visibility:` key) cannot be shown to
  // be shareable, so the item is withheld - the same discipline the
  // cited-source gate applies.
  if (pledgeNotices.length > 0) return null;
  const tagLists: ReadonlyArray<string>[] = [[...pageVisibility(meta)]];
  let sourceRel = pledgeRel(pledge.slug);
  if (pledge.source.length > 0) {
    const source = pledgeSourceWithinVault(pledge.source);
    if (source === null) return null;
    if (readable !== undefined && !readable(source)) return null;
    const sourceAbs = join(vault, source);
    // The cited page must be there: the item is drawn from two pages,
    // and a source that is gone (deleted, renamed, never written) leaves
    // its own shareability unprovable. The gate fails closed, so the
    // item is withheld rather than shared on the pledge page alone.
    if (!isRegularFile(sourceAbs)) return null;
    const [sourceMeta, , sourceNotices] = parseFrontmatterWithNotices(sourceAbs);
    if (sourceNotices.length > 0) return null;
    tagLists.push([...pageVisibility(sourceMeta)]);
    sourceRel = source;
  }
  const folded = strictestVisibilityOf(tagLists);
  if (folded.includes(REMOTE_DENY_VISIBILITY_TOKEN)) return null;
  return Object.freeze({
    date: pledge.due,
    text: clipText(pledge.title),
    sourceRel,
  });
}

/** The bounded fact text of a preference page: its principle, else its first body line. */
function preferenceText(meta: Readonly<Record<string, unknown>>, body: string): string {
  const principle = meta["principle"];
  if (typeof principle === "string" && principle.trim().length > 0) return principle.trim();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/** What one bounded walk of the preference directory found. */
interface PreferenceWalk {
  readonly items: ReadonlyArray<CounterpartyBriefItem>;
  /** Pages that could not be read (counted, never swallowed). */
  readonly skippedReads: number;
  /** One typed degradation notice per unreadable page. */
  readonly notices: ReadonlyArray<DegradationNotice>;
}

/**
 * The preference facts the bounded walk finds, newest first among the read
 * window. The walk reads at most {@link BRIEF_PAGE_READ_CAP} pages in the
 * vault's stable name order; a page the `readable` predicate refuses is
 * filtered BEFORE reading, so it spends neither a read nor an item. A page
 * whose frontmatter is malformed or missing contributes nothing, as does a
 * page carrying the reserved visibility token - the reserved-token check is
 * reach-independent by design, because the rendered block leaves the
 * machine - and as does a page that was tombstoned or superseded: the brief
 * renders current facts, so it wants the chain tips only, the same
 * exclusion the shared lifecycle predicate applies in recall / inject /
 * active.md / dream.
 */
function preferenceItems(
  vault: string,
  forms: ReadonlyArray<string>,
  anchorOpts: ValidateEntityLabelOptions,
  input: CounterpartyBriefInput,
): PreferenceWalk {
  const dir = join(vault, BRAIN_PREFERENCES_REL);
  const notices: DegradationNotice[] = [];
  if (!existsSync(dir)) return { items: [], skippedReads: 0, notices };
  const read: Array<{ item: CounterpartyBriefItem; date: string; name: string }> = [];
  let reads = 0;
  let skippedReads = 0;
  // Code-unit name order, the same order listPledges walks its directory
  // in: the read window - and so the brief - must not depend on the host's
  // ICU locale.
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    compareCodeUnits(a.name, b.name),
  )) {
    if (reads >= BRIEF_PAGE_READ_CAP) break;
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const rel = posix.join(BRAIN_PREFERENCES_REL, entry.name);
    if (input.readable !== undefined && !input.readable(rel)) continue;
    reads += 1;
    let text: string;
    try {
      text = readFileSync(join(dir, entry.name), "utf8");
    } catch (err) {
      // A page that cannot be read is skipped, but never silently: the
      // skip is counted and reported through the typed degradation
      // channel, so "this page says nothing" and "this page could not be
      // read" stay distinguishable.
      skippedReads += 1;
      emitDegradationNotice(notices, {
        code: DEGRADATION_CODE.frontmatterUnreadable,
        site: DEGRADATION_SITE,
        path: rel,
        detail: `preference page read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const [meta, body, pageNotices] = parseFrontmatterTextWithNotices(text);
    if (pageNotices.length > 0) continue;
    if (pageVisibility(meta).includes(REMOTE_DENY_VISIBILITY_TOKEN)) continue;
    const lifecycle = readLifecycleState(meta);
    if (lifecycle.tombstoned || lifecycle.supersededBy !== null) continue;
    if (anchorEntityForms(body, forms, anchorOpts).length === 0) continue;
    const date = isoDateHead(meta["created_at"]);
    read.push({
      date,
      name: entry.name,
      item: Object.freeze({
        date,
        text: clipText(preferenceText(meta, body)),
        sourceRel: rel,
      }),
    });
  }
  // Recent first among what was read; an undated page sorts last, and the
  // slug breaks ties so the order never depends on readdir timing.
  const items = read
    .toSorted((a, b) => {
      if (a.date !== b.date) return a.date > b.date ? -1 : 1;
      return compareCodeUnits(a.name, b.name);
    })
    .map((entry) => entry.item);
  return { items, skippedReads, notices };
}

/**
 * Build the brief for the prompt, or abstain with the typed reason. See
 * the module docblock for the abstention, shareability and cap contract.
 */
export function buildCounterpartyBrief(
  vault: string,
  input: CounterpartyBriefInput,
): CounterpartyBrief | CounterpartyBriefAbstention {
  const triggers = input.triggers.map(normalizeToken).filter((token) => token.length > 0);
  if (triggers.length === 0) return { abstain: "no_trigger" };
  const promptTokens = tokenize(input.text.normalize("NFC").toLowerCase());
  if (!triggers.some((trigger) => promptCarriesTrigger(promptTokens, trigger))) {
    return { abstain: "no_trigger" };
  }
  // The lexicon is resolved ONCE and threaded into the match: the derived
  // artifact is read a single time per brief, not once per walk.
  const lexicon = resolveEntityLexicon(vault);
  const match = matchExactlyOneEntity(vault, input, lexicon);
  if ("abstain" in match) return match;
  const entity = match;

  // A caller-supplied limit is clamped: a NaN, a zero or a negative
  // number would otherwise disable the limit outright and hand an
  // unbounded brief to the hook.
  const rawItemLimit = input.itemLimit ?? DEFAULT_BRIEF_ITEM_LIMIT;
  const itemLimit =
    Number.isInteger(rawItemLimit) && rawItemLimit > 0 ? rawItemLimit : DEFAULT_BRIEF_ITEM_LIMIT;
  const items: CounterpartyBriefItem[] = [];
  const notices: DegradationNotice[] = [];
  let spent = 0;
  let skippedReads = 0;
  // Open pledges promised to the entity first (listPledges is due-sorted),
  // then undated preference facts - the dated supply leads. The pledge
  // walk keeps at most BRIEF_PLEDGE_READ_CAP pages and parses at most
  // BRIEF_PLEDGE_SCAN_CAP, so a large pledge directory cannot make the
  // hook's work unbounded; listPledges refuses a page the predicate
  // withholds before parsing it and does not count it against either cap,
  // the same discipline as the preference walk.
  for (const pledge of listPledges(vault, {
    now: input.now,
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
    readCap: BRIEF_PLEDGE_READ_CAP,
    scanCap: BRIEF_PLEDGE_SCAN_CAP,
  })) {
    if (items.length >= itemLimit) break;
    if (!pledge.counterparties.includes(entity.id)) continue;
    const item = pledgeItem(vault, pledge, input.readable);
    if (item === null) continue;
    if (!fitsCharBudget(spent, item.text)) break;
    items.push(item);
    spent += codePointLength(item.text);
  }
  // The preference walk runs only when the budget can still hold an item:
  // with the budget spent, the one predicate refuses every item anyway.
  if (items.length < itemLimit && spent < BRIEF_CHAR_BUDGET) {
    const walk = preferenceItems(vault, [entity.name, ...entity.aliases], { lexicon }, input);
    skippedReads += walk.skippedReads;
    notices.push(...walk.notices);
    for (const item of walk.items) {
      if (items.length >= itemLimit) break;
      if (!fitsCharBudget(spent, item.text)) break;
      items.push(item);
      spent += codePointLength(item.text);
    }
  }
  return Object.freeze({
    entityId: entity.id,
    entityName: entity.name,
    items: Object.freeze(items),
    skippedReads,
    notices: Object.freeze(notices),
  });
}

/**
 * Render the brief for injection, or the empty string when there is nothing
 * to inject (the hook then emits nothing). Vault-derived text is framed
 * with the shared records-not-instructions header and every variable part
 * is neutralized single-line, so a hostile page cannot break the line shape
 * of the block.
 */
export function renderCounterpartyBrief(brief: CounterpartyBrief): string {
  if (brief.items.length === 0) return "";
  const lines = [
    untrustedFramingHeader(`counterparty-brief:${brief.entityId}`),
    `Counterparty brief for ${neutralizeSingleLine(brief.entityName)}:`,
    ...brief.items.map(
      (item) =>
        `- ${item.date === "" ? "undated" : neutralizeSingleLine(item.date)} ${neutralizeSingleLine(item.text)} ` +
        `(${neutralizeSingleLine(item.sourceRel)})`,
    ),
  ];
  return lines.join("\n");
}
