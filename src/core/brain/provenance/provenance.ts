/**
 * Provenance / citation primitive (shared lib b of the Knowledge Provenance
 * suite).
 *
 * A piece of knowledge in the brain should carry its origin. Three
 * generation-bearing features stamp their output through this one module so
 * the representation is uniform and tested in a single place:
 *   - the source-ingest pipeline (a page built from a source document),
 *   - the research pipeline (a report whose findings cite their sources),
 *   - derived-fact synthesis (a fact inferred from premise facts).
 *
 * What this module owns:
 *   - {@link ProvenanceLevel} - the trust band (stated > deduced > inferred),
 *   - {@link asProvenanceLevel} - a narrowing guard (no `as` cast) so a level
 *     read from frontmatter is validated, not assumed,
 *   - {@link provenanceTrustRank} - the ordering recall uses to trust an
 *     operator-stated rule above a machine-inferred one,
 *   - {@link renderProvenanceSection} - the canonical `## Sources` /
 *     `## Premises` body markdown,
 *   - {@link sourceIdentityHash} - a deterministic identity hash for
 *     idempotent dedup of an ingested source.
 *
 * What it deliberately does NOT own: any page's frontmatter schema. A
 * preference, an entity page, and a report each serialize the level into
 * their own frontmatter and parse it back through {@link asProvenanceLevel}.
 * Keeping the primitive decoupled from a specific record shape is what lets
 * all three features share it (single responsibility).
 *
 * Language-agnostic: the level is a fixed structural token set, never derived
 * from natural-language vocabulary.
 */

import { createHash } from "node:crypto";

/**
 * Trust band of a piece of knowledge, ordered most-trusted first:
 *   - `stated`   - asserted by the operator (or promoted from operator signals),
 *   - `deduced`  - a logically-entailed conclusion from stated premises,
 *   - `inferred` - a machine-generalized pattern, the least authoritative.
 */
export type ProvenanceLevel = "stated" | "deduced" | "inferred";

/** Every level exactly once, most-trusted first. The trust rank is the index. */
export const PROVENANCE_LEVELS: readonly ProvenanceLevel[] = Object.freeze([
  "stated",
  "deduced",
  "inferred",
]);

/**
 * Narrow an arbitrary value to a {@link ProvenanceLevel}, or null when it is
 * not one. Case- and whitespace-insensitive. Returns null for non-strings so
 * a frontmatter read never needs an `as` cast to satisfy the type.
 */
export function asProvenanceLevel(value: unknown): ProvenanceLevel | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  for (const level of PROVENANCE_LEVELS) {
    if (level === token) return level;
  }
  return null;
}

/**
 * Trust rank: the position of the level in {@link PROVENANCE_LEVELS}. Lower is
 * more trusted (`stated` = 0). Recall sorts ascending by this rank so that an
 * operator-stated rule outranks a machine-inferred one.
 */
export function provenanceTrustRank(level: ProvenanceLevel): number {
  return PROVENANCE_LEVELS.indexOf(level);
}

/** Provenance stamped onto a generated page or fact. */
export interface Provenance {
  /** Trust band of the knowledge this provenance describes. */
  readonly level: ProvenanceLevel;
  /** Wikilinks to the external source artifacts the knowledge was built from. */
  readonly sources: readonly string[];
  /** Wikilinks to the premise facts a derived fact was inferred from. */
  readonly premises: readonly string[];
}

const HASH_SEPARATOR = "\n";

/**
 * Deterministic identity hash of an ingested source, for idempotent dedup.
 * The parts (e.g. a source path plus a part identifier) are trimmed and
 * newline-joined before hashing, so the same logical source always yields the
 * same 64-char lowercase hex digest regardless of incidental whitespace.
 */
export function sourceIdentityHash(parts: readonly string[]): string {
  const payload = parts.map((p) => p.trim()).join(HASH_SEPARATOR);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Render one `## Heading\n\n- bullet` markdown block; caller order preserved. */
function renderBullets(heading: string, items: readonly string[]): string {
  return [`## ${heading}`, "", ...items.map((item) => `- ${item}`)].join("\n");
}

/**
 * Render the canonical provenance body markdown: a `## Sources` section
 * (external artifacts) followed by a `## Premises (<level>)` section (premise
 * facts), each omitted when empty. Returns the empty string when there is
 * nothing to cite. Caller ordering is preserved - no implicit sort - so the
 * output is deterministic and idempotent on identical input.
 */
export function renderProvenanceSection(prov: Provenance): string {
  const blocks: string[] = [];
  if (prov.sources.length > 0) {
    blocks.push(renderBullets("Sources", prov.sources));
  }
  if (prov.premises.length > 0) {
    blocks.push(renderBullets(`Premises (${prov.level})`, prov.premises));
  }
  return blocks.join("\n\n");
}
