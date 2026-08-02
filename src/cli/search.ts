/**
 * `o2b search` subcommand dispatcher.
 *
 * Routes the Brain Search verbs (design doc §8) to thin wrappers over
 * `src/core/search/*`. The core modules own all I/O; each verb handler
 * lives in `./search/verbs/<name>.ts` and only parses flags, resolves the
 * vault, shapes exit codes, and renders either human-readable or JSON
 * output. This file dispatches and maps thrown errors onto exit codes.
 *
 * Shared parse/validate/config plumbing lives in `./search/helpers.ts`,
 * which is the single barrel every verb imports it through.
 */

import { SafeguardTimeoutError } from "../core/brain/safeguard.ts";
import { SearchError } from "../core/search/index.ts";
import { CliError } from "./argparse.ts";
import { cmdSearchCheck } from "./search/verbs/check.ts";
import { cmdSearchExpand } from "./search/verbs/expand.ts";
import { cmdSearchFocus } from "./search/verbs/focus.ts";
import { cmdSearchEventAnchorBackfill } from "./search/verbs/event-anchor-backfill.ts";
import { cmdSearchIndex, cmdSearchReindex } from "./search/verbs/indexing.ts";
import { cmdSearchFeedback, cmdSearchWeights } from "./search/verbs/learned-weights.ts";
import { cmdSearchPlan } from "./search/verbs/plan.ts";
import { cmdSearchProvider, cmdSearchRerankProvider } from "./search/verbs/provider-registry.ts";
import { cmdSearchQuery } from "./search/verbs/query.ts";
import { cmdSearchRerankFit } from "./search/verbs/rerank-fit.ts";
import { cmdSearchStatus } from "./search/verbs/status.ts";
import { cmdSearchVectorBackfill } from "./search/verbs/vector-backfill.ts";
import { cmdSearchWatch } from "./search/verbs/watch.ts";

const KNOWN_VERBS = new Set([
  "query",
  "expand",
  "index",
  "reindex",
  "status",
  "check",
  "focus",
  "feedback",
  "weights",
  "provider",
  "rerank-provider",
  "rerank-fit",
  "plan",
  "watch",
  "vector-backfill",
  "event-anchor-backfill",
]);

export async function handleSearchSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  // First positional is verb iff it matches a known verb. Otherwise the
  // default verb is `query` and the positional is the query string.
  let verb = "query";
  let rest = argv;
  if (argv.length > 0 && KNOWN_VERBS.has(argv[0]!)) {
    verb = argv[0]!;
    rest = argv.slice(1);
  }

  try {
    switch (verb) {
      case "query":
        return await cmdSearchQuery(rest);
      case "expand":
        return await cmdSearchExpand(rest);
      case "index":
        return await cmdSearchIndex(rest);
      case "reindex":
        return await cmdSearchReindex(rest);
      case "watch":
        return await cmdSearchWatch(rest);
      case "status":
        return await cmdSearchStatus(rest);
      case "check":
        return await cmdSearchCheck(rest);
      case "focus":
        return await cmdSearchFocus(rest);
      case "feedback":
        return await cmdSearchFeedback(rest);
      case "weights":
        return await cmdSearchWeights(rest);
      case "provider":
        return await cmdSearchProvider(rest);
      case "rerank-provider":
        return await cmdSearchRerankProvider(rest);
      case "rerank-fit":
        return await cmdSearchRerankFit(rest);
      case "plan":
        return await cmdSearchPlan(rest);
      case "vector-backfill":
        return await cmdSearchVectorBackfill(rest);
      case "event-anchor-backfill":
        return await cmdSearchEventAnchorBackfill(rest);
      default:
        process.stderr.write(`error: unknown search verb: ${verb}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof SafeguardTimeoutError) {
      // Operational failure with a precise cause: the cooperative
      // deadline tripped at a checkpoint (t_06784b8d). Search verbs
      // report errors as stderr text regardless of --json, so the
      // timeout follows the same convention.
      process.stderr.write(`error: ${e.message} [SAFEGUARD_TIMEOUT]\n`);
      return 1;
    }
    if (e instanceof SearchError) {
      process.stderr.write(`error: ${e.message} [${e.code}]\n`);
      return e.code === "INVALID_INPUT" ? 2 : 1;
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
