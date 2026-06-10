/**
 * Bundled opencode plugin asset.
 *
 * The plugin source lives at `plugins/opencode/open-second-brain.ts`
 * in the repository (and inside every packaged install, which ships
 * the directory verbatim). The install adapter copies it into
 * `~/.config/opencode/plugins/` with a version-stamped header so
 * `verify` can flag a stale or hand-edited copy by content comparison
 * against this re-constructed expectation — same drift model as the
 * JSON payload.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import packageJson from "../../../package.json";

const PLUGIN_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "plugins",
  "opencode",
  "open-second-brain.ts",
);

export const OPENCODE_PLUGIN_FILENAME = "open-second-brain.ts";

/**
 * The exact bytes the installed plugin file must contain for the
 * current Open Second Brain version. Deterministic: same source and
 * version produce identical content, which is what makes re-apply
 * idempotent and drift detection a string comparison.
 */
export function installedPluginContent(): string {
  const source = readFileSync(PLUGIN_SOURCE_PATH, "utf8");
  return (
    `// open-second-brain plugin v${packageJson.version}` +
    " (installed copy; re-apply `o2b install --target opencode --apply` after upgrades)\n" +
    source
  );
}
