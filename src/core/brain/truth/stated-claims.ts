/**
 * Grounded agent-stated claim core (truth-correctable-time-aware,
 * task 4): the bridge from an agent's stated claims
 * (`{ subject, relation, object }` plus the assertion `text` they came
 * from) into claim-ledger events.
 *
 * Two boundaries govern the path, with different strictness:
 *
 *   - The payload boundary refuses WHOLE calls: an unknown relation
 *     (validated against the single relation vocabulary), missing text,
 *     missing source, an empty agent or a malformed ts throws
 *     {@link StatedClaimsRefusal} before anything is written.
 *   - The anchoring verdict is PER CLAIM, using the one occurrence
 *     kernel {@link anchorEntityForms} (quality-gated normalized match
 *     forms, minimum length 3): a claim whose subject and object both
 *     anchor in the text commits with `extractor: "agent_stated"`; an
 *     ungrounded claim is reported back with machine reason codes.
 *     Per-claim partial commit is safe here because each event is an
 *     independent append in an append-only ledger and the outcome
 *     reports exactly what landed.
 *
 * The extractor tag is annotation only: conflict detection reads the
 * ledger exactly as before and the tag never re-ranks or resolves a
 * conflict. Naming deliberately avoids "grounding", which is taken by
 * the source-diversity score in `truth/grounding.ts` - verdicts here
 * speak of anchoring.
 */

import { isKnownRelation, normalizeRelation } from "../../graph/relation-vocab.ts";
import { anchorEntityForms, type AtomicEntityLike } from "../atomic-facts.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import type { AppendClaimInput, AppendClaimResult } from "./store.ts";
import { appendClaimEvent, ISO_UTC_TS_RE } from "./store.ts";
import type { ClaimExtractor } from "./types.ts";

/** How this release tags agent-stated claims. */
const AGENT_STATED: ClaimExtractor = "agent_stated";

/** One stated claim: subject, typed relation, object. */
export interface StatedClaim {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
}

/** The payload the agent states, anchored by one shared assertion text. */
export interface StatedClaimsPayload {
  readonly claims: ReadonlyArray<StatedClaim>;
  /** The assertion text every claim must anchor in. */
  readonly text: string;
  readonly agent: string;
  /** Canonical ISO-8601 UTC timestamp for the committed events. */
  readonly ts: string;
  /** Provenance wikilink or vault-relative path. */
  readonly source: string;
}

export interface StatedClaimsOptions {
  /**
   * Registry entities whose aliases extend the anchoring forms: an
   * entity whose canonical name normalizes equal to a claim's subject
   * or object contributes its full alias pool to that side.
   */
  readonly entities?: ReadonlyArray<AtomicEntityLike>;
  readonly configPath?: string;
  /**
   * The caller's reach gate over the payload's source page (see
   * `AppendClaimOptions.readableSource`): a source the caller cannot
   * read resolves no frontmatter window, exactly like an absent one.
   * Absent at operator reach.
   */
  readonly readableSource?: (rel: string) => boolean;
}

/** Machine-readable reason codes for an ungrounded claim. */
export type StatedClaimRefusalReason =
  | "missing_subject"
  | "missing_object"
  | "subject_unanchored"
  | "object_unanchored";

/** A claim that was reported back instead of committed. */
export interface UngroundedStatedClaim {
  readonly claim: StatedClaim;
  readonly reasons: ReadonlyArray<StatedClaimRefusalReason>;
}

export interface StatedClaimsOutcome {
  /** What landed, in payload order. */
  readonly committed: ReadonlyArray<AppendClaimResult>;
  /** What was reported back, in payload order. */
  readonly ungrounded: ReadonlyArray<UngroundedStatedClaim>;
}

/** The payload boundary's typed refusal. Nothing has been written. */
export class StatedClaimsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatedClaimsRefusal";
  }
}

/**
 * The anchoring forms for one claimed side: the stated value itself,
 * plus the alias pool of a registry entity whose canonical name
 * normalizes equal to it.
 */
function statedAnchorForms(
  value: string,
  entities: ReadonlyArray<AtomicEntityLike>,
): ReadonlyArray<string> {
  const normalized = normalizeEntityName(value);
  for (const entity of entities) {
    if (normalizeEntityName(entity.name) === normalized) {
      return [value, ...entity.aliases];
    }
  }
  return [value];
}

/** Per-claim anchoring verdict: why the claim cannot commit, if it cannot. */
function ungroundedReasons(
  claim: StatedClaim,
  text: string,
  entities: ReadonlyArray<AtomicEntityLike>,
): ReadonlyArray<StatedClaimRefusalReason> {
  const reasons: StatedClaimRefusalReason[] = [];
  if (normalizeEntityName(claim.subject) === "") {
    reasons.push("missing_subject");
  } else if (anchorEntityForms(text, statedAnchorForms(claim.subject, entities)).length === 0) {
    reasons.push("subject_unanchored");
  }
  if (claim.object.trim() === "") {
    reasons.push("missing_object");
  } else if (anchorEntityForms(text, statedAnchorForms(claim.object, entities)).length === 0) {
    reasons.push("object_unanchored");
  }
  return reasons;
}

/**
 * Validate the payload boundary, commit the grounded claims as ledger
 * events, and report the ungrounded ones back. Refused payloads write
 * nothing; anchoring verdicts are per claim. The outcome reports
 * exactly what landed, in payload order on both sides.
 */
export function appendStatedClaims(
  vault: string,
  payload: StatedClaimsPayload,
  opts: StatedClaimsOptions = {},
): StatedClaimsOutcome {
  const source = payload.source.trim();
  if (source === "") {
    throw new StatedClaimsRefusal("stated claims: source is required");
  }
  if (payload.text.trim() === "") {
    throw new StatedClaimsRefusal("stated claims: text is required");
  }
  for (const claim of payload.claims) {
    if (!isKnownRelation(claim.relation)) {
      throw new StatedClaimsRefusal(
        `stated claims: unknown relation: ${JSON.stringify(claim.relation)}`,
      );
    }
  }
  // The whole-call promise covers every field the committed events
  // carry: an empty agent or a malformed ts must refuse HERE, through
  // the typed refusal channel, before the first write - not surface
  // mid-loop as the store's plain error outside the documented refusal
  // channel.
  if (payload.agent.trim() === "") {
    throw new StatedClaimsRefusal("stated claims: agent is required");
  }
  if (!ISO_UTC_TS_RE.test(payload.ts)) {
    throw new StatedClaimsRefusal(
      `stated claims: ts must be canonical ISO-8601 UTC: ${JSON.stringify(payload.ts)}`,
    );
  }

  const entities = opts.entities ?? [];
  const committed: AppendClaimResult[] = [];
  const ungrounded: UngroundedStatedClaim[] = [];
  for (const claim of payload.claims) {
    const reasons = ungroundedReasons(claim, payload.text, entities);
    if (reasons.length > 0) {
      ungrounded.push(Object.freeze({ claim, reasons: Object.freeze(reasons) }));
      continue;
    }
    const input: AppendClaimInput = {
      ts: payload.ts,
      agent: payload.agent,
      entity: normalizeEntityName(claim.subject),
      aspect: normalizeRelation(claim.relation),
      value: claim.object.trim(),
      extractor: AGENT_STATED,
      source,
    };
    committed.push(
      appendClaimEvent(vault, input, {
        configPath: opts.configPath,
        ...(opts.readableSource !== undefined ? { readableSource: opts.readableSource } : {}),
      }),
    );
  }
  return Object.freeze({
    committed: Object.freeze(committed),
    ungrounded: Object.freeze(ungrounded),
  });
}
