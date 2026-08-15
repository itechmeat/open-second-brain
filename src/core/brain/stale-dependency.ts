/**
 * Collection side of the reverse stale-dependency audit (U3).
 *
 * The question and the reasoning behind it are in
 * `doctor/stale-dependency-check.ts`, which owns the pure join this
 * module feeds. What lives here is every read the join cannot perform
 * for itself, and the decisions each read forces.
 *
 * ## Three stores, one direction of travel
 *
 * The STATE side is assembled from the three writers that end a record's
 * currency:
 *
 *   - `moveToRetired` renames `pref-<slug>` to `ret-<slug>` and stamps
 *     `retired_at`. The records arrive through `doctor/records.ts`, so
 *     the parse discipline is the doctor's, not this module's.
 *   - `tombstone` stamps `_status: tombstoned` and `tombstoned_at` on
 *     any Brain artifact.
 *   - `temporalReplace` closes a fact's half-open interval by writing
 *     `valid_until`.
 *
 * The CONSUMER side is assembled from the two receipt stores and the
 * live artifact graph. No identifier is rewritten anywhere: the rename
 * is already crossed by `moveToRetired` writing the old `pref-<slug>`
 * into the retired file's `aliases:`, which `buildBacklinkIndex`
 * resolves through the alias index, and by `brainArtifactSlug` folding
 * both spellings onto one key on both sides of the join.
 *
 * ## The log is not a consumer
 *
 * `buildBacklinkIndex` walks `Brain/log/` alongside the artifacts, and
 * every retirement writes its own log entry naming the rule it retired.
 * Counting those would make the check fire on its own audit trail, every
 * time, for every retirement. The append-only log is the record THAT the
 * state changed; it is not something resting on the state having not
 * changed. Log-sourced references are dropped.
 *
 * ## What an unreadable store does
 *
 * Nothing here turns a failed read into an empty result. A directory
 * that exists and cannot be entered raises `StaleDependencyReadError`
 * naming the path and the attempted action, and the doctor check reports
 * it through the uncertainty channel. An ABSENT store is different and
 * stays quiet: a vault that never emitted a receipt legitimately has no
 * continuity directory, and that case is already carried by
 * `recorded: false`.
 *
 * The kernel, the vocabularies, the shapes and that error all come from
 * `doctor/stale-dependency-check.ts`, which imports nothing back. The
 * dependency runs one way on purpose; see that module's docblock.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildBacklinkIndex } from "./backlinks.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { listContinuityRecords } from "./continuity/store.ts";
import {
  normalizeDecisionSubject,
  readDecisionChangeReceipts,
  receiptsDir,
} from "./decisions/receipts.ts";
import { readAllRetiredRecords } from "./doctor/records.ts";
import {
  joinStaleDependencies,
  STALE_DEPENDENCY_CONSUMER,
  STALE_DEPENDENCY_LOOKBACK_DAYS,
  STALE_DEPENDENCY_MAX_CONSUMERS_PER_STATE,
  STALE_DEPENDENCY_STATE,
  StaleDependencyReadError,
  type StaleDependencyCitation,
  type StaleDependencyRow,
  type StaleDependencyState,
} from "./doctor/stale-dependency-check.ts";
import { readLifecycleState } from "./lifecycle/tombstone.ts";
import { boundaryToMs, VALID_UNTIL_KEY } from "./lifecycle/temporal-replace.ts";
import { brainDirs } from "./paths.ts";
import { MS_PER_DAY } from "./time.ts";
import { parseFrontmatter } from "../vault.ts";
import { brainArtifactSlug } from "./wikilink.ts";

// ----- Constants ------------------------------------------------------------

/** Extension of every Brain artifact this module reads. */
const MARKDOWN_EXT = ".md";

/**
 * `BacklinkRef.sourceKind` prefix marking a reference read out of the
 * append-only log. See the module docblock for why those are dropped.
 */
const LOG_SOURCE_KIND_PREFIX = "log-";

/** Continuity record kind carrying the injected item list. */
const CONTEXT_RECEIPT_KIND = "context_receipt";

/** Directory holding the continuity shards, relative to `Brain/log`. */
const CONTINUITY_DIR_NAME = "continuity";

/** Payload key holding a context receipt's injected items. */
const RECEIPT_ITEMS_KEY = "items";

/** Item key holding an injected artifact's identifier. */
const RECEIPT_ITEM_ID_KEY = "id";

/** The one `errno` meaning a directory was never created. */
const DIR_ABSENT_ERRNO = "ENOENT";

// ----- Public shapes --------------------------------------------------------

export interface StaleDependencyOptions {
  /** Wall clock; tests pin it. Defaults to now. */
  readonly now?: Date;
  /** Consumer window in days; defaults to {@link STALE_DEPENDENCY_LOOKBACK_DAYS}. */
  readonly lookbackDays?: number;
  /** Per-state report cap; defaults to {@link STALE_DEPENDENCY_MAX_CONSUMERS_PER_STATE}. */
  readonly maxConsumersPerState?: number;
}

/**
 * The audit's answer.
 *
 * `recorded` is the {@link import("./context-receipts.ts").ContextReceiptFoldEmpty}
 * contract restated: `false` means the window held no receipts of either
 * kind, so nothing measured what the store's consumers actually rest on.
 * It is emphatically NOT "no stale dependencies were found" - the rows
 * are empty in both cases, and only this flag tells them apart.
 */
export interface StaleDependencyReport {
  /**
   * Whether either receipt store held anything in the window.
   *
   * It is NOT "whether the audit found anything", and it no longer gates
   * the rows: the artifact arm reads the backlink graph and always runs,
   * so a vault with the receipt gates off still gets every finding that
   * evidence supports. What this flag scopes is the part that was not
   * measured - the packs and decisions whose consumption is only visible
   * through a receipt - so a caller can say which half of the answer is
   * missing instead of implying the whole of it is.
   */
  readonly receipts_recorded: boolean;
  readonly rows: ReadonlyArray<StaleDependencyRow>;
  /**
   * How many states this vault has that stopped being current - retired,
   * tombstoned, or with a closed validity interval.
   *
   * Deliberately over all of vault history rather than the window: the
   * question it answers is whether anything was at stake at all. A store
   * where nothing ever changed has nothing whose consumers could have gone
   * stale, so an unmeasured receipt trail costs it nothing and there is no
   * honest warning to raise. A store where states did change and nothing
   * recorded what consumed them is the case worth saying out loud, and
   * this is how a caller tells the two apart without re-walking the vault.
   */
  readonly states_changed: number;
  /** Inclusive lower bound of the consumer window, as a UTC instant. */
  readonly window_since: string;
  readonly lookback_days: number;
}

// ----- Entry point ----------------------------------------------------------

/**
 * Audit which consumers rest on a state that has since changed.
 *
 * Read-only. With no receipts in the window there is nothing to join,
 * so the citation collection and the join are skipped - but the state
 * walk is not. An unmeasured audit still has to report whether anything
 * changed, because "nobody measured, and nothing changed either" and
 * "nobody measured, and eleven states moved" are different answers and
 * only the second is worth an operator's attention.
 *
 * @throws {@link StaleDependencyReadError} when a store that exists
 *   cannot be read.
 */
export function auditStaleDependencies(
  vault: string,
  opts: StaleDependencyOptions = {},
): StaleDependencyReport {
  const now = opts.now ?? new Date();
  const lookbackDays = Math.max(1, Math.floor(opts.lookbackDays ?? STALE_DEPENDENCY_LOOKBACK_DAYS));
  const windowSince = new Date(now.getTime() - lookbackDays * MS_PER_DAY).toISOString();
  const contextReceipts = readContextReceipts(vault, windowSince);
  const decisionReceipts = readDecisionCitations(vault, windowSince);
  const artifacts = walkBrainArtifacts(vault);
  const states = collectStates(vault, artifacts, now.getTime());
  const stateKeys = new Set(states.map((state) => state.key));

  // The artifact arm runs unconditionally, and that is the point. It reads
  // the backlink universe on disk and needs no telemetry, so a vault with
  // the receipt gates off can still be told which live records cite a rule
  // that was retired under them. An earlier shape returned empty here the
  // moment both receipt stores were quiet, which threw away a computable
  // answer and then reported that nothing was knowable - the exact trade
  // this release exists to stop making.
  const citations: StaleDependencyCitation[] = [
    ...contextReceipts,
    ...decisionReceipts,
    ...collectArtifactCitations(vault, artifacts, stateKeys),
  ];

  return Object.freeze({
    receipts_recorded: contextReceipts.length > 0 || decisionReceipts.length > 0,
    rows: joinStaleDependencies({
      states,
      citations,
      maxConsumersPerState: opts.maxConsumersPerState ?? STALE_DEPENDENCY_MAX_CONSUMERS_PER_STATE,
    }),
    window_since: windowSince,
    lookback_days: lookbackDays,
    states_changed: states.length,
  });
}

// ----- Consumer side: context receipts --------------------------------------

/**
 * Context receipts in the window, one citation each.
 *
 * Private and redacted receipts are counted as measurement having
 * happened but are never unfolded, mirroring the withheld rule in
 * `summarizeContextReceiptSession`: a redacted payload must not re-enter
 * the vault through an aggregate built over it.
 */
function readContextReceipts(vault: string, since: string): ReadonlyArray<StaleDependencyCitation> {
  let records: ReadonlyArray<ContinuityRecord>;
  try {
    records = listContinuityRecords(vault, { kind: CONTEXT_RECEIPT_KIND, since });
  } catch (err) {
    throw new StaleDependencyReadError(
      "continuity record read failed",
      join(brainDirs(vault).log, CONTINUITY_DIR_NAME),
      err,
    );
  }
  const out: StaleDependencyCitation[] = [];
  for (const record of records) {
    if (record.private || record.redacted) continue;
    const items = record.payload[RECEIPT_ITEMS_KEY];
    if (!Array.isArray(items)) continue;
    const cites = new Set<string>();
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const id = (raw as Record<string, unknown>)[RECEIPT_ITEM_ID_KEY];
      if (typeof id !== "string") continue;
      const key = brainArtifactSlug(id);
      if (key !== "") cites.add(key);
    }
    if (cites.size === 0) continue;
    const writtenAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(writtenAtMs)) continue;
    out.push({
      kind: STALE_DEPENDENCY_CONSUMER.contextReceipt,
      id: record.id,
      written_at: record.createdAt,
      written_at_ms: writtenAtMs,
      live: true,
      cites: [...cites],
    });
  }
  return out;
}

// ----- Consumer side: decision-change receipts ------------------------------

/**
 * Decision-change receipts in the window, one citation each.
 *
 * The cited states are the receipt's `evidence_triggers` - the records
 * the writer said the change rested on. The consumer's own identity is
 * its `subject`, folded through `normalizeDecisionSubject`, which is the
 * existing read-side normalizer for the three shapes subjects are stored
 * in; inventing a second one here would be the drift this wave keeps
 * finding.
 *
 * A receipt whose `ts` did not survive the line parse cannot be placed
 * in time, so it contributes no citation. Its shard already produced a
 * parse warning at the read below.
 */
function readDecisionCitations(
  vault: string,
  since: string,
): ReadonlyArray<StaleDependencyCitation> {
  let receipts;
  try {
    receipts = readDecisionChangeReceipts(vault).receipts;
  } catch (err) {
    throw new StaleDependencyReadError(
      "decision-change receipt read failed",
      receiptsDir(vault),
      err,
    );
  }
  const out: StaleDependencyCitation[] = [];
  for (const receipt of receipts) {
    if (receipt.ts < since) continue;
    const writtenAtMs = Date.parse(receipt.ts);
    if (!Number.isFinite(writtenAtMs)) continue;
    const cites = new Set<string>();
    for (const trigger of receipt.evidence_triggers) {
      const key = brainArtifactSlug(trigger);
      if (key !== "") cites.add(key);
    }
    if (cites.size === 0) continue;
    out.push({
      kind: STALE_DEPENDENCY_CONSUMER.decisionChange,
      id: normalizeDecisionSubject(receipt.subject),
      written_at: receipt.ts,
      written_at_ms: writtenAtMs,
      live: true,
      cites: [...cites],
    });
  }
  return out;
}

// ----- The artifact walk ----------------------------------------------------

/** One Brain markdown file, read once and used by both sides of the join. */
interface BrainArtifactFile {
  readonly basename: string;
  readonly path: string;
  /** Last write instant, in milliseconds. */
  readonly mtimeMs: number;
  readonly mtimeIso: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * The directories the walk covers, resolved from {@link brainDirs}.
 *
 * Deliberately the same universe `buildBacklinkIndex` reads artifacts
 * from, minus the log: a state outside that universe could never be
 * joined to a live artifact anyway, and including the log would make the
 * audit trail its own consumer.
 */
function artifactDirs(vault: string): ReadonlyArray<string> {
  const dirs = brainDirs(vault);
  return [dirs.brain, dirs.preferences, dirs.retired, dirs.inbox, dirs.processed];
}

/**
 * Read every Brain markdown file once.
 *
 * `mtime` rather than `created_at` is the consumer instant, and
 * deliberately so: the question is whether the consumer has been written
 * since the state changed, and an artifact rewritten after a retirement
 * has had the opportunity to reflect it whatever its frontmatter says it
 * was created. Under replication an incoming file carries its origin
 * mtime, which is the same instant on every device holding it.
 *
 * A directory that is absent is skipped; one that exists and cannot be
 * listed raises, because a shorter artifact list means fewer findings
 * and that must not pass as a clean store.
 */
function walkBrainArtifacts(vault: string): ReadonlyArray<BrainArtifactFile> {
  const out: BrainArtifactFile[] = [];
  const seen = new Set<string>();
  for (const dir of artifactDirs(vault)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === DIR_ABSENT_ERRNO) continue;
      throw new StaleDependencyReadError("artifact directory listing failed", dir, err);
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(MARKDOWN_EXT)) continue;
      const path = join(dir, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch (err) {
        throw new StaleDependencyReadError("artifact stat failed", path, err);
      }
      const [meta] = parseFrontmatter(path);
      out.push({
        basename: entry.name.slice(0, -MARKDOWN_EXT.length),
        path,
        mtimeMs,
        mtimeIso: new Date(mtimeMs).toISOString(),
        meta,
      });
    }
  }
  return out;
}

// ----- State side -----------------------------------------------------------

/**
 * Every state that has already stopped being current.
 *
 * `nowMs` bounds it: a `valid_until` in the future has not closed yet,
 * so nothing written before it can be resting on a change that has not
 * happened.
 *
 * An instant that does not parse contributes no state. For preferences,
 * retired records and signals that condition is the doctor's own
 * `iso-invalid` finding, which is where a malformed timestamp is
 * reported; this join reports on time relationships and has nothing to
 * add about a timestamp that has none.
 */
function collectStates(
  vault: string,
  artifacts: ReadonlyArray<BrainArtifactFile>,
  nowMs: number,
): ReadonlyArray<StaleDependencyState> {
  const out: StaleDependencyState[] = [];
  const push = (
    key: string,
    kind: StaleDependencyState["kind"],
    path: string,
    changedAt: string,
  ): void => {
    if (key === "") return;
    const changedAtMs = Date.parse(changedAt);
    if (!Number.isFinite(changedAtMs) || changedAtMs > nowMs) return;
    out.push({ key, kind, path, changed_at: changedAt, changed_at_ms: changedAtMs });
  };

  let retired;
  try {
    retired = readAllRetiredRecords(vault);
  } catch (err) {
    throw new StaleDependencyReadError("retired record read failed", brainDirs(vault).retired, err);
  }
  for (const record of retired) {
    push(
      brainArtifactSlug(record.retired.id),
      STALE_DEPENDENCY_STATE.retired,
      record.path,
      record.retired.retired_at,
    );
  }

  for (const artifact of artifacts) {
    const key = brainArtifactSlug(artifact.basename);
    const lifecycle = readLifecycleState(artifact.meta);
    if (lifecycle.tombstoned && lifecycle.tombstonedAt !== null) {
      push(key, STALE_DEPENDENCY_STATE.tombstoned, artifact.path, lifecycle.tombstonedAt);
    }
    const validUntil = artifact.meta[VALID_UNTIL_KEY];
    if (typeof validUntil === "string" && boundaryToMs(validUntil) !== null) {
      push(key, STALE_DEPENDENCY_STATE.validityClosed, artifact.path, validUntil);
    }
  }
  return out;
}

// ----- Consumer side: live Brain artifacts ----------------------------------

/**
 * Artifacts whose links still reach a changed state.
 *
 * The backlink index does the resolution, including through the
 * `aliases:` entry `moveToRetired` leaves behind, so a body still
 * spelling `[[pref-<slug>]]` lands on the retired record without this
 * module rewriting anything. Self-references are already dropped by the
 * index, which is why a retired file pointing back at its own former id
 * cannot flag itself.
 *
 * A source that is itself a changed state is not live: history citing
 * history is not a dependency anybody is standing on.
 */
function collectArtifactCitations(
  vault: string,
  artifacts: ReadonlyArray<BrainArtifactFile>,
  stateKeys: ReadonlySet<string>,
): ReadonlyArray<StaleDependencyCitation> {
  if (stateKeys.size === 0) return [];
  let index;
  try {
    index = buildBacklinkIndex(vault);
  } catch (err) {
    throw new StaleDependencyReadError("backlink index build failed", brainDirs(vault).brain, err);
  }

  const byBasename = new Map(artifacts.map((artifact) => [artifact.basename, artifact]));
  const cited = new Map<string, Set<string>>();
  for (const [target, refs] of index) {
    const key = brainArtifactSlug(target);
    if (!stateKeys.has(key)) continue;
    for (const ref of refs) {
      if (ref.sourceKind.startsWith(LOG_SOURCE_KIND_PREFIX)) continue;
      const bucket = cited.get(ref.source);
      if (bucket) bucket.add(key);
      else cited.set(ref.source, new Set([key]));
    }
  }

  const out: StaleDependencyCitation[] = [];
  for (const [source, keys] of cited) {
    const artifact = byBasename.get(source);
    // A source the walk did not see is a file outside the artifact
    // directories - it has no write instant this join can read, and
    // guessing one would decide the strict comparison by invention.
    if (artifact === undefined) continue;
    out.push({
      kind: STALE_DEPENDENCY_CONSUMER.brainArtifact,
      id: source,
      path: artifact.path,
      written_at: artifact.mtimeIso,
      written_at_ms: artifact.mtimeMs,
      live: !stateKeys.has(brainArtifactSlug(source)),
      cites: [...keys],
    });
  }
  return out;
}
