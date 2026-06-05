/**
 * `o2b brain clusters run|list` (t_4ba927ec): graph-wide community
 * detection over the search index's link graph. `run` detects
 * communities (deterministic label propagation), materializes one
 * derived note per community under `Brain/clusters/`, removes stale
 * generated notes, and records one `communities` metric. `list`
 * reads the generated notes back. Fail-soft on a missing index.
 *
 * Exit codes: 0 on success/fail-soft skip, 1 on an operational
 * failure, 2 on usage errors.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  detectCommunities,
  materializeClusterNotes,
  COMMUNITY_DEFAULT_MIN_SIZE,
} from "../../../core/brain/link-graph/communities.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { Store } from "../../../core/search/store.ts";
import { SearchError } from "../../../core/search/types.ts";
import { defaultConfigPath } from "../../../core/config.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE = "usage: o2b brain clusters run [--min-size N] | list  [--vault <path>] [--json]";

export async function cmdBrainClusters(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "min-size": { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const action = positional[0];
  if ((action !== "run" && action !== "list") || positional.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  try {
    if (action === "list") {
      const dir = join(vault, "Brain", "clusters");
      if (!existsSync(dir)) {
        if (asJson) okJson({ clusters: [] });
        else ok("no cluster notes yet - run: o2b brain clusters run");
        return 0;
      }
      const clusters = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .toSorted()
        .map((f) => {
          const [meta] = parseFrontmatter(join(dir, f));
          return meta["kind"] === "brain-cluster"
            ? {
                path: `Brain/clusters/${f}`,
                cluster: String(meta["cluster"] ?? ""),
                size: Number(meta["size"] ?? 0),
                density: Number(meta["density"] ?? 0),
                generated_at: String(meta["generated_at"] ?? ""),
              }
            : null;
        })
        .filter((c) => c !== null);
      if (asJson) okJson({ clusters });
      else if (clusters.length === 0) ok("no generated cluster notes");
      else {
        for (const c of clusters) {
          ok(`${c.cluster}: ${c.size} notes, density ${c.density} (${c.path})`);
        }
      }
      return 0;
    }

    // run
    const minSize = parsePositiveInt(flags["min-size"] as string | undefined);
    if (minSize === false) {
      process.stderr.write("brain clusters run: --min-size must be a positive integer\n");
      return 2;
    }

    const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
    let store: Store;
    try {
      store = await Store.open(searchConfig, { mode: "read" });
    } catch (exc) {
      if (
        exc instanceof SearchError &&
        (exc.code === "INDEX_MISSING" || exc.code === "SCHEMA_MISMATCH")
      ) {
        if (asJson) okJson({ communities: 0, reason: "index not built" });
        else ok("clusters run: search index not initialised - run: o2b search index");
        return 0;
      }
      throw exc;
    }

    const now = new Date();
    try {
      const communities = detectCommunities(store, minSize !== undefined ? { minSize } : {});
      const result = materializeClusterNotes(vault, communities, { store, now });
      try {
        appendMetric(vault, {
          surface: "communities",
          runAt: isoSecond(now),
          payload: {
            communities: communities.length,
            sizes: communities.map((c) => c.size),
            written: result.written.length,
            removed: result.removed.length,
            min_size: minSize ?? COMMUNITY_DEFAULT_MIN_SIZE,
          },
        });
      } catch {
        // Metrics are observability, not correctness.
      }
      if (asJson) {
        okJson({
          communities: communities.map((c) => ({
            id: c.id,
            size: c.size,
            density: c.density,
            members: c.members.map((m) => m.path),
          })),
          written: result.written,
          removed: result.removed,
        });
      } else if (communities.length === 0) {
        ok("clusters run: no communities at the current threshold");
      } else {
        ok(`clusters run: ${communities.length} communit${communities.length === 1 ? "y" : "ies"}`);
        for (const c of communities) {
          ok(`  ${c.id}: ${c.size} notes, density ${c.density.toFixed(2)}`);
        }
        if (result.removed.length > 0) ok(`  removed stale: ${result.removed.join(", ")}`);
      }
      return 0;
    } finally {
      await store.close();
    }
  } catch (exc) {
    const message = `clusters ${action} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined | false {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}
