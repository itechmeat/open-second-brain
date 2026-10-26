/**
 * `o2b brain continuity promote` - the host-memory readback path
 * (issue #277).
 *
 * `host_memory_write` records land in the continuity ledger as a durable,
 * write-only substrate: nothing read them back for recall. The search
 * index admits only `.md`, the brain grep surface keeps session kinds,
 * and the context pack reads preferences and retired pages. This module
 * is the explicit, reviewable readback: it re-renders ledger rows as
 * unconfirmed preference pages under the same trial window every
 * first-party unconfirmed write observes, so a mirrored host fact becomes
 * recallable like any other preference and the dream pass reviews it like
 * any other candidate.
 *
 * The direction of authority is one-way and stated plainly: the ledger
 * stays the durable substrate and is never rewritten or pruned by a
 * promotion; the pages are a derived mirror whose provenance names the
 * shard and the record each was rendered from. `brain continuity export`
 * remains the full-fidelity audit path - it hands the same rows out
 * whole, where a promotion lands only their rendered projection.
 *
 * No supersession is inferred: the bridge never says which record
 * replaced which, so a `replace` action promotes as its own page beside
 * the one it superseded, and reconciling the two is the confirm/retire
 * flow's job, not this verb's guess.
 *
 * The module walks the same plan/seal/apply machinery as the Claude
 * memory import: `planAction` for
 * CREATE/UPDATE/RECREATE/SKIP_UNCHANGED/CONFLICT, a sealed approval
 * digest so an apply lands exactly the plan an operator reviewed, a
 * snapshot before the first write, and the evidence-preserving merge on
 * UPDATE (shared from `import-claude-memory.ts`).
 *
 * Two doors onto the store, deliberately (provenance-at-the-boundary):
 * the read-model supplies the promotion payload under the masking policy
 * - `private` records are dropped and never reach a page - while the raw
 * store door counts what the policy dropped, so the report states how
 * many records it did not see instead of silently shortening the run.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { resolveAgentName } from "../../config.ts";
import { EGRESS_REDACTION_OPTIONS } from "../../egress/guard.ts";
import { redactStructured } from "../../redactor.ts";
import { digestVerifies, sealWithDigest, sha256Hex } from "../../integrity/digest.ts";
import { loadBrainConfig } from "../policy.ts";
import { DEFAULT_BRAIN_CONFIG } from "../policy/defaults.ts";
import { mergePreservingEvidence } from "../import-claude-memory.ts";
import {
  loadPromotionsManifest,
  savePromotionsManifest,
  type HostMemoryPromotionEntry,
} from "../host-memory-promotions.ts";
import { appendLogEvent } from "../log.ts";
import { BRAIN_PREFERENCES_REL, preferencePath, retiredPath, vaultRelative } from "../paths.ts";
import { planAction, type PlannedFile } from "../claude-memory-plan.ts";
import { renderPreferenceFromMemory, slugifyMemoryName } from "../claude-memory-render.ts";
import { resolvedOwnerFor } from "../preference.ts";
import { createSnapshot } from "../snapshot.ts";
import { TagSyntaxError } from "../tag-syntax.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { HOST_MEMORY_WRITE_KIND } from "../host-memory-write.ts";
import { loadNormalizedContinuityRecords } from "./read-model.ts";
import { continuityLogPath, isCanonicalUtcTimestamp, listContinuityRecords } from "./store.ts";

export interface PromoteHostMemoryOpts {
  readonly vault: string;
  readonly mode: "dry-run" | "apply";
  /** Restrict the readback to one UTC month (`YYYY-MM`), as the export verb spells it. */
  readonly month?: string;
  /**
   * The plan digest a dry run computed and an operator approved (the CLI
   * plumbing is `--approval-digest`). Absent, apply behaves exactly as it
   * did before approval digests existed - the interactive path's escape
   * hatch. Present, it is checked against the freshly computed plan
   * BEFORE the snapshot or any write, and a mismatch is a
   * {@link PromoteApprovalDigestError} that leaves the vault untouched.
   */
  readonly approvalDigest?: string;
  readonly now?: Date;
}

export interface PromoteHostMemoryResult {
  readonly mode: "dry-run" | "apply";
  /** Raw `host_memory_write` rows the window holds, private rows included. */
  readonly total: number;
  readonly plans: ReadonlyArray<PlannedFile>;
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
  readonly conflicts: ReadonlyArray<PlannedFile>;
  readonly applied: ReadonlyArray<PlannedFile>;
  readonly skippedUnchanged: ReadonlyArray<PlannedFile>;
  /** Records that land in masked form: write-time redaction or the strict re-scan. */
  readonly redactedCount: number;
  /** Records the read-model dropped as private, counted through the store door. */
  readonly privateCount: number;
  /**
   * True when the promotion sidecar exists but could not be read as the
   * manifest shape: the plan was computed against an empty history, every
   * landed page will show as CONFLICT, and an apply refuses until the
   * operator reconciles the file.
   */
  readonly manifestCorrupt: boolean;
  readonly snapshotRunId: string | null;
  readonly localDate: string;
  /**
   * The seal of the promotion plan: sha256 of the plans, skips, conflicts
   * and unchanged rows - each plan row bound to the sha256 of its source
   * record's content and of its rendered body, clock fields normalized
   * out of the latter (see {@link SEAL_RENDER_CLOCK}) - via the integrity
   * module's `sealWithDigest`. Wall-clock fields (`localDate`, the
   * promotion timestamps) are deliberately OUTSIDE the sealed body, so a
   * dry run and a later apply of the same content seal identically and an
   * approval binds the plan, never the moment it was printed.
   */
  readonly digest: string;
}

/**
 * A plan row's content binding, sealed alongside the row: the sha256 of
 * the source record's content and the sha256 of the RENDERED preference
 * body the row would land, rendered under a fixed clock so the seal stays
 * wall-clock-free.
 */
interface PromotedRowSeal {
  readonly content_sha256: string;
  readonly body_sha256: string;
}

/**
 * The fixed clock the seal's render runs under. The rendered body embeds
 * the run's clock (`created_at`, `unconfirmed_until`, `_imported_at`, the
 * prose day); sealed as-written, a dry run and its later apply would seal
 * differently on every tick and the approval could never carry. Re-
 * rendered with both clock inputs pinned to this constant, the same
 * content produces the same seal body whenever it is planned - while a
 * source record whose content changed between the two runs still changes
 * the rendered body, which is the binding the approval exists for.
 */
const SEAL_RENDER_CLOCK = "1970-01-01T00:00:00Z";

/**
 * The body an approval covers: what will land, what will not, and what
 * refuses. The one spelling of "the plan", shared by the dry run that
 * seals it and the apply that re-checks it. Each plan row carries its
 * content binding ({@link PromotedRowSeal}) so a record whose content
 * changed after the approved dry run no longer verifies, even when its
 * plan action would come out the same.
 */
function planApprovalBody(parts: {
  plans: ReadonlyArray<PlannedFile>;
  skipped: ReadonlyArray<{ id: string; reason: string }>;
  conflicts: ReadonlyArray<PlannedFile>;
  skippedUnchanged: ReadonlyArray<PlannedFile>;
  seals: ReadonlyMap<string, PromotedRowSeal>;
}): Record<string, unknown> {
  return {
    conflicts: parts.conflicts,
    plans: parts.plans.map((plan) => {
      const seal = parts.seals.get(plan.basename);
      return {
        id: plan.basename,
        pref_id: plan.prefId,
        action: plan.action,
        content_sha256: seal?.content_sha256 ?? null,
        body_sha256: seal?.body_sha256 ?? null,
      };
    }),
    skipped: parts.skipped,
    skipped_unchanged: parts.skippedUnchanged,
  };
}

/**
 * The apply-time refusal when the plan an operator approved no longer
 * matches the plan this run computed. Nothing has been written and no
 * snapshot has been taken; the remedy is a fresh dry run, whose digest
 * is what the next apply must carry.
 */
export class PromoteApprovalDigestError extends Error {
  /** The digest the caller asked to apply against. */
  readonly approvalDigest: string;
  /** The digest of the plan this run just computed. */
  readonly planDigest: string;

  constructor(approvalDigest: string, planDigest: string) {
    super(
      `approval digest mismatch: the plan changed since the approved dry run ` +
        `(approved ${approvalDigest}, current plan ${planDigest}); nothing was written and ` +
        "no snapshot was taken. Re-run `o2b brain continuity promote` (the default is the " +
        "dry run) to review the current plan, then apply with its digest.",
    );
    this.name = "PromoteApprovalDigestError";
    this.approvalDigest = approvalDigest;
    this.planDigest = planDigest;
  }
}

/**
 * The apply-time refusal while the promotion sidecar is unreadable. Every
 * landed page would plan CONFLICT against the empty history and a save
 * would flatten whatever was still recoverable; the remedy is operator
 * reconciliation of the file, not a write over it.
 */
export class PromoteManifestCorruptError extends Error {
  constructor() {
    super(
      "the promotion manifest Brain/.imports/host-memory-promotions.json exists but could " +
        "not be read as the manifest shape, so the promotion history is unavailable and the " +
        "apply refuses. Inspect and reconcile the file (every promoted page names its record " +
        "id in the Origin section), or remove it to rebuild the history from scratch - a " +
        "rebuild plans CONFLICT for every landed page, which is the review that keeps another " +
        "writer's page from being overwritten.",
    );
    this.name = "PromoteManifestCorruptError";
  }
}

export interface PromoteConflictsPartialProgress {
  readonly total: number;
  readonly plans: ReadonlyArray<PlannedFile>;
  readonly applied: ReadonlyArray<PlannedFile>;
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
  readonly skippedUnchanged: ReadonlyArray<PlannedFile>;
  readonly redactedCount: number;
  readonly privateCount: number;
  readonly manifestCorrupt: boolean;
  readonly snapshotRunId: string | null;
  readonly localDate: string;
  readonly digest: string;
}

export class PromoteConflictsError extends Error {
  readonly conflicts: ReadonlyArray<PlannedFile>;
  readonly partial: PromoteConflictsPartialProgress | null;
  constructor(
    conflicts: ReadonlyArray<PlannedFile>,
    partial: PromoteConflictsPartialProgress | null = null,
  ) {
    super(`promote-host-memory: ${conflicts.length} conflict(s)`);
    this.conflicts = conflicts;
    this.partial = partial;
  }
}

/** Longest head of a record id kept in a target slug. */
const SLUG_REF_CHARS = 12;

/**
 * The stable short ref a record contributes to its target slug: the tail
 * of the id, lowercased. The TAIL, not the head the way a filename slug
 * is cut - a continuity id spells `ctn_<timestamp digits>_<content hash>`,
 * so its first twelve characters are the UTC day plus the `ctn_` prefix
 * and every record written on one day would slug-collide onto a single
 * preference page, planning CONFLICT for each promotion after the first.
 * The hash tail is content-derived and unique per record in practice.
 */
function slugRef(recordId: string): string {
  return recordId.slice(-SLUG_REF_CHARS).toLowerCase();
}

/** Longest head of a line kept in a rendered name or description. */
function headLine(line: string, maxChars: number): string {
  return line.length > maxChars ? line.slice(0, maxChars) : line;
}

/**
 * The provenance string a promoted page carries for its source: the
 * month shard's vault-relative path, in the non-sharded spelling. The
 * record may physically sit in a per-device `<month>.<deviceId>.jsonl`
 * file, but the store merges every shard of the month and the page
 * provenance stays stable across devices by naming the month, not this
 * device's file.
 */
function ledgerShardRef(vault: string, createdAt: string): string {
  return vaultRelative(continuityLogPath(vault, createdAt.slice(0, 7), ""), vault);
}

export function promoteHostMemory(opts: PromoteHostMemoryOpts): PromoteHostMemoryResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). The
  // dry-run form writes nothing, so it stays a read and is not gated -
  // guarding a preview would refuse the very inspection an operator
  // runs to decide whether the resolved vault is the intended one.
  if (opts.mode === "apply") assertVaultIdentityForWrite(opts.vault);
  const now = opts.now ?? new Date();
  const promotedAt = isoSecond(now);
  const localDate = promotedAt.slice(0, 10);
  // Every promotion lands under trial, on the same source as every
  // first-party unconfirmed write (`dream.unconfirmed_window_days`),
  // read fail-soft: host memory is agent-writable from conversation
  // content, so a poisoned entry must not become a live rule on landing.
  const unconfirmedUntil = isoSecond(addDays(now, unconfirmedWindowDays(opts.vault)));
  // The same window spelling the export verb builds for --month.
  const window =
    opts.month !== undefined
      ? { since: `${opts.month}-01`, until: `${opts.month}-31T23:59:59.999Z` }
      : {};

  const records = loadNormalizedContinuityRecords(opts.vault, {
    kind: HOST_MEMORY_WRITE_KIND,
    ...window,
  });
  const rawRows = listContinuityRecords(opts.vault, {
    kind: HOST_MEMORY_WRITE_KIND,
    ...window,
  });
  const privateCount = rawRows.filter((record) => record.private === true).length;

  const manifest = loadPromotionsManifest(opts.vault);
  const newPromotions: Record<string, HostMemoryPromotionEntry> = { ...manifest.promotions };

  const plans: PlannedFile[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const filesToWrite: Array<{ plan: PlannedFile; body: string; sha256: string; slug: string }> = [];
  // The content binding per plan row, keyed by the row's record id: the
  // record content's sha256 and the rendered body's sha256 (clock fields
  // normalized out). Every plan row is pushed immediately after its
  // render, so every row the seal below reads has an entry here.
  const rowSeals = new Map<string, PromotedRowSeal>();
  // Target slugs already claimed this run, so two records whose ids
  // share a hash tail cannot plan onto one page where the second
  // atomic write would silently overwrite the first.
  const seenTargets = new Map<string, string>();
  // Content shas already spoken for - by the sidecar (a landed page) or
  // by a row planned earlier this run. The record id hashes createdAt
  // (store.ts recordId), so the same memory text written in three
  // sessions is three records; only the first may become a page, or the
  // context pack fills with duplicates that each run their own trial.
  const seenContentSha = new Map<string, string>();
  for (const [id, entry] of Object.entries(manifest.promotions)) {
    seenContentSha.set(entry.sha256, id);
  }
  let redactedCount = 0;

  for (const record of records) {
    // Fail-soft per row, the way the read model is: a hand-edited or
    // foreign-written ledger row must never block every promotion. The
    // canonical checks also pin the slug story - the filename, the
    // retired-page guard and the frontmatter identity all derive from
    // the id tail, and a tail that slugifies differently than it reads
    // would land a page whose `id:` does not answer for it.
    if (!isCanonicalUtcTimestamp(record.createdAt)) {
      skipped.push({ id: record.id, reason: "non-canonical createdAt" });
      continue;
    }
    if (!/^ctn_\d{14}_[0-9a-f]{16}$/.test(record.id)) {
      skipped.push({ id: record.id, reason: "non-canonical record id" });
      continue;
    }
    const content = record.payload["content"];
    if (typeof content !== "string") {
      skipped.push({ id: record.id, reason: "content is not text" });
      continue;
    }
    if (content.trim().length === 0) {
      skipped.push({ id: record.id, reason: "empty content" });
      continue;
    }
    // The strict re-scan (issue #277 review H1): the ledger redacts at
    // write time under the loose defaults, so a vendor key, a bare
    // high-entropy token or a user:pass@host URL can sit in a row whose
    // `redacted` flag is false, and the read model never re-scans. A
    // promotion moves the text into the indexed corpus, where the export
    // door's own header documents what would happen to it. The MASKED
    // text is what lands - the fact stays recallable, the credential
    // does not leave the shape the write-time scan left or the scan
    // produces here.
    const scanned = redactStructured(content, EGRESS_REDACTION_OPTIONS);
    const safeContent = scanned.value;
    if (typeof safeContent !== "string" || safeContent.trim().length === 0) {
      skipped.push({ id: record.id, reason: "content is empty after redaction" });
      continue;
    }
    const masked = scanned.redacted;
    if (masked || record.redacted === true) redactedCount += 1;
    const contentSha256 = sha256Hex(safeContent);
    const sameAs = seenContentSha.get(contentSha256);
    if (sameAs !== undefined && sameAs !== record.id) {
      skipped.push({ id: record.id, reason: `same content as record ${sameAs}` });
      continue;
    }
    seenContentSha.set(contentSha256, record.id);
    const ref = slugRef(record.id);
    // Defence in depth over the canonical-id check above: the slug the
    // renderer derives from `identityName` must be the slug every
    // consumer (filename, retired guard, manifest) computes, whatever
    // the tail contains.
    const slug = slugifyMemoryName(`hostmem-${ref}`);
    if (slug.length <= "hostmem-".length) {
      skipped.push({ id: record.id, reason: "record id produces no slug" });
      continue;
    }
    const prefId = `pref-${slug}`;
    const seenBy = seenTargets.get(slug);
    if (seenBy !== undefined) {
      skipped.push({
        id: record.id,
        reason: `target ${prefId} is already claimed by record ${seenBy}`,
      });
      continue;
    }
    const prefFile = preferencePath(opts.vault, slug);
    if (existsSync(retiredPath(opts.vault, slug))) {
      // A deliberately retired page must not resurrect through a
      // re-run of the promotion: the retirement outlives the record.
      skipped.push({
        id: record.id,
        reason: `a retired copy exists (${vaultRelative(retiredPath(opts.vault, slug), opts.vault)}); restore or delete it first`,
      });
      continue;
    }
    seenTargets.set(slug, record.id);
    // The page's identity (`id:` frontmatter, `topic` tag, and the
    // filename) is the stable record-derived slug; the memory's own
    // first line is display text, carried by the `principle` field -
    // not the identity, which would move with every rewording.
    const firstLine =
      safeContent
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "";
    const memoryPath = ledgerShardRef(opts.vault, record.createdAt);
    const renderInput = {
      name: headLine(firstLine, 60) || `Host memory ${ref}`,
      identityName: slug,
      description: headLine(firstLine, 100),
      body: safeContent,
      memoryPath,
      importedAt: promotedAt,
      unconfirmedUntil,
      bodySha256: contentSha256,
      owner: resolvedOwnerFor(opts.vault, prefFile, undefined, undefined),
      originLabel: `Promoted from host memory write \`${record.id}\` in the continuity ledger:`,
    };
    // Render BEFORE any plan row exists. A render that refuses THIS
    // record - a purely numeric first line fails the one shared tag rule -
    // is a per-record data problem: it lands a named skip row (record and
    // rule both named) and the promotion continues.
    let body: string;
    try {
      body = renderPreferenceFromMemory(renderInput);
    } catch (err) {
      if (!(err instanceof TagSyntaxError)) throw err;
      skipped.push({ id: record.id, reason: err.message });
      continue;
    }
    rowSeals.set(record.id, {
      content_sha256: contentSha256,
      // The seal's render of the SAME record under a fixed clock: the
      // approval covers the content, never the moment.
      body_sha256: sha256Hex(
        renderPreferenceFromMemory({
          ...renderInput,
          importedAt: SEAL_RENDER_CLOCK,
          unconfirmedUntil: SEAL_RENDER_CLOCK,
        }),
      ),
    });
    const manifestEntry = manifest.promotions[record.id];
    const plan = planAction({
      basename: record.id,
      prefId,
      sha256: contentSha256,
      inManifest: manifestEntry ? { sha256: manifestEntry.sha256 } : null,
      prefExists: existsSync(prefFile),
    });
    plans.push(plan);
    if (plan.action === "CREATE" || plan.action === "RECREATE" || plan.action === "UPDATE") {
      filesToWrite.push({ plan, body, sha256: contentSha256, slug });
    }
  }

  const conflicts = plans.filter((p) => p.action === "CONFLICT");
  const skippedUnchanged = plans.filter((p) => p.action === "SKIP_UNCHANGED");

  // Seal the promotion plan. The apply below re-checks the operator's
  // approval against THIS seal before the snapshot or any write, so what
  // lands is what was approved or nothing is.
  const approvalBody = planApprovalBody({
    plans,
    skipped,
    conflicts,
    skippedUnchanged,
    seals: rowSeals,
  });
  const planDigest = sealWithDigest(approvalBody).digest;

  if (opts.mode === "dry-run") {
    return {
      mode: "dry-run",
      total: rawRows.length,
      plans,
      skipped,
      conflicts,
      applied: [],
      skippedUnchanged,
      redactedCount,
      privateCount,
      manifestCorrupt: manifest.corrupt,
      snapshotRunId: null,
      localDate,
      digest: planDigest,
    };
  }

  // The approved plan is checked against the one just computed BEFORE
  // the snapshot/write loop. Drift between dry run and apply is the case
  // this exists for: a ledger that moved in between must be re-reviewed,
  // never written over.
  if (opts.approvalDigest !== undefined && !digestVerifies(approvalBody, opts.approvalDigest)) {
    throw new PromoteApprovalDigestError(opts.approvalDigest, planDigest);
  }

  // A corrupt sidecar means the plan was computed against an empty
  // history: every landed page would show CONFLICT and a save would
  // flatten a file that was mostly recoverable. Refuse before the
  // snapshot; reconciliation is the operator's move.
  if (manifest.corrupt) {
    throw new PromoteManifestCorruptError();
  }

  // Process the non-conflict records first; throw `PromoteConflictsError`
  // at the end if any CONFLICT was detected, so the applied side of the
  // run still landed. The caller (CLI) uses the thrown error to exit 2.
  let snapshotRunId: string | null = null;
  if (filesToWrite.length > 0) {
    // The run-id prefix and the recorded reason are one constant, so the
    // archive's filename can never disagree with its stamped provenance.
    const runId = `${BRAIN_SNAPSHOT_REASON.promoteHostMemory}-${promotedAt.replace(/:/g, "-")}`;
    createSnapshot(opts.vault, runId, {
      reason: BRAIN_SNAPSHOT_REASON.promoteHostMemory,
      now,
    });
    snapshotRunId = runId;
  }

  const applied: PlannedFile[] = [];
  if (filesToWrite.length > 0) {
    mkdirSync(join(opts.vault, BRAIN_PREFERENCES_REL), { recursive: true });
  }
  for (const { plan, body: freshBody, sha256, slug } of filesToWrite) {
    const prefFile = preferencePath(opts.vault, slug);
    let finalBody = freshBody;
    if (plan.action === "UPDATE") {
      // Preserve evidence fields by merging frontmatter.
      finalBody = mergePreservingEvidence(readFileSync(prefFile, "utf8"), freshBody);
    }
    atomicWriteFileSync(prefFile, finalBody);
    newPromotions[plan.basename] = { pref_id: plan.prefId, sha256, promoted_at: promotedAt };
    applied.push(plan);
  }

  // The manifest is persisted only when something was applied: a
  // conflict-only run would otherwise rewrite the file (a corrupt one to
  // the empty set) without landing a page. The log event still records a
  // conflict-only run, so the no-op bloat concern is about the sidecar,
  // not the ledger.
  if (applied.length > 0) {
    savePromotionsManifest(opts.vault, { version: 1, promotions: newPromotions });
  }
  const didSomething = applied.length > 0 || conflicts.length > 0;
  if (didSomething) {
    const counts = {
      created: plans.filter((p) => p.action === "CREATE").length,
      updated: plans.filter((p) => p.action === "UPDATE").length,
      recreated: plans.filter((p) => p.action === "RECREATE").length,
      skipped_unchanged: skippedUnchanged.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
    };
    appendLogEvent(opts.vault, {
      timestamp: promotedAt,
      eventType: BRAIN_LOG_EVENT_KIND.promoteHostMemory,
      body: {
        created: String(counts.created),
        updated: String(counts.updated),
        recreated: String(counts.recreated),
        skipped_unchanged: String(counts.skipped_unchanged),
        skipped: String(counts.skipped),
        conflicts: String(counts.conflicts),
        private_dropped: String(privateCount),
        redacted: String(redactedCount),
        snapshot: snapshotRunId ?? "none",
        agent: resolveAgentName(),
      },
    });
  }

  if (conflicts.length > 0) {
    // Throw AFTER landing the safe writes so partial progress is
    // preserved. The error carries the conflict list and the run's
    // progress; the CLI prints them and exits 2.
    throw new PromoteConflictsError(conflicts, {
      total: rawRows.length,
      plans,
      applied,
      skipped,
      skippedUnchanged,
      redactedCount,
      privateCount,
      manifestCorrupt: manifest.corrupt,
      snapshotRunId,
      localDate,
      digest: planDigest,
    });
  }

  return {
    mode: "apply",
    total: rawRows.length,
    plans,
    skipped,
    conflicts,
    applied,
    skippedUnchanged,
    redactedCount,
    privateCount,
    manifestCorrupt: manifest.corrupt,
    snapshotRunId,
    localDate,
    digest: planDigest,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The trial window a promotion grants, in days. Same source as every
 * first-party unconfirmed write (`dream.unconfirmed_window_days`), read
 * fail-soft for the same reason the import's is: a vault with no
 * readable `_brain.yaml` still gets the shipped default, not a live rule.
 */
function unconfirmedWindowDays(vault: string): number {
  try {
    return loadBrainConfig(vault).dream.unconfirmed_window_days;
  } catch {
    return DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days;
  }
}
