/**
 * Hub candidates at inbox-drain (t_23bd347d).
 *
 * When an inbox-drain routes a capture into a corpus page (the idea route),
 * the page's area hub is decided HERE and staged for the repair lane - the
 * edge itself is never written at intake. The rule is deterministic and
 * structural end to end:
 *
 *   1. The candidate pool is the durable-memory corpus pages (the same
 *      population `loadPages` reads) that pass the moc-audit structural hub
 *      predicate - ONE shared definition of "hub", `isHubBody`.
 *   2. The pool is restricted to hubs in the routed page's composite scope
 *      bucket (`compositeScopeKey` over owner/session/project). A scopeless
 *      captured page matches scopeless hubs only - conservative and
 *      deterministic.
 *   3. The shared exactly-one kernel `resolveUniqueMatch` decides: a unique
 *      hub yields an `area_membership` candidate at full confidence; zero
 *      hubs is a `skip-no-hub` refusal naming the scope bucket; several hubs
 *      is a `skip-ambiguous-hub` refusal listing every hub path in
 *      first-occurrence order. No tie-break by degree exists - a tie-break
 *      would make the target depend on index state at drain time - and no
 *      hub is ever auto-created (that is `materializeClusterNotes`' gated
 *      job).
 *
 * The staged records land in ONE JSONL file under `Brain/.state/` that
 * `o2b brain repair-lane` merges with its graph-collected candidates. The
 * store is logically append-only - a record is only ever added, never
 * re-decided or removed - and an identical record is not staged twice, so a
 * re-routed capture (route ok, archive failed, rerun) converges to one
 * record. Zero new write paths: the only artifact is this internal-state
 * file, written through the shared atomic writer, and the edge lands
 * exclusively through the lane's apply + confirm phrase + holdout gate.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  compositeScopeKey,
  scopeFromFrontmatter,
  SCOPE_AXES,
  type CompositeScope,
} from "../../scope-key.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath, ensureInsideVault } from "../../path-safety.ts";
import { parseFrontmatter } from "../../vault.ts";
import { resolveUniqueMatch } from "../../graph/unique-match.ts";
import { BRAIN_INTERNAL_STATE_REL } from "../path-constants.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import { isHubBody, resolveHubThresholds } from "./moc-audit.ts";
import {
  HUB_CANDIDATE_CONFIDENCE,
  IDENTITY_STRENGTH,
  loadPages,
  type IdentityStrength,
  type RepairCandidate,
  type RepairDecision,
} from "./repair-lane.ts";

/** Filename of the staged store, inside {@link BRAIN_INTERNAL_STATE_REL}. */
export const REPAIR_CANDIDATES_STORE_FILE = "repair-candidates.jsonl";

/** Vault-relative display path of the store, for error messages. */
const STORE_REL_DISPLAY = `${BRAIN_INTERNAL_STATE_REL}/${REPAIR_CANDIDATES_STORE_FILE}`;

/** Display label for a scope in which every axis is absent. */
const UNSCOPED_BUCKET_LABEL = "(unscoped)";

/** Failure of the hub selection or of its staged store - always named. */
export class HubCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubCandidateError";
  }
}

/** The refusal actions this module stages, narrowed for type safety. */
export type HubRefusalAction = "skip-no-hub" | "skip-ambiguous-hub";

/** A staged hub refusal: a {@link RepairDecision} whose action is one of the two hub refusals. */
export type HubRefusal = RepairDecision & { readonly action: HubRefusalAction };

/** The outcome of the deterministic hub selection for one routed page. */
export type HubSelection =
  | { readonly outcome: "candidate"; readonly candidate: RepairCandidate }
  | { readonly outcome: "refusal"; readonly refusal: HubRefusal };

/** Human-readable form of a scope bucket, for reasons and refusals. */
function displayScopeBucket(scope: CompositeScope): string {
  const parts: string[] = [];
  for (const axis of SCOPE_AXES) {
    const value = scope[axis];
    if (value !== null) parts.push(`${axis}=${value}`);
  }
  return parts.length === 0 ? UNSCOPED_BUCKET_LABEL : parts.join(", ");
}

/** The page's own wikilink spelling, excluded from its hub count. */
function selfTargetFor(rel: string): string {
  return normaliseWikilinkTarget(basename(rel));
}

function uniqueHubReason(hubRel: string, bucket: string): string {
  return `area hub ${hubRel} for scope bucket ${bucket}`;
}

function noHubReason(bucket: string): string {
  return `no hub page in scope bucket ${bucket}`;
}

function ambiguousHubReason(hubs: ReadonlyArray<string>, bucket: string): string {
  return `${hubs.length} hub pages in scope bucket ${bucket}: ${hubs.join(", ")}`;
}

/**
 * Decide the routed page's area hub. Read-only: nothing is written here.
 *
 * Throws {@link HubCandidateError} when the routed page does not exist or
 * escapes the vault - a caller that names no routed page gets a named
 * refusal, not a silent structural answer about nothing.
 */
export function selectHubCandidate(vault: string, routedRelPath: string): HubSelection {
  const routedRel = canonicalNotePath(routedRelPath);
  let routedAbs: string;
  try {
    routedAbs = ensureInsideVault(join(vault, routedRel), vault);
  } catch {
    throw new HubCandidateError(`routed page path escapes the vault: ${routedRel}`);
  }
  if (!existsSync(routedAbs)) {
    throw new HubCandidateError(`routed page not found: ${routedRel}`);
  }

  const [routedMeta] = parseFrontmatter(routedAbs);
  const routedScope = scopeFromFrontmatter(routedMeta);
  const routedBucket = compositeScopeKey(routedScope);
  const bucketDisplay = displayScopeBucket(routedScope);

  const thresholds = resolveHubThresholds(vault);
  const hubs: string[] = [];
  for (const page of loadPages(vault)) {
    if (page.rel === routedRel) continue;
    if (compositeScopeKey(scopeFromFrontmatter(page.meta)) !== routedBucket) continue;
    if (!isHubBody(page.body, thresholds, { selfTarget: selfTargetFor(page.rel) })) continue;
    hubs.push(page.rel);
  }

  const verdict = resolveUniqueMatch(hubs);
  if (verdict.status === "unique") {
    return {
      outcome: "candidate",
      candidate: {
        source: routedRel,
        target: verdict.target,
        strength: IDENTITY_STRENGTH.areaMembership,
        confidence: HUB_CANDIDATE_CONFIDENCE,
        reason: uniqueHubReason(verdict.target, bucketDisplay),
      },
    };
  }
  if (verdict.status === "none") {
    return {
      outcome: "refusal",
      refusal: {
        source: routedRel,
        target: "",
        strength: IDENTITY_STRENGTH.areaMembership,
        confidence: HUB_CANDIDATE_CONFIDENCE,
        action: "skip-no-hub",
        reason: noHubReason(bucketDisplay),
      },
    };
  }
  return {
    outcome: "refusal",
    refusal: {
      source: routedRel,
      target: "",
      strength: IDENTITY_STRENGTH.areaMembership,
      confidence: HUB_CANDIDATE_CONFIDENCE,
      action: "skip-ambiguous-hub",
      reason: ambiguousHubReason(verdict.matches, bucketDisplay),
    },
  };
}

// ----- The staged store ------------------------------------------------------

interface CandidateRecord {
  readonly kind: "candidate";
  readonly source: string;
  readonly target: string;
  readonly strength: string;
  readonly confidence: number;
  readonly reason: string;
}

interface RefusalRecord {
  readonly kind: "refusal";
  readonly source: string;
  readonly target: string;
  readonly strength: string;
  readonly confidence: number;
  /** The two refusal actions this store writes, validated on read. */
  readonly action: HubRefusalAction;
  readonly reason: string;
}

type StagedRecord = CandidateRecord | RefusalRecord;

function candidateRecord(candidate: RepairCandidate): CandidateRecord {
  return {
    kind: "candidate",
    source: candidate.source,
    target: candidate.target,
    strength: candidate.strength,
    confidence: candidate.confidence,
    reason: candidate.reason,
  };
}

function refusalRecord(refusal: HubRefusal): RefusalRecord {
  return {
    kind: "refusal",
    source: refusal.source,
    target: refusal.target,
    strength: refusal.strength,
    confidence: refusal.confidence,
    action: refusal.action,
    reason: refusal.reason,
  };
}

/** Canonical dedup key of a record; field order is fixed by the builders. */
function recordKey(record: StagedRecord): string {
  return JSON.stringify(record);
}

function storePath(vault: string): string {
  return join(vault, BRAIN_INTERNAL_STATE_REL, REPAIR_CANDIDATES_STORE_FILE);
}

function requireField(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new HubCandidateError(`${STORE_REL_DISPLAY}: ${where}: field ${field} must be a string`);
  }
  return value;
}

/**
 * Parse and validate one store line. The store's schema is exactly what
 * {@link stageHubSelection} writes - `area_membership` candidates and
 * `skip-no-hub` / `skip-ambiguous-hub` refusals - so anything else is
 * corruption and is refused by name rather than skipped.
 */
function parseRecordLine(line: string, lineNumber: number): StagedRecord {
  const where = `line ${lineNumber}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new HubCandidateError(
      `${STORE_REL_DISPLAY}: ${where}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new HubCandidateError(`${STORE_REL_DISPLAY}: ${where}: record is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const kind = record["kind"];
  if (kind !== "candidate" && kind !== "refusal") {
    throw new HubCandidateError(`${STORE_REL_DISPLAY}: ${where}: unknown record kind`);
  }
  const source = requireField(record, "source", where);
  if (source.length === 0) {
    throw new HubCandidateError(`${STORE_REL_DISPLAY}: ${where}: field source must not be empty`);
  }
  const target = requireField(record, "target", where);
  const strength = requireField(record, "strength", where);
  if (strength !== IDENTITY_STRENGTH.areaMembership) {
    throw new HubCandidateError(
      `${STORE_REL_DISPLAY}: ${where}: unexpected identity strength ${JSON.stringify(strength)}`,
    );
  }
  const confidence = record["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new HubCandidateError(
      `${STORE_REL_DISPLAY}: ${where}: field confidence must be a finite number`,
    );
  }
  const reason = requireField(record, "reason", where);
  if (kind === "candidate") {
    if (target.length === 0) {
      throw new HubCandidateError(
        `${STORE_REL_DISPLAY}: ${where}: candidate record has an empty target`,
      );
    }
    return { kind, source, target, strength, confidence, reason };
  }
  const action = requireField(record, "action", where);
  if (action !== "skip-no-hub" && action !== "skip-ambiguous-hub") {
    throw new HubCandidateError(
      `${STORE_REL_DISPLAY}: ${where}: unexpected refusal action ${JSON.stringify(action)}`,
    );
  }
  return { kind, source, target, strength, confidence, action, reason };
}

function parseStore(path: string): StagedRecord[] {
  if (!existsSync(path)) return [];
  const records: StagedRecord[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    records.push(parseRecordLine(line, i + 1));
  }
  return records;
}

/**
 * Stage the selection's record in the store. Identical records are not
 * staged twice, so re-routing the same capture converges; a refusal already
 * staged stays - the store is history, never re-decided.
 *
 * The write goes through the shared atomic writer, not a raw append: the
 * store is read back before every stage (the dedup), so staging is
 * read-merge-write over the whole record set, and a rename-based write can
 * never land the torn line a crash mid-append could - a line this store's
 * strict reader would refuse.
 */
export function stageHubSelection(vault: string, selection: HubSelection): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = storePath(vault);
  const record =
    selection.outcome === "candidate"
      ? candidateRecord(selection.candidate)
      : refusalRecord(selection.refusal);
  const records = parseStore(path);
  const staged = new Set(records.map(recordKey));
  if (staged.has(recordKey(record))) return;
  records.push(record);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

/** The staged candidates and refusals, ready to merge into a lane run. */
export interface StagedHubRecords {
  readonly candidates: RepairCandidate[];
  readonly refusals: RepairDecision[];
}

/**
 * Read the staged store back. A missing file is an empty store, not an
 * error; a corrupt or foreign record is a named {@link HubCandidateError}.
 */
export function loadStagedHubRecords(vault: string): StagedHubRecords {
  const candidates: RepairCandidate[] = [];
  const refusals: RepairDecision[] = [];
  for (const record of parseStore(storePath(vault))) {
    const strength = record.strength as IdentityStrength;
    if (record.kind === "candidate") {
      candidates.push({
        source: record.source,
        target: record.target,
        strength,
        confidence: record.confidence,
        reason: record.reason,
      });
    } else {
      refusals.push({
        source: record.source,
        target: record.target,
        strength,
        confidence: record.confidence,
        action: record.action,
        reason: record.reason,
      });
    }
  }
  return { candidates, refusals };
}
