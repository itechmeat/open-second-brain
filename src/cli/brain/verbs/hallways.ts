/**
 * `o2b brain hallways mine|show|promote|dismiss` (recall-quality wave,
 * Lane B / t_13a82a31): the CLI over the session-mined ledger.
 *
 *   mine     - derive incidence and pairwise PMI over the mined-mention
 *              ledger and persist the derived artifact plus the
 *              reviewable proposals file; records one hallways_mine
 *              metric. Writes NO entity page.
 *   show     - read the proposals artifact back (fail-soft).
 *   promote  - the ONE bridge into the entity registry. Offered only for
 *              keys seen in >= N distinct sessions (default
 *              DEFAULT_PROMOTION_MIN_SESSIONS, override with
 *              --min-sessions) and never for a dismissed key; the write
 *              itself flows through `upsertEntity` and `relateEntities`
 *              exclusively, so a promoted label failing the tightened
 *              admission gate is refused by that gate, not by this verb.
 *   dismiss  - silence a key across future runs.
 *
 * Exit codes: 0 on success/fail-soft skip, 1 on an operational failure
 * or a refused promotion, 2 on usage errors.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  computeHallways,
  DEFAULT_PROMOTION_MIN_SESSIONS,
  dismissHallwayKey,
  HALLWAYS_PROPOSALS_REL,
  hallwaysKeyId,
  readDismissedHallwayKeys,
  writeHallwaysArtifact,
  writeHallwaysProposals,
} from "../../../core/brain/link-graph/hallways.ts";
import { SESSION_MINING_FAMILIES } from "../../../core/brain/link-graph/session-mining.ts";
import { getEntity, relateEntities, upsertEntity } from "../../../core/brain/entities/registry.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
} from "../../../core/brain/safeguard.ts";
import { InvalidEntityLabelError } from "../../../core/brain/entities/canonical.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain hallways mine [--min-co N] [--min-score X] [--limit N] [--min-sessions N] [--progress] | " +
  "show | promote <family> <key> [--min-sessions N] | dismiss <family> <key>  [--vault <path>] [--json]";

export async function cmdBrainHallways(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "min-co": { type: "string" },
    "min-score": { type: "string" },
    limit: { type: "string" },
    "min-sessions": { type: "string" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const action = positional[0];
  if (
    action === undefined ||
    !["mine", "show", "promote", "dismiss"].includes(action) ||
    ((action === "promote" || action === "dismiss") && positional.length !== 3) ||
    ((action === "mine" || action === "show") && positional.length !== 1)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  // The advisory stream, for the one forward pointer this verb can emit
  // (the absent-artifact case below): the rail owns what reaches stdout.
  const stream: AdvisoryStream = { command: "brain", argv: ["hallways"], jsonRequested: asJson };

  // `promote` names a mined family: the ledger is family-scoped, so a
  // family that never mines is a typo, not a refusal.
  if (action === "promote" || action === "dismiss") {
    const family = positional[1]!;
    if (!(SESSION_MINING_FAMILIES as readonly string[]).includes(family)) {
      process.stderr.write(
        `${USAGE}\nerror: unknown mining family '${family}' - the mined families are ${SESSION_MINING_FAMILIES.join(", ")}\n`,
      );
      return 2;
    }
  }

  const minSessions = parsePositiveInt(flags["min-sessions"] as string | undefined);
  if (minSessions === false) {
    process.stderr.write("brain hallways: --min-sessions must be a positive integer\n");
    return 2;
  }

  if (action === "dismiss") {
    const added = dismissHallwayKey(vault, positional[1]!, positional[2]!);
    if (asJson) {
      okJson({ dismissed: hallwaysKeyId(positional[1]!, positional[2]!), added });
    } else ok(added ? "key dismissed" : "key was already dismissed");
    return 0;
  }

  if (action === "show") {
    const path = join(vault, HALLWAYS_PROPOSALS_REL);
    if (!existsSync(path)) {
      if (asJson) {
        okJson({ exists: false, proposals: 0, ...nextCommandField("hallways-proposals-absent") });
      } else ok("no proposals artifact yet");
      // Fail-soft, but not silent about the fix: the pointer rides the
      // advisory rail like every other one.
      emitNextStep("hallways-proposals-absent", stream);
      return 0;
    }
    const [meta, body] = parseFrontmatter(path);
    if (asJson) {
      okJson({
        exists: true,
        path: "Brain/proposals/hallways.md",
        generated_at: meta["generated_at"] ?? null,
        proposals: Number(meta["proposals"] ?? 0),
        keys: Number(meta["keys"] ?? 0),
        pairs: Number(meta["pairs"] ?? 0),
      });
    } else ok(body);
    return 0;
  }

  if (action === "promote") {
    return promote(vault, {
      family: positional[1]!,
      key: positional[2]!,
      minSessions: minSessions ?? DEFAULT_PROMOTION_MIN_SESSIONS,
      agent: resolveBrainAgent(flags, config ?? ""),
      config,
      asJson,
    });
  }

  // mine
  const minCo = parsePositiveInt(flags["min-co"] as string | undefined);
  const limit = parsePositiveInt(flags["limit"] as string | undefined);
  const minScoreRaw = flags["min-score"] as string | undefined;
  const minScore = minScoreRaw === undefined ? undefined : Number(minScoreRaw);
  if (
    minCo === false ||
    limit === false ||
    (minScoreRaw !== undefined && !Number.isFinite(minScore))
  ) {
    process.stderr.write(
      "brain hallways mine: --min-co and --limit must be positive integers, --min-score a number\n",
    );
    return 2;
  }

  const now = new Date();
  // Progress is opt-in, exactly like `brain bridges discover`: attaching a
  // sink by default would change the stderr of every existing invocation.
  const observation =
    flags["progress"] === true
      ? attachProgress({ command: "brain", argv: ["hallways"], jsonRequested: asJson })
      : null;
  reportProgressRefusal(observation);
  try {
    const dismissed = readDismissedHallwayKeys(vault);
    const result = computeHallways(vault, {
      ...(minCo !== undefined ? { minCoSessions: minCo } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
      ...(limit !== undefined ? { limit } : {}),
      dismissed,
      safeguard: createSafeguard({
        operation: OPERATION.sessions,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.sessions, config ?? undefined),
      }),
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
    writeHallwaysArtifact(vault, result, { generatedAt: isoSecond(now) });
    writeHallwaysProposals(vault, result, {
      now,
      dismissed,
      ...(minSessions !== undefined ? { minSessions } : {}),
    });
    try {
      appendMetric(vault, {
        surface: "hallways_mine",
        runAt: isoSecond(now),
        payload: {
          session_count: result.sessionCount,
          keys: result.keys.length,
          pairs: result.pairs.length,
          mention_rows: result.mentionRows,
          skipped_rows: result.skippedRows,
          dismissed_total: dismissed.size,
          promotion_min_sessions: minSessions ?? DEFAULT_PROMOTION_MIN_SESSIONS,
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    if (asJson) {
      okJson({
        artifact: "Brain/link-graph/hallways.json",
        proposals: "Brain/proposals/hallways.md",
        session_count: result.sessionCount,
        mention_rows: result.mentionRows,
        skipped_rows: result.skippedRows,
        keys: result.keys.length,
        pairs: result.pairs.length,
        promotion_min_sessions: minSessions ?? DEFAULT_PROMOTION_MIN_SESSIONS,
      });
    } else {
      ok(
        `mined ${result.keys.length} keys over ${result.sessionCount} sessions; ` +
          `${result.pairs.length} pairs; proposals at Brain/proposals/hallways.md`,
      );
    }
    return 0;
  } catch (exc) {
    return fail(`brain hallways mine failed: ${(exc as Error).message}`);
  }
}

/**
 * Promote one mined key. The gate first (threshold, dismissals), then
 * the registry: `upsertEntity` for the page, `relateEntities` for every
 * association whose other half is already promoted. No other write path
 * exists here - which is exactly why a label the tightened admission
 * gate refuses cannot become an entity page through this verb.
 */
function promote(
  vault: string,
  args: {
    readonly family: string;
    readonly key: string;
    readonly minSessions: number;
    readonly agent: string;
    /** Config path the safeguard ladder resolves promote's deadline from. */
    readonly config: string | null;
    readonly asJson: boolean;
  },
): number {
  const dismissed = readDismissedHallwayKeys(vault);
  if (dismissed.has(hallwaysKeyId(args.family, args.key))) {
    return refuse(
      args.asJson,
      `promote refused: '${args.key}' (${args.family}) is dismissed - a dismissal is final ` +
        "for this artifact (re-mining keeps the key silenced), so there is no undo verb: " +
        "the way back is removing its id from Brain/proposals/hallways-dismissed.json by hand",
    );
  }

  // The threshold is read off the CURRENT ledger fold, never the stored
  // artifact: the artifact is a cache, the gate is a decision. The fold is
  // the same O(k^2) pass `mine` runs, so it carries mine's bounded-wait
  // deadline too - a promote over a huge ledger stops at a checkpoint and
  // reports the timeout instead of owning the thread.
  let derivation: ReturnType<typeof computeHallways>;
  try {
    derivation = computeHallways(vault, {
      dismissed,
      safeguard: createSafeguard({
        operation: OPERATION.sessions,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.sessions, args.config ?? undefined),
      }),
    });
  } catch (exc) {
    return fail(`brain hallways promote failed: ${(exc as Error).message}`);
  }
  const stat = derivation.keys.find((k) => k.family === args.family && k.key === args.key);
  if (stat === undefined || stat.sessionCount < args.minSessions) {
    return refuse(
      args.asJson,
      `promote refused: '${args.key}' (${args.family}) is seen in ${stat?.sessionCount ?? 0} ` +
        `distinct sessions, below the promotion threshold of ${args.minSessions} ` +
        "(raise coverage or lower --min-sessions)",
    );
  }

  try {
    const out = upsertEntity(vault, {
      category: args.family,
      name: args.key,
      agent: args.agent,
      now: new Date(),
      bodyOnCreate:
        "Promoted from the session-mining ledger: this key kept turning up in " +
        "imported session transcripts. Provenance-grade until an operator curates it.",
    });

    // Associations whose other half is already an entity get a real
    // relation edge; the rest can be promoted later, and a later promote
    // relates back. `relateEntities` resolves and refuses on its own, so
    // a partner that is not (yet) an entity simply contributes nothing.
    const related: string[] = [];
    for (const pair of derivation.pairs) {
      const other =
        pair.left === hallwaysKeyId(args.family, args.key)
          ? splitKeyId(pair.right)
          : pair.right === hallwaysKeyId(args.family, args.key)
            ? splitKeyId(pair.left)
            : null;
      if (other === null) continue;
      const partner = getEntity(vault, { category: other.family, query: other.key });
      if (partner === null) continue;
      relateEntities(vault, {
        from: { category: args.family, query: args.key },
        relation: "related",
        to: { category: other.family, query: other.key },
        now: new Date(),
      });
      related.push(partner.id);
    }

    if (args.asJson) {
      okJson({
        promoted: true,
        created: out.created,
        entity: out.entity.id,
        sessions: stat.sessionCount,
        related,
      });
    } else {
      ok(
        `${out.created ? "created" : "updated"}: ${out.entity.id} ` +
          `(${stat.sessionCount} sessions${related.length > 0 ? `; related to ${related.join(", ")}` : ""})`,
      );
    }
    return 0;
  } catch (exc) {
    if (exc instanceof InvalidEntityLabelError) {
      // The pinned coupling: the admission path refused, so this verb
      // reports the gate's verdict and writes nothing.
      return refuse(
        args.asJson,
        `promote refused: the entity admission gate rejected '${args.key}' ` +
          `(${exc.reason}) - a mined key is a suggestion, the registry is the decision`,
      );
    }
    return fail(`brain hallways promote failed: ${(exc as Error).message}`);
  }
}

/** Refusal shape: message on stderr (or JSON), exit 1, nothing written. */
function refuse(asJson: boolean, message: string): number {
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, refused: true, reason: message }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  return 1;
}

function splitKeyId(id: string): { family: string; key: string } {
  const sep = id.indexOf(":");
  return { family: id.slice(0, sep), key: id.slice(sep + 1) };
}

function parsePositiveInt(raw: string | undefined): number | undefined | false {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}
