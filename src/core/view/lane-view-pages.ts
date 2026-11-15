/**
 * Report and source pages of the human view (design D7 "Pages"; spec
 * brain-store "Report stored"; task 3.2): `reports/<entry>.md` for every
 * research report and `sources/<entry>.md` for every ingested source
 * summary, rendered from their `lane-entry` records (the lanes `reports`
 * and `sources`) in the `shared` partition.
 *
 * A page shows the entry's title, one generated line (in the view
 * language) with its day, and the entry's Markdown body as written, with
 * Obsidian-only links turned into their plain text. A body line's key is
 * a hash of its text and its occurrence, so a correction the user makes
 * to a line follows it while the report keeps that line, and lapses when
 * a rewrite of the report drops it.
 *
 * Left out: a removed entry, one whose fields reserve it as private, one
 * whose record carries a `<private>` region, and an entry id that is not
 * a plain file name.
 */

import { sha256Hex } from "../integrity/digest.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  type LaneEntryValue,
} from "../store/lane-records.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { isPrivateFrontmatter } from "../store/private-page.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { compareCodeUnits } from "../store/compare.ts";
import { VIEW_PAGE_EXT, VIEW_REPORTS_DIR, VIEW_SOURCES_DIR } from "./constants.ts";
import type { ViewStrings } from "./i18n.ts";
import { RESERVED_DEVICE_NAME_RE } from "./page-path.ts";
import { idLine, plainText, type PageLine, type PageModel } from "./pages.ts";

/** The lanes whose entries the view renders, and their folder. */
const LANES = Object.freeze([
  { lane: "reports", dir: VIEW_REPORTS_DIR },
  { lane: "sources", dir: VIEW_SOURCES_DIR },
] as const);

/** An entry id that is a plain file name: dot-separated runs of letters, digits, `_` and `-`. */
const ENTRY_RE = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const BLANK: PageLine = { key: null, text: "" };

function field(value: LaneEntryValue, name: string): string | null {
  const v = value.fields[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A body line with its Obsidian-only links written as plain text. */
function plainLine(line: string): string {
  return line
    .replaceAll(WIKILINK_RE, (_all, target: string, alias: string | undefined) =>
      (alias ?? target).trim(),
    )
    .trimEnd();
}

function bodyLines(prefix: string, text: string, title: string): PageLine[] {
  const raw = text.replaceAll(/\r\n?/g, "\n").split("\n").map(plainLine);
  // The body's own title heading is the page title already.
  const first = raw.findIndex((l) => l.trim() !== "");
  if (first >= 0 && raw[first]!.replace(/^#+\s*/, "").trim() === title) raw.splice(0, first + 1);
  while (raw.length > 0 && raw[0]!.trim() === "") raw.shift();
  while (raw.length > 0 && raw.at(-1)!.trim() === "") raw.pop();
  const seen = new Map<string, number>();
  return raw.map((line) => {
    if (line.trim() === "") return BLANK;
    const hash = sha256Hex(line).slice(0, 12);
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    return { key: `${prefix}:${hash}:${n}`, text: line };
  });
}

function entryPage(
  storeId: string,
  dir: string,
  lane: string,
  value: LaneEntryValue,
  strings: ViewStrings,
): PageModel {
  const page = `${dir}/${value.entry}${VIEW_PAGE_EXT}`;
  const prefix = `e:${lane}:${value.entry}`;
  const isReport = lane === "reports";
  const title = isReport
    ? (field(value, "title") ?? value.entry)
    : strings.sourceTitle(plainText(field(value, "source_path") ?? value.entry));
  const day =
    (isReport ? field(value, "report_date") : field(value, "updated_at"))?.slice(0, 10) ?? null;
  const lines: PageLine[] = [
    idLine(storeId, page),
    BLANK,
    { key: `${prefix}:title`, text: `# ${plainText(title)}` },
  ];
  if (day !== null) {
    lines.push(BLANK, {
      key: `${prefix}:intro`,
      text: isReport ? strings.reportIntro(day) : strings.sourceIntro(day),
    });
  }
  const body = bodyLines(prefix, value.text, plainText(field(value, "title") ?? ""));
  if (body.length > 0) lines.push(BLANK, ...body);
  return { page, lines };
}

/** The report and source pages the `shared` records render to, in page order. */
export function lanePages(
  storeId: string,
  shared: ReadonlyArray<StoreRecord>,
  strings: ViewStrings,
): PageModel[] {
  const usable = shared.filter(
    (r) =>
      (r.kind === LANE_ENTRY_KIND || r.kind === LANE_ENTRY_REMOVE_KIND) &&
      !valueCarriesPrivateRegion(r.body),
  );
  const fold = foldLaneEntries(usable);
  const pages: PageModel[] = [];
  for (const { lane, dir } of LANES) {
    for (const state of fold.entries.values()) {
      const value = state.value;
      if (value === null || value.lane !== lane || !ENTRY_RE.test(value.entry)) continue;
      if (RESERVED_DEVICE_NAME_RE.test(value.entry) || isPrivateFrontmatter(value.fields)) continue;
      pages.push(entryPage(storeId, dir, lane, value, strings));
    }
  }
  // Two ids that differ only in case are one file on a case-insensitive
  // file system: the first in code unit order keeps the page, on every
  // machine, and the other renders none.
  const seen = new Set<string>();
  return pages
    .toSorted((a, b) => compareCodeUnits(a.page, b.page))
    .filter((p) => {
      const folded = p.page.toLowerCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
}
