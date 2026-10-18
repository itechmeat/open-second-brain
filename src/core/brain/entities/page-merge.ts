/**
 * Entity page-merge: plan, plan hash, and the guarded apply
 * (actionable-now batch, A1 / t_28a8789d).
 *
 * Two entity pages of one category that denote the same subject - the
 * doctor's `duplicate-entity` collision, or an opt-in
 * `entity-alias-candidate` nomination - are repaired by ALIAS, not by
 * rewriting history: the survivor keeps its page and gains the old
 * display name as an alias, the dropped page is archived behind the
 * destructive-snapshot gate, and nothing append-only is touched. Claims
 * aggregate by normalized name (`truth/aggregate.ts`), so once the old
 * name answers to the survivor every claim and name link keeps
 * resolving with ZERO rewrites.
 *
 * The apply is sealed by a plan-hash accept gate (the dream-stage
 * `plan_hash` precedent): the preview renders the plan and echoes
 * `sha256Hex` over it; apply RE-PLANS from the live vault and refuses
 * before any write unless the caller presents the hash of the plan the
 * vault still agrees with. There is no accepted-plan journal - the
 * re-plan plus the hash is the seal (v1 decision, actionable-now
 * design.md).
 *
 * Every removal here sits inside {@link withDestructiveSnapshot}, so a
 * bad merge is recoverable from the recovery point it names; every
 * rewrite goes through `writeFrontmatterAtomic`; the write path asserts
 * vault identity at entry; and one reliability-audit record plus one
 * Brain `merge` log event are appended after the bytes land.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { normalizeRelationTarget } from "../../graph/frontmatter-relations.ts";
import { relationFromFrontmatterField } from "../../graph/relation-vocab.ts";
import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import { appendAuditRecord } from "../../reliability/audit.ts";
import { normalizeEntityName, quoteVariantCollisionTail } from "./canonical.ts";
import { buildEntityIndex, type EntityIndex } from "./index-builder.ts";
import { guardEntityMerge } from "../truth/merge-guard.ts";
import { BRAIN_ENTITY_STATUS, type BrainEntity } from "./types.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./status-scope.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import { HYGIENE_AUDIT_DIR } from "../audit-dirs.ts";
import { brainDirsForWrite, vaultRelative } from "../paths.ts";
import { appendLogEvent } from "../log.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "../types.ts";

/** Why an entity merge refused, as a stable code an operator scripts on. */
export type EntityMergeErrorCode =
  | "keep-not-found"
  | "drop-not-found"
  | "same-entity"
  | "shared-entity-id"
  | "category-mismatch"
  | "ambiguous-subject"
  | "quarantine-record"
  | "inactive-record"
  | "alias-claimed"
  | "entity-guard"
  | "hash-required"
  | "hash-mismatch";

/** A merge refusal with its code first, so the sentence is skippable. */
export class EntityMergeError extends Error {
  readonly code: EntityMergeErrorCode;

  constructor(code: EntityMergeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "EntityMergeError";
    this.code = code;
  }
}

/** The two subjects of a merge, each an entity id, name or alias. */
export interface EntityMergeRefs {
  readonly keep: string;
  readonly drop: string;
  /** Narrow the category the subject must resolve in. */
  readonly keepCategory?: string;
  readonly dropCategory?: string;
}

/** The plan an operator previews, hashes and - via the hash - accepts. */
export interface EntityMergePlan {
  readonly keep_id: string;
  readonly drop_id: string;
  readonly category: string;
  readonly keep_name: string;
  readonly drop_name: string;
  /** Vault-relative paths, so the plan is stable across synced machines. */
  readonly keep_path: string;
  readonly drop_path: string;
  /**
   * SHA-256 over each page file's current bytes, read at plan time. The
   * ids and counts below describe the vault; these seal it: any edit to
   * either page between the preview and the apply shifts the re-planned
   * hash, and the apply refuses as stale instead of folding prose the
   * operator never read.
   */
  readonly keep_digest: string;
  readonly drop_digest: string;
  /**
   * The dropped page's display name, added to the survivor's aliases;
   * null when the survivor already answers to it (the duplicate-name
   * collision folds to one identity key, so there is nothing to add).
   * The human-facing summary - {@link aliases_merged} is the full,
   * authoritative write list.
   */
  readonly alias_added: string | null;
  /**
   * Every alias the survivor gains, in write order: the dropped page's
   * display name first (when new), then the aliases the dropped page
   * held - deduplicated by normalized form, the survivor's own names
   * skipped. Part of the hashed plan, so the operator previews exactly
   * the alias set the apply writes.
   */
  readonly aliases_merged: ReadonlyArray<string>;
  /** True when the dropped page's body folds into the survivor's. */
  readonly body_folded: boolean;
  /** Dropped-page relation edges unioned into the survivor's frontmatter. */
  readonly relations_absorbed: number;
  /** Other entities' edges retargeted from the dropped id to the survivor. */
  readonly inbound_edges_retargeted: number;
  /** Survivor edges pointing at the dropped id, removed as self-relations. */
  readonly cyclic_edges_removed: number;
  /**
   * Whether this plan overrode a refusal from the text-level merge guard.
   * Stamped only when the guard WOULD have refused and the caller opted
   * out (`--force`): a pair the guard passes stamps false and hashes
   * identically at either stance, so the standard flow - preview without
   * `--force`, apply with it for consent - re-plans to the hash the
   * preview echoed. Part of the hashed plan on purpose: a pair that
   * refuses stamps true, so a hash taken under the override is not
   * spendable at a guarded re-plan (and the other way round) - the apply
   * refuses as stale, forcing a re-preview that is honest about the
   * override instead of widening or hiding it under a hash taken at
   * another stance.
   */
  readonly guard_bypassed: boolean;
}

/** What a verified, applied merge did, and where the recovery point is. */
export interface EntityMergeResult {
  readonly plan: EntityMergePlan;
  /** Vault-relative path of the archived page (the file that is now gone). */
  readonly dropped_path: string;
  readonly snapshot_run_id: string;
  readonly snapshot_path: string;
  readonly verified_hash: string;
}

export interface ApplyEntityMergeOptions {
  /**
   * The plan hash the preview echoed. Absent refuses with
   * `hash-required` before anything is read for writing; present and
   * mismatched refuses with `hash-mismatch`.
   */
  readonly expectHash?: string;
  readonly now?: Date;
  /** Acting identity for the audit record and the log event. */
  readonly agent?: string;
  /** Bypass the text-level merge guard over the two bodies (`--force`). */
  readonly bypassEntityGuard?: boolean;
}

export interface PlanEntityMergeOptions {
  readonly bypassEntityGuard?: boolean;
}

/**
 * The heading a folded body lands under on the survivor. One constant,
 * because the wording is part of the on-disk contract a reader matches.
 */
const FOLDED_BODY_HEADING_PREFIX = "## Merged from";

/**
 * The plan hash: sha256 over the plan serialized with stable key order.
 * The dream-stage precedent (`plan_hash` over the serialized plan), and
 * the only seal the apply accepts.
 */
export function entityMergePlanHash(plan: EntityMergePlan): string {
  return sha256Hex(canonicalJson(plan));
}

/**
 * Resolve one subject at the CANONICAL scope, by exact id first and by
 * normalized name or alias second.
 *
 * Non-canonical holders refuse BY NAME rather than reading as missing: a
 * quarantined record is a lane this verb must never merge across
 * (actionable-now design: quarantine-lane records are refused or routed
 * explicitly, never silently merged), and an archived one is a restore
 * away from canonical. Two canonical claimants of one key - the exact
 * collision this verb exists to repair - refuse as ambiguous so the
 * operator picks both sides by id.
 */
function resolveSubject(
  index: EntityIndex,
  side: "keep" | "drop",
  query: string,
  category: string | undefined,
): BrainEntity {
  const notFound = () =>
    new EntityMergeError(
      side === "keep" ? "keep-not-found" : "drop-not-found",
      `entity not found: ${JSON.stringify(query)}`,
    );
  const trimmed = query.trim();
  if (trimmed.length === 0) throw notFound();

  // The requested category narrows the id path too: an id that resolves
  // outside it is as missing as a name no record in the category holds,
  // and refuses with the same named error.
  const inCategory = (e: BrainEntity) => category === undefined || e.category === category;
  const byId = index.entities.filter((e) => e.id === trimmed && inCategory(e));
  if (byId.length === 1) return assertMergeable(byId[0]!);
  if (byId.length > 1) {
    // More than one record carries the id: the sync / hand-copy collision
    // the doctor reports. Refuse by name - the id cannot disambiguate
    // itself, so "pass both sides by id" (the advice the ambiguous-name
    // path gives) is impossible here. The fix is archival, not path-based.
    throw new EntityMergeError(
      "shared-entity-id",
      `${byId.length} records share entity_id ${JSON.stringify(trimmed)} ` +
        `(${byId.map((m) => m.path).join(", ")}) - the sync or hand-copy collision the doctor ` +
        "reports; archive or rename one copy first, then merge",
    );
  }

  const normalized = normalizeEntityName(trimmed);
  if (normalized.length === 0) throw notFound();
  const canonical = index.entities.filter(
    (e) =>
      entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) &&
      inCategory(e) &&
      (normalizeEntityName(e.name) === normalized ||
        e.aliases.some((a) => normalizeEntityName(a) === normalized)),
  );
  if (canonical.length === 1) return canonical[0]!;
  if (canonical.length > 1) {
    throw new EntityMergeError(
      "ambiguous-subject",
      `entity reference ${JSON.stringify(query)} is claimed by ${canonical.length} canonical ` +
        `records: ${canonical.map((m) => m.id).join(", ")} - pass both sides by id` +
        quoteVariantCollisionTail(...canonical.map((m) => m.name)),
    );
  }

  // Nothing canonical: name the non-canonical holder through the one gate
  // every subject passes, so the real status names itself - hard-coding
  // "archived" here would misreport any status this vocabulary grows.
  const held = index.entities.filter(
    (e) =>
      inCategory(e) &&
      (normalizeEntityName(e.name) === normalized ||
        e.aliases.some((a) => normalizeEntityName(a) === normalized)),
  );
  if (held.length > 0) {
    assertMergeable(held[0]!); // throws, naming the holder's actual status
    throw notFound(); // unreachable: held holds only non-canonical records
  }
  throw notFound();
}

function assertMergeable(entity: BrainEntity): BrainEntity {
  if (entity.status === BRAIN_ENTITY_STATUS.quarantine) {
    throw new EntityMergeError(
      "quarantine-record",
      `${entity.id} is a quarantine-lane record; the merge refuses rather than fold an ` +
        "unvouched record into the canonical registry - release it first " +
        "(brain entity archive --restore)",
    );
  }
  if (entity.status === BRAIN_ENTITY_STATUS.archived) {
    throw new EntityMergeError(
      "inactive-record",
      `${entity.id} is archived; restore it (brain entity archive --restore) or merge the ` +
        "canonical records only",
    );
  }
  if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) {
    throw new EntityMergeError(
      "inactive-record",
      `${entity.id} has status '${entity.status}', which this merge does not admit`,
    );
  }
  return entity;
}

/** The relation edges of one entity, keyed by their frontmatter field. */
function relationEdges(meta: FrontmatterMap): Array<{ key: string; target: string }> {
  const out: Array<{ key: string; target: string }> = [];
  for (const [key, value] of Object.entries(meta)) {
    if (!relationFromFrontmatterField(key)) continue;
    const items = Array.isArray(value) ? value : value === "" ? [] : [value];
    for (const item of items) {
      const target = normalizeRelationTarget(String(item));
      if (target !== null) out.push({ key, target });
    }
  }
  return out;
}

/**
 * Build the merge plan for two canonical entity pages. Reads only - the
 * plan is a frozen value and building it writes nothing, which is what
 * makes the preview a byte-no-op and the hash a seal over vault state.
 */
export function planEntityMerge(
  vault: string,
  refs: EntityMergeRefs,
  opts: PlanEntityMergeOptions = {},
): EntityMergePlan {
  const index = buildEntityIndex(vault);
  const keep = resolveSubject(index, "keep", refs.keep, refs.keepCategory);
  const drop = resolveSubject(index, "drop", refs.drop, refs.dropCategory);

  if (keep.id === drop.id) {
    throw new EntityMergeError("same-entity", `both sides resolve to ${keep.id}`);
  }
  if (keep.category !== drop.category) {
    throw new EntityMergeError(
      "category-mismatch",
      `keep is '${keep.category}' but drop is '${drop.category}'; one canonical entity per ` +
        "(category, name) means a merge only makes sense inside one category",
    );
  }

  // Every name the dropped page answers to moves to the survivor - the
  // display name first, then the aliases it held - so removing the page
  // orphans no resolution. Dedup by normalized form, and skip the names
  // the survivor already answers to (the duplicate-identity case folds to
  // one key). Each candidate runs the claimed-alias check at PLAN time:
  // keep and drop are exempt (keep's claim folds into the merge, and a
  // drop listing its own name claims itself), any other canonical holder
  // refuses by name - merging would duplicate the claim, not move it.
  // A holder is read off BOTH name fields, scoped the way the registry
  // scopes them: a candidate equal to another record's DISPLAY NAME is
  // as claimed as one listed in its aliases, but only inside the merge's
  // own category (`byKey` is `category:normalized`, so two categories
  // sharing a display name is valid and cannot be fixed by the operator
  // - refusing on it would block merges no repair can unblock), while an
  // ALIAS match refuses across categories (`byAlias` is global). The
  // holders are scanned off the entity list, not `byAlias`: the map
  // keeps only a duplicate claim's first claimant, which for a contested
  // alias is often the drop itself - the claimant this check must exempt.
  const keepNormalized = normalizeEntityName(keep.name);
  const survivorAnswers = (raw: string): boolean => {
    const normalized = normalizeEntityName(raw);
    return (
      normalized === keepNormalized ||
      keep.aliases.some((a) => normalizeEntityName(a) === normalized)
    );
  };
  const aliasHolderOf = (normalized: string): BrainEntity | undefined =>
    index.entities.find(
      (e) =>
        e.id !== keep.id &&
        e.id !== drop.id &&
        entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) &&
        ((e.category === keep.category && normalizeEntityName(e.name) === normalized) ||
          e.aliases.some((a) => normalizeEntityName(a) === normalized)),
    );
  const seenAliases = new Set<string>();
  const aliasesMerged: string[] = [];
  for (const candidate of [drop.name, ...drop.aliases]) {
    const normalized = normalizeEntityName(candidate);
    if (normalized.length === 0 || seenAliases.has(normalized) || survivorAnswers(candidate)) {
      continue;
    }
    seenAliases.add(normalized);
    const holder = aliasHolderOf(normalized);
    if (holder !== undefined) {
      throw new EntityMergeError(
        "alias-claimed",
        `alias ${JSON.stringify(candidate)} is already claimed by ${holder.id} ` +
          `(${holder.path}) - resolve that claim first`,
      );
    }
    aliasesMerged.push(candidate);
  }
  const aliasAdded = aliasesMerged.includes(drop.name) ? drop.name : null;

  // Text-level merge guard over the two bodies (t_e9692750): disjoint
  // guarded anchor sets are the one demonstrably unsafe fold. The verdict
  // is consulted even under an explicit bypass (`--force`), because the
  // plan's guard_bypassed stamp means "the guard would have refused and
  // the caller overrode it" - a clean pair stamps false and hashes
  // identically at either stance, while a refused pair is plannable only
  // through the override, and the hash seals which of the two happened.
  const verdict = guardEntityMerge({
    keepText: keep.body,
    dropText: drop.body,
    entities: index.entities,
  });
  let guardBypassed = false;
  if (!verdict.allowed) {
    if (opts.bypassEntityGuard !== true) {
      throw new EntityMergeError(
        "entity-guard",
        `${verdict.reason} - pass --force to merge anyway`,
      );
    }
    guardBypassed = true;
  }

  const keepMeta = parseFrontmatter(keep.path)[0];
  const keepTargets = new Set(relationEdges(keepMeta).map((e) => `${e.key}:${e.target}`));
  const dropMeta = parseFrontmatter(drop.path)[0];
  // Dedup the dropped edges by field:target BEFORE counting, so the plan
  // counts edges the way the apply's union writes them: a duplicated edge
  // on the dropped page lands once, and the plan says one.
  const seenDropEdges = new Set<string>();
  let relationsAbsorbed = 0;
  for (const edge of relationEdges(dropMeta)) {
    const edgeKey = `${edge.key}:${edge.target}`;
    if (seenDropEdges.has(edgeKey)) continue;
    seenDropEdges.add(edgeKey);
    if (edge.target !== keep.id && edge.target !== drop.id && !keepTargets.has(edgeKey)) {
      relationsAbsorbed++;
    }
  }
  const cyclicRemoved = relationEdges(keepMeta).filter((e) => e.target === drop.id).length;
  const inboundRetargeted = index.entities.filter(
    (entity) =>
      entity.id !== keep.id &&
      entity.id !== drop.id &&
      entity.relations.some((edge) => edge.target === drop.id),
  ).length;

  return Object.freeze({
    keep_id: keep.id,
    drop_id: drop.id,
    category: keep.category,
    keep_name: keep.name,
    drop_name: drop.name,
    keep_path: vaultRelative(keep.path, vault),
    drop_path: vaultRelative(drop.path, vault),
    keep_digest: sha256Hex(readFileSync(keep.path)),
    drop_digest: sha256Hex(readFileSync(drop.path)),
    alias_added: aliasAdded,
    aliases_merged: Object.freeze(aliasesMerged),
    body_folded: drop.body.trim().length > 0,
    relations_absorbed: relationsAbsorbed,
    inbound_edges_retargeted: inboundRetargeted,
    cyclic_edges_removed: cyclicRemoved,
    guard_bypassed: guardBypassed,
  });
}

/**
 * Merge one entity page into another, behind the verified plan hash.
 *
 * Refuses before ANY write until the caller presents the hash of a plan
 * the live vault still produces; then takes one recovery point, rewrites
 * the survivor (alias in, dropped relation edges unioned in, folded body
 * appended), retargets the inbound relation edges, and archives the
 * dropped page inside it. Audit record and Brain log event land after
 * the bytes, so a failure past the gate still names the snapshot.
 */
export function applyEntityMerge(
  vault: string,
  refs: EntityMergeRefs,
  opts: ApplyEntityMergeOptions = {},
): EntityMergeResult {
  // Vault-identity write guard (context-integrity-gates, Unit J) at the
  // entry of the write path, ahead of any other work: everything below
  // this line is deciding how to write, not whether to.
  assertVaultIdentityForWrite(vault);

  const plan = planEntityMerge(vault, refs, { bypassEntityGuard: opts.bypassEntityGuard });
  if (opts.expectHash === undefined) {
    throw new EntityMergeError(
      "hash-required",
      "no --expect-hash given; preview the merge first and present the plan hash it echoes " +
        "before anything is written",
    );
  }
  const verified = entityMergePlanHash(plan);
  if (verified !== opts.expectHash) {
    throw new EntityMergeError(
      "hash-mismatch",
      `the presented hash does not describe this vault's merge plan any more (expected ` +
        `${verified}); re-run the preview - a stale plan is a vault that moved`,
    );
  }

  const index = buildEntityIndex(vault);
  const keep = index.entities.find((e) => e.id === plan.keep_id)!;
  const drop = index.entities.find((e) => e.id === plan.drop_id)!;
  const stamp = isoSecond(opts.now ?? new Date());

  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.entityMerge,
    () => {
      // 1. Survivor rewrite: the dropped page's names in as aliases, its
      //    relation edges unioned in, edges pointing at the dropped page
      //    removed (a self-relation the registry would refuse), folded
      //    body appended.
      const [keepMeta, keepBody] = parseFrontmatter(keep.path);
      const [dropMeta] = parseFrontmatter(drop.path);
      const nextMeta: FrontmatterMap = { ...keepMeta };
      if (plan.aliases_merged.length > 0) {
        const existing = nextMeta["aliases"];
        const aliases = Array.isArray(existing)
          ? [...existing]
          : typeof existing === "string" && existing.trim().length > 0
            ? [existing]
            : [];
        for (const alias of plan.aliases_merged) {
          const normalized = normalizeEntityName(alias);
          if (
            normalized.length > 0 &&
            aliases.some((a) => normalizeEntityName(String(a)) === normalized)
          ) {
            continue;
          }
          aliases.push(alias);
        }
        nextMeta["aliases"] = aliases;
      }
      for (const [key, value] of Object.entries(dropMeta)) {
        if (!relationFromFrontmatterField(key)) continue;
        const incoming = Array.isArray(value) ? value : value === "" ? [] : [value];
        const currentRaw = nextMeta[key];
        const current = Array.isArray(currentRaw)
          ? [...currentRaw]
          : typeof currentRaw === "string" && currentRaw.trim().length > 0
            ? [currentRaw]
            : [];
        for (const item of incoming) {
          const target = normalizeRelationTarget(String(item));
          if (target === keep.id || target === drop.id) continue;
          if (current.some((c) => normalizeRelationTarget(String(c)) === target)) continue;
          current.push(String(item));
        }
        if (current.length > 0) nextMeta[key] = current;
      }
      for (const [key, value] of Object.entries(nextMeta)) {
        if (!relationFromFrontmatterField(key)) continue;
        const items = Array.isArray(value) ? value : value === "" ? [] : [value];
        const kept = items.filter((item) => normalizeRelationTarget(String(item)) !== drop.id);
        if (kept.length === 0) delete nextMeta[key];
        else nextMeta[key] = kept;
      }
      nextMeta["updated_at"] = stamp;
      const foldedBody =
        plan.body_folded && drop.body.trim().length > 0
          ? `${keepBody.trimEnd()}\n\n${FOLDED_BODY_HEADING_PREFIX} ${drop.name}\n\n${drop.body.trim()}\n`
          : keepBody;
      writeFrontmatterAtomic(keep.path, nextMeta, foldedBody, { overwrite: true });

      // 2. Inbound relation edges: retarget the dropped id to the survivor
      //    so no `broken-entity-relation` survives the merge and no edge
      //    information is lost. A field holding BOTH sides of the pair maps
      //    onto `[[keep]]` twice, so the map dedups by normalized target -
      //    first occurrence wins, order preserved (the same union rule the
      //    survivor's own absorbed edges follow).
      for (const entity of index.entities) {
        if (entity.id === keep.id || entity.id === drop.id) continue;
        if (!entity.relations.some((edge) => edge.target === drop.id)) continue;
        const [meta, body] = parseFrontmatter(entity.path);
        const metaNext: FrontmatterMap = { ...meta };
        for (const [key, value] of Object.entries(metaNext)) {
          if (!relationFromFrontmatterField(key)) continue;
          const items = Array.isArray(value) ? value : value === "" ? [] : [value];
          // A field nothing in it points at the dropped page is left
          // exactly as it reads: no scalar arrayified, no empty field
          // rewritten into an empty list.
          if (!items.some((item) => normalizeRelationTarget(String(item)) === drop.id)) continue;
          const mapped = items.map((item) =>
            normalizeRelationTarget(String(item)) === drop.id ? `[[${keep.id}]]` : String(item),
          );
          const seen = new Set<string>();
          const deduped: string[] = [];
          for (const item of mapped) {
            const target = normalizeRelationTarget(item);
            if (target !== null && seen.has(target)) continue;
            if (target !== null) seen.add(target);
            deduped.push(item);
          }
          metaNext[key] = deduped;
        }
        metaNext["updated_at"] = stamp;
        writeFrontmatterAtomic(entity.path, metaNext, body, { overwrite: true });
      }
      // 3. The old page is archived - removed BEHIND the recovery point
      //    this callback runs under, never as a bare delete.
      rmSync(drop.path, { force: true });
    },
    opts.now !== undefined ? { now: opts.now } : {},
  );

  const agent = opts.agent ?? "unknown";
  // Reliability audit record (the destructive-entity-verb template: the
  // hygiene audit directory under Brain/log/ carries week shards).
  appendAuditRecord(join(brainDirsForWrite(vault).log, HYGIENE_AUDIT_DIR), {
    timestamp: (opts.now ?? new Date()).toISOString(),
    actor: agent,
    action: "entity_merge",
    target: plan.keep_id,
    ok: true,
    details: {
      dropped: plan.drop_id,
      category: plan.category,
      alias_added: plan.alias_added ?? "",
      // The full moved set, not just the display name: the aliases the
      // dropped page held are nowhere else in the trail.
      aliases_merged: JSON.stringify(plan.aliases_merged),
      body_folded: String(plan.body_folded),
      relations_absorbed: String(plan.relations_absorbed),
      inbound_edges_retargeted: String(plan.inbound_edges_retargeted),
      cyclic_edges_removed: String(plan.cyclic_edges_removed),
      plan_hash: verified,
      snapshot_run_id: gated.snapshot.runId,
    },
  });

  // Brain log event (the `merge` kind, entity payload), so the merge
  // surfaces in the activity timeline like every other lifecycle event.
  appendLogEvent(vault, {
    timestamp: stamp,
    eventType: BRAIN_LOG_EVENT_KIND.merge,
    agent,
    body: {
      keep_id: plan.keep_id,
      drop_id: plan.drop_id,
      category: plan.category,
      alias_added: plan.alias_added ?? "",
      // Mirrors the audit record: the full moved alias set, not just the
      // display name the alias_added field carries.
      aliases_merged: JSON.stringify(plan.aliases_merged),
      body_folded: String(plan.body_folded),
      relations_absorbed: String(plan.relations_absorbed),
      cyclic_edges_removed: String(plan.cyclic_edges_removed),
      plan_hash: verified,
      snapshot_run_id: gated.snapshot.runId,
    },
  });

  return Object.freeze({
    plan,
    dropped_path: plan.drop_path,
    snapshot_run_id: gated.snapshot.runId,
    snapshot_path: gated.snapshot.path,
    verified_hash: verified,
  });
}
