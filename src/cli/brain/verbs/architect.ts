/**
 * `o2b brain architect <project-path>` (Project History Suite,
 * t_929da8a2): deterministic architecture notes for a code project,
 * generated into the vault through the sentinel-region engine so
 * operator edits survive every re-scan.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { generateArchDocs } from "../../../core/brain/architect/generate.ts";
import { RegionError } from "../../../core/brain/regions.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainArchitect(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const target = positional[0];
  if (!target) {
    return fail("usage: o2b brain architect <project-path> [--vault V] [--json]");
  }
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
    const res = generateArchDocs(vault, target);
    if (flags["json"] === true) {
      okJson({
        ok: true,
        repo_key: res.repoKey,
        dir: res.dir,
        overview_path: res.overviewPath,
        module_paths: res.modulePaths,
        created: res.created,
        updated: res.updated,
        unchanged: res.unchanged,
      });
      return 0;
    }
    ok(
      `architecture notes for ${res.repoKey}: ${res.created} created, ` +
        `${res.updated} updated, ${res.unchanged} unchanged`,
    );
    ok(`overview: ${res.overviewPath}`);
    return 0;
  } catch (err) {
    if (err instanceof RegionError) {
      return fail(
        `${err.message} - repair the sentinel markers (or delete the note to regenerate it)`,
      );
    }
    return fail((err as Error).message ?? String(err));
  }
}
