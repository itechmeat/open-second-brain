/**
 * `o2b brain sgrep <query> [path]` (Workspace Insight Suite,
 * t_323a9a83): grep-shaped semantic Brain search. Ordinary shell
 * reflexes - positional query, optional path scope, `path:line:`
 * output lines - over the existing search pipeline. Exact `grep`
 * stays untouched; this is a separate verb, never a wrapper.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { resolveSearchConfig, search, SearchError } from "../../../core/search/index.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSgrep(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    limit: { type: "string" },
    "keyword-only": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  const query = positional[0];
  if (!query || query.trim() === "") {
    return fail(
      "usage: o2b brain sgrep <query> [path-prefix] [--limit N] [--keyword-only] [--json]",
    );
  }
  const pathPrefix = positional[1];
  const limitRaw = flags["limit"];
  const limit = typeof limitRaw === "string" && limitRaw.trim() !== "" ? Number(limitRaw) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail("--limit must be an integer in 1..100");
  }

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const searchConfig = resolveSearchConfig({ vault, configPath: config });
    const outcome = await search(searchConfig, {
      query,
      limit,
      keywordOnly: flags["keyword-only"] === true,
      ...(pathPrefix !== undefined ? { pathPrefix } : {}),
    });
    if (json) {
      okJson({
        ok: true,
        results: outcome.results.map((r) => ({
          path: r.path,
          line: r.startLine,
          score: r.score,
          snippet: r.content.trim().replace(/\s+/gu, " ").slice(0, 200),
        })),
        total: outcome.total,
        warnings: outcome.warnings,
      });
      return 0;
    }
    for (const r of outcome.results) {
      const snippet = r.content.trim().replace(/\s+/gu, " ").slice(0, 160);
      ok(`${r.path}:${r.startLine}: ${snippet}`);
    }
    if (outcome.results.length === 0) ok("(no matches)");
    for (const warning of outcome.warnings) ok(`warning: ${warning}`);
    return outcome.results.length > 0 ? 0 : 1;
  } catch (err) {
    if (err instanceof SearchError) return fail(`${err.message} [${err.code}]`);
    return fail((err as Error).message ?? String(err));
  }
}
