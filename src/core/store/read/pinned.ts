/**
 * Read facade for pinned context (design D4, D14, task 2.10): the pinned
 * register on a store-only machine, `Brain/pinned.md` on an unswitched
 * one, in the shape `readPinnedContext` returns minus its path.
 *
 * The two partition registers are not merged (FORMAT.md, "Pinned
 * context"): a machine that holds `private` writes its pinned context
 * there, so that register is the one it reads; a machine without
 * `private` reads `shared`. The text is returned without trailing
 * whitespace, as the legacy reader returns the file.
 */

import { existsSync, readFileSync } from "node:fs";

import { brainPinnedPath } from "../../brain/paths.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readEntitiesOf } from "./store-entities.ts";

/** The pinned context as the facade returns it. */
export interface PinnedEntry {
  /** Whether anything is pinned (a set won; on the legacy side, the file exists). */
  readonly present: boolean;
  readonly content: string;
}

const NOTHING: PinnedEntry = Object.freeze({ present: false, content: "" });

/** The current pinned context. */
export function readPinned(context: ReadContext = {}): PinnedEntry {
  const source = readSource(context);
  if (source.kind === "legacy") {
    // The file itself: the facade already decided the source from the
    // caller's context, and the legacy reader would decide it again from
    // the default config alone.
    const path = brainPinnedPath(source.vault);
    if (!existsSync(path)) return NOTHING;
    return { present: true, content: readFileSync(path, "utf8").trimEnd() };
  }
  if (source.store === null) return NOTHING;
  const partition = source.store.partitions.has("private") ? "private" : "shared";
  const fold = readEntitiesOf(source.store).pinned.get(partition);
  if (fold === undefined || fold.content === null) return NOTHING;
  return { present: true, content: fold.content.trimEnd() };
}
