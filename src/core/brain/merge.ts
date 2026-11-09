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

import { join } from "node:path";

import { PREFERENCE_EVIDENCE_KIND, type EvidenceResult } from "../store/constants.ts";
import {
  isPrivatePageFile,
  isPrivatePreference,
  MERGED_FROM_FIELD,
  preferenceEvidenceRecord,
} from "../store/dual-write-records.ts";
import { storeWrite } from "../store/store-write.ts";

import { regenerateActiveQuiet } from "./active.ts";
import { preferencesStoreOnly, storePreferenceEntry } from "./preference-store.ts";
import { computeContentHash } from "./content-hash.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { guardEntityMerge, type GuardEntityLike } from "./truth/merge-guard.ts";
import { resolveAppendShardId } from "./ledger-shards.ts";
import { appendLogEvent, logShardWikilink } from "./log.ts";
import { brainDirs, preferencePath } from "./paths.ts";
import { appendPrefAudit } from "./pref-audit.ts";
import {
  loadPreference,
  moveToRetired,
  parsePreference,
  preferencePresence,
  writePreference,
} from "./preference.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_RETIRED_REASON, PREF_AUDIT_OP } from "./types.ts";
import { renderPrefLink } from "./wikilink.ts";

export type BrainMergeErrorCode =
  | "same-id"
  | "keep-not-found"
  | "drop-not-found"
  | "drop-already-retired"
  | "topic-mismatch"
  | "scope-mismatch"
  | "pin-parity"
  | "unsupported-status"
  | "entity-guard";

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
  /**
   * Skip the name-aware entity merge guard (t_e9692750). The CLI maps
   * `--force` here; the guard otherwise refuses to collapse claims
   * about different people/orgs into one preference.
   */
  readonly bypassEntityGuard?: boolean;
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

  // The pages on an unswitched machine, the store's fold once switched.
  const keepPresence = preferencePresence(vault, keepSlug);
  if (keepPresence !== "active") {
    if (keepPresence === "retired") {
      throw new BrainMergeError(
        "keep-not-found",
        `keep '${keepId}' is already retired; cannot merge into a retired pref`,
      );
    }
    throw new BrainMergeError("keep-not-found", `keep preference '${keepId}' not found`);
  }
  const dropPresence = preferencePresence(vault, dropSlug);
  if (dropPresence !== "active") {
    if (dropPresence === "retired") {
      throw new BrainMergeError("drop-already-retired", `drop '${dropId}' is already retired`);
    }
    throw new BrainMergeError("drop-not-found", `drop preference '${dropId}' not found`);
  }

  // Once switched the fold is the only source: a preference gone since
  // the presence check is not found, and no page path is read.
  const storeOnly = preferencesStoreOnly(vault);
  const load = (slug: string, path: string, code: "keep-not-found" | "drop-not-found") => {
    const loaded = loadPreference(vault, slug);
    if (loaded !== null) return loaded;
    if (storeOnly) throw new BrainMergeError(code, `preference 'pref-${slug}' not found`);
    return parsePreference(path);
  };
  const keep = load(keepSlug, keepPath, "keep-not-found");
  const drop = load(dropSlug, dropPath, "drop-not-found");

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

  // Name-aware entity guard (t_e9692750): same-topic near-duplicates
  // naming different people/orgs must not collapse into one rule.
  if (opts.bypassEntityGuard !== true) {
    let entities: ReadonlyArray<GuardEntityLike> = [];
    try {
      entities = buildEntityIndex(vault).entities;
    } catch {
      // No readable registry means nothing to anchor against.
    }
    const verdict = guardEntityMerge({
      keepText: `${keep.topic} ${keep.principle}`,
      dropText: `${drop.topic} ${drop.principle}`,
      entities,
    });
    if (!verdict.allowed) {
      throw new BrainMergeError("entity-guard", `${verdict.reason}; pass --force to override`);
    }
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
    // Once switched no page is written: the retired record's id names it.
    retired_path: storeOnly
      ? `ret-${dropSlug}`
      : join(brainDirs(vault).retired, `ret-${dropSlug}.md`),
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
      // Rewrites the persisted keep record: a legacy scope must not
      // block the merge (see `lenientScopeTags`).
      lenientScopeTags: true,
      ...(keep.supersedes ? { supersedes: keep.supersedes } : {}),
      ...(keep.aliases ? { aliases: keep.aliases } : {}),
    },
    { overwrite: true },
  );

  // 1b. Once switched the fold derives the counters from evidence records
  //     and ignores a counter written as a field, so the keep absorbs the
  //     drop's counters as evidence: one evidence record per drop
  //     evidence record, private when either side is.
  if (storeOnly) {
    const dropEntry = storePreferenceEntry(dropSlug);
    const keepEntry = storePreferenceEntry(keepSlug);
    // The merge's steps are separate store writes. A merge retried after
    // a step past this one failed (the drop still active) must not copy
    // the drop's evidence a second time: each copy names the record it
    // copies, and a record the keep already holds a copy of is skipped.
    const copied = new Set(
      (keepEntry?.state.history ?? [])
        .map((record) => record.body[MERGED_FROM_FIELD])
        .filter((id): id is string => typeof id === "string"),
    );
    const evidence = (dropEntry?.state.history ?? []).filter(
      (record) => record.kind === PREFERENCE_EVIDENCE_KIND && !copied.has(record.id),
    );
    if (evidence.length > 0) {
      const pairPrivate = (keepEntry?.private ?? true) || (dropEntry?.private ?? true);
      storeWrite(
        () =>
          evidence.map((record) =>
            preferenceEvidenceRecord({
              id: keep.id,
              result: record.body["result"] as EvidenceResult,
              artifact: typeof record.body["artifact"] === "string" ? record.body["artifact"] : "",
              agent: opts.agentName ?? "merge",
              private: pairPrivate,
              mergedFrom: record.id,
            }),
          ),
        { vault },
      );
    }
  }

  // 2. Move drop to retired/ with merged-into reason. moveToRetired
  //    re-reads the source file, so the latest on-disk state is
  //    what lands in the snapshot — including drop's own counters,
  //    which we want preserved as audit trail.
  const supersededBy = renderPrefLink({
    id: keep.id,
    principle: keep.principle,
  });
  // The retired_by link names the log shard the `merge` event below is
  // about to land in, so the retirement's provenance always resolves.
  // Resolved once here and handed to both writes: two independent
  // resolutions are two chances to disagree about the shard.
  const shardId = resolveAppendShardId();
  moveToRetired(vault, dropPath, BRAIN_RETIRED_REASON.mergedInto, {
    now,
    retired_by: logShardWikilink(isoDate(now), shardId),
    superseded_by: supersededBy,
    audit: { agent: opts.agentName ?? "merge" },
  });

  // Per-preference mutation audit (Brain lifecycle suite F1). The keep
  // pref absorbed evidence + counters; record a `merge` op on its trail.
  // A merge is a lifecycle event, so it records even though keep's
  // principle/scope fingerprint is unchanged. The drop's retire(merged-
  // into) record is written by moveToRetired above.
  {
    const keepHash = computeContentHash(keep.principle, keep.scope);
    appendPrefAudit(
      vault,
      {
        pref_id: keep.id,
        op: PREF_AUDIT_OP.merge,
        agent: opts.agentName ?? "merge",
        reason: `merged-in ${drop.id}`,
        revision_before: keep.revision ?? null,
        revision_after: keep.revision ?? null,
        hash_before: keepHash,
        hash_after: keepHash,
        // The row names the drop too (`merged-in <drop>`): private when
        // either side is. The drop is already in `retired/` by now.
        private: () =>
          (storeOnly
            ? (storePreferenceEntry(keepSlug)?.private ?? true)
            : isPrivatePageFile(keepPath)) || isPrivatePreference(vault, dropSlug),
      },
      { now },
    );
  }

  // 3. Append a `merge` log event with audit-grade payload. The same
  //    shard id the retired_by link above names, so the event is where
  //    the link says it is.
  appendLogEvent(
    vault,
    {
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
    },
    { deviceId: shardId },
  );

  // 4. Regenerate active.md so the operator sees the new state on
  //    their next session start.
  // The digest is a page of the legacy tree; a store-only machine renders
  // it on demand (design D14 item 7).
  if (!preferencesStoreOnly(vault)) regenerateActiveQuiet(vault, { now });

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
