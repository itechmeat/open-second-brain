/**
 * Derived-fact synthesis with premise provenance (Knowledge Provenance suite).
 *
 * A derived fact is a second-order conclusion ("because A and B, therefore C")
 * the calling agent reasons out from existing premise preferences. OSB is
 * provider-agnostic and runs no model: the agent supplies the conclusion and
 * names its premises; OSB owns the deterministic half - it validates that each
 * premise preference exists, then commits the derived fact as an unconfirmed
 * preference carrying a `deduced`/`inferred` provenance level and premise
 * wikilinks in `evidenced_by`.
 *
 * Recall trusts an operator-stated rule above a machine-derived one; the
 * provenance level is what makes that ordering possible (see
 * provenance/provenance.ts and the recall trust-ordering helper).
 */

import { existsSync } from "node:fs";

import { loadBrainConfig, DEFAULT_BRAIN_CONFIG } from "./policy.ts";
import { preferencePath } from "./paths.ts";
import { writePreference } from "./preference.ts";
import { isoSecond } from "./time.ts";
import { asProvenanceLevel, type ProvenanceLevel } from "./provenance/provenance.ts";

export interface DeriveFactInput {
  readonly slug: string;
  readonly topic: string;
  readonly principle: string;
  /** Premise preference ids (`pref-<slug>` or bare `<slug>`), at least one. */
  readonly premises: readonly string[];
  /** Trust level of the derivation: `deduced` (entailed) or `inferred` (pattern). */
  readonly level: ProvenanceLevel;
}

export interface DeriveFactOptions {
  readonly now: Date;
}

export interface DeriveFactResult {
  readonly id: string;
}

/** A derived-fact request failed validation; nothing was written. */
export class DeriveFactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeriveFactError";
  }
}

/** Strip a leading `pref-` so a premise can be given as an id or a bare slug. */
function premiseSlug(premise: string): string {
  const trimmed = premise.trim();
  return trimmed.startsWith("pref-") ? trimmed.slice("pref-".length) : trimmed;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function unconfirmedWindowDays(vault: string): number {
  try {
    return loadBrainConfig(vault).dream.unconfirmed_window_days;
  } catch {
    return DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days;
  }
}

/**
 * Commit a derived fact. Validates the level is a derivation (not `stated`)
 * and that every premise preference exists, then writes an unconfirmed
 * preference with the provenance level and premise wikilinks. Throws
 * {@link DeriveFactError} with no write on any validation failure.
 */
export function deriveFact(
  vault: string,
  input: DeriveFactInput,
  opts: DeriveFactOptions,
): DeriveFactResult {
  const level = asProvenanceLevel(input.level);
  if (level === null || level === "stated") {
    throw new DeriveFactError(
      `a derived fact must be 'deduced' or 'inferred', not ${JSON.stringify(input.level)}`,
    );
  }
  if (!input.slug.trim()) throw new DeriveFactError("derived fact missing slug");
  if (!input.topic.trim()) throw new DeriveFactError("derived fact missing topic");
  if (!input.principle.trim()) throw new DeriveFactError("derived fact missing principle");
  if (input.premises.length === 0) {
    throw new DeriveFactError("a derived fact must cite at least one premise");
  }

  const evidencedBy: string[] = [];
  for (const premise of input.premises) {
    const slug = premiseSlug(premise);
    if (!slug) throw new DeriveFactError("premise id must not be empty");
    if (!existsSync(preferencePath(vault, slug))) {
      throw new DeriveFactError(`premise preference not found: ${JSON.stringify(premise)}`);
    }
    evidencedBy.push(`[[pref-${slug}]]`);
  }

  const now = opts.now;
  writePreference(vault, {
    slug: input.slug,
    topic: input.topic,
    principle: input.principle,
    created_at: isoSecond(now),
    unconfirmed_until: isoSecond(addDays(now, unconfirmedWindowDays(vault))),
    status: "unconfirmed",
    evidenced_by: evidencedBy,
    provenance: level,
  });

  return { id: `pref-${input.slug.trim()}` };
}
