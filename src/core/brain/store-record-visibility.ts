/**
 * The visibility of a store record that a reference names (design D14
 * item 18, task 2.10). On a store-only machine a preference or a signal is
 * a record of the folds, not a file: a reference to one resolves to the
 * path its page would have (`artifact-ref-resolve.ts`), and no file is
 * there to read. The reach and ownership views ask here first, so such a
 * record is judged by its own partition and fields:
 *
 *  - at a reach: a record of the `private` partition, or one whose fields
 *    reserve it (`visibility:` or an informal privacy marker), is withheld
 *    below local reach; a shared record is readable like an open page;
 *  - under an owner scope: the record's `owner:` field, by the rule a
 *    page's `owner:` follows.
 *
 * Any other path (`undefined` from the lookup) is a vault page and keeps
 * its file-based judgement. The page views are built once per view.
 */

import { isOwnerVisible, pageOwner } from "../graph/agent-scope.ts";
import type { ArtifactRef, ArtifactRefView } from "./artifact-ref-view.ts";
import { remoteDenyVisibilityTokens } from "../graph/privacy-markers.ts";
import { isRemotelyReadable, REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import type { TransportReach } from "../graph/transport-reach.ts";
import { memoryFromStore, type StoreMemoryPage, storeRecordPages } from "./memory-pages.ts";
import { join } from "node:path";
import { laneEntryInPrivate, laneVaultRoot, readLanePage } from "../store/lane-pages.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";
import { ANCHORED_WIKILINK_RE, stripBrainIdPrefix, stripWikilinkDecoration } from "./wikilink.ts";

/** The store record whose page would sit at a vault-relative path. */
export type StoreRecordLookup = (rel: string) => StoreMemoryPage | undefined;

/** A lookup over the store's records, or `null` on a machine that reads the legacy tree. */
export function storeRecordLookup(vault: string | null): StoreRecordLookup | null {
  if (vault !== null && !memoryFromStore(vault)) return null;
  let byRel: Map<string, StoreMemoryPage> | null = null;
  return (rel) => {
    byRel ??= new Map(
      storeRecordPages(vault, { signalStates: "all" }).map((page) => [page.rel, page] as const),
    );
    return byRel.get(rel.replace(/\\/g, "/"));
  };
}

/**
 * What a visibility rule reads of a record: its vault-relative page path,
 * its fields as frontmatter, and whether the store holds it in `private`.
 * A memory record's page and a record-lane page (`lanePageVisible`) both
 * have it, so every view judges both by its own rule.
 */
export type VisibilityRecord = Pick<StoreMemoryPage, "rel" | "meta" | "private">;

/** Whether a store record may be read at `reach`. */
export function isStoreRecordReadableAtReach(
  page: VisibilityRecord,
  reach: TransportReach,
): boolean {
  const tokens = [...remoteDenyVisibilityTokens(page.meta)];
  if (page.private && !tokens.includes(REMOTE_DENY_VISIBILITY_TOKEN)) {
    tokens.push(REMOTE_DENY_VISIBILITY_TOKEN);
  }
  return isRemotelyReadable(tokens, reach);
}

/** Whether a store record is visible under the owner scope `scope`. */
export function isStoreRecordOwnerVisible(page: VisibilityRecord, scope: string): boolean {
  return isOwnerVisible(pageOwner(page.meta), scope);
}

/**
 * A reference view for a machine with no vault (design D14): every memory
 * page is a store record, so a reference resolves to the record it names,
 * by vault-relative page path or by id (`[[pref-x]]`, `pref-x`,
 * `Brain/preferences/pref-x.md`), and `pageVisible` judges it. A
 * reference that names no record names nothing that could be hidden, as a
 * bare id with no artifact on disk does on a vault.
 */
export function storeRecordRefView(
  pageVisible: (page: VisibilityRecord) => boolean,
): ArtifactRefView {
  let pages: {
    byRel: Map<string, StoreMemoryPage>;
    byId: Map<string, StoreMemoryPage>;
    bySlug: Map<string, StoreMemoryPage>;
  } | null = null;
  const lookup = (spelled: string): StoreMemoryPage | undefined => {
    if (pages === null) {
      const all = storeRecordPages(null, { signalStates: "all" });
      pages = {
        byRel: new Map(all.map((page) => [page.rel, page] as const)),
        byId: new Map(all.map((page) => [page.id, page] as const)),
        // `pref-x` and `ret-x` are one preference: a reference written
        // before a retire (`[[pref-x]]`) still names the retired record.
        bySlug: new Map(
          all
            .filter((page) => page.kind !== "signal")
            .map((page) => [stripBrainIdPrefix(page.id), page] as const),
        ),
      };
    }
    const base = spelled.replace(/^.*\//, "").replace(/\.md$/, "");
    return (
      pages.byRel.get(spelled) ??
      pages.byId.get(base) ??
      (/^(pref|ret)-/.test(base) ? pages.bySlug.get(stripBrainIdPrefix(base)) : undefined)
    );
  };
  // One verdict per lane page per view: a long result list naming the same
  // pages reads and parses each once.
  const laneVerdicts = new Map<string, boolean>();
  const laneVisible = (rel: string): boolean => {
    let verdict = laneVerdicts.get(rel);
    if (verdict === undefined) {
      verdict = lanePageVisible(rel, pageVisible);
      laneVerdicts.set(rel, verdict);
    }
    return verdict;
  };
  const visible = (ref: ArtifactRef): boolean => {
    if (ref === null || ref === undefined || ref.length === 0) return true;
    const spelled = refTarget(ref);
    const page = lookup(spelled);
    if (page !== undefined) return pageVisible(page);
    // A path into `Brain/` that names no memory record is a record-lane
    // page (a decision, a pledge, a tension): judged by its own record's
    // visibility, and hidden when there is none (fail closed). A bare id
    // that names nothing names nothing that could be hidden.
    if (spelled.startsWith(`${BRAIN_ROOT_REL}/`)) return laneVisible(spelled);
    return true;
  };
  return Object.freeze({
    filtersNothing: false,
    visible,
    row: (...refs: ReadonlyArray<ArtifactRef>) => refs.every(visible),
    keep: <T>(rows: ReadonlyArray<T>, refsOf: (r: T) => ReadonlyArray<ArtifactRef>) =>
      rows.filter((r) => refsOf(r).every(visible)),
  });
}

/**
 * The target a reference spells, parsed as the vault view and the
 * write-side judge parse it: the anchored wikilink body, alias and anchor
 * removed, POSIX separators.
 */
function refTarget(ref: string): string {
  const anchored = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return stripWikilinkDecoration(anchored === null ? ref : anchored[1]!).replace(/\\/g, "/");
}

/**
 * Whether the record-lane page at `Brain/`-rooted `rel` is visible: its
 * record, judged by the view's own rule (`pageVisible`: the reach, the
 * owner scope, the reader's paths) over its fields and its partition, and
 * hidden when there is none (fail closed). A reference that leaves the
 * `Brain/` tree (a `..` or `.` segment) names no lane page and is hidden
 * without reading anything, so a caller cannot probe the device's files.
 */
function lanePageVisible(rel: string, pageVisible: (page: VisibilityRecord) => boolean): boolean {
  const segments = rel.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return false;
  }
  const root = laneVaultRoot(null);
  let page;
  let held: boolean;
  try {
    const path = ensureInsideVault(join(root, ...segments), join(root, BRAIN_ROOT_REL));
    page = readLanePage(root, path);
    held = page !== null && laneEntryInPrivate(root, path);
  } catch {
    return false;
  }
  if (page === null) return false;
  return pageVisible({ rel, meta: page.frontmatter, private: held });
}
