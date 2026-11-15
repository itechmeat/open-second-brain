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
const KEPT_EXTENSIONS = Object.freeze(["json", "jsonl", "yaml", "yml", "txt", "base", "csv"]);
const KEPT_EXTENSION_RE = new RegExp(`\\.(?:${KEPT_EXTENSIONS.join("|")})$`);

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

/** Whether an entry id is a file name as it stands, with no `.md` to add back. */
function keepsItsName(entry: string): boolean {
  return KEPT_EXTENSION_RE.test(entry) || entry.endsWith(MD);
}

/**
 * The entry id of a path inside its lane folder: `.md` dropped, other
 * extensions kept, and the whole name kept for a page whose name without
 * `.md` would read as a kept file (`x.json.md`).
 */
export function entryOfPath(inLane: string): string {
  if (!inLane.endsWith(MD)) return inLane;
  const stem = inLane.slice(0, -MD.length);
  return keepsItsName(stem) ? inLane : stem;
}

function placeOfSegments(segments: ReadonlyArray<string>): { lane: string; entry: string } {
  if (segments.length === 1) {
    const special = ROOT_FILE_LANES[segments[0]!];
    if (special !== undefined) return special;
    return { lane: ROOT_LANE, entry: entryOfPath(segments[0]!) };
  }
  const [folder, ...rest] = segments as [string, ...string[]];
  return { lane: laneOfFolder(folder), entry: entryOfPath(rest.join("/")) };
}

/**
 * Why the `Brain/`-relative path `brainRel` (`/`-separated) names no lane
 * entry, or null when it names one. A path names no entry when it is
 * empty (the root itself) or when its place would not turn back into the
 * same path (see the module comment).
 */
export function laneNameRefusal(brainRel: string): string | null {
  const segments = brainRel.split("/").filter((s) => s !== "");
  if (segments.length === 0) return "the Brain root is not a lane entry";
  const place = placeOfSegments(segments);
  const back = place.entry === "" ? null : brainRelOfEntry(place.lane, place.entry);
  if (back === segments.join("/")) return null;
  return (
    `the name ${segments.join("/")} does not map to a lane entry and back ` +
    `(lane ${place.lane}, entry ${place.entry === "" ? "(empty)" : place.entry}` +
    `${back === null ? "" : `, which maps back to ${back}`}); a lane entry is a .md page ` +
    `or a file ending in .${KEPT_EXTENSIONS.join(", .")}, in a folder named as its lane`
  );
}

/**
 * The lane and entry of a `Brain/`-relative path (`/`-separated), or null
 * for a path that names no entry: empty, the root itself, or a name that
 * does not round-trip ({@link laneNameRefusal}).
 */
export function lanePlaceOf(brainRel: string): { lane: string; entry: string } | null {
  if (laneNameRefusal(brainRel) !== null) return null;
  return placeOfSegments(brainRel.split("/").filter((s) => s !== ""));
}

/** The `Brain/`-relative path of an entry (`/`-separated). */
export function brainRelOfEntry(lane: string, entry: string): string {
  for (const [file, place] of Object.entries(ROOT_FILE_LANES)) {
    if (place.lane === lane && place.entry === entry) return file;
  }
  const file = keepsItsName(entry) ? entry : `${entry}${MD}`;
  return lane === ROOT_LANE ? file : `${folderOfLane(lane)}/${file}`;
}

/**
 * The place a legacy path whose top folder is spelled otherwise than its
 * lane name (`My Notes/x.md`, `project_x/x.md`: case, spaces, other
 * separators) takes in the store: the normalized lane (`my-notes`) and
 * the entry of the rest of the path, or null for any other path. Such a
 * path is refused by {@link lanePlaceOf}, since the entry would turn back
 * into the normalized folder; the migration imports it here and keeps the
 * original path in the record's `migrated` mark, which is where a
 * rollback writes it back. Null as well when the normalized name is no
 * plain lane (the root lane, another folder's lane, or no lane name at
 * all), and when the rest of the path does not round-trip; the caller
 * also refuses a folder whose normalized lane another folder of the tree
 * takes.
 */
export function normalizedFolderPlace(brainRel: string): { lane: string; entry: string } | null {
  const segments = brainRel.split("/").filter((s) => s !== "");
  if (segments.length < 2) return null;
  const [folder, ...rest] = segments as [string, ...string[]];
  if (FOLDER_LANES[folder] !== undefined) return null;
  const lane = laneNameOf(folder);
  if (lane === folder || lane === ROOT_LANE || laneNameOf(lane) !== lane) return null;
  if (
    folder
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") !== lane
  ) {
    return null;
  }
  if (laneOfFolder(lane) !== lane || folderOfLane(lane) !== lane) return null;
  const inLane = rest.join("/");
  const entry = entryOfPath(inLane);
  if (entry === "" || brainRelOfEntry(lane, entry) !== `${lane}/${inLane}`) return null;
  return { lane, entry };
}

/**
 * The top folders among `folders` (names directly under `Brain/`) whose
 * pages the migration files under `lane` besides `folder`: a rival of a
 * respelled folder. A dot-folder is no rival (the catch-all claims none
 * of its pages), and a folder whose lane is another name (`state` is
 * `exact-state`, `.archives` is `source-archive`) takes that lane, not its
 * spelling.
 */
export function laneFolderRivals(
  folders: ReadonlyArray<string>,
  folder: string,
  lane: string,
): string[] {
  return folders.filter((f) => f !== folder && !f.startsWith(".") && laneOfFolder(f) === lane);
}
