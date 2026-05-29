import { readFileSync } from "node:fs";

import { defaultConfigPath } from "../../../core/config.ts";
import {
  importVaultGraph,
  type GraphImportMode,
} from "../../../core/brain/portability/graph.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

const MODES: ReadonlyArray<GraphImportMode> = ["skip", "overwrite", "merge"];

/**
 * `o2b brain graph-import <file> [--mode skip|overwrite|merge] [--json]`
 * reconstruct vault page stubs from a graph.json. `skip` (default) never
 * overwrites; writes are guarded against escaping the vault.
 */
export async function cmdBrainGraphImport(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    mode: { type: "string" },
  });
  const file = positional[0];
  if (!file) return fail("usage: o2b brain graph-import <file> [--mode skip|overwrite|merge]");

  const mode = (flags["mode"] as string | undefined) ?? "skip";
  if (!MODES.includes(mode as GraphImportMode)) {
    return fail(`graph-import: --mode must be one of ${MODES.join(" | ")}; got ${mode}`);
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let graph: { nodes?: unknown };
  try {
    graph = JSON.parse(readFileSync(file, "utf8")) as { nodes?: unknown };
  } catch (exc) {
    return fail(`graph-import: failed to read ${file}: ${(exc as Error).message ?? exc}`);
  }

  let result;
  try {
    result = importVaultGraph(vault, graph as never, { mode: mode as GraphImportMode });
  } catch (exc) {
    return fail(`graph-import failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `created ${result.created.length}, overwritten ${result.overwritten.length}, ` +
        `merged ${result.merged.length}, skipped ${result.skipped.length}, ` +
        `rejected ${result.rejected.length}\n`,
    );
  }
  return 0;
}
