import { defaultConfigPath } from "../../../core/config.ts";
import { findUnlinkedMentions } from "../../../core/brain/link-graph/unlinked-mentions.ts";
import { normaliseWikilinkTarget } from "../../../core/brain/wikilink.ts";
import { parse, fail, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain unlinked <target-id> [--limit N] [--vault PATH] [--json]`
 *
 * Surface raw-text mentions of `<target-id>`'s title / aliases that
 * are NOT already inside `[[...]]` wikilinks. Read-only; walks
 * `Brain/preferences/` and `Brain/retired/` only. Match boundary is
 * Unicode-aware (codepoint class), language-agnostic.
 */
export async function cmdBrainUnlinked(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const id = positional[0];
  if (!id) {
    return fail("brain unlinked requires a target id (e.g. pref-foo, ret-bar)");
  }
  const target = normaliseWikilinkTarget(id);

  let limit: number | undefined;
  const limitFlag = flags["limit"];
  if (typeof limitFlag === "string" && limitFlag.length > 0) {
    if (!/^[0-9]+$/.test(limitFlag)) {
      return fail("brain unlinked: --limit must be a positive integer");
    }
    const parsed = Number.parseInt(limitFlag, 10);
    if (parsed < 1) {
      return fail("brain unlinked: --limit must be a positive integer");
    }
    limit = parsed;
  }

  const mentions = findUnlinkedMentions(vault, target, {
    ...(limit !== undefined ? { limit } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          id: target,
          count: mentions.length,
          mentions: mentions.map((m) => ({
            source: m.source,
            line: m.line,
            term: m.term,
            context: m.contextSnippet,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `Unlinked mentions of ${target}: ${mentions.length}\n`,
  );
  for (const m of mentions) {
    process.stdout.write(
      `  ${m.source}:${m.line}  (${m.term})  ${m.contextSnippet.trim()}\n`,
    );
  }
  return 0;
}
