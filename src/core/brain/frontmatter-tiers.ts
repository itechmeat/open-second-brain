/**
 * Tiered frontmatter field protection (write-time-integrity-governance).
 *
 * Four tiers, EverOS-inspired, mapped onto Open Second Brain's
 * existing conventions:
 *
 *   - `identity` - framework-owned join keys (`kind`, `id`,
 *     `entity_id`, an entity's `category`). A hand-edit here corrupts
 *     the joins the index and registry depend on.
 *   - `system`   - framework-written bookkeeping: timestamps,
 *     counters, lifecycle status. The `_`-prefixed preference fields
 *     already follow this convention informally; the tier model makes
 *     it explicit.
 *   - `business` - domain fields agents write through verbs.
 *   - `user`     - freely editable; everything undeclared.
 *
 * Resolution order: schema-pack `frontmatter_tiers` override >
 * built-in framework defaults > `user`. Unknown kinds resolve every
 * field to `user`, so a human's own vault is never constrained.
 *
 * The guard never write-denies humans: framework writers merge
 * through `mergeFrontmatterTiered` (preserve user fields they do not
 * own, refuse to change identity values), and the drift check
 * (`o2b brain tiers check`) detects hand-edits against the indexed
 * baseline and stages repair - it does not fight the editor.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { FRONTMATTER_TIERS, type FrontmatterTier, type SchemaPack } from "./schema-pack.ts";

export { FRONTMATTER_TIERS };
export type { FrontmatterTier };

/** Thrown when a merge would change an identity join key. */
export class FrontmatterTierConflictError extends Error {
  readonly field: string;
  readonly existingValue: unknown;
  readonly incomingValue: unknown;

  constructor(field: string, existingValue: unknown, incomingValue: unknown) {
    super(
      `identity field "${field}" cannot change in a framework write: ` +
        `${JSON.stringify(existingValue)} -> ${JSON.stringify(incomingValue)} ` +
        `(pass acceptIdentity for an explicit migration)`,
    );
    this.name = "FrontmatterTierConflictError";
    this.field = field;
    this.existingValue = existingValue;
    this.incomingValue = incomingValue;
  }
}

/**
 * Built-in tier defaults for framework-owned kinds, grounded in the
 * fields the writers actually emit (preference.ts, entities/registry,
 * signal.ts, dead-ends.ts). Fields not listed here fall through to
 * the `_`-prefix system rule, then to `user`.
 */
export const DEFAULT_TIER_MAP: Readonly<Record<string, Readonly<Record<string, FrontmatterTier>>>> =
  Object.freeze({
    "brain-preference": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      id: "identity",
      created_at: "system",
      unconfirmed_until: "system",
      topic: "business",
      principle: "business",
      scope: "business",
      tags: "business",
      aliases: "business",
      supersedes: "business",
      // Legacy unprefixed Group C names (pre-§24). System tier so a
      // tier-merging rewrite drops them instead of preserving a stale
      // copy beside the `_`-prefixed field the writer emits today.
      status: "system",
      confirmed_at: "system",
      evidenced_by: "system",
      applied_count: "system",
      violated_count: "system",
      last_evidence_at: "system",
      confidence: "system",
      confidence_value: "system",
    }),
    "brain-retired": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      id: "identity",
      created_at: "system",
      retired_at: "system",
    }),
    // Derived cluster notes (link-recall-intelligence, t_4ba927ec):
    // fully framework-owned and regenerated every run, so every field
    // is system except the identity pair.
    "brain-cluster": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      cluster: "identity",
      generated_at: "system",
      size: "system",
      density: "system",
      members: "system",
    }),
    "brain-signal": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      id: "identity",
      created_at: "system",
      agent: "system",
      topic: "business",
      signal: "business",
      scope: "business",
    }),
    "brain-entity": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      entity_id: "identity",
      category: "identity",
      created_at: "system",
      updated_at: "system",
      status: "system",
      source_agent: "system",
      name: "business",
      aliases: "business",
      confidence: "business",
    }),
    "brain-dead-end": Object.freeze<Record<string, FrontmatterTier>>({
      kind: "identity",
      id: "identity",
      created_at: "system",
      agent: "system",
    }),
  });

/**
 * Resolve one field's tier: pack override > built-in default >
 * `_`-prefix system rule (framework kinds only) > `user`.
 */
export function resolveFieldTier(pack: SchemaPack, kind: string, field: string): FrontmatterTier {
  const packKind = pack.frontmatter_tiers[kind];
  const override = packKind?.[field];
  if (override !== undefined) return override;
  const isFrameworkKind = DEFAULT_TIER_MAP[kind] !== undefined || packKind !== undefined;
  if (!isFrameworkKind) return "user";
  const builtin = DEFAULT_TIER_MAP[kind]?.[field];
  if (builtin !== undefined) return builtin;
  if (field.startsWith("_")) return "system";
  return "user";
}

/**
 * Every field of a kind with a declared non-`user` tier (pack
 * overrides merged over built-ins). The drift check walks this map;
 * `user`-tier overrides are omitted because they need no protection.
 */
export function tieredFieldsForKind(
  pack: SchemaPack,
  kind: string,
): Record<string, FrontmatterTier> {
  const out: Record<string, FrontmatterTier> = {};
  for (const [field, tier] of Object.entries(DEFAULT_TIER_MAP[kind] ?? {})) out[field] = tier;
  for (const [field, tier] of Object.entries(pack.frontmatter_tiers[kind] ?? {})) {
    if (tier === "user") delete out[field];
    else out[field] = tier;
  }
  return out;
}

export interface MergeFrontmatterTieredOptions {
  /** The file's framework kind (the writer knows what it writes). */
  readonly kind: string;
  readonly pack: SchemaPack;
  /**
   * Allow an identity value to change - explicit migrations only
   * (rename, re-id). Never set this on a routine update write.
   */
  readonly acceptIdentity?: boolean;
}

/**
 * Tier-respecting frontmatter merge for framework writers. Incoming
 * (framework) values win field-by-field; existing-only fields are
 * preserved when their tier is `user` - a field a human added by hand
 * survives every framework rewrite - and DROPPED otherwise: a
 * framework-owned field the writer no longer emits is a deliberate
 * migration (e.g. legacy unprefixed names), not user data. A changed
 * identity value throws unless `acceptIdentity` marks an explicit
 * migration. Unknown kinds have no non-`user` fields, so the merge
 * degrades to a plain spread.
 */
export function mergeFrontmatterTiered<V>(
  existing: Readonly<Record<string, V>>,
  incoming: Readonly<Record<string, V>>,
  opts: MergeFrontmatterTieredOptions,
): Record<string, V> {
  if (opts.acceptIdentity !== true) {
    for (const [field, incomingValue] of Object.entries(incoming)) {
      if (resolveFieldTier(opts.pack, opts.kind, field) !== "identity") continue;
      if (!(field in existing)) continue;
      const existingValue = existing[field];
      if (!sameScalar(existingValue, incomingValue)) {
        throw new FrontmatterTierConflictError(field, existingValue, incomingValue);
      }
    }
  }
  const merged: Record<string, V> = {};
  for (const [field, value] of Object.entries(existing)) {
    if (field in incoming) continue;
    if (resolveFieldTier(opts.pack, opts.kind, field) === "user") merged[field] = value;
  }
  return Object.assign(merged, incoming);
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((v, i) => sameScalar(v, right[i]));
  }
  return left === right;
}

/**
 * Count the staged tier-drift findings straight from the index
 * database (doctor surface). Read-only, fail-soft: a missing index
 * file, a pre-v6 schema, or any read error counts as zero.
 */
export function readTierDriftCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tier_drift").get()?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}
