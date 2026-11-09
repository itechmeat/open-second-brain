/**
 * Where every row of `STATE_SURFACES` (`state/surfaces.ts`) goes when a
 * legacy install moves into the brain store (task 2.1, design D11 step 4).
 *
 * The table is keyed by surface id and typed as a total record over
 * {@link StateSurfaceId}, so a surface added to the catalogue without a
 * mapping fails to compile, and `tests/core/store-migration/surface-map.test.ts`
 * checks the same both ways at run time (a surface with no mapping, a
 * mapping for a surface that does not exist).
 *
 * Stream rows replay the phase 1 dual write of each item
 * (`row-records.ts`); see `destinations.ts` for what each destination means.
 */

import { basename, dirname } from "node:path";

import { CONTINUITY_GRAMMAR } from "../brain/continuity/store.ts";
import { RECEIPT_GRAMMAR } from "../brain/decisions/receipts.ts";
import {
  jsonlLedgerGrammar,
  JSONL_LEDGER_EXT,
  type LedgerShardGrammar,
} from "../brain/ledger-shards.ts";
import { LINEAGE_STATE_GRAMMARS } from "../brain/lineage/ledger.ts";
import { LOG_HEAD_GRAMMAR } from "../brain/log.ts";
import { ANY_SURFACE_GRAMMAR } from "../brain/metrics.ts";
import { DECISIONS_GRAMMAR } from "../brain/permissions/ledger.ts";
import { PREF_AUDIT_GRAMMAR } from "../brain/pref-audit.ts";
import { AUDIT_WEEK_SHARD_GRAMMAR } from "../reliability/audit.ts";
import { STATE_SURFACE_ID, type StateSurfaceId } from "../state/surfaces.ts";
import { LEDGER_ROW_KIND, LEDGER_STREAM, LOG_EVENT_KIND } from "../store/constants.ts";
import { DUAL_WRITE_LEDGERS, type RowPartition } from "../store/dual-write-records.ts";
import { LANE_ENTRY_KIND } from "../store/lane-records.ts";
import {
  DESTINATION_KIND,
  MIGRATION_LEDGERS,
  plain,
  rebuildable,
  type Locator,
  type RecordFromItem,
  type SurfaceMapping,
} from "./destinations.ts";
import {
  auditTrailRow,
  continuityRow,
  logEventRow,
  prefAuditRow,
  privateWhenHeld,
  recurrenceRow,
  sharedUnlessNamed,
} from "./row-records.ts";
import { blobFileItem, laneEntryItem } from "./lane-entry-records.ts";

const { deviceLocal, backup, drop } = DESTINATION_KIND;

/** A `ledgers/<name>` stream mapping whose items are found by `locate`. */
function ledger(
  name: string,
  partition: RowPartition,
  rule: string,
  record: RecordFromItem,
  locate: SurfaceMapping["locate"],
): SurfaceMapping {
  return {
    destination: {
      to: DESTINATION_KIND.stream,
      stream: LEDGER_STREAM,
      ledger: name,
      kind: LEDGER_ROW_KIND,
      partition,
      rule,
      record,
    },
    ...(locate !== undefined ? { locate } : {}),
  };
}

/** Shards of `grammar` in the surface's own directory. */
const shardsIn =
  (...grammars: ReadonlyArray<LedgerShardGrammar>) =>
  (_vault: string, primary: string): ReadonlyArray<Locator> =>
    grammars.map((grammar) => ({ shape: "jsonl", dir: primary, grammar }));

/**
 * The per-device shards of a fixed-stem ledger whose surface names the
 * legacy `<stem>.jsonl`: every `<stem>[.<device>].jsonl` beside it.
 */
function stemShards(_vault: string, primary: string): ReadonlyArray<Locator> {
  const stem = basename(primary).slice(0, -`.${JSONL_LEDGER_EXT}`.length);
  return [{ shape: "jsonl", dir: dirname(primary), grammar: jsonlLedgerGrammar(stem) }];
}

/** A SQLite file with its journal siblings and the rebuild's swap file. */
const SQLITE_SIBLINGS = ["", "-wal", "-shm", "-journal", ".new"];
function sqliteFiles(_vault: string, primary: string): ReadonlyArray<Locator> {
  return SQLITE_SIBLINGS.map((suffix) => ({ shape: "tree", path: primary + suffix }));
}

/** One JSON value per file in the surface's directory. */
function jsonFiles(_vault: string, primary: string): ReadonlyArray<Locator> {
  return [{ shape: "json-files", dir: primary }];
}

/** A record lane whose entries become `lane-entry` records (design D14 item 2). */
export function laneEntries(lane: string): SurfaceMapping {
  return {
    destination: {
      to: DESTINATION_KIND.stream,
      stream: "events",
      ledger: null,
      kind: LANE_ENTRY_KIND,
      partition: "by-item",
      rule: LANE_ENTRY_RULE,
      record: laneEntryItem,
    },
    locate: (_vault, primary) => [{ shape: "entries", root: primary, lane }],
  };
}

/** The partition rule of a lane entry. */
export const LANE_ENTRY_RULE =
  "private when the page is private by its visibility markers, or its fields or text name " +
  "a private page or one that cannot be judged";

/** A blob surface: each file becomes a `lane-entry` whose text spills into a blob. */
function blobLane(lane: string, reason: string): SurfaceMapping {
  return {
    destination: {
      to: DESTINATION_KIND.blob,
      partition: "private-when-held",
      reason,
      kind: LANE_ENTRY_KIND,
      record: blobFileItem,
    },
    locate: (_vault, primary) => [{ shape: "entries", root: primary, lane, anyFile: true }],
  };
}

const NAMED = "private when a row names a private page or one that cannot be judged";
const HELD = "private when this machine holds that partition, else shared; " + NAMED;

const REBUILT = "rebuilt from the store on this machine; ";
const MOVED = "kept on this machine only, never synced; ";
const BACKED_UP = "nothing rebuilds it; ";

/** Every `STATE_SURFACES` row, mapped. */
export const SURFACE_MAP: Readonly<Record<StateSurfaceId, SurfaceMapping>> = Object.freeze({
  [STATE_SURFACE_ID.searchIndex]: rebuildable({
    ...plain(
      deviceLocal,
      REBUILT + "the index moves to device-local state (design D5) and is re-read from the store",
    ),
    locate: sqliteFiles,
  }),
  [STATE_SURFACE_ID.searchWriterLock]: rebuildable(
    plain(drop, "a writer lock, recreated beside the device-local index by its next writer"),
  ),
  [STATE_SURFACE_ID.searchSessionFocus]: plain(deviceLocal, MOVED + "per-session search focus"),
  [STATE_SURFACE_ID.secretCustody]: plain(
    backup,
    BACKED_UP + "encrypted secrets and their keyfile",
  ),
  [STATE_SURFACE_ID.ingestContentManifest]: plain(
    deviceLocal,
    MOVED + "per-path ingest digests of this machine's sources",
  ),
  [STATE_SURFACE_ID.ingestCheckpoints]: plain(backup, BACKED_UP + "ingest resume points"),
  [STATE_SURFACE_ID.sessionImportCheckpoints]: plain(
    backup,
    BACKED_UP + "session import resume points",
  ),
  [STATE_SURFACE_ID.attestations]: plain(backup, BACKED_UP + "a past signature cannot be remade"),
  [STATE_SURFACE_ID.attestationKeys]: plain(backup, BACKED_UP + "the private signing key"),
  [STATE_SURFACE_ID.writeDeadLetters]: plain(
    backup,
    BACKED_UP + "the only evidence of a partial multi-artifact write",
  ),
  [STATE_SURFACE_ID.sessionImportLedger]: plain(
    deviceLocal,
    MOVED + "keyed by absolute paths of session logs on this machine",
  ),
  [STATE_SURFACE_ID.sessionMiningLedger]: plain(deviceLocal, MOVED + "barren-session tombstones"),
  [STATE_SURFACE_ID.sessionMiningSurveys]: plain(deviceLocal, MOVED + "pending mining surveys"),
  [STATE_SURFACE_ID.installManifest]: plain(backup, BACKED_UP + "a lockfile of what install wrote"),
  [STATE_SURFACE_ID.protectManifest]: plain(backup, BACKED_UP + "a lockfile of managed fences"),
  [STATE_SURFACE_ID.bootstrapReceipt]: plain(
    backup,
    BACKED_UP + "a lockfile of what bootstrap provisioned",
  ),
  [STATE_SURFACE_ID.maintenanceLease]: {
    ...plain(deviceLocal, MOVED + "the local maintenance lease"),
    locate: sqliteFiles,
  },
  [STATE_SURFACE_ID.maintenanceJournal]: ledger(
    DUAL_WRITE_LEDGERS.maintenanceJournal,
    "shared",
    NAMED,
    sharedUnlessNamed(DUAL_WRITE_LEDGERS.maintenanceJournal),
    stemShards,
  ),
  [STATE_SURFACE_ID.hookAudit]: ledger(
    DUAL_WRITE_LEDGERS.reliabilityAudit,
    "private-when-held",
    HELD,
    auditTrailRow,
    shardsIn(AUDIT_WEEK_SHARD_GRAMMAR),
  ),
  [STATE_SURFACE_ID.hookSessionState]: plain(deviceLocal, MOVED + "per-session hook state"),
  [STATE_SURFACE_ID.selfHealUpgradeMarker]: plain(
    deviceLocal,
    MOVED + "this machine's failed-upgrade cooldown",
  ),
  [STATE_SURFACE_ID.freshenState]: rebuildable(
    plain(deviceLocal, MOVED + "this machine's freshen backoff"),
  ),
  [STATE_SURFACE_ID.watchdogAudit]: ledger(
    DUAL_WRITE_LEDGERS.reliabilityAudit,
    "private-when-held",
    HELD,
    auditTrailRow,
    shardsIn(AUDIT_WEEK_SHARD_GRAMMAR),
  ),
  [STATE_SURFACE_ID.injectFailopenCache]: rebuildable(
    plain(drop, "a cache of the last rendered injection; the next render writes it again"),
  ),
  [STATE_SURFACE_ID.aiderContext]: rebuildable(
    plain(drop, "regenerated before every Aider session"),
  ),
  [STATE_SURFACE_ID.brainLog]: {
    destination: {
      to: DESTINATION_KIND.stream,
      stream: "log",
      ledger: null,
      kind: LOG_EVENT_KIND,
      partition: "by-item",
      rule: "shared, except an event that names a private page or carries a private region",
      record: logEventRow,
    },
    locate: shardsIn(LOG_HEAD_GRAMMAR),
  },
  [STATE_SURFACE_ID.continuityLedger]: ledger(
    DUAL_WRITE_LEDGERS.continuity,
    "shared",
    "private when the record is flagged private or names a private page",
    continuityRow,
    shardsIn(CONTINUITY_GRAMMAR),
  ),
  [STATE_SURFACE_ID.dreamRuns]: plain(
    drop,
    "resume points of dream passes over the legacy tree; no such pass resumes after the " +
      "switch, and the Brain snapshot keeps them",
  ),
  [STATE_SURFACE_ID.prefAudit]: ledger(
    DUAL_WRITE_LEDGERS.preferenceAudit,
    "private-when-held",
    "private when this machine holds that partition, else shared; private only when the " +
      "preference is private",
    prefAuditRow,
    (_vault, primary) => [
      { shape: "jsonl", dir: primary, grammar: PREF_AUDIT_GRAMMAR, subdirs: true },
    ],
  ),
  [STATE_SURFACE_ID.recurrenceLedger]: ledger(
    DUAL_WRITE_LEDGERS.recurrence,
    "shared",
    "private when its source or any field names a private page",
    recurrenceRow,
    stemShards,
  ),
  [STATE_SURFACE_ID.queryDemandLedger]: ledger(
    DUAL_WRITE_LEDGERS.queryDemand,
    "private-when-held",
    HELD,
    privateWhenHeld(DUAL_WRITE_LEDGERS.queryDemand),
    stemShards,
  ),
  [STATE_SURFACE_ID.captureDecisionLog]: ledger(
    MIGRATION_LEDGERS.captureDecisions,
    "private-when-held",
    HELD,
    privateWhenHeld(MIGRATION_LEDGERS.captureDecisions),
    stemShards,
  ),
  [STATE_SURFACE_ID.decisionReceipts]: ledger(
    DUAL_WRITE_LEDGERS.decisionReceipts,
    "shared",
    NAMED,
    sharedUnlessNamed(DUAL_WRITE_LEDGERS.decisionReceipts),
    shardsIn(RECEIPT_GRAMMAR),
  ),
  [STATE_SURFACE_ID.lineageLedger]: ledger(
    DUAL_WRITE_LEDGERS.lineage,
    "private-when-held",
    HELD,
    privateWhenHeld(DUAL_WRITE_LEDGERS.lineage),
    (vault, primary) => shardsIn(...LINEAGE_STATE_GRAMMARS)(vault, dirname(primary)),
  ),
  [STATE_SURFACE_ID.freezeMarker]: plain(
    drop,
    "a stop signal for legacy writers, not data; the migration quiesces through its own " +
      "device-local gate (design D11 step 2)",
  ),
  [STATE_SURFACE_ID.repairCandidates]: plain(
    deviceLocal,
    MOVED + "pending hub proposals; the next drain stages them again",
  ),
  [STATE_SURFACE_ID.writeImages]: blobLane(
    "write-image",
    "the bytes a note write replaced, content-addressed already",
  ),
  [STATE_SURFACE_ID.anticipatoryCache]: rebuildable(
    plain(drop, "pre-rendered context packs, recomputed"),
  ),
  [STATE_SURFACE_ID.exactState]: laneEntries("exact-state"),
  [STATE_SURFACE_ID.searchFeedback]: ledger(
    MIGRATION_LEDGERS.searchFeedback,
    "private-when-held",
    HELD,
    privateWhenHeld(MIGRATION_LEDGERS.searchFeedback),
    jsonFiles,
  ),
  [STATE_SURFACE_ID.searchLearnedWeights]: rebuildable(
    plain(drop, "folded from the search feedback events, which migrate"),
  ),
  [STATE_SURFACE_ID.searchReinforce]: ledger(
    MIGRATION_LEDGERS.searchReinforce,
    "private-when-held",
    HELD,
    privateWhenHeld(MIGRATION_LEDGERS.searchReinforce),
    jsonFiles,
  ),
  [STATE_SURFACE_ID.searchTuning]: rebuildable(
    plain(
      drop,
      "a tuning result re-validated on every read; search uses the defaults until the next run",
    ),
  ),
  [STATE_SURFACE_ID.searchEmbeddingProviders]: plain(
    deviceLocal,
    MOVED + "the custom embedding providers registered on this machine",
  ),
  [STATE_SURFACE_ID.searchRerankProviders]: plain(
    deviceLocal,
    MOVED + "the custom rerank providers registered on this machine",
  ),
  [STATE_SURFACE_ID.searchActivation]: plain(
    deviceLocal,
    MOVED + "this machine's search recency boost and its access events",
  ),
  [STATE_SURFACE_ID.snapshots]: plain(
    deviceLocal,
    MOVED + "snapshots are device-local and unsynced in the store layout",
  ),
  [STATE_SURFACE_ID.mcpArtifacts]: plain(
    deviceLocal,
    MOVED + "tool payloads fetched back by id within their time to live",
  ),
  [STATE_SURFACE_ID.metrics]: ledger(
    DUAL_WRITE_LEDGERS.metrics,
    "shared",
    NAMED,
    sharedUnlessNamed(DUAL_WRITE_LEDGERS.metrics),
    shardsIn(ANY_SURFACE_GRAMMAR),
  ),
  [STATE_SURFACE_ID.skillAcceptJournal]: plain(
    backup,
    BACKED_UP + "in-flight repair markers of skill rewrites",
  ),
  [STATE_SURFACE_ID.claudeMemoryManifest]: plain(
    deviceLocal,
    MOVED + "digests of this machine's host memory directory",
  ),
  [STATE_SURFACE_ID.claimGraph]: rebuildable(plain(drop, "a projection recomputed from the pages")),
  [STATE_SURFACE_ID.rollupLedger]: plain(deviceLocal, MOVED + "consolidation counters"),
  [STATE_SURFACE_ID.crossTopicLedger]: plain(deviceLocal, MOVED + "the daily promotion budget"),
  [STATE_SURFACE_ID.proposalWatermark]: plain(deviceLocal, MOVED + "a scan watermark"),
  [STATE_SURFACE_ID.captureWatermark]: plain(deviceLocal, MOVED + "a catch-up watermark"),
  [STATE_SURFACE_ID.decisionLedger]: ledger(
    DUAL_WRITE_LEDGERS.permissions,
    "private-when-held",
    HELD,
    privateWhenHeld(DUAL_WRITE_LEDGERS.permissions),
    shardsIn(DECISIONS_GRAMMAR),
  ),
  [STATE_SURFACE_ID.sourceArchives]: blobLane(
    "source-archive",
    "redacted source text, content-addressed already",
  ),
  [STATE_SURFACE_ID.instructionBlockLock]: plain(
    backup,
    BACKED_UP + "a lockfile of instruction blocks this tool wrote",
  ),
  [STATE_SURFACE_ID.lessonApprovals]: plain(backup, BACKED_UP + "operator approval decisions"),
  [STATE_SURFACE_ID.skillBenchmarks]: laneEntries("skill-benchmark"),
});
