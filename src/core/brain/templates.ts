/**
 * Managed-template resolution and rendering primitives shared by
 * `init.ts` (first install) and `upgrade.ts` (subsequent
 * migrations). Keeping them here means the two paths cannot drift
 * on which file is "managed" or how its `{{key}}` placeholders are
 * filled.
 *
 * Unknown placeholders are left intact so a typo surfaces in the
 * rendered file rather than disappearing silently.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeRegex } from "../strings.ts";
import { DEFAULT_BRAIN_CONFIG } from "./policy.ts";
import type { BrainConfig } from "./types.ts";

// Template files ship in the same directory as the source so a future
// bundled build that keeps assets alongside the JS output keeps
// working without path surgery.
const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "templates");

/** Operating manual rendered at `Brain/_BRAIN.md`. */
export const BRAIN_MANUAL_TEMPLATE_PATH = join(TEMPLATE_DIR, "_BRAIN.md.tpl");

/**
 * Read a template file from disk. A missing template would indicate a
 * broken open-second-brain install — the message names the canonical
 * cause so the operator does not chase an opaque `ENOENT`.
 */
export function readTemplate(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load Brain template at ${path}: ${message}. ` +
        "This indicates a broken open-second-brain install — the " +
        "src/core/brain/templates/ directory must ship alongside templates.ts.",
      { cause: err },
    );
  }
}

/**
 * Compute `{{key}}` substitutions for the given vault. Kept tiny on
 * purpose; new substitutions are a one-line change here.
 */
export function buildSubstitutions(
  vault: string,
  config: BrainConfig = DEFAULT_BRAIN_CONFIG,
): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ["vault_name", vaultDisplayName(vault)],
    ["schema_version", String(config.schema_version)],
  ]);
}

/**
 * Apply `{{key}}` substitutions to `template`. Unknown placeholders
 * are left intact so a typo surfaces in the rendered file rather
 * than disappearing silently.
 */
export function renderTemplate(
  template: string,
  substitutions: ReadonlyMap<string, string>,
): string {
  let out = template;
  for (const [key, value] of substitutions) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g");
    // Function form keeps the substitution literal — string-form
    // `replace` interprets `$&` / `$1` / `$n` / `$$` in `value` as
    // backreference syntax. A vault name like `pay-$1` or
    // `team-$everyone` would otherwise be silently mangled.
    out = out.replace(pattern, () => value);
  }
  return out;
}

/**
 * Render the operating manual the way the current release ships it
 * for `vault`. Used by both `bootstrapBrain` (first write) and
 * `planUpgrade` (drift check).
 */
export function renderBrainManual(
  vault: string,
  config: BrainConfig = DEFAULT_BRAIN_CONFIG,
): string {
  return renderTemplate(
    readTemplate(BRAIN_MANUAL_TEMPLATE_PATH),
    buildSubstitutions(vault, config),
  );
}

/**
 * Best-effort display name for the vault: the trailing directory name
 * with separators stripped. Falls back to the literal `Second Brain`
 * if the vault path has no usable basename.
 */
export function vaultDisplayName(vault: string): string {
  const parts = vault.split(/[\\/]/).filter((p) => p.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1]! : "";
  return last !== "" ? last : "Second Brain";
}
