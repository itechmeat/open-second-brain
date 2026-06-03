/**
 * `o2b brain intention <set|show|list|move>` (Agent Surface Suite,
 * t_6d78f69e): scoped current-intention chains with a move-to-history
 * lifecycle.
 */

import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import {
  listIntentions,
  moveIntentionToHistory,
  setIntention,
  showIntention,
} from "../../../core/brain/intentions.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainIntention(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !["set", "show", "list", "move"].includes(action)) {
    return fail("usage: o2b brain intention <set|show|list|move> [--scope S] [--text T]");
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    scope: { type: "string" },
    text: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const scope = normalizeFlagString(flags["scope"]);
  const json = flags["json"] === true;

  if (action === "list") {
    const intentions = listIntentions(vault);
    if (json) {
      okJson({
        ok: true,
        intentions: intentions.map((c) => ({
          scope: c.scope,
          version: c.version,
          updated_at: c.updatedAt,
          text: c.text,
        })),
      });
      return 0;
    }
    if (intentions.length === 0) {
      ok("no active intentions");
      return 0;
    }
    for (const c of intentions) ok(`${c.scope} v${c.version} (${c.updatedAt}): ${c.text}`);
    return 0;
  }

  if (scope === null) return fail(`brain intention ${action} requires --scope`);

  try {
    if (action === "set") {
      const text = normalizeFlagString(flags["text"]);
      if (text === null) return fail("brain intention set requires --text");
      const chain = setIntention(vault, { scope, text, agent: resolveAgentName(config) });
      if (json) okJson({ ok: true, scope: chain.scope, version: chain.version, path: chain.path });
      else ok(`intention ${chain.scope} v${chain.version}: ${chain.text}`);
      return 0;
    }
    if (action === "show") {
      const chain = showIntention(vault, scope);
      if (chain === null) {
        if (json) okJson({ ok: true, present: false, scope });
        else ok(`no active intention for scope: ${scope}`);
        return 0;
      }
      if (json) {
        okJson({
          ok: true,
          present: true,
          scope: chain.scope,
          version: chain.version,
          updated_at: chain.updatedAt,
          text: chain.text,
          history: chain.history,
          path: chain.path,
        });
      } else {
        ok(`${chain.scope} v${chain.version} (${chain.updatedAt}): ${chain.text}`);
        for (const line of chain.history) ok(`  history: ${line}`);
      }
      return 0;
    }
    // move
    const moved = moveIntentionToHistory(vault, { scope });
    if (json) okJson({ ok: true, scope: moved.scope, archive_path: moved.archivePath });
    else ok(`intention ${moved.scope} moved to history: ${moved.archivePath}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}
