import { planAuthoredAtBackfill } from "../../../core/brain/authored-at-backfill.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { brainVerbContext, info, ok, okJson, parse } from "../helpers.ts";

/**
 * `o2b brain authored-at-backfill` (conversation chronology, S1).
 *
 * Materialise the additive `authored_at` frontmatter field on
 * session-imported signals that preserved a transcript turn instant but
 * predate the field. Dry-run by DEFAULT (report only); `--apply` writes.
 * Idempotent, and never re-embeds - it only edits frontmatter.
 */
export async function cmdBrainAuthoredAtBackfill(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const apply = flags["apply"] === true;

  const result = planAuthoredAtBackfill(vault, { apply });

  if (apply && result.updated > 0) {
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.authoredAtBackfill,
        body: {
          agent: resolveAgentName(config),
          updated: String(result.updated),
          scanned: String(result.scanned),
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append authored-at-backfill log failed: ${(err as Error).message}\n`,
      );
    }
  }

  if (flags["json"]) {
    okJson({
      dry_run: !apply,
      scanned: result.scanned,
      updated: result.updated,
      candidates: result.candidates.map((c) => ({ path: c.path, authored_at: c.authoredAt })),
    });
    return 0;
  }

  if (apply) {
    ok(
      `authored-at-backfill: updated ${result.updated} of ${result.candidates.length} candidate(s)`,
    );
  } else {
    ok(
      `authored-at-backfill dry-run: ${result.candidates.length} candidate(s) (scanned ${result.scanned})`,
    );
    info("re-run with --apply to write the authored_at field");
  }
  for (const c of result.candidates) {
    info(`  ${c.path}: authored_at=${c.authoredAt}`);
  }
  return 0;
}
