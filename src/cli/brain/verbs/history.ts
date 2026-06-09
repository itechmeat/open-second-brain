import { readEditHistory, renderEditHistory } from "../../../core/brain/health/edit-history.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain history <slug>` - render a preference's edit-history
 * timeline (one entry per content mutation). A leading `pref-` on the
 * argument is tolerated. Read-only.
 */
export async function cmdBrainHistory(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const raw = positional[0];
  if (!raw) return fail("usage: o2b brain history <slug>");
  const slug = raw.replace(/^pref-/, "");

  const { vault } = brainVerbContext(flags);

  let entries;
  try {
    entries = readEditHistory(vault, slug);
  } catch (exc) {
    return fail(`history failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  } else {
    process.stdout.write(renderEditHistory(entries) + "\n");
  }
  return 0;
}
