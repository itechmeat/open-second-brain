/**
 * Where a record-lane entry lives in the legacy tree, and back (design
 * D14 item 2). A lane entry is addressed by its legacy page path: the lane
 * is the top folder under `Brain/` (a page directly in `Brain/` belongs to
 * the lane `brain`), and the entry id is the path inside that folder, with
 * a `.md` extension dropped and any other extension kept. So
 * `Brain/dead-ends/archive/de-x.md` is lane `dead-ends`, entry
 * `archive/de-x`, and `Brain/entities/lexicon.json` is lane `entities`,
 * entry `lexicon.json`.
 *
 * A few folders are named differently from their lane: the ones the
 * migration gives a lane of their own (exact-state pages, skill benchmarks,
 * standing rules, write sessions). The one table here serves the
 * migration, the lane page store and the rollback exporter alike.
 */

import { laneNameOf } from "./lane-records.ts";

/** The lane of every page directly in `Brain/`. */
export const ROOT_LANE = "brain";

const MD = ".md";

/** Extensions an entry id keeps: the files of a lane that are not pages. */
const KEPT_EXTENSION_RE = /\.(?:json|jsonl|yaml|yml|txt|base|csv)$/;

/** Folders whose lane is not their own name, and the one root file with a lane. */
const FOLDER_LANES: Readonly<Record<string, string>> = Object.freeze({
  state: "exact-state",
  "skill-benchmarks": "skill-benchmark",
  "standing-rules": "standing-rule",
  ".sessions": "write-session",
  // Redacted source texts (the migration's blob lane, `surface-map.ts`).
  ".archives": "source-archive",
});

/** The root file the standing-rule lane also holds, as its entry id. */
const ROOT_FILE_LANES: Readonly<Record<string, { lane: string; entry: string }>> = Object.freeze({
  "standing-rules.md": { lane: "standing-rule", entry: "standing-rules" },
});

const LANE_FOLDERS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(FOLDER_LANES).map(([folder, lane]) => [lane, folder])),
);

/** The lane of a top folder under `Brain/`. */
export function laneOfFolder(folder: string): string {
  return FOLDER_LANES[folder] ?? laneNameOf(folder);
}

/** The top folder under `Brain/` a lane's entries live in. */
export function folderOfLane(lane: string): string {
  return LANE_FOLDERS[lane] ?? lane;
}

/** The entry id of a path inside its lane folder: `.md` dropped, other extensions kept. */
export function entryOfPath(inLane: string): string {
  return inLane.endsWith(MD) ? inLane.slice(0, -MD.length) : inLane;
}

/**
 * The lane and entry of a `Brain/`-relative path (`/`-separated), or null
 * for a path that names no entry (empty, or the root itself).
 */
export function lanePlaceOf(brainRel: string): { lane: string; entry: string } | null {
  const segments = brainRel.split("/").filter((s) => s !== "");
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    const special = ROOT_FILE_LANES[segments[0]!];
    if (special !== undefined) return special;
    return { lane: ROOT_LANE, entry: entryOfPath(segments[0]!) };
  }
  const [folder, ...rest] = segments as [string, ...string[]];
  return { lane: laneOfFolder(folder), entry: entryOfPath(rest.join("/")) };
}

/** The `Brain/`-relative path of an entry (`/`-separated). */
export function brainRelOfEntry(lane: string, entry: string): string {
  for (const [file, place] of Object.entries(ROOT_FILE_LANES)) {
    if (place.lane === lane && place.entry === entry) return file;
  }
  const file = KEPT_EXTENSION_RE.test(entry) ? entry : `${entry}${MD}`;
  return lane === ROOT_LANE ? file : `${folderOfLane(lane)}/${file}`;
}
