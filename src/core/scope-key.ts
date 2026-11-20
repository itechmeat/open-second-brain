/**
 * Composite scope keys and source-identity keys (seam 1, t_37c05a34).
 *
 * The ONE module owning both:
 *   - the owner / session / project scope vocabulary that makes dedup
 *     per-scope and lets search opt into scope filters (t_37c05a34); and
 *   - the source-identity key that RRF/dedup uses so federated results from
 *     different origins never collide, plus the canonical source-set key the
 *     query cache scopes by (t_09b7ccea federation hardening).
 *
 * A single implementation is deliberate: a key mismatch silently collapses
 * distinct results or fails to collapse duplicates, so the scope key and the
 * source-identity key live here and nowhere else.
 *
 * Language-agnostic: every axis is an opaque identifier normalized purely
 * structurally (NFC / case / slug), never matched against any word list. The
 * owner axis reuses the v1.6 agent-scope normalization; session and project
 * use the scoped-rule key (`brain/scoped-rule-key.ts`), the rule a record's
 * project is stamped with: letters, marks and digits of every script are
 * kept, so a key the writer stamps reads back unchanged and a name in
 * another script or with an accent is its own scope. ASCII values key
 * exactly as the older session-scope slug rule keyed them.
 */

import { normalizeAgentScope, pageOwner } from "./graph/agent-scope.ts";
import { scopedRuleKey } from "./brain/scoped-rule-key.ts";
import type { FrontmatterMap } from "./types.ts";

/** The ordered scope axes. Owner is the pre-existing v1.6 isolation axis. */
export const SCOPE_AXES = Object.freeze(["owner", "session", "project"] as const);
export type ScopeAxis = (typeof SCOPE_AXES)[number];

/** A page's or a request's normalized composite scope; null = axis absent. */
export interface CompositeScope {
  readonly owner: string | null;
  readonly session: string | null;
  readonly project: string | null;
}

/**
 * Normalize a session/project axis value into a slug, or null when blank
 * or separator-only. Tolerant by design (frontmatter is untrusted input):
 * an unusable value contributes no scope rather than throwing.
 */
function normalizeSlugAxis(value: unknown): string | null {
  return typeof value === "string" ? scopedRuleKey(value) : null;
}

/** The composite scope a page declares in its frontmatter. */
export function scopeFromFrontmatter(
  meta: FrontmatterMap | Record<string, unknown>,
): CompositeScope {
  return Object.freeze({
    owner: pageOwner(meta as FrontmatterMap),
    session: normalizeSlugAxis((meta as Record<string, unknown>)["session"]),
    project: normalizeSlugAxis((meta as Record<string, unknown>)["project"]),
  });
}

/**
 * Normalize a caller-supplied scope filter. Owner uses the agent-scope
 * normalization; session/project use the slug rule. Any axis left undefined
 * or blank resolves to null (no filtering on that axis).
 */
export function normalizeScopeFilter(input: {
  readonly owner?: string;
  readonly session?: string;
  readonly project?: string;
}): CompositeScope {
  return Object.freeze({
    owner: normalizeAgentScope(input.owner),
    session: normalizeSlugAxis(input.session),
    project: normalizeSlugAxis(input.project),
  });
}

/**
 * Canonical dedup-key contribution for a scope. Empty string when every
 * axis is absent, so a scopeless page keys byte-identically to the
 * pre-scope world (additive keying, no destructive migration). Axis labels
 * are folded in so the same slug on different axes never collides.
 */
export function compositeScopeKey(scope: CompositeScope): string {
  const parts: string[] = [];
  for (const axis of SCOPE_AXES) {
    const value = scope[axis];
    if (value !== null) parts.push(`${axis}=${value}`);
  }
  return parts.join("\0");
}

/**
 * Is a page with axis value `pageValue` reachable by a request for
 * `requested` on that axis? A null request does not filter (reaches every
 * page); an unscoped page (null value) is shared and always reachable; a
 * scoped page is reachable only by its own scope. Mirrors the owner-axis
 * opt-in isolation so a request that scopes nothing is byte-identical.
 */
export function scopeAxisReachable(pageValue: string | null, requested: string | null): boolean {
  if (requested === null) return true;
  if (pageValue === null) return true;
  return pageValue === requested;
}

// ----- Source identity for federated RRF / dedup (t_09b7ccea) --------------

/** The identity of a single retrieved result across federated origins. */
export interface ResultIdentity {
  /** Origin label (cross-vault), or null for the single active vault. */
  readonly origin: string | null;
  /** Vault-relative path of the source document. */
  readonly path: string;
  /** Chunk id within its origin's index. */
  readonly chunkId: number;
}

/**
 * Canonical RRF/dedup key carrying source identity. Two results with the
 * same chunk id from different origins map to distinct keys, so federated
 * fusion never collapses them; the same origin + chunk id is one identity.
 */
export function rrfKey(id: ResultIdentity): string {
  return `${id.origin ?? ""}\0${id.path}\0${id.chunkId}`;
}

/**
 * Order-independent, duplicate-collapsing key for the SET of origins a
 * federated query drew from. The query cache scopes by this so a cache row
 * computed over one origin set is never served for a different set.
 */
export function canonicalSourceSetKey(origins: ReadonlyArray<string | null>): string {
  const unique = [...new Set(origins.map((o) => o ?? ""))].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return unique.join("\0");
}
