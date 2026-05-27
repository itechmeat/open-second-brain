import { defaultConfigPath } from "../../../core/config.ts";
import { buildConceptCluster } from "../../../core/brain/link-graph/concept-cluster.ts";
import { normaliseWikilinkTarget } from "../../../core/brain/wikilink.ts";
import { parse, fail, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain synthesise <id> [--include-unlinked] [--vault PATH] [--json]`
 *
 * Assemble the concept-cluster envelope (target + linkers
 * [depth-1], optionally + unlinked mentions). Pure assembler; no
 * LLM call. JSON output is the canonical surface for downstream
 * consumers.
 */
export async function cmdBrainSynthesise(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    "include-unlinked": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const id = positional[0];
  if (!id) return fail("brain synthesise requires a target id (e.g. pref-foo)");
  const target = normaliseWikilinkTarget(id);

  const cluster = buildConceptCluster(vault, target, {
    includeUnlinked: flags["include-unlinked"] === true,
  });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          target_id: cluster.targetId,
          target_title: cluster.targetTitle,
          linkers: cluster.linkers,
          unlinked_mentions: cluster.unlinkedMentions,
          generated_at: cluster.generatedAt,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(`Concept cluster for ${cluster.targetId} (${cluster.targetTitle}):\n`);
  process.stdout.write(`  Linkers: ${cluster.linkers.length}\n`);
  for (const l of cluster.linkers) {
    const anchor = l.targetAnchor ? `#${l.targetAnchor}` : "";
    const block = l.targetBlock ? `#^${l.targetBlock}` : "";
    const alias = l.aliasSource ? ` via "${l.aliasSource}"` : "";
    process.stdout.write(
      `    ${l.source}${anchor}${block} (${l.sourceKind}, field: ${l.field})${alias}\n`,
    );
  }
  if (cluster.unlinkedMentions.length > 0) {
    process.stdout.write(`  Unlinked mentions: ${cluster.unlinkedMentions.length}\n`);
    for (const m of cluster.unlinkedMentions) {
      process.stdout.write(`    ${m.source}:${m.line}  (${m.term})\n`);
    }
  }
  return 0;
}
