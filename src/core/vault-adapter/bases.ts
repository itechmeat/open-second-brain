/**
 * `.base` view files, the vault adapter's Obsidian Bases surface (design
 * D14 item 8). Moved here from `brain/init.ts`.
 *
 * A `.base` file is an Obsidian view over vault pages. The rule: no
 * `.base` file queries store data. Each bundled template says what it
 * queries:
 *
 *  - `user-notes`: the user's own notes, which stay in the vault. These
 *    are stamped whenever the adapter is active.
 *  - `legacy-tree`: pages of the legacy `Brain/` tree (entities,
 *    obligations, log days). That data moves to the store at migration,
 *    so these are stamped only while the machine still writes the legacy
 *    tree; a store-only machine gets none of them.
 *
 * Every template bundled today queries the legacy tree. The source assets
 * ship under `src/core/brain/templates/bases/` so they travel with the
 * published `src/` tree (the `package.json` `files` allowlist).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { BRAIN_BASES_REL } from "../brain/path-constants.ts";
import { vaultRelative } from "../brain/paths.ts";

/** Directory holding the bundled Obsidian Bases view definitions. */
export const BASES_TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "brain",
  "templates",
  "bases",
);

/** One bundled `.base` template and what its filters read. */
export interface BaseTemplate {
  readonly file: string;
  readonly queries: "user-notes" | "legacy-tree";
}

/**
 * The bundled templates, stamped into `Brain/bases/` on a legacy machine:
 *
 *   - `projects.base` → entities with `category: project`
 *   - `people.base`   → entities with `category: person`
 *   - `tasks.base`    → obligations (`Brain/obligations/`)
 *   - `daily.base`    → log days (`Brain/log/`)
 */
export const BASE_TEMPLATES: ReadonlyArray<BaseTemplate> = Object.freeze([
  { file: "projects.base", queries: "legacy-tree" },
  { file: "people.base", queries: "legacy-tree" },
  { file: "tasks.base", queries: "legacy-tree" },
  { file: "daily.base", queries: "legacy-tree" },
]);

/** Per-file outcome, in the vault-relative shape `bootstrapBrain` reports. */
export interface BaseStampResult {
  readonly created: string[];
  readonly overwritten: string[];
  readonly skipped: string[];
}

export interface StampBasesOptions {
  /** Overwrite existing files. */
  readonly force?: boolean;
  /** The machine writes the store only: no template that queries the legacy tree. */
  readonly storeOnly: boolean;
}

/** The templates the adapter stamps on a machine in this mode. */
export function basesFor(storeOnly: boolean): ReadonlyArray<BaseTemplate> {
  return BASE_TEMPLATES.filter((t) => !storeOnly || t.queries === "user-notes");
}

/**
 * Copy the bundled view definitions this machine may use into
 * `Brain/bases/`. Each file is written only when absent; `force`
 * overwrites.
 */
export function stampBaseTemplates(vault: string, options: StampBasesOptions): BaseStampResult {
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const { file } of basesFor(options.storeOnly)) {
    const body = readFileSync(join(BASES_TEMPLATE_DIR, file), "utf8");
    const dest = join(vault, BRAIN_BASES_REL, file);
    const rel = vaultRelative(dest, vault);
    if (existsSync(dest)) {
      if (options.force === true) {
        atomicWriteFileSync(dest, body);
        overwritten.push(rel);
      } else {
        skipped.push(rel);
      }
    } else {
      atomicWriteFileSync(dest, body);
      created.push(rel);
    }
  }
  return { created, overwritten, skipped };
}
