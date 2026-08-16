import { buildBacklinkIndex } from "../../../core/brain/backlinks.ts";
import { gatedOwnerScopeView } from "../../../core/brain/owner-scope-view.ts";
import { normaliseWikilinkTarget } from "../../../core/brain/wikilink.ts";
import { brainVerbContext, fail, parse, resolveBrainAgent } from "../helpers.ts";

/**
 * The one sentence that turns a count into a measurement.
 *
 * `buildBacklinkIndex` reports the artifacts whose references it could not
 * read, and this verb printed the count alone - so an operator debugging a
 * legacy vault, on the surface they reach FIRST, read `Backlinks to
 * pref-x: 0` for a preference that is referenced by three files the walk
 * could not parse. The MCP tool says it; the CLI now says the same thing
 * in the same vocabulary.
 */
const INCOMPLETE_WALK_NOTE =
  "the count above is incomplete: the walk could not read these artifacts";

export async function cmdBrainBacklinks(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  const id = positional[0];
  if (!id) return fail("brain backlinks requires a target id (e.g. pref-foo, ret-bar, sig-...)");
  const target = normaliseWikilinkTarget(id);
  // The refs name the artifacts that WROTE them, so an unscoped index
  // publishes another owner's preference and retired ids - the leak
  // `brain_backlinks` closed on the MCP side while this verb, reading the
  // same index, kept publishing them. The scope is the gated one: under
  // `owner_scope_delivery: off` the view hides nothing and the output is
  // byte-identical.
  const index = buildBacklinkIndex(
    vault,
    gatedOwnerScopeView(vault, resolveBrainAgent(flags, config)).scope,
  );
  const refs = index.get(target) ?? [];

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          id: target,
          count: refs.length,
          refs,
          // Omitted entirely on a clean walk, so a healthy vault's payload
          // is unchanged and matches `brain_backlinks` key for key.
          ...(index.unparsed.length > 0 ? { unparsed: index.unparsed } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(`Backlinks to ${target}: ${refs.length}\n`);
  for (const r of refs) {
    const ts = r.timestamp ? ` @ ${r.timestamp}` : "";
    process.stdout.write(`  ${r.source} (${r.sourceKind}, field: ${r.field})${ts}\n`);
  }
  if (index.unparsed.length > 0) {
    process.stderr.write(`${INCOMPLETE_WALK_NOTE}:\n`);
    for (const u of index.unparsed) {
      process.stderr.write(`  ${u.source} (${u.sourceKind}): ${u.reason}\n`);
    }
  }
  return 0;
}
