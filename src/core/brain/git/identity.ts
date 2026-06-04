/**
 * Repo identity for the git history store (Project History Suite,
 * t_c812752c).
 *
 * `repoKey` names the per-repo directory under `Brain/projects/git/` and
 * `Brain/projects/arch/`. The key is human-readable (sanitized basename)
 * yet collision-safe across same-named checkouts (8-hex digest of the
 * absolute path), and stable for a given checkout location - the same
 * properties `profiles.json` keys rely on, applied to project paths.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

/** Lowercase, collapse anything outside [a-z0-9] to single hyphens. */
function sanitizeBasename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
}

/** Deterministic per-checkout key: `<sanitized-basename>-<8-hex>`. */
export function repoKey(repoPath: string): string {
  const abs = resolve(repoPath);
  const digest = createHash("sha256").update(abs).digest("hex").slice(0, 8);
  return `${sanitizeBasename(basename(abs))}-${digest}`;
}
