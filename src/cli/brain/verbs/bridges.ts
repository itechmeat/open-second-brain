/**
 * `o2b brain bridges discover|list|accept|dismiss` (t_ab540afe):
 * bridge discovery over the vec index. `discover` regenerates the
 * reviewable `Brain/proposals/bridges.md` artifact and records one
 * `bridge_discovery` metric; `accept` writes a single `related:`
 * wikilink into the source note; `dismiss` silences a pair across
 * future runs. Fail-soft on a missing index or vec layer - the verb
 * reports why and exits 0 so cron wrappers stay quiet.
 *
 * Exit codes: 0 on success/fail-soft skip, 1 on an operational
 * failure, 2 on usage errors.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  acceptBridge,
  bridgePairKey,
  discoverBridges,
  dismissBridge,
  readDismissedBridges,
  writeBridgeProposals,
  BRIDGE_DEFAULT_MAX_PROPOSALS,
  BRIDGE_DEFAULT_MIN_SIMILARITY,
} from "../../../core/brain/link-graph/bridge-discovery.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import {
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SafeguardTimeoutError,
} from "../../../core/brain/safeguard.ts";
import { loadSchemaPack } from "../../../core/brain/schema-pack.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { Store } from "../../../core/search/store.ts";
import { SearchError } from "../../../core/search/types.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain bridges discover [--max N] [--min-similarity X] | list | " +
  "accept <source> <target> | dismiss <source> <target>  [--vault <path>] [--json]";

export async function cmdBrainBridges(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    max: { type: "string" },
    "min-similarity": { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const action = positional[0];
  if (
    action === undefined ||
    !["discover", "list", "accept", "dismiss"].includes(action) ||
    ((action === "accept" || action === "dismiss") && positional.length !== 3) ||
    ((action === "discover" || action === "list") && positional.length !== 1)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  try {
    if (action === "accept") {
      const pack = loadSchemaPack(vault);
      const result = acceptBridge(vault, positional[1]!, positional[2]!, { pack });
      if (asJson) okJson({ ...result, source: positional[1], target: positional[2] });
      else if (result.changed) ok(`bridge accepted: related now ${result.related.join(", ")}`);
      else ok("bridge already accepted (related target present)");
      return 0;
    }

    if (action === "dismiss") {
      const added = dismissBridge(vault, positional[1]!, positional[2]!);
      if (asJson) {
        okJson({ dismissed: bridgePairKey(positional[1]!, positional[2]!), added });
      } else ok(added ? "bridge dismissed" : "bridge was already dismissed");
      return 0;
    }

    if (action === "list") {
      const path = join(vault, "Brain", "proposals", "bridges.md");
      if (!existsSync(path)) {
        if (asJson) okJson({ exists: false, proposals: 0 });
        else ok("no proposals artifact yet - run: o2b brain bridges discover");
        return 0;
      }
      const [meta, body] = parseFrontmatter(path);
      if (asJson) {
        okJson({
          exists: true,
          path: "Brain/proposals/bridges.md",
          generated_at: meta["generated_at"] ?? null,
          proposals: Number(meta["proposals"] ?? 0),
        });
      } else ok(body);
      return 0;
    }

    // discover
    const max = parsePositiveInt(flags["max"] as string | undefined);
    const minSimilarity = parseFraction(flags["min-similarity"] as string | undefined);
    if (max === false || minSimilarity === false) {
      process.stderr.write(
        "brain bridges discover: --max must be a positive integer, --min-similarity in (0, 1]\n",
      );
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
        if (asJson) okJson({ vec_available: false, proposals: [], reason: "index not built" });
        else ok("bridges discover: search index not initialised - run: o2b search index");
        return 0;
      }
      throw exc;
    }

    const now = new Date();
    try {
      const dismissed = readDismissedBridges(vault);
      const report = discoverBridges(store, {
        ...(max !== undefined ? { maxProposals: max } : {}),
        ...(minSimilarity !== undefined ? { minSimilarity } : {}),
        dismissed,
        safeguard: createSafeguard({
          operation: "bridges",
          timeoutMs: resolveSafeguardTimeoutMs("bridges", config ?? undefined),
        }),
      });
      const path = writeBridgeProposals(vault, report, { now });
      try {
        appendMetric(vault, {
          surface: "bridge_discovery",
          runAt: isoSecond(now),
          payload: {
            proposals: report.proposals.length,
            scanned_candidates: report.scannedCandidates,
            vec_available: report.vecAvailable,
            dismissed_total: dismissed.size,
            min_similarity: minSimilarity ?? BRIDGE_DEFAULT_MIN_SIMILARITY,
            max_proposals: max ?? BRIDGE_DEFAULT_MAX_PROPOSALS,
          },
        });
      } catch {
        // Metrics are observability, not correctness.
      }
      if (asJson) {
        okJson({
          vec_available: report.vecAvailable,
          ...(report.reason !== undefined ? { reason: report.reason } : {}),
          scanned_candidates: report.scannedCandidates,
          proposals: report.proposals,
          artifact: "Brain/proposals/bridges.md",
        });
      } else if (!report.vecAvailable) {
        ok(`bridges discover: ${report.reason ?? "vec layer unavailable"}`);
      } else if (report.proposals.length === 0) {
        ok("bridges discover: no new bridge proposals");
      } else {
        ok(`bridges discover: ${report.proposals.length} proposal(s) -> ${path}`);
        for (const p of report.proposals) {
          ok(`  ${p.source} <-> ${p.target}  sim=${p.similarity.toFixed(3)}`);
        }
      }
      return 0;
    } finally {
      await store.close();
    }
  } catch (exc) {
    const timedOut = exc instanceof SafeguardTimeoutError;
    const message = `bridges ${action} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message, ...(timedOut ? { timed_out: true } : {}) });
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

function parseFraction(raw: string | undefined): number | undefined | false {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : false;
}
