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

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeRegex } from "../strings.ts";
import { BRAIN_MANIFEST_SIDECAR_SINCE_VERSION } from "./manifest.ts";
import { DEFAULT_BRAIN_CONFIG } from "./policy.ts";
import type { BrainConfig } from "./types.ts";

// Template files ship in the same directory as the source so a future
// bundled build that keeps assets alongside the JS output keeps
// working without path surgery.
const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "templates");

/** Operating manual rendered at `Brain/_BRAIN.md`. */
export const BRAIN_MANUAL_TEMPLATE_PATH = join(TEMPLATE_DIR, "_BRAIN.md.tpl");

/** Directory holding the bundled Obsidian Bases view definitions. */
export const BASES_TEMPLATE_DIR = join(TEMPLATE_DIR, "bases");

/**
 * Bundled Obsidian Bases view definitions stamped into `Brain/bases/`
 * at init. Each maps a Brain collection to a native structured view:
 *
 *   - `projects.base` → entities with `category: project`
 *   - `people.base`   → entities with `category: person`
 *   - `tasks.base`    → obligations (`Brain/obligations/`)
 *   - `daily.base`    → log days (`Brain/log/`)
 *
 * Static assets — no `{{key}}` substitution — because the Brain layout
 * the filters target is fixed. They carry no plugin dependency:
 * Obsidian renders `.base` files natively, and they are inert in
 * editors that do not.
 */
export const BASE_TEMPLATE_FILES: ReadonlyArray<string> = [
  "projects.base",
  "people.base",
  "tasks.base",
  "daily.base",
];

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
    // The release the sidecar manifest shipped in. A substitution rather
    // than a literal in the template, because the same version is stated
    // in the rollback warning and in the verb help; one owner, three
    // readers.
    ["manifest_sidecar_since", BRAIN_MANIFEST_SIDECAR_SINCE_VERSION],
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
 * Render the manual for `vault`, keeping the `vault_name` spelling an
 * existing manual already carries when that spelling names the SAME
 * directory as `vault`.
 *
 * The display name is the basename as the caller spelled the path. On a
 * case-insensitive filesystem (macOS, Windows) `.../vault` and `.../Vault`
 * open one directory, so two runtimes configured with the two spellings
 * rendered two different manuals for one vault. Each saw the other's as a
 * pending upgrade, and the start-up self-heal re-ran that upgrade, snapshot
 * included, on every start.
 *
 * The filesystem decides, not a platform guess: the existing spelling is
 * kept only when it differs from ours by case alone AND a `stat` of the
 * path under that spelling reaches the same file (device and inode, read as
 * bigints so Windows file ids compare exactly). On a case-sensitive
 * filesystem where `vault` and `Vault` are two directories the probe says
 * so, and the manual is re-rendered as before.
 */
export function renderBrainManualFor(
  vault: string,
  existing: string | null,
  config: BrainConfig = DEFAULT_BRAIN_CONFIG,
): string {
  const rendered = renderBrainManual(vault, config);
  if (existing === null) return rendered;
  const ours = vaultDisplayName(vault);
  const theirs = recordedVaultName(existing);
  if (theirs === null || theirs === ours) return rendered;
  if (theirs.toLowerCase() !== ours.toLowerCase()) return rendered;
  if (!sameDirectory(vault, join(dirname(resolve(vault)), theirs))) return rendered;
  const substitutions = new Map(buildSubstitutions(vault, config));
  substitutions.set("vault_name", theirs);
  return renderTemplate(readTemplate(BRAIN_MANUAL_TEMPLATE_PATH), substitutions);
}

/** The `vault_name:` value a rendered manual carries, or null. */
function recordedVaultName(manual: string): string | null {
  const match = /^vault_name: (.+)$/m.exec(manual);
  return match === null ? null : match[1]!.trim();
}

/** Whether two paths open the same file, by device and inode. */
function sameDirectory(a: string, b: string): boolean {
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
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
