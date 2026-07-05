/**
 * Epistemic provenance markers (ACM - Artifact-Constrained Metacognition).
 *
 * Every item placed into a model's context should say how grounded it is, so
 * the consuming model can tell a source-backed fact from a conjecture and stop
 * treating both as equally true. This module owns the fixed status vocabulary
 * and the deterministic derivation of a status from a page's existing
 * frontmatter - no manual tagging required.
 *
 * The five statuses, most-grounded first:
 *   - `observed`   - an operator-stated, evidence-backed fact.
 *   - `derived`    - inferred/deduced from cited premises (a derived fact).
 *   - `hypothesis` - a conjecture on trial (unconfirmed / quarantined).
 *   - `plan`       - intended, not-yet-true (explicit tag only).
 *   - `unknown`    - an acknowledged gap or contested/disputed page.
 *
 * Each marker carries `evidenceRefs`: the page's `evidenced_by` wikilinks
 * (origin signals for a stated rule, premise facts for a derived one), so the
 * consumer can follow the grounding.
 *
 * Derivation reuses the existing graph metadata (provenance trust level,
 * preference status, lifecycle) rather than a new hand-maintained field. A
 * page MAY still override the result with an explicit `epistemic:` frontmatter
 * value - the only path that can yield `plan`, which no automatic signal maps
 * to. This mirrors provenance.ts: the primitive owns the vocabulary and the
 * mapping, never a specific record's frontmatter schema.
 *
 * Language-agnostic: the status is a fixed structural token set, never derived
 * from natural-language vocabulary.
 */

import { asProvenanceLevel } from "./provenance.ts";
import { readLifecycle, PAGE_LIFECYCLE } from "../page-meta/lifecycle.ts";

/** Epistemic grounding of a context item, most-grounded first. */
export const EPISTEMIC_STATUS = Object.freeze({
  observed: "observed",
  derived: "derived",
  hypothesis: "hypothesis",
  plan: "plan",
  unknown: "unknown",
} as const);

export type EpistemicStatus = (typeof EPISTEMIC_STATUS)[keyof typeof EPISTEMIC_STATUS];

const ALL: ReadonlySet<string> = new Set(Object.values(EPISTEMIC_STATUS));

/**
 * Narrow an arbitrary value to an {@link EpistemicStatus}, or null when it is
 * not one. Case- and whitespace-insensitive, so an explicit `epistemic:`
 * frontmatter value round-trips without an `as` cast.
 */
export function asEpistemicStatus(value: unknown): EpistemicStatus | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return ALL.has(token) ? (token as EpistemicStatus) : null;
}

/** An epistemic marker: the status plus the evidence links that ground it. */
export interface EpistemicMarker {
  readonly status: EpistemicStatus;
  /** `evidenced_by` wikilinks - origin signals or premise facts. */
  readonly evidenceRefs: readonly string[];
}

/**
 * Read `evidenced_by` into a clean string list. Accepts an array (the normal
 * shape) or a lone string, drops blanks, and trims incidental whitespace so a
 * marker's refs are stable regardless of how the frontmatter serialized them.
 *
 * Reads the derived `_evidenced_by` key or its `normalizeDerivedKeys`-renamed
 * `evidenced_by` form, so it works on both raw and normalized frontmatter -
 * the same dual-read the `_lifecycle`/`lifecycle` readers use.
 */
export function readEvidenceRefs(meta: Readonly<Record<string, unknown>>): string[] {
  const raw = meta["_evidenced_by"] ?? meta["evidenced_by"];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Derive an {@link EpistemicMarker} from a page's frontmatter.
 *
 * Precedence:
 *   1. an explicit, valid `epistemic:` value always wins (the only `plan` path);
 *   2. a `disputed` lifecycle is `unknown` (its truth is contested);
 *   3. a `deduced`/`inferred` provenance level is `derived`;
 *   4. otherwise (a `stated`/absent level) an `unconfirmed`/`quarantine`
 *      preference status is `hypothesis`, and anything else is `observed`.
 *
 * The evidence refs are the page's `evidenced_by` links regardless of status.
 */
export function deriveEpistemicStatus(meta: Readonly<Record<string, unknown>>): EpistemicMarker {
  const evidenceRefs = readEvidenceRefs(meta);

  const explicit = asEpistemicStatus(meta["epistemic"]);
  if (explicit !== null) return { status: explicit, evidenceRefs };

  if (readLifecycle(meta) === PAGE_LIFECYCLE.disputed) {
    return { status: EPISTEMIC_STATUS.unknown, evidenceRefs };
  }

  const level = asProvenanceLevel(meta["provenance"]) ?? "stated";
  if (level === "deduced" || level === "inferred") {
    return { status: EPISTEMIC_STATUS.derived, evidenceRefs };
  }

  const statusRaw = meta["_status"] ?? meta["status"];
  const status = typeof statusRaw === "string" ? statusRaw.trim() : "";
  if (status === "unconfirmed" || status === "quarantine") {
    return { status: EPISTEMIC_STATUS.hypothesis, evidenceRefs };
  }
  return { status: EPISTEMIC_STATUS.observed, evidenceRefs };
}
