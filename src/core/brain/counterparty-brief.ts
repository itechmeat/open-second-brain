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
 * caller's reach, because a hook-injected block leaves the machine; an
 * item drawn from two pages (a pledge and the source it cites) inherits
 * `strictestVisibilityOf`, so disjoint token sets drop the item. A page
 * the `readable` predicate refuses contributes nothing and is not counted
 * - identical to absent.
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
import { BRAIN_PREFERENCES_REL } from "./path-constants.ts";
import { listPledges, pledgeRel, type PledgeListItem } from "./pledges.ts";
import { neutralizeSingleLine, untrustedFramingHeader } from "./untrusted-source.ts";
import {
  REMOTE_DENY_VISIBILITY_TOKEN,
  pageVisibility,
  strictestVisibilityOf,
} from "../graph/visibility.ts";
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
 */
export const BRIEF_CHAR_BUDGET = 900;

/**
 * Page-read cap on the preference walk (the morning-brief discipline): at
 * most this many preference pages are read per brief, in the vault's
 * stable name order, before the walk gives up. The cap bounds the hook's
 * worst-case latency on a large vault; recency orders what was read.
 */
export const BRIEF_PAGE_READ_CAP = 24;

/** One dated, shareable fact about the counterparty. */
export interface CounterpartyBriefItem {
  /** The item's date (`YYYY-MM-DD`, a pledge due or a page created_at); "" when undated. */
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
 * The exactly-one canonical entity the text names, or null. Canonical scope
 * only (`entityStatusInScope` - a quarantined record never holds an identity
 * a read resolves to), anchored by name or alias through the shared
 * occurrence kernel with the vault's store-learned lexicon; an entity page
 * the caller's view refuses is treated as absent, so a withheld record can
 * neither match nor block a match.
 */
function matchExactlyOneEntity(vault: string, input: CounterpartyBriefInput): BrainEntity | null {
  const trimmed = input.text.trim();
  if (trimmed === "") return null;
  const lexicon = resolveEntityLexicon(vault);
  let match: BrainEntity | null = null;
  for (const entity of buildEntityIndex(vault).entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    if (input.readable !== undefined && !input.readable(vaultRel(vault, entity.path))) continue;
    if (anchorEntityForms(trimmed, [entity.name, ...entity.aliases], { lexicon }).length === 0) {
      continue;
    }
    if (match !== null) return null;
    match = entity;
  }
  return match;
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

/**
 * The preference facts the bounded walk finds, newest first among the read
 * window. The walk reads at most {@link BRIEF_PAGE_READ_CAP} pages in the
 * vault's stable name order; a page the `readable` predicate refuses is
 * filtered BEFORE reading, so it spends neither a read nor an item. A page
 * whose frontmatter is malformed or missing contributes nothing, as does a
 * page carrying the reserved visibility token - the reserved-token check is
 * reach-independent by design, because the rendered block leaves the
 * machine.
 */
function preferenceItems(
  vault: string,
  forms: ReadonlyArray<string>,
  anchorOpts: ValidateEntityLabelOptions,
  input: CounterpartyBriefInput,
): ReadonlyArray<CounterpartyBriefItem> {
  const dir = join(vault, BRAIN_PREFERENCES_REL);
  if (!existsSync(dir)) return [];
  const read: Array<{ item: CounterpartyBriefItem; createdAt: string; name: string }> = [];
  let reads = 0;
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
    } catch {
      continue;
    }
    const [meta, body, notices] = parseFrontmatterTextWithNotices(text);
    if (notices.length > 0) continue;
    if (pageVisibility(meta).includes(REMOTE_DENY_VISIBILITY_TOKEN)) continue;
    if (anchorEntityForms(body, forms, anchorOpts).length === 0) continue;
    const createdAt = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
    read.push({
      createdAt,
      name: entry.name,
      item: Object.freeze({
        date: createdAt,
        text: clipText(preferenceText(meta, body)),
        sourceRel: rel,
      }),
    });
  }
  // Recent first among what was read; an undated page sorts last, and the
  // slug breaks ties so the order never depends on readdir timing.
  return read
    .toSorted((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((entry) => entry.item);
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
  const items: CounterpartyBriefItem[] = [];
  let spent = 0;
  // Open pledges promised to the entity first (listPledges is due-sorted),
  // then undated preference facts - the dated supply leads.
  for (const pledge of listPledges(vault, {
    now: input.now,
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
  })) {
    if (items.length >= DEFAULT_BRIEF_ITEM_LIMIT || spent >= BRIEF_CHAR_BUDGET) break;
    if (!pledge.counterparties.includes(entity.id)) continue;
    const item = pledgeItem(vault, pledge, input.readable);
    if (item === null) continue;
    items.push(item);
    spent += item.text.length;
  }
  if (items.length < DEFAULT_BRIEF_ITEM_LIMIT && spent < BRIEF_CHAR_BUDGET) {
    for (const item of preferenceItems(
      vault,
      [entity.name, ...entity.aliases],
      { lexicon },
      input,
    )) {
      if (
        items.length >= DEFAULT_BRIEF_ITEM_LIMIT ||
        spent + item.text.length > BRIEF_CHAR_BUDGET
      ) {
        break;
      }
      items.push(item);
      spent += item.text.length;
    }
  }
  return Object.freeze({
    entityId: entity.id,
    entityName: entity.name,
    items: Object.freeze(items),
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
        `- ${item.date === "" ? "undated" : item.date} ${neutralizeSingleLine(item.text)} ` +
        `(${neutralizeSingleLine(item.sourceRel)})`,
    ),
  ];
  return lines.join("\n");
}
