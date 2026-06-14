/**
 * `o2b brain idea-lineage <id>` (Session Knowledge Synthesis, t_635a3ea5):
 * read-only provenance trace of how a derived artifact was reached, as an
 * observation -> synthesis -> conclusion graph. The id is a continuity
 * record id (ctn_...) or a preference id (pref-.../ret-...).
 *
 *   o2b brain idea-lineage <id> [--max-depth N] [--json]
 */

import {
  traceIdeaLineage,
  IdeaLineageError,
  type IdeaLineageResult,
} from "../../../core/brain/idea-lineage.ts";
import { brainVerbContext, parse, usageError } from "../helpers.ts";

const USAGE = "usage: o2b brain idea-lineage <id> [--max-depth N] [--json]";

export async function cmdBrainIdeaLineage(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "max-depth": { type: "string" },
    json: { type: "boolean" },
  });

  const id = positional[0]?.trim() ?? "";
  if (id.length === 0) return usageError(USAGE);

  let maxDepth: number | undefined;
  if (typeof flags["max-depth"] === "string") {
    const parsed = Number(flags["max-depth"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return usageError("brain idea-lineage: --max-depth must be a positive integer");
    }
    maxDepth = parsed;
  }

  const vault = brainVerbContext(flags).vault;
  let result: IdeaLineageResult;
  try {
    result = traceIdeaLineage(vault, { id }, maxDepth !== undefined ? { maxDepth } : {});
  } catch (error) {
    if (error instanceof IdeaLineageError)
      return usageError(`brain idea-lineage: ${error.message}`);
    throw error;
  }

  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`lineage of ${result.root.id} (${result.root.kind})\n`);
  for (const node of result.nodes) {
    const marker = node.id === result.root.id ? "*" : " ";
    process.stdout.write(`${marker} [${node.stage}] d${node.depth} ${node.kind}  ${node.label}\n`);
  }
  if (result.truncated) {
    process.stdout.write("  (truncated at the depth bound; pass --max-depth to go deeper)\n");
  }
  return 0;
}
