/**
 * Entity-label hygiene: config-backed denylist resolution, malformed-node
 * detection, and the snapshot-gated prune (A1 / t_657b365e).
 *
 * The pure label-quality primitives live in `canonical.ts`; this module is
 * the I/O-aware layer around them. It resolves the operator denylist from the
 * plugin config, re-runs the SAME validator over stored entity nodes to find
 * historical junk labels (surfaced by the doctor and the prune dry-run), and
 * removes failing nodes plus their inbound relation edges behind the shared
 * D1 destructive-snapshot gate so a bad run is always recoverable.
 */

import { rmSync } from "node:fs";

import { discoverConfig } from "../../config.ts";
import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { normalizeRelationTarget } from "../../graph/frontmatter-relations.ts";
import { relationFromFrontmatterField } from "../../graph/relation-vocab.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import {
  normalizeEntityName,
  sanitizeEntityLabel,
  validateEntityLabel,
  type EntityLabelInvalidReason,
} from "./canonical.ts";
import { buildEntityIndex, type EntityIndex } from "./index-builder.ts";
import type { BrainEntity } from "./types.ts";

/** Snapshot run-id label for a confirmed entity-label prune. */
export const ENTITY_PRUNE_SNAPSHOT_LABEL = "entity-prune";

/** Config key / env twin for the operator-supplied exact-label denylist. */
export const ENTITY_LABEL_DENYLIST_CONFIG_KEY = "entities.label_denylist";
export const ENTITY_LABEL_DENYLIST_ENV_KEY = "OPEN_SECOND_BRAIN_ENTITIES_LABEL_DENYLIST";

/**
 * Resolve the operator label denylist (env wins over config file). The raw
 * value is a comma-separated list of EXACT labels; each entry is compared
 * post-`normalizeEntityName`, so the returned set holds normalised forms.
 * Empty / absent yields an empty set - the default is no name-based rejection.
 */
export function resolveEntityLabelDenylist(configPath?: string): ReadonlySet<string> {
  const env = process.env[ENTITY_LABEL_DENYLIST_ENV_KEY];
  const raw =
    env !== undefined && env !== ""
      ? env
      : discoverConfig(configPath).data[ENTITY_LABEL_DENYLIST_CONFIG_KEY];
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const normalized = normalizeEntityName(part);
    if (normalized) out.add(normalized);
  }
  return out;
}

/** A stored entity whose label fails the quality gate - a prune candidate. */
export interface MalformedEntityLabel {
  readonly id: string;
  readonly path: string;
  readonly category: string;
  /** The stored (unsanitised) display name. */
  readonly name: string;
  readonly status: string;
  readonly reason: EntityLabelInvalidReason;
  /** Ids of other entities that declare a relation edge pointing at this node. */
  readonly inboundReferences: ReadonlyArray<string>;
}

/** Build the id -> [referrer id] map for inbound relation edges. */
function inboundReferenceIndex(index: EntityIndex): Map<string, string[]> {
  const inbound = new Map<string, string[]>();
  for (const entity of index.entities) {
    for (const edge of entity.relations) {
      const list = inbound.get(edge.target);
      if (list) {
        if (!list.includes(entity.id)) list.push(entity.id);
      } else {
        inbound.set(edge.target, [entity.id]);
      }
    }
  }
  return inbound;
}

/**
 * Re-run the label validator over every stored entity node (any status) and
 * return the failing ones as prune candidates. Uses the SAME validator as
 * creation and anchoring - one source of truth.
 */
export function findMalformedEntityLabels(
  vault: string,
  opts: { readonly denylist?: ReadonlySet<string>; readonly configPath?: string } = {},
): MalformedEntityLabel[] {
  const denylist = opts.denylist ?? resolveEntityLabelDenylist(opts.configPath);
  const index = buildEntityIndex(vault);
  const inbound = inboundReferenceIndex(index);
  const out: MalformedEntityLabel[] = [];
  for (const entity of index.entities) {
    const verdict = validateEntityLabel(sanitizeEntityLabel(entity.name), { denylist });
    if (verdict.valid) continue;
    out.push(
      Object.freeze({
        id: entity.id,
        path: entity.path,
        category: entity.category,
        name: entity.name,
        status: entity.status,
        reason: verdict.reason!,
        inboundReferences: Object.freeze([...(inbound.get(entity.id) ?? [])]),
      }),
    );
  }
  return out;
}

export interface PruneEntityLabelsOptions {
  /** Apply the removals. Absent / false is a dry run that mutates nothing. */
  readonly confirm?: boolean;
  /** Injected clock for a deterministic snapshot run id. */
  readonly now?: Date;
  readonly configPath?: string;
  readonly denylist?: ReadonlySet<string>;
}

export interface PruneEntityLabelsResult {
  readonly confirmed: boolean;
  /** Malformed nodes found (the dry-run list; the confirm removal set). */
  readonly candidates: ReadonlyArray<MalformedEntityLabel>;
  /** Absolute paths of the node files removed (confirm only). */
  readonly removed: ReadonlyArray<string>;
  /** Count of inbound relation edges stripped from surviving nodes. */
  readonly edgesStripped: number;
  /** Recovery point taken behind the D1 gate, when work was applied. */
  readonly snapshotRunId: string | null;
  readonly snapshotPath: string | null;
}

/** One planned rewrite of a surviving node whose relations lost a target. */
interface EdgeRewrite {
  readonly path: string;
  readonly meta: FrontmatterMap;
  readonly body: string;
  readonly removed: number;
}

/**
 * Plan the inbound-edge removals: for every surviving entity, drop relation
 * targets that resolve to a pruned id so no dangling `broken-entity-relation`
 * survives the prune. Returns one rewrite per changed file plus the total
 * number of edges removed.
 */
function planEdgeRewrites(
  survivors: ReadonlyArray<BrainEntity>,
  prunedIds: ReadonlySet<string>,
): { rewrites: EdgeRewrite[]; edgesStripped: number } {
  const rewrites: EdgeRewrite[] = [];
  let edgesStripped = 0;
  for (const entity of survivors) {
    const [meta, body] = parseFrontmatter(entity.path);
    let changed = 0;
    const nextMeta: FrontmatterMap = {};
    for (const [key, value] of Object.entries(meta)) {
      if (!relationFromFrontmatterField(key)) {
        nextMeta[key] = value;
        continue;
      }
      const items = Array.isArray(value) ? value : value === "" ? [] : [value];
      const kept = items.filter((item) => {
        const target = normalizeRelationTarget(String(item));
        if (target !== null && prunedIds.has(target)) {
          changed++;
          return false;
        }
        return true;
      });
      // Drop the relation key entirely when nothing remains, rather than
      // leaving an empty `related: []` behind.
      if (kept.length > 0) nextMeta[key] = kept;
    }
    if (changed > 0) {
      edgesStripped += changed;
      rewrites.push({ path: entity.path, meta: nextMeta, body, removed: changed });
    }
  }
  return { rewrites, edgesStripped };
}

/**
 * Prune stored entity nodes whose labels fail the quality gate. Dry-run by
 * default (mutates nothing); `confirm: true` removes the node files AND
 * strips inbound relation edges pointing at them, all inside a single
 * pre-operation snapshot so the run is recoverable and leaves no orphaned
 * references behind.
 */
export function pruneEntityLabels(
  vault: string,
  opts: PruneEntityLabelsOptions = {},
): PruneEntityLabelsResult {
  const denylist = opts.denylist ?? resolveEntityLabelDenylist(opts.configPath);
  const candidates = findMalformedEntityLabels(vault, { denylist });

  if (!opts.confirm || candidates.length === 0) {
    return Object.freeze({
      confirmed: false,
      candidates: Object.freeze(candidates),
      removed: Object.freeze([]),
      edgesStripped: 0,
      snapshotRunId: null,
      snapshotPath: null,
    });
  }

  const prunedIds = new Set(candidates.map((c) => c.id));
  const prunePaths = candidates.map((c) => c.path);
  const survivors = buildEntityIndex(vault).entities.filter((e) => !prunedIds.has(e.id));
  const { rewrites, edgesStripped } = planEdgeRewrites(survivors, prunedIds);

  const gated = withDestructiveSnapshot(
    vault,
    ENTITY_PRUNE_SNAPSHOT_LABEL,
    () => {
      for (const path of prunePaths) rmSync(path, { force: true });
      for (const rewrite of rewrites) {
        writeFrontmatterAtomic(rewrite.path, rewrite.meta, rewrite.body, { overwrite: true });
      }
    },
    opts.now !== undefined ? { now: opts.now } : {},
  );

  return Object.freeze({
    confirmed: true,
    candidates: Object.freeze(candidates),
    removed: Object.freeze([...prunePaths]),
    edgesStripped,
    snapshotRunId: gated.snapshot.runId,
    snapshotPath: gated.snapshot.path,
  });
}
