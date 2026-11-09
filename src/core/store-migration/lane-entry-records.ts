/**
 * The store records of record-lane entries (design D14 items 2 and 4):
 * every Brain lane with no record kind of its own becomes `lane-entry`
 * records (`store/lane-records.ts`), and so do the files of the two blob
 * surfaces, whose text the appender spills into content-addressed blobs.
 *
 * Privacy follows the page's own visibility markers (`isPrivatePageFile`,
 * the frontmatter rule search uses), then the fail-closed reference rule
 * over its fields and text (`rowNamesPrivatePage`), both imported from the
 * phase 1 modules.
 *
 * Authority: standing rules are human-authored (`human`); any other entry
 * is `agent`, unless its page records a human decision
 * (`pageRecordsHumanDecision`).
 */

import { isPrivateFrontmatter, isPrivatePageFile } from "../store/dual-write-records.ts";
import { laneEntryRecord, STANDING_RULE_LANE } from "../store/lane-records.ts";
import { opaqueFields } from "../store/operation-privacy.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import type { LegacyItem, RecordFromItem } from "./destinations.ts";
import {
  LEGACY_SEED_AUTHORITY,
  LegacyItemShapeError,
  pageRecordsHumanDecision,
} from "./row-records.ts";

/** Fields of an entry that are stamps and ids, never page references. */
const ENTRY_OPAQUE_FIELDS = opaqueFields("slug", "date", "valid_from", "content_hash", "revision");

function entryOf(item: LegacyItem): Extract<LegacyItem, { shape: "entry" }> {
  if (item.shape !== "entry") throw new LegacyItemShapeError("not a lane entry");
  return item;
}

function agentOf(fields: Readonly<Record<string, unknown>>): string | undefined {
  const agent = fields["agent"];
  return typeof agent === "string" && agent.trim() !== "" ? agent.trim() : undefined;
}

/** One record-lane entry: a page, a JSON file or a text file. */
export const laneEntryItem: RecordFromItem = (vault, item) => {
  const entry = entryOf(item);
  const isPage = entry.path.endsWith(".md");
  const isPrivate =
    (isPage ? isPrivatePageFile(entry.path) : isPrivateFrontmatter(entry.fields)) ||
    rowNamesPrivatePage(vault, { fields: entry.fields, text: entry.text }, ENTRY_OPAQUE_FIELDS);
  const authority =
    entry.lane === STANDING_RULE_LANE || pageRecordsHumanDecision(entry.fields)
      ? "human"
      : LEGACY_SEED_AUTHORITY;
  const agent = agentOf(entry.fields);
  return laneEntryRecord({
    lane: entry.lane,
    entry: entry.entry,
    fields: entry.fields,
    text: entry.text,
    authority,
    ...(agent !== undefined ? { agent } : {}),
    private: isPrivate,
  });
};

/**
 * One file of a blob surface (source archives, write images): a copy of
 * note or source text, so it goes to `private` when this machine holds
 * it, and to `shared` only when nothing marks it private: no visibility
 * marker in its frontmatter (a `.md` file's frontmatter is already split
 * into `fields`), no region and no reference to a private page. Its file
 * name, the content hash, is the entry id.
 */
export const blobFileItem: RecordFromItem = (vault, item) => {
  const entry = entryOf(item);
  const namesPrivate =
    isPrivateFrontmatter(entry.fields) ||
    rowNamesPrivatePage(vault, { fields: entry.fields, text: entry.text }, ENTRY_OPAQUE_FIELDS);
  return laneEntryRecord({
    lane: entry.lane,
    entry: entry.entry,
    fields: entry.fields,
    text: entry.text,
    authority: LEGACY_SEED_AUTHORITY,
    private: namesPrivate,
    privateWhenHeld: true,
  });
};
