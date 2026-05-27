/**
 * `mergePreferences` — explicit operator-initiated merge of two
 * confirmed/quarantine preferences (§12).
 *
 * Contract: `keep` retains identity. `drop` retires under
 * `BRAIN_RETIRED_REASON.mergedInto` with a `superseded_by` pointing
 * at `keep`. `keep` picks up the sorted-dedup union of
 * `evidenced_by`, the sum of `applied_count` / `violated_count`, and
 * `max(last_evidence_at)`. `confidence` and `confidence_value` are
 * NOT recomputed here — the next `dream` pass owns that derivation;
 * recomputing in-place would split the source of truth.
 *
 * All guards (`same-id`, `keep-not-found`, `drop-not-found`,
 * `topic-mismatch`, `scope-mismatch`, `pin-parity`) are data
 * invariants and throw `BrainMergeError`. `--force` at the CLI
 * level does NOT bypass them — it only skips the interactive
 * confirmation prompt.
 *
 * No snapshot is created. Merge is point-precise (one keep, one
 * drop). Roll-back: copy `Brain/retired/ret-<drop>.md` back to
 * `Brain/preferences/pref-<drop>.md`, rerun `o2b brain dream` to
 * recompute counters.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { regenerateActiveQuiet } from "./active.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirs, preferencePath } from "./paths.ts";
import { moveToRetired, parsePreference, writePreference } from "./preference.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_RETIRED_REASON } from "./types.ts";
import { renderPrefLink } from "./wikilink.ts";

export type BrainMergeErrorCode =
  | "same-id"
  | "keep-not-found"
  | "drop-not-found"
  | "drop-already-retired"
  | "topic-mismatch"
  | "scope-mismatch"
  | "pin-parity"
  | "unsupported-status";

export class BrainMergeError extends Error {
  readonly code: BrainMergeErrorCode;
  constructor(code: BrainMergeErrorCode, message: string) {
    super(message);
    this.name = "BrainMergeError";
    this.code = code;
  }
}

export interface MergeOptions {
  /** Wall clock for the run. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Agent identity stamped into the log event. */
  readonly agentName?: string;
  /** When true, return the plan but make no writes. */
  readonly dryRun?: boolean;
}

export interface MergePlan {
  readonly keep_id: string;
  readonly drop_id: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly merged_evidenced_by: ReadonlyArray<string>;
  readonly applied_sum: number;
  readonly violated_sum: number;
  readonly last_evidence_at: string | null;
  readonly retired_path: string;
}

export function mergePreferences(
  vault: string,
  keepId: string,
  dropId: string,
  opts: MergeOptions = {},
): MergePlan {
  if (keepId === dropId) {
    throw new BrainMergeError("same-id", `keep and drop refer to the same preference '${keepId}'`);
  }
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;

  const keepSlug = stripPrefPrefix(keepId);
  const dropSlug = stripPrefPrefix(dropId);
  const keepPath = preferencePath(vault, keepSlug);
  const dropPath = preferencePath(vault, dropSlug);

  if (!existsSync(keepPath)) {
    if (existsSync(join(brainDirs(vault).retired, `ret-${keepSlug}.md`))) {
      throw new BrainMergeError(
        "keep-not-found",
        `keep '${keepId}' is already retired; cannot merge into a retired pref`,
      );
    }
    throw new BrainMergeError(
      "keep-not-found",
      `keep '${keepId}' not found under Brain/preferences/`,
    );
  }
  if (!existsSync(dropPath)) {
    if (existsSync(join(brainDirs(vault).retired, `ret-${dropSlug}.md`))) {
      throw new BrainMergeError(
        "drop-already-retired",
        `drop '${dropId}' is already in Brain/retired/`,
      );
    }
    throw new BrainMergeError(
      "drop-not-found",
      `drop '${dropId}' not found under Brain/preferences/`,
    );
  }

  const keep = parsePreference(keepPath);
  const drop = parsePreference(dropPath);

  if (!isMergeableStatus(keep.status)) {
    throw new BrainMergeError(
      "unsupported-status",
      `keep '${keepId}' has status '${keep.status}'; merge only supports confirmed or quarantine preferences`,
    );
  }
  if (!isMergeableStatus(drop.status)) {
    throw new BrainMergeError(
      "unsupported-status",
      `drop '${dropId}' has status '${drop.status}'; merge only supports confirmed or quarantine preferences`,
    );
  }

  if (keep.topic !== drop.topic) {
    throw new BrainMergeError(
      "topic-mismatch",
      `topic mismatch: keep='${keep.topic}', drop='${drop.topic}'.` +
        " Merge is for near-duplicate rules in the same bucket;" +
        " use `o2b brain reject` if drop is wrong rather than redundant.",
    );
  }
  const keepScope = keep.scope ?? null;
  const dropScope = drop.scope ?? null;
  if (keepScope !== dropScope) {
    throw new BrainMergeError(
      "scope-mismatch",
      `scope mismatch: keep='${keepScope ?? "(none)"}', drop='${dropScope ?? "(none)"}'.` +
        " Use `o2b brain reject` instead.",
    );
  }
  if (keep.pinned !== drop.pinned && drop.pinned) {
    throw new BrainMergeError(
      "pin-parity",
      `drop '${dropId}' is pinned but keep '${keepId}' is not;` +
        " put the pinned pref first as <keep> if you want to merge.",
    );
  }

  const merged_evidenced_by = mergeEvidencedBy(keep.evidenced_by, drop.evidenced_by);
  const applied_sum = keep.applied_count + drop.applied_count;
  const violated_sum = keep.violated_count + drop.violated_count;
  const last_evidence_at = maxIso(keep.last_evidence_at, drop.last_evidence_at);

  const plan: MergePlan = Object.freeze({
    keep_id: keepId,
    drop_id: dropId,
    topic: keep.topic,
    scope: keepScope,
    merged_evidenced_by,
    applied_sum,
    violated_sum,
    last_evidence_at,
    retired_path: join(brainDirs(vault).retired, `ret-${dropSlug}.md`),
  });

  if (dryRun) return plan;

  // 1. Rewrite keep with the merged fields. Confidence band/value
  //    are NOT recomputed here — dream owns that derivation. We
  //    pass the existing values through so the file is consistent.
  writePreference(
    vault,
    {
      slug: keepSlug,
      topic: keep.topic,
      principle: keep.principle,
      created_at: keep.created_at,
      unconfirmed_until: keep.unconfirmed_until,
      status: keep.status,
      evidenced_by: merged_evidenced_by,
      confirmed_at: keep.confirmed_at,
      applied_count: applied_sum,
      violated_count: violated_sum,
      last_evidence_at,
      confidence: keep.confidence,
      confidence_value: keep.confidence_value,
      pinned: keep.pinned,
      ...(keep.scope ? { scope: keep.scope } : {}),
      ...(keep.supersedes ? { supersedes: keep.supersedes } : {}),
      ...(keep.aliases ? { aliases: keep.aliases } : {}),
    },
    { overwrite: true },
  );

  // 2. Move drop to retired/ with merged-into reason. moveToRetired
  //    re-reads the source file, so the latest on-disk state is
  //    what lands in the snapshot — including drop's own counters,
  //    which we want preserved as audit trail.
  const supersededBy = renderPrefLink({
    id: keep.id,
    principle: keep.principle,
  });
  moveToRetired(vault, dropPath, BRAIN_RETIRED_REASON.mergedInto, {
    now,
    retired_by: `[[Brain/log/${isoDate(now)}]]`,
    superseded_by: supersededBy,
  });

  // 3. Append a `merge` log event with audit-grade payload.
  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.merge,
    body: {
      keep: renderPrefLink({ id: keep.id, principle: keep.principle }),
      drop: renderPrefLink({ id: drop.id, principle: drop.principle }),
      signal_union: `${merged_evidenced_by.length} (was ${keep.evidenced_by.length}, ${drop.evidenced_by.length})`,
      applied_sum: `${applied_sum} (was ${keep.applied_count}, ${drop.applied_count})`,
      violated_sum: `${violated_sum} (was ${keep.violated_count}, ${drop.violated_count})`,
      agent: opts.agentName ?? "unknown",
    },
  });

  // 4. Regenerate active.md so the operator sees the new state on
  //    their next session start.
  regenerateActiveQuiet(vault, { now });

  return plan;
}

function stripPrefPrefix(id: string): string {
  if (!id.startsWith("pref-") || id.length <= "pref-".length) {
    throw new BrainMergeError("keep-not-found", `expected a 'pref-…' id; got '${id}'`);
  }
  return id.slice("pref-".length);
}

function mergeEvidencedBy(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort();
  return Object.freeze(out);
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function isMergeableStatus(status: string): boolean {
  return status === "confirmed" || status === "quarantine";
}
