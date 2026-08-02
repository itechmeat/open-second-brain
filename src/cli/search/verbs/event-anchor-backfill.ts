/**
 * `o2b search event-anchor-backfill` — resolve the event anchors an
 * in-place schema migration could not (provenance at the boundary).
 *
 * A schema bump migrates the index in place and reindexes nothing, and
 * the indexer resolves an anchor only below its two content-identity
 * fastpaths. A document indexed by the previous binary therefore never
 * gets one: its content does not change, so it is never re-read. This
 * verb reads exactly those documents and nothing else - no vault walk,
 * no re-chunking, no embedding provider.
 *
 * Dry-run is the DEFAULT; `--apply` is the only path that writes. The
 * shape follows `search/verbs/vector-backfill.ts` line for line,
 * including the log append whose failure is reported on stderr rather
 * than swallowed.
 */

import { appendLogEvent } from "../../../core/brain/log.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { resolveAgentName } from "../../../core/config.ts";
import {
  planEventAnchorBackfill,
  type EventAnchorBackfillResult,
} from "../../../core/search/event-anchor-backfill.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import { info, ok } from "../../output.ts";
import {
  flagBoolean,
  parseFlags,
  resolveConfig,
  resolveConfigPath,
  searchAdvisoryStream,
  VAULT_FLAGS,
} from "../helpers.ts";

/**
 * The state this verb leaves an operator in when work remains: indexed
 * documents whose event anchor has never been resolved. Its registered
 * exit is this same verb under `--apply`, which is the point of naming it.
 */
const EVENT_ANCHORS_PENDING = "event-anchors-pending";

/** JSON payload shape. Snake case, matching every other search verb. */
function jsonForResult(result: EventAnchorBackfillResult): Record<string, unknown> {
  return {
    dry_run: !result.applied,
    documents_total: result.documentsTotal,
    pending: result.pending,
    examined: result.examined,
    anchored: result.anchored,
    // Absent rather than empty when every file was readable, so a clean
    // run emits the payload it would have emitted without this field.
    ...(result.unreadable.length > 0
      ? { unreadable: result.unreadable.map((u) => ({ path: u.path, message: u.message })) }
      : {}),
  };
}

function renderHuman(result: EventAnchorBackfillResult): void {
  if (result.applied) {
    ok(
      `event-anchor-backfill: examined ${result.examined} of ${result.pending} pending document(s), ` +
        `${result.anchored} of which declare an event time`,
    );
  } else {
    ok(
      `event-anchor-backfill dry-run: ${result.pending} of ${result.documentsTotal} document(s) ` +
        `have no event anchor resolved`,
    );
  }
  // A file that could not be read is NAMED. It keeps no verdict and
  // stays pending, so it must not vanish into the counts above.
  if (result.unreadable.length > 0) {
    info(`  ${result.unreadable.length} indexed document(s) could not be read:`);
    for (const u of result.unreadable) info(`    - ${u.path}: ${u.message}`);
  }
}

export async function cmdSearchEventAnchorBackfill(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const apply = flagBoolean(flags, "apply");
  const jsonRequested = flagBoolean(flags, "json");

  const result = await planEventAnchorBackfill(cfg, { apply });

  if (apply && result.examined > 0) {
    try {
      appendLogEvent(cfg.vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.eventAnchorBackfill,
        body: {
          agent: resolveAgentName(resolveConfigPath(flags)),
          examined: String(result.examined),
          anchored: String(result.anchored),
          pending: String(result.pending),
          documents_total: String(result.documentsTotal),
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append event-anchor-backfill log failed: ${(err as Error).message}\n`,
      );
    }
  }

  // Work remains exactly when the run did not consume it - which
  // includes every document whose file could not be read, since those
  // were deliberately left unexamined rather than recorded as dateless.
  const pendingAfter = result.pending - result.examined;

  if (jsonRequested) {
    process.stdout.write(
      JSON.stringify({
        ...jsonForResult(result),
        ...(pendingAfter > 0 ? nextCommandField(EVENT_ANCHORS_PENDING) : {}),
      }) + "\n",
    );
  } else {
    renderHuman(result);
  }
  if (pendingAfter > 0) {
    emitNextStep(EVENT_ANCHORS_PENDING, searchAdvisoryStream(argv, jsonRequested));
  }
  return 0;
}
