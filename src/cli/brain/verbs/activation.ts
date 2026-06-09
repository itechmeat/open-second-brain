/**
 * `o2b brain activation <op>` (Time-Aware Recall & Activation Suite,
 * t_2bc79017): operator surface over the activation event store -
 * `status` reports the folded state, `sweep` drops events outside the
 * retention window / newest-N cap and refolds.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import {
  ACCESS_EVENT_MAX_COUNT,
  ACCESS_EVENT_RETENTION_DAYS,
  computeActivationState,
  loadAccessEvents,
  sweepActivationEvents,
} from "../../../core/search/activation/store.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain activation <status|sweep> " +
  "[--top N] [--retention-days N] [--max-events N] [--vault V] [--json]";

const TOP_DEFAULT = 10;

function parsePositiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

export async function cmdBrainActivation(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    top: { type: "string" },
    "retention-days": { type: "string" },
    "max-events": { type: "string" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  if (op !== "status" && op !== "sweep") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const asJson = flags["json"] === true;
  const vault = brainVerbContext(flags).vault;

  try {
    if (op === "status") {
      const top = parsePositiveInt(flags["top"], "top", TOP_DEFAULT);
      const state = computeActivationState(loadAccessEvents(vault));
      const rows = Object.entries(state.paths)
        .map(([path, row]) => ({
          path,
          strength: row.strength,
          access_count: row.accessCount,
          last_access_at: new Date(row.lastAccessAt).toISOString(),
        }))
        .toSorted(
          (a, b) =>
            b.strength - a.strength ||
            b.access_count - a.access_count ||
            a.path.localeCompare(b.path),
        )
        .slice(0, top);
      const body = {
        events: state.events,
        paths: Object.keys(state.paths).length,
        co_access_pairs: state.coAccess.length,
        updated_at: state.updatedAt,
        top: rows,
      };
      if (asJson) {
        okJson(body);
      } else {
        ok(
          `activation: ${body.events} event(s), ${body.paths} path(s), ` +
            `${body.co_access_pairs} co-access pair(s)`,
        );
        for (const r of rows) {
          ok(`  ${r.strength.toFixed(2)}  x${r.access_count}  ${r.path}`);
        }
      }
      return 0;
    }

    const retentionDays = parsePositiveInt(
      flags["retention-days"],
      "retention-days",
      ACCESS_EVENT_RETENTION_DAYS,
    );
    const maxEvents = parsePositiveInt(flags["max-events"], "max-events", ACCESS_EVENT_MAX_COUNT);
    const outcome = sweepActivationEvents(vault, {
      nowMs: Date.now(),
      retentionDays,
      maxEvents,
    });
    if (asJson) {
      okJson({ removed: outcome.removed, kept: outcome.kept });
    } else {
      ok(`activation sweep: removed ${outcome.removed}, kept ${outcome.kept}`);
    }
    return 0;
  } catch (exc) {
    const message = `activation ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
