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
 * Every refusal is an abstention (`null`), never a weaker match:
 *   - an empty trigger list abstains (the hook is inert without a
 *     vocabulary the operator declared);
 *   - a prompt carrying no trigger token abstains (deterministic token
 *     containment - the tokens are the operator's, in the operator's
 *     language; nothing here ships a natural-language word list, the
 *     standing refusal in status-scope.ts and visibility.ts);
 *   - zero or several canonical-scope entity matches abstain (the
 *     exactly-one rule: a brief that fires on a weak match injects the
 *     wrong person's facts, so anything weaker than one confident match
 *     is silence).
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
 * {@link BRIEF_PAGE_READ_CAP} pages and the pledge walk at most
 * {@link BRIEF_PLEDGE_READ_CAP}, each in the vault's stable name order, so
 * the hook's worst-case latency is bounded by the cap and not by the size
 * of the vault. A page that cannot be read is skipped AND counted
 * (`skippedReads` plus a typed degradation notice) - never swallowed.
 *
 * Dates are dates: an item's date is a `YYYY-MM-DD` day, taken from a
 * pledge's due date or from the day a preference page was created. A value
 * that is not a calendar date renders as `undated`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { posix } from "node:path";

import { anchorEntityForms } from "./atomic-facts.ts";
import { type ValidateEntityLabelOptions } from "./entities/canonical.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { resolveEntityLexicon } from "./entities/lexicon.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./entities/status-scope.ts";
import type { BrainEntity } from "./entities/types.ts";
import { readLifecycleState } from "./lifecycle/tombstone.ts";
import { BRAIN_PREFERENCES_REL } from "./path-constants.ts";
import { validateIsoDate } from "./paths.ts";
import { listPledges, pledgeRel, type PledgeListItem } from "./pledges.ts";
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
import { parseFrontmatter, parseFrontmatterTextWithNotices } from "../vault.ts";

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
 * Page-read cap on the pledge walk, the same discipline as
 * {@link BRIEF_PAGE_READ_CAP} and the same value: at most this many pledge
 * pages are parsed per brief, in the vault's stable name order. The cap
 * bounds the hook's worst-case latency on a large pledge directory - the
 * arm used to read every page in `Brain/pledges/` before the item limit
 * applied, while the sibling preference walk was already capped.
 */
export const BRIEF_PLEDGE_READ_CAP = 24;

/** The length of the `YYYY-MM-DD` head of a date or timestamp. */
const ISO_DATE_HEAD_LENGTH = 10;

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

/** A brief for exactly one counterparty, or the abstention null. */
export interface CounterpartyBrief {
  readonly entityId: string;
  readonly entityName: string;
  readonly items: ReadonlyArray<CounterpartyBriefItem>;
  /** Pages the walks could not read. Counted, never swallowed. */
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

/** A vault-relative POSIX path from an absolute one, whatever the host separator. */
function vaultRel(vault: string, abs: string): string {
  return relative(vault, abs).split(sep).join("/");
}

/** Clip to the per-item cap on code points, so astral letters stay whole. */
function clipText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= BRIEF_ITEM_CHAR_CAP) return text;
  return `${codePoints.slice(0, BRIEF_ITEM_CHAR_CAP).join("")}…`;
}

/**
 * The one character-budget predicate, used by both arms: the next item's
 * text must fit WHOLE inside what is left of the budget. Tested before the
 * push, so a brief never carries more text than the budget allows.
 */
function fitsCharBudget(spent: number, text: string): boolean {
  return spent + text.length <= BRIEF_CHAR_BUDGET;
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
 * match. A page that cannot be read carries no token and answers false.
 */
function entityCarriesReservedToken(entity: BrainEntity): boolean {
  const [meta] = parseFrontmatter(entity.path);
  return pageVisibility(meta).includes(REMOTE_DENY_VISIBILITY_TOKEN);
}

/**
 * The exactly-one canonical entity the text names, or null. Canonical scope
 * only (`entityStatusInScope` - a quarantined record never holds an identity
 * a read resolves to), anchored by name or alias through the shared
 * occurrence kernel with the vault's store-learned lexicon. An entity page
 * the caller's view refuses is treated as absent, so a withheld record can
 * neither match nor block a match; the same holds for an entity page
 * carrying the reserved visibility token, whatever the caller's reach.
 */
function matchExactlyOneEntity(vault: string, input: CounterpartyBriefInput): BrainEntity | null {
  const trimmed = input.text.trim();
  if (trimmed === "") return null;
  const lexicon = resolveEntityLexicon(vault);
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
  return shareable.length === 1 ? shareable[0]! : null;
}

/**
 * One pledge item, or null when the item is not shareable. The item is
 * drawn from TWO pages - the pledge page and the source it cites - so the
 * strictest visibility of the two governs: either carrying the reserved
 * token, or two non-empty token sets that share nothing, drops the item
 * (the folded list is exactly the reserved token then). A source page the
 * `readable` predicate refuses withholds the whole item: a pledge citing
 * bytes the caller cannot see is not shown second-hand. The item names the
 * cited source page, which is where the promise was read.
 */
function pledgeItem(
  vault: string,
  pledge: PledgeListItem,
  readable: ((rel: string) => boolean) | undefined,
): CounterpartyBriefItem | null {
  const [meta] = parseFrontmatter(pledge.path);
  const tagLists: ReadonlyArray<string>[] = [[...pageVisibility(meta)]];
  if (pledge.source.length > 0) {
    if (readable !== undefined && !readable(pledge.source)) return null;
    const sourceAbs = join(vault, pledge.source);
    if (existsSync(sourceAbs)) {
      const [sourceMeta] = parseFrontmatter(sourceAbs);
      tagLists.push([...pageVisibility(sourceMeta)]);
    }
  }
  const folded = strictestVisibilityOf(tagLists);
  if (folded.includes(REMOTE_DENY_VISIBILITY_TOKEN)) return null;
  return Object.freeze({
    date: pledge.due,
    text: clipText(pledge.title),
    sourceRel: pledge.source.length > 0 ? pledge.source : pledgeRel(pledge.slug),
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
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
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
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((entry) => entry.item);
  return { items, skippedReads, notices };
}

/**
 * Build the brief for the prompt, or abstain with null. See the module
 * docblock for the abstention, shareability and cap contract.
 */
export function buildCounterpartyBrief(
  vault: string,
  input: CounterpartyBriefInput,
): CounterpartyBrief | null {
  const triggers = input.triggers.map(normalizeToken).filter((token) => token.length > 0);
  if (triggers.length === 0) return null;
  const haystack = input.text.normalize("NFC").toLowerCase();
  if (!triggers.some((token) => haystack.includes(token))) return null;
  const entity = matchExactlyOneEntity(vault, input);
  if (entity === null) return null;

  const lexicon = resolveEntityLexicon(vault);
  const itemLimit = input.itemLimit ?? DEFAULT_BRIEF_ITEM_LIMIT;
  const items: CounterpartyBriefItem[] = [];
  const notices: DegradationNotice[] = [];
  let spent = 0;
  let skippedReads = 0;
  // Open pledges promised to the entity first (listPledges is due-sorted),
  // then undated preference facts - the dated supply leads. The pledge
  // walk reads at most BRIEF_PLEDGE_READ_CAP pages, so a large pledge
  // directory cannot make the hook's work unbounded; listPledges refuses a
  // page the predicate withholds before parsing it and does not count it
  // against the cap, the same discipline as the preference walk.
  for (const pledge of listPledges(vault, {
    now: input.now,
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
    readCap: BRIEF_PLEDGE_READ_CAP,
  })) {
    if (items.length >= itemLimit) break;
    if (!pledge.counterparties.includes(entity.id)) continue;
    const item = pledgeItem(vault, pledge, input.readable);
    if (item === null) continue;
    if (!fitsCharBudget(spent, item.text)) break;
    items.push(item);
    spent += item.text.length;
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
      spent += item.text.length;
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
