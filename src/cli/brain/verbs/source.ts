/**
 * `o2b brain source <add|list|remove>` (Workspace Insight Suite,
 * t_1375e69f): read-only recall sources of the active vault. Distinct
 * from `o2b brain sources` (the signals-by-agent dashboard): this verb
 * manages which EXTERNAL vaults participate in recall as read-only
 * origins.
 */

import { resolve } from "node:path";

import { defaultConfigPath } from "../../../core/config.ts";
import {
  addRecallSource,
  listRecallSources,
  removeRecallSource,
} from "../../../core/brain/portability/recall-sources.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSource(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !["add", "list", "remove"].includes(action)) {
    return fail("usage: o2b brain source <add|list|remove> [path|alias] [--alias A] [--json]");
  }
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    alias: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  try {
    const owner = resolveBrainVault(flags["vault"] as string | undefined, config);

    if (action === "add") {
      const target = positional[0];
      if (!target) return fail("brain source add requires a vault path");
      const alias = normalizeFlagString(flags["alias"]);
      if (alias === null) return fail("brain source add requires --alias");
      addRecallSource(config, owner, alias, resolve(target));
      if (json) okJson({ ok: true, alias, vault: resolve(target), read_only: true });
      else ok(`source ${alias} -> ${resolve(target)} (read-only)`);
      return 0;
    }

    if (action === "list") {
      const sources = listRecallSources(config, owner);
      if (json) {
        okJson({
          ok: true,
          sources: sources.map((s) => ({ alias: s.alias, vault: s.vault, broken: s.broken })),
        });
        return 0;
      }
      if (sources.length === 0) {
        ok("no recall sources");
        return 0;
      }
      for (const s of sources) ok(`${s.alias} -> ${s.vault}${s.broken ? " (BROKEN)" : ""}`);
      return 0;
    }

    // remove
    const alias = positional[0] ?? normalizeFlagString(flags["alias"]);
    if (!alias) return fail("brain source remove requires an alias");
    if (!removeRecallSource(config, owner, alias)) {
      return fail(`no recall source with alias: ${alias}`);
    }
    if (json) okJson({ ok: true, alias, removed: true });
    else ok(`source ${alias} removed`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
