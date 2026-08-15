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
import { graphStats } from "../../../core/brain/link-graph/graph-index.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import { brainConfigPath } from "../../../core/brain/paths.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
  SafeguardTimeoutError,
} from "../../../core/brain/safeguard.ts";
import {
  BRAIN_HEALTH_DEFAULTS,
  loadBrainConfig,
  resolveHealth,
} from "../../../core/brain/policy.ts";
import {
  evaluateStaleness,
  MATERIALIZE_FRESHNESS,
  stalenessReason,
  type StalenessResult,
} from "../../../core/brain/staleness.ts";
import { isoSecond, MS_PER_DAY } from "../../../core/brain/time.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { Store } from "../../../core/search/store.ts";
import { SearchError } from "../../../core/search/types.ts";
import { listVaultPages, parseFrontmatter } from "../../../core/vault.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain clusters run [--min-size N] [--batch-size N] [--if-stale] [--progress] | " +
  "list  [--vault <path>] [--json]";

/** Vault-relative directory holding the materialized cluster notes. */
const CLUSTERS_DIR_REL = join("Brain", "clusters");

/**
 * Compare the materialized cluster notes against the vault's notes (their
 * inputs) for the `--if-stale` fast-path. Cluster notes are excluded from the
 * input set so an output never counts as its own input.
 */
function clustersStaleness(vault: string, nowMs: number): StalenessResult {
  const clustersDir = join(vault, CLUSTERS_DIR_REL);
  const inputs = listVaultPages(vault)
    .map((p) => p.path)
    .filter((p) => !p.startsWith(clustersDir));
  const outputs = existsSync(clustersDir)
    ? readdirSync(clustersDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(clustersDir, f))
    : [];
  return evaluateStaleness(inputs, outputs, { nowMs, maxAgeMs: materializeMaxAgeMs(vault) });
}

/**
 * The wall-clock ceiling from `health.materialize_max_age_days`, in ms.
 *
 * A vault with no Brain config at all is the normal case for this verb -
 * `clusters run` works on any indexed vault - so an ABSENT config resolves
 * the ceiling from the defaults table, exactly as an absent key does.
 *
 * A config that exists and will not parse is a different answer and is not
 * swallowed. The earlier reading here was that a default ceiling "can only
 * make the ceiling looser than the operator intended", which is wrong in
 * both directions: an operator who wrote 7 and typed it wrong silently gets
 * 30, and the run then reports `skipped: "fresh"` and exits 0 over a vault
 * whose configuration this verb could not read. Every other verb refuses
 * that config loudly, and `--if-stale` was the one path that did not.
 */
function materializeMaxAgeMs(vault: string): number {
  if (!existsSync(brainConfigPath(vault))) {
    return BRAIN_HEALTH_DEFAULTS.materialize_max_age_days * MS_PER_DAY;
  }
  return resolveHealth(loadBrainConfig(vault)).materialize_max_age_days * MS_PER_DAY;
}

/**
 * Record what the freshness gate concluded, on every `--if-stale` run
 * rather than only on the skip. A metric written only when the answer is
 * `fresh` records nothing about the two answers an operator would
 * actually want to see in a dashboard: how often the fast-path does the
 * work anyway, and how often it could not tell.
 */
function recordFreshness(vault: string, staleness: StalenessResult, runAt: string): void {
  try {
    appendMetric(vault, {
      surface: "communities",
      runAt,
      payload: {
        freshness: staleness.state,
        freshness_reason: stalenessReason(staleness),
        newest_input_ms: staleness.newestInputMs,
        oldest_output_ms: staleness.oldestOutputMs,
        oldest_output_age_ms: staleness.oldestOutputAgeMs,
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }
}

export async function cmdBrainClusters(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "min-size": { type: "string" },
    "batch-size": { type: "string" },
    "if-stale": { type: "boolean" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  // no-dead-ends, task 5: the fail-soft "no index" exit below shares its
  // registry code with the identical branch in `bridges`, so the two
  // cannot drift on what an operator is told to run.
  const stream: AdvisoryStream = { command: "brain", argv, jsonRequested: asJson };
  const action = positional[0];
  if ((action !== "run" && action !== "list") || positional.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  try {
    if (action === "list") {
      const dir = join(vault, "Brain", "clusters");
      if (!existsSync(dir)) {
        if (asJson) okJson({ clusters: [], ...nextCommandField("cluster-notes-absent") });
        else ok("no cluster notes yet");
        // no-dead-ends, phase 3: this pointer was hand-written in the
        // same file as a migrated one, so `list` printed `- run: ...`
        // while `run` printed `next: ...`.
        emitNextStep("cluster-notes-absent", stream);
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
      if (asJson) {
        okJson({
          clusters,
          ...(clusters.length === 0 ? nextCommandField("cluster-notes-absent") : {}),
        });
      } else if (clusters.length === 0) {
        // The directory exists but holds nothing this verb generated -
        // the SAME state as the missing-directory branch above, which
        // previously said nothing forward at all.
        ok("no generated cluster notes");
        emitNextStep("cluster-notes-absent", stream);
      } else {
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
    const batchSize = parsePositiveInt(flags["batch-size"] as string | undefined);
    if (batchSize === false) {
      process.stderr.write("brain clusters run: --batch-size must be a positive integer\n");
      return 2;
    }

    // Staleness fast-path (t_845fe240): when the materialized cluster notes are
    // already newer than every input note and inside the configured wall-clock
    // ceiling, skip the recompute entirely. Opt-in so the default behavior is
    // unchanged; records the verdict as a metric on every run.
    //
    // B4: the gate skips ONLY on `fresh`. On `unknown` it recomputes AND says
    // which measurement failed - recomputing silently would be as dishonest as
    // skipping silently, because the operator asked for a fast-path and is
    // entitled to know it could not be evaluated.
    let freshnessNotice: Record<string, unknown> = {};
    if (flags["if-stale"] === true) {
      const evaluatedAt = new Date();
      const staleness = clustersStaleness(vault, evaluatedAt.getTime());
      recordFreshness(vault, staleness, isoSecond(evaluatedAt));
      if (staleness.state === MATERIALIZE_FRESHNESS.fresh) {
        if (asJson) okJson({ communities: 0, skipped: "fresh" });
        else ok("clusters run: outputs already fresh - skipped (--if-stale)");
        return 0;
      }
      if (staleness.state === MATERIALIZE_FRESHNESS.unknown) {
        const reason = staleness.unknownReason;
        // In `--json` the notice rides the result object: a bare line on
        // stdout would corrupt the document the caller is parsing.
        if (asJson) {
          freshnessNotice = { staleness: { state: staleness.state, reason } };
        } else {
          ok(`clusters run: freshness unknown (${reason}) - recomputing`);
        }
      }
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
        if (asJson) {
          okJson({
            communities: 0,
            reason: "index not built",
            ...freshnessNotice,
            ...nextCommandField("search-index-missing"),
          });
        } else ok("clusters run: search index not initialised");
        emitNextStep("search-index-missing", stream);
        return 0;
      }
      throw exc;
    }

    const now = new Date();
    // Progress is opt-in: attaching a sink by default would change the
    // stderr of every existing invocation, and this CLI's one streaming
    // precedent (`o2b search index --verbose`) is opt-in for the same
    // reason. The rail decides whether the stream can carry it at all.
    const observation =
      flags["progress"] === true
        ? attachProgress({ command: "brain", argv: ["clusters"], jsonRequested: asJson })
        : null;
    reportProgressRefusal(observation);
    // No interrupt handle: `detectCommunitiesRun` is synchronous end to
    // end, so a signal handler cannot run while it does (see
    // `interrupt.ts`). Leaving SIGINT alone keeps the keystroke lethal,
    // which is the only way this pass can actually be stopped.
    try {
      const safeguard = createSafeguard({
        operation: OPERATION.clusters,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.clusters, config ?? undefined),
      });
      const communities = detectCommunities(store, {
        ...(minSize !== undefined ? { minSize } : {}),
        safeguard,
        ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
      });
      // O(1) from the snapshot detectCommunities just built (same index
      // revision -> cache hit, no second graph rebuild).
      const stats = graphStats(store, { top: 5 });
      const result = materializeClusterNotes(vault, communities, {
        store,
        now,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
      const failedBatches = result.batches?.filter((b) => b.error !== undefined) ?? [];
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
            ...(result.batches
              ? { batches: result.batches.length, failed_batches: failedBatches.length }
              : {}),
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
          graph: {
            documents: stats.documentCount,
            linked_nodes: stats.nodeCount,
            edges: stats.edgeCount,
            top_degree: stats.topByDegree,
          },
          written: result.written,
          removed: result.removed,
          ...(result.batches ? { batches: result.batches } : {}),
          ...freshnessNotice,
        });
      } else if (communities.length === 0) {
        ok("clusters run: no communities at the current threshold");
        ok(`  graph: ${stats.nodeCount} linked nodes, ${stats.edgeCount} edges`);
      } else {
        ok(`clusters run: ${communities.length} communit${communities.length === 1 ? "y" : "ies"}`);
        for (const c of communities) {
          ok(`  ${c.id}: ${c.size} notes, density ${c.density.toFixed(2)}`);
        }
        ok(`  graph: ${stats.nodeCount} linked nodes, ${stats.edgeCount} edges`);
        if (result.batches) {
          ok(
            `  batches: ${result.batches.length} (${failedBatches.length} failed)` +
              (failedBatches.length > 0
                ? ` - failed: ${failedBatches.map((b) => `#${b.index} (${b.error})`).join(", ")}`
                : ""),
          );
        }
        if (result.removed.length > 0) ok(`  removed stale: ${result.removed.join(", ")}`);
      }
      return 0;
    } finally {
      await store.close();
    }
  } catch (exc) {
    const timedOut = exc instanceof SafeguardTimeoutError;
    const message = `clusters ${action} failed: ${(exc as Error).message ?? exc}`;
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
