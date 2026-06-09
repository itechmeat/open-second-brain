/**
 * Assertion-to-claim structuring (t_cbd22536 + t_220c313e): the
 * explicit bridge between atomic assertions and the claim ledger.
 * Only assertions matching a structured fact family ingest - aspects
 * are never guessed from arbitrary prose. The capture hot path stays
 * untouched; callers invoke this through the `facts decompose
 * --ingest` verb or the MCP ingest op.
 */

import type { AtomicAssertion } from "../atomic-facts.ts";
import { extractFacts, parseQuantityFact } from "../fact-extract.ts";
import { normalizeClaimValue } from "./fold.ts";
import type { AppendClaimInput } from "./store.ts";

/** Cap on the derived aspect length. */
const MAX_ASPECT_CHARS = 120;

export interface AssertionClaimInput {
  /** Entity the claims are about (explicit, never guessed). */
  readonly entity: string;
  readonly agent: string;
  /** Canonical ISO-8601 UTC timestamp for the claim events. */
  readonly ts: string;
  /** Provenance wikilink or path for every derived claim. */
  readonly source: string;
}

interface FamilyStructurer {
  readonly re: RegExp;
  readonly aspect: string;
  /** Capture group index holding the value. */
  readonly group: number;
}

// Deterministic value structurers for the structural fact families.
// Each regex is language-neutral (a bare e-mail / URL shape) - no
// human-language trigger words. The English-framed structurers (name,
// "called", "based in") and the "my X is Y" possession regex were
// removed in t_80cbefa1; we cannot enumerate the world's languages.
const STRUCTURERS: ReadonlyArray<FamilyStructurer> = Object.freeze([
  { re: /\b([\w.+-]+@[\w.-]+\.\w{2,})\b/u, aspect: "email", group: 1 },
  { re: /\b(https?:\/\/[^\s)>\]]+)/u, aspect: "website", group: 1 },
]);

/**
 * Derive claim inputs from one assertion's facts. Quantity facts use
 * the normalized assertion text as the aspect, so re-ingesting the
 * same sentence folds idempotently into one slot while distinct
 * measurements stay separate slots that aggregation can sum.
 */
export function claimsFromAssertion(
  assertion: Pick<AtomicAssertion, "text">,
  input: AssertionClaimInput,
): AppendClaimInput[] {
  const out: AppendClaimInput[] = [];
  const facts = extractFacts(assertion.text);
  for (const fact of facts) {
    if (fact.family === "quantity") {
      const quantity = parseQuantityFact(fact.text);
      if (quantity === null) continue;
      out.push({
        ts: input.ts,
        agent: input.agent,
        entity: input.entity,
        aspect: normalizeClaimValue(fact.text).slice(0, MAX_ASPECT_CHARS),
        value: String(quantity.value),
        valueKind: "quantity",
        // `action` is no longer derived: it used to be an English verb
        // ("spent", "ran", ...). Quantities now aggregate by unit. The
        // ledger column stays nullable for back-compat and a future
        // explicit-label source.
        quantity: { value: quantity.value, unit: quantity.unit, action: null },
        source: input.source,
      });
      continue;
    }
    for (const s of STRUCTURERS) {
      const m = s.re.exec(fact.text);
      if (m === null) continue;
      out.push({
        ts: input.ts,
        agent: input.agent,
        entity: input.entity,
        aspect: s.aspect,
        value: m[s.group]!.trim(),
        source: input.source,
      });
      break;
    }
  }
  return out;
}
