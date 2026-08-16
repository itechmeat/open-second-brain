import { readFileSync } from "node:fs";

import { BankImportError, importBankBundle } from "../../../core/brain/portability/bundle.ts";
import type { GraphImportMode } from "../../../core/brain/portability/graph.ts";
import { brainVerbContext, fail, parse, resolveBrainAgent } from "../helpers.ts";

const MODES: ReadonlyArray<GraphImportMode> = ["skip", "overwrite", "merge"];

/**
 * `o2b brain bank-import <file> [--mode skip|overwrite|merge] [--agent
 * <name>] [--json]` reconstruct the page graph and the preferences from
 * a bank bundle.json.
 *
 * `--mode` governs the page graph; `skip` (default) never overwrites.
 * Preferences restore through the audited preference transaction and are
 * governed by their revision instead: a bundle behind the vault is
 * refused per-row and named in the result, as is a row whose id, topic or
 * alias arrived carrying the redactor's placeholder - a name that is gone
 * and that every other redacted row shares. Page contracts and the
 * sources dashboard stay carried-not-restored. An unsupported bundle
 * schema fails loudly.
 */
export async function cmdBrainBankImport(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    mode: { type: "string" },
    agent: { type: "string" },
  });
  const file = positional[0];
  if (!file) {
    process.stderr.write("usage: o2b brain bank-import <file> [--mode skip|overwrite|merge]\n");
    return 2;
  }

  const mode = (flags["mode"] as string | undefined) ?? "skip";
  if (!MODES.includes(mode as GraphImportMode)) {
    process.stderr.write(
      `error: bank-import: --mode must be one of ${MODES.join(" | ")}; got ${mode}\n`,
    );
    return 2;
  }

  const { vault, config } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);

  // JSON boundary: parse then hand the loosely-typed shape to the
  // importer, which validates the schema and guards every graph node
  // and preference row.
  let bundle: {
    schema?: unknown;
    graph?: { nodes?: ReadonlyArray<unknown> };
    preferences?: unknown;
  };
  try {
    bundle = JSON.parse(readFileSync(file, "utf8")) as typeof bundle;
  } catch (exc) {
    return fail(`bank-import: failed to read ${file}: ${(exc as Error).message ?? exc}`);
  }

  let result;
  try {
    result = importBankBundle(vault, bundle, { mode: mode as GraphImportMode, agent });
  } catch (exc) {
    if (exc instanceof BankImportError) return fail(`bank-import: ${exc.message}`);
    return fail(`bank-import failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const g = result.graph;
    const p = result.preferences;
    const lines = [
      `graph: created ${g.created.length}, overwritten ${g.overwritten.length}, ` +
        `merged ${g.merged.length}, skipped ${g.skipped.length}, rejected ${g.rejected.length}`,
      `preferences: restored ${p.restored.length} of ${p.carried}, failed ${p.failed.length}` +
        `${p.fieldsNotRestored.length > 0 ? `, not restored: ${p.fieldsNotRestored.join(", ")}` : ""}`,
      `carried (not restored): ${result.pagesCarried} page contracts, ` +
        `sources ${result.sourcesCarried ? "yes" : "no"}`,
    ];
    for (const failure of p.failed) {
      lines.push(`  ${failure.id ?? `#${failure.index}`}: ${failure.reason} (${failure.detail})`);
    }
    // A value the bundle did not carry is reported as derived, never folded
    // into the restored count as if the backup had contained it.
    for (const d of p.derived) {
      lines.push(`  ${d.id}: ${d.field} derived from ${d.derivedFrom} (${d.value})`);
    }
    // A contention this import created: the dream pass plans nothing for a
    // topic key two spellings claim, so an operator who is not told here
    // sees consolidation stop with no cause named.
    for (const collision of p.topicKeyCollisions) {
      lines.push(
        `  topic key '${collision.key}' is claimed by ${collision.topics.join(", ")} ` +
          `(${collision.prefIds.join(", ")}); consolidation plans nothing until one owner remains`,
      );
    }
    // The collision list above is a claim over every rule already in the
    // DESTINATION. A rule the scan could not parse makes it a partial
    // claim, and an empty list read as "no collisions" would be the
    // confident zero. The import itself is unaffected - those files are
    // not what the bundle carried - so it proceeds and says this instead
    // of refusing wholesale.
    for (const unreadable of p.topicScanUnreadable) {
      lines.push(
        `  topic-key check incomplete: ${unreadable.path} could not be parsed ` +
          `(${unreadable.reason}); an existing rule may already claim a restored topic key`,
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  // A refused preference is a partial import, not a clean one: the caller
  // asked for the bundle's rules and did not get all of them. A row restored
  // on a DERIVED value did land, so it does not gate the code - it is
  // reported above instead, as is a topic-key collision the import created:
  // both are states an operator must see, neither is a rule left on the
  // floor. The graph half keeps its own per-entry tolerance and does not
  // gate the code either.
  return result.preferences.failed.length > 0 ? 1 : 0;
}
