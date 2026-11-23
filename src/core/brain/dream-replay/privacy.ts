/**
 * The partition of a replay record (FORMAT.md "Partitions"). A plan, the
 * private part of an admission and an inventory page freeze what the
 * window read; when that names a private signal, a private preference or
 * a record read from the `private` partition, the record goes to
 * `private`, as every other writer's private-derived record does, so a
 * machine that holds only `shared` never receives it. The coverage, the
 * shared part of an admission and the ledger records name no record's
 * content and stay in `shared`.
 *
 * The judge matches every string of a body (object keys included) against
 * the private names, also as a wikilink and as a page path's basename: a
 * name that matches by accident only makes a record more private.
 */

import { basename } from "node:path";

import type { StoreEntities } from "../../store/read/store-entities.ts";
import { parseWikilink } from "../wikilink.ts";

/** The names a replay record may not carry into `shared`. */
export function privateNamesOf(
  entities: Pick<StoreEntities, "preferences" | "signals"> | null,
  records: Iterable<string> = [],
): Set<string> {
  const names = new Set<string>(records);
  for (const [id, entry] of entities?.preferences ?? []) {
    if (!entry.private) continue;
    const slug = id.startsWith("pref-") ? id.slice("pref-".length) : id;
    names.add(slug);
    names.add(`pref-${slug}`);
    names.add(`ret-${slug}`);
  }
  for (const [id, signal] of entities?.signals ?? []) {
    if (!signal.private) continue;
    names.add(id);
    const own = signal.record.body["id"];
    if (typeof own === "string") names.add(own);
  }
  return names;
}

function stringNames(value: string, names: ReadonlySet<string>): boolean {
  if (names.has(value)) return true;
  const link = parseWikilink(value);
  if (link !== null && names.has(link)) return true;
  const base = basename(link ?? value).replace(/\.md$/, "");
  return names.has(base);
}

/** Whether `value` names anything in `names`. */
export function namesPrivate(value: unknown, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  if (typeof value === "string") return stringNames(value, names);
  if (Array.isArray(value)) return value.some((entry) => namesPrivate(entry, names));
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (stringNames(key, names) || namesPrivate(entry, names)) return true;
    }
  }
  return false;
}
