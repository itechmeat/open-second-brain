/**
 * `o2b brain pre-extract <file>`: run the deterministic, no-LLM
 * code-structure pre-extraction pass over one source file and print its JSON
 * entity/edge seeds.
 *
 * This is the agent-facing form of the pre-ingest pass: an agent runs it before
 * extracting from a code source so the structural seeds (classes, functions,
 * imports, inheritance, JSX component usages; Terraform blocks in address
 * syntax with their `depends_on` and `references` edges) are available as
 * pre-extracted facts. Read-only and deterministic - the kernel runs no model. An unsupported extension is
 * reported as unextracted with a reason, never a fake empty success.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { oneLine } from "../../../core/brain/architect/manifests.ts";
import { preExtractCodeStructure } from "../../../core/brain/ingest/pre-extract.ts";
import { fail, info, ok, okJson, parse, usageError } from "../helpers.ts";

export async function cmdBrainPreExtract(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    json: { type: "boolean" },
  });
  const file = positional[0];
  if (!file) {
    return usageError("usage: o2b brain pre-extract <file> [--json]");
  }

  try {
    if (!existsSync(file) || !statSync(file).isFile()) {
      return fail(`pre-extract: not a readable file: ${file}`);
    }
    const result = preExtractCodeStructure(file, readFileSync(file, "utf8"));

    if (flags["json"]) {
      okJson({ path: file, ...result });
      return 0;
    }

    if (!result.extracted) {
      // An honest "unextracted" report is data, not a failure; surface it as a
      // warning so the operator sees exactly why nothing was seeded.
      info(`pre-extract: ${file} unextracted (${result.reason})`);
      return 0;
    }
    ok(
      `pre-extract: ${file} (${result.language}) - ` +
        `${result.entities.length} entit(ies), ${result.edges.length} edge(s)`,
    );
    // A seed carries text from the source file; fold it onto one line so
    // no control character reaches the terminal. `--json` keeps it escaped.
    for (const e of result.entities) ok(`  ${e.kind} ${oneLine(e.name)}`);
    for (const e of result.edges) ok(`  ${e.kind} ${oneLine(e.from)} -> ${oneLine(e.to)}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
