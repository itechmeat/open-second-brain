import { buildBacklinkIndex } from "../../../core/brain/backlinks.ts";
import { normaliseWikilinkTarget } from "../../../core/brain/wikilink.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

export async function cmdBrainBacklinks(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const id = positional[0];
  if (!id) return fail("brain backlinks requires a target id (e.g. pref-foo, ret-bar, sig-...)");
  const target = normaliseWikilinkTarget(id);
  const index = buildBacklinkIndex(vault);
  const refs = index.get(target) ?? [];

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ id: target, count: refs.length, refs }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Backlinks to ${target}: ${refs.length}\n`);
  if (refs.length === 0) return 0;
  for (const r of refs) {
    const ts = r.timestamp ? ` @ ${r.timestamp}` : "";
    process.stdout.write(`  ${r.source} (${r.sourceKind}, field: ${r.field})${ts}\n`);
  }
  return 0;
}
