import { readFileSync } from "node:fs";

import { BankImportError, importBankBundle } from "../../../core/brain/portability/bundle.ts";
import type { GraphImportMode } from "../../../core/brain/portability/graph.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

const MODES: ReadonlyArray<GraphImportMode> = ["skip", "overwrite", "merge"];

/**
 * `o2b brain bank-import <file> [--mode skip|overwrite|merge] [--json]`
 * reconstruct the page graph from a bank bundle.json. `skip` (default)
 * never overwrites; preferences, page contracts, and the sources
 * dashboard are reported as carried-not-restored. An unsupported bundle
 * schema fails loudly.
 */
export async function cmdBrainBankImport(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    mode: { type: "string" },
  });
  const file = positional[0];
  if (!file) return fail("usage: o2b brain bank-import <file> [--mode skip|overwrite|merge]");

  const mode = (flags["mode"] as string | undefined) ?? "skip";
  if (!MODES.includes(mode as GraphImportMode)) {
    return fail(`bank-import: --mode must be one of ${MODES.join(" | ")}; got ${mode}`);
  }

  const { vault } = brainVerbContext(flags);

  // JSON boundary: parse then hand the loosely-typed shape to the
  // importer, which validates the schema and guards every graph node.
  let bundle: { schema?: unknown; graph?: { nodes?: ReadonlyArray<unknown> } };
  try {
    bundle = JSON.parse(readFileSync(file, "utf8")) as typeof bundle;
  } catch (exc) {
    return fail(`bank-import: failed to read ${file}: ${(exc as Error).message ?? exc}`);
  }

  let result;
  try {
    result = importBankBundle(vault, bundle, { mode: mode as GraphImportMode });
  } catch (exc) {
    if (exc instanceof BankImportError) return fail(`bank-import: ${exc.message}`);
    return fail(`bank-import failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const g = result.graph;
    process.stdout.write(
      `graph: created ${g.created.length}, overwritten ${g.overwritten.length}, ` +
        `merged ${g.merged.length}, skipped ${g.skipped.length}, rejected ${g.rejected.length}\n` +
        `carried (not restored): ${result.preferencesCarried} preferences, ` +
        `${result.pagesCarried} page contracts, sources ${result.sourcesCarried ? "yes" : "no"}\n`,
    );
  }
  return 0;
}
