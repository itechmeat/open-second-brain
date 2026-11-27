/**
 * Hygiene below local reach is judged per action (change
 * `lane-reach-residuals`, design R11).
 *
 * Each hygiene action lists the members it would act on, on the fold of
 * every partition, before its first durable step:
 *
 *   - `merge`: the kept and the dropped preference (a merge rewrites no
 *     link of a lane page: it writes preference records, moves the drop to
 *     retired, and appends the preference audit and the merge log event);
 *   - `supersede`: the entity records whose name or alias is the claim's
 *     entity;
 *   - `recompile`: the page and the pages the recompile plan of the whole
 *     fold rederives or archives for it;
 *   - `archive` and `forget`: the page;
 *   - `retire`: the copies, the canonical page, every page whose links the
 *     retirement retargets, and every member the duplicate group of
 *     `detectors/document-dedup.ts` has on the whole fold;
 *   - a refresh entry: its page.
 *
 * Below local reach a member held in `private` (a lane entry whose winning
 * record is held there, or a preference the store holds as private), or a
 * fold that may miss a record, refuses that action with the fixed answer.
 * Nothing names the member. Outside that scope, and where lane pages are
 * files, nothing is read and the action runs as before.
 */

import { isAbsolute, join } from "node:path";

import { privateWithheld, withPrivateShown } from "../../store/caller-reach.ts";
import { lanePagesInStore } from "../../store/lane-entry-store.ts";
import { laneFoldIncomplete, wholeLaneStoreFold } from "../../store/lane-fold-cache.ts";
import { assertLaneWriteAtReach, LaneEntryWithheldError } from "../../store/lane-reach-guard.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import { retargetWikilinks } from "../page-dedup.ts";
import { storePreferencePages } from "../preference-page-write.ts";
import { storePreferenceEntry } from "../preference-store.ts";
import { planRecompile, type RecompileEntry } from "../recompile.ts";
import { detectDocumentDedup } from "./detectors/document-dedup.ts";
import type { HygieneFinding } from "./types.ts";

/** What one action acts on: lane pages (absolute paths) and preference slugs. */
interface ActionMembers {
  readonly pages: ReadonlyArray<string>;
  readonly preferences: ReadonlyArray<string>;
}

const NONE: ActionMembers = Object.freeze({ pages: [], preferences: [] });

/** Basename without the `.md` extension: the wikilink spelling of a page. */
function linkTarget(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/, "");
}

function absolute(vault: string, path: string): string {
  return isAbsolute(path) ? path : join(vault, path);
}

/** The entity records whose name or alias is the claim slot's entity. */
function supersedeMembers(vault: string, finding: HygieneFinding): ActionMembers {
  const slot = finding.targets[0] ?? "";
  const separator = slot.indexOf("#");
  if (separator <= 0) return NONE;
  const entity = normalizeEntityName(slot.slice(0, separator));
  let entities: ReturnType<typeof buildEntityIndex>["entities"] = [];
  try {
    entities = buildEntityIndex(vault).entities;
  } catch {
    // No readable registry: no entity record is touched.
  }
  const named = entities.filter((e) =>
    [e.name, ...e.aliases].some((name) => normalizeEntityName(name) === entity),
  );
  return { pages: named.map((e) => e.path), preferences: [] };
}

/** The page and what the whole fold's recompile plan does for it. */
function recompileMembers(vault: string, page: string | undefined): ActionMembers {
  if (page === undefined) return NONE;
  const entries = planRecompile(vault).entries.filter((entry) => entry.page === page);
  return { pages: [page, ...entries.map((entry) => entry.page)], preferences: [] };
}

/**
 * The copies, the canonical page, the pages whose links the retirement
 * retargets (a counting pass, which writes nothing) and the members of
 * every duplicate group the whole fold forms with any of them.
 */
function retireMembers(vault: string, finding: HygieneFinding, now: Date): ActionMembers {
  const canonical = finding.evidence["canonical"];
  const named = [...finding.targets, ...(typeof canonical === "string" ? [canonical] : [])];
  const copies = finding.targets.filter((target) => target !== canonical);
  const pages = new Set(named);
  const preferences = new Set<string>();
  if (typeof canonical === "string" && copies.length > 0) {
    const report = retargetWikilinks(
      vault,
      copies.map((copy) => ({ from: linkTarget(copy), to: linkTarget(canonical) })),
      { apply: false },
    );
    const slugOf = new Map(storePreferencePages(vault).map((page) => [page.rel, page.slug]));
    for (const rel of report.matched) {
      const slug = slugOf.get(rel);
      if (slug !== undefined) preferences.add(slug);
      else pages.add(rel);
    }
  }
  const mine = new Set(named);
  for (const group of detectDocumentDedup(vault, { now })) {
    const groupCanonical = group.evidence["canonical"];
    const members = [
      ...group.targets,
      ...(typeof groupCanonical === "string" ? [groupCanonical] : []),
    ];
    if (members.some((member) => mine.has(member))) {
      for (const member of members) pages.add(member);
    }
  }
  return { pages: [...pages], preferences: [...preferences] };
}

/** The members of `finding`'s action, read on the caller's current fold. */
function findingMembers(vault: string, finding: HygieneFinding, now: Date): ActionMembers {
  switch (finding.proposed_action) {
    case "merge":
      return {
        pages: [],
        preferences: finding.targets.slice(0, 2).map((id) => id.replace(/^pref-/, "")),
      };
    case "supersede":
      return supersedeMembers(vault, finding);
    case "recompile":
      return recompileMembers(vault, finding.targets[0]);
    case "archive":
    case "forget":
      return { pages: finding.targets.slice(0, 1), preferences: [] };
    case "retire":
      return retireMembers(vault, finding, now);
    default:
      return NONE;
  }
}

/**
 * Below local reach, refuse an action whose `members` (listed on the fold
 * of every partition by `list`) include a member held in `private`, or
 * any action while that fold may miss a record.
 */
function assertMembersAtReach(
  vault: string,
  list: () => ActionMembers,
  configPath: string | undefined,
): void {
  if (!privateWithheld() || !lanePagesInStore(vault, configPath)) return;
  if (laneFoldIncomplete(wholeLaneStoreFold(configPath))) throw new LaneEntryWithheldError();
  const members = withPrivateShown(list);
  if (members.preferences.some((slug) => storePreferenceEntry(slug, configPath)?.private)) {
    throw new LaneEntryWithheldError();
  }
  assertLaneWriteAtReach(
    vault,
    members.pages.map((page) => absolute(vault, page)),
    configPath,
  );
}

/**
 * Below local reach, refuse the hygiene action of `finding` with the fixed
 * answer when one of its members on the fold of every partition is held
 * in `private`. Call it before the action's first durable step.
 */
export function assertHygieneActionAtReach(
  vault: string,
  finding: HygieneFinding,
  now: Date,
  configPath?: string,
): void {
  assertMembersAtReach(vault, () => findingMembers(vault, finding, now), configPath);
}

/**
 * Below local reach, refuse the refresh of one recompile entry with the
 * fixed answer when its page is held in `private` on the fold of every
 * partition. Call it before the entry is rederived or archived.
 */
export function assertRecompileEntryAtReach(
  vault: string,
  entry: RecompileEntry,
  configPath?: string,
): void {
  assertMembersAtReach(vault, () => recompileMembers(vault, entry.page), configPath);
}
