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
import { BRAIN_MANIFEST_SIDECAR_SINCE_VERSION } from "./manifest.ts";
import { DEFAULT_BRAIN_CONFIG } from "./policy.ts";
import type { BrainConfig } from "./types.ts";

// Template files ship in the same directory as the source so a future
// bundled build that keeps assets alongside the JS output keeps
// working without path surgery.
const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "templates");

/** Operating manual rendered at `Brain/_BRAIN.md`. */
export const BRAIN_MANUAL_TEMPLATE_PATH = join(TEMPLATE_DIR, "_BRAIN.md.tpl");

/**
 * Revision of the manual template, rendered into the manual's frontmatter
 * as `template_revision:`. A manual without the line is revision 0.
 *
 * The manual is synced vault content and devices sharing a vault may run
 * different releases. Without an order between renderings, an older
 * release saw a newer release's manual as a pending upgrade and rewrote it
 * back, and the newer release upgraded it forward again, each step behind a
 * pre-apply snapshot. The upgrade plan now leaves a manual from a newer
 * revision as it is (`planManagedPath` in `upgrade.ts`).
 *
 * Bump it by one whenever the rendered manual changes (the template text,
 * or a release constant it renders), and set
 * {@link BRAIN_MANUAL_TEMPLATE_SHA256} to the new hash: a test fails while
 * the hash does not match, so a change cannot ship under an old revision.
 * The revision moves only with the template, so a release that leaves the
 * template alone causes no upgrade on any vault.
 */
export const BRAIN_MANUAL_TEMPLATE_REVISION = 1;

/**
 * SHA-256 (hex) of the manual as this release renders it with every
 * device-independent substitution applied (all but `vault_name`), line
 * endings normalised to LF, at {@link BRAIN_MANUAL_TEMPLATE_REVISION}. A
 * change to the template text OR to a release constant it renders
 * (`schema_version`, `manifest_sidecar_since`) changes the bytes every
 * device writes, so it fails the guard test until the revision is bumped.
 * Read only by that test.
 */
export const BRAIN_MANUAL_TEMPLATE_SHA256 =
  "40b711db15b7215225cc8218d12400dd72825f39fe859b8446a5665b32367804";

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
    ["template_revision", String(BRAIN_MANUAL_TEMPLATE_REVISION)],
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
  if (substitutions.size === 0) return template;
  // One pass over the template: a substituted value is never scanned
  // again, so a value that itself reads `{{schema_version}}` (a vault name
  // kept from a synced manual, say) stays literal instead of being
  // expanded by a later key.
  const keys = [...substitutions.keys()].map(escapeRegex).join("|");
  const pattern = new RegExp(`\\{\\{\\s*(${keys})\\s*\\}\\}`, "g");
  // Function form keeps the substitution literal — string-form
  // `replace` interprets `$&` / `$1` / `$n` / `$$` in `value` as
  // backreference syntax. A vault name like `pay-$1` or
  // `team-$everyone` would otherwise be silently mangled.
  return template.replace(pattern, (match, key: string) => substitutions.get(key) ?? match);
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
 * Render the manual for `vault`, keeping the `vault_name` an existing
 * manual already carries.
 *
 * The display name is the basename of the vault path on THIS device, but
 * the manual is synced vault content. A vault shared between a Mac
 * (`/Users/<user>/Vault`) and Linux hosts (`/root/vault`, `/srv/vault`)
 * gave every device its own spelling: each saw the manual another device
 * wrote as a pending upgrade, and the start-up self-heal rewrote it back,
 * pre-apply snapshot included, on every start of every device (hundreds of
 * `upgrade-*` snapshots on one live vault). The same happened with two
 * spellings of one directory on a case-insensitive filesystem.
 *
 * So the name is decided once, when the manual is first written (or when
 * an existing manual has no `vault_name:` line), and kept from then on: a
 * device-local fact must never make synced content look stale. The cost is
 * cosmetic: a vault moved to a new directory name keeps its old display
 * name until the line is edited by hand.
 */
export function renderBrainManualFor(
  vault: string,
  existing: string | null,
  config: BrainConfig = DEFAULT_BRAIN_CONFIG,
): string {
  const recorded = existing === null ? null : recordedVaultName(existing);
  if (recorded === null) return renderBrainManual(vault, config);
  const substitutions = new Map(buildSubstitutions(vault, config));
  substitutions.set("vault_name", recorded);
  return renderTemplate(readTemplate(BRAIN_MANUAL_TEMPLATE_PATH), substitutions);
}

/**
 * The frontmatter block of a rendered manual, or null. A leading UTF-8 BOM
 * (some Windows editors add one on save) is allowed before the opening
 * fence.
 */
function manualFrontmatter(manual: string): string | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(manual);
  return match === null ? null : match[1]!;
}

/**
 * The `vault_name:` value a rendered manual carries in its frontmatter,
 * or null. A line in the body never counts: it would be lifted into the
 * frontmatter for good.
 */
function recordedVaultName(manual: string): string | null {
  const frontmatter = manualFrontmatter(manual);
  if (frontmatter === null) return null;
  const match = /^vault_name: (.+?)\r?$/m.exec(frontmatter);
  if (match === null) return null;
  const name = match[1]!.trim();
  return name === "" ? null : name;
}

/**
 * The `template_revision:` a rendered manual carries in its frontmatter.
 * A manual without the line (written before the stamp existed), or with a
 * value that is not a non-negative integer, is revision 0.
 */
export function templateRevisionOf(manual: string): number {
  const frontmatter = manualFrontmatter(manual);
  if (frontmatter === null) return 0;
  const match = /^template_revision:[ \t]*(\d+)[ \t]*\r?$/m.exec(frontmatter);
  return match === null ? 0 : Number(match[1]);
}

/**
 * The manual's template revision when a newer release wrote it (higher than
 * {@link BRAIN_MANUAL_TEMPLATE_REVISION}), else null. Such a manual is never
 * rewritten back to this release's template.
 */
export function manualRevisionAhead(manual: string): number | null {
  const revision = templateRevisionOf(manual);
  return revision > BRAIN_MANUAL_TEMPLATE_REVISION ? revision : null;
}

/**
 * One line for a manual a newer release wrote, kept rather than rewritten
 * to this release's template. `o2b brain upgrade` and `o2b brain status`
 * both print it, so the two surfaces word it the same way.
 */
export function describeManualRevisionAhead(path: string, aheadRevision: number): string {
  return (
    `${path}: kept; written by a newer release (template revision ${aheadRevision}, ` +
    `this release ships ${BRAIN_MANUAL_TEMPLATE_REVISION})`
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
