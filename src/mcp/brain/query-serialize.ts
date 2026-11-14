/**
 * The payload shaping of the query family (task 3.19): the delivery
 * wrappers that fence a preference, signal and contribution payload at
 * the caller's reach, the record serializers beneath them, and the
 * source-page resolution a mention names. Split from `query-tools.ts`.
 */

import {
  type BrainPreference,
  type BrainRetired,
  type BrainSignal,
} from "../../core/brain/types.ts";
import type { BrainLogEntry } from "../../core/brain/log.ts";
import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../../core/brain/path-constants.ts";
import type { AgentSourceContribution } from "../../core/brain/agent-source/types.ts";
import { deliveryView, signalDeliveryRel, UNPROBED_DELIVERY_REL } from "./reach-events.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";

/** The page a preference or retired payload was parsed from. */
export function preferenceDeliveryRel(p: BrainPreference | BrainRetired): string {
  return p.kind === "brain-retired"
    ? `${BRAIN_RETIRED_REL}/${p.id}.md`
    : `${BRAIN_PREFERENCES_REL}/${p.id}.md`;
}

/**
 * The page an agent contribution's provenance is probed from, or null
 * when there is none to ask: a `log` row is a log event's own text,
 * which the delivery-shaping boundary deliberately leaves untouched.
 * The signal walk is {@link signalDeliveryRel}, shared with the
 * artifact-id mapping in reach-events.ts so the two faces cannot drift.
 * A note with no page of its own probes the guaranteed-absent page -
 * null means "leave untouched" for log rows only, because a fenced
 * delivery is the fail-closed answer for note text whose provenance
 * nothing can name.
 */
export function contributionDeliveryRel(vault: string, c: AgentSourceContribution): string | null {
  switch (c.kind) {
    case "note":
      return c.path ?? UNPROBED_DELIVERY_REL;
    case "preference":
      return c.id.startsWith("ret-")
        ? `${BRAIN_RETIRED_REL}/${c.id}.md`
        : `${BRAIN_PREFERENCES_REL}/${c.id}.md`;
    case "signal":
      return signalDeliveryRel(vault, c.id);
    default:
      return null;
  }
}

/**
 * Serialize one preference payload with its principle shaped.
 *
 * Delivery boundary (delivery-trust, lane A): `principle` is the payload's
 * stored-record body and fences; a retired payload's `retired_reason` does
 * NOT, because it is not free text - `parseRetired` refuses any value
 * outside the closed `BRAIN_RETIRED_REASON` vocabulary (and every writer
 * passes an enum member), so the field is a machine-readable token, not
 * stored prose, and fencing it would break the closed-vocabulary reading
 * remote consumers do. The free text the retire path actually collects
 * lands in `user_rejected_reason`, which no MCP surface delivers.
 */
export function shapePreferencePayload(
  delivery: ReturnType<typeof deliveryView>,
  p: BrainPreference | BrainRetired,
): Record<string, unknown> {
  const payload = serializePreference(p);
  if (delivery.reach === TRANSPORT_REACH.local) return payload;
  return {
    ...payload,
    principle: delivery.shape(payload.principle as string, preferenceDeliveryRel(p)),
  };
}

/** Serialize one signal payload with its principle and raw body shaped. */
export function shapeSignalPayload(
  delivery: ReturnType<typeof deliveryView>,
  vault: string,
  s: BrainSignal,
): Record<string, unknown> {
  const payload = serializeSignal(s);
  if (delivery.reach === TRANSPORT_REACH.local) return payload;
  const rel = signalDeliveryRel(vault, s.id);
  const shaped: Record<string, unknown> = {
    ...payload,
    principle: delivery.shape(payload.principle as string, rel),
  };
  if (typeof payload.raw === "string") shaped.raw = delivery.shape(payload.raw, rel);
  return shaped;
}

/**
 * Shape one contribution row: its `text` body, and the principle the
 * structured `data` block echoes beside it - the same stored text, so a
 * fenced body with an unfenced copy in `data` would not be a fence.
 * Log rows pass through untouched.
 */
export function shapeContribution(
  delivery: ReturnType<typeof deliveryView>,
  vault: string,
  c: AgentSourceContribution,
): AgentSourceContribution {
  if (delivery.reach === TRANSPORT_REACH.local) return c;
  const rel = contributionDeliveryRel(vault, c);
  if (rel === null) return c;
  const data = { ...c.data };
  if (typeof data["principle"] === "string") {
    data["principle"] = delivery.shape(data["principle"] as string, rel);
  }
  return { ...c, text: delivery.shape(c.text, rel), data };
}

export function serializeSignal(s: BrainSignal): Record<string, unknown> {
  return {
    kind: s.kind,
    id: s.id,
    created_at: s.created_at,
    topic: s.topic,
    signal: s.signal,
    agent: s.agent,
    principle: s.principle,
    tags: [...s.tags],
    ...(s.scope !== undefined ? { scope: s.scope } : {}),
    ...(s.source !== undefined ? { source: [...s.source] } : {}),
    ...(s.raw !== undefined ? { raw: s.raw } : {}),
    ...(s.expiration_date !== undefined ? { expiration_date: s.expiration_date } : {}),
  };
}

export function serializePreference(p: BrainPreference | BrainRetired): Record<string, unknown> {
  if (p.kind === "brain-retired") {
    return {
      kind: p.kind,
      id: p.id,
      status: p.status,
      retired_at: p.retired_at,
      retired_reason: p.retired_reason,
      retired_by: p.retired_by,
      ...(p.superseded_by !== undefined ? { superseded_by: p.superseded_by } : {}),
      created_at: p.created_at,
      topic: p.topic,
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
      principle: p.principle,
      evidenced_by: [...p.evidenced_by],
      applied_count: p.applied_count,
      violated_count: p.violated_count,
      last_evidence_at: p.last_evidence_at,
      confidence: p.confidence,
      confidence_value: p.confidence_value,
      pinned: p.pinned,
      tags: [...p.tags],
      ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
    };
  }
  return {
    kind: p.kind,
    id: p.id,
    created_at: p.created_at,
    confirmed_at: p.confirmed_at,
    unconfirmed_until: p.unconfirmed_until,
    topic: p.topic,
    ...(p.scope !== undefined ? { scope: p.scope } : {}),
    status: p.status,
    principle: p.principle,
    evidenced_by: [...p.evidenced_by],
    applied_count: p.applied_count,
    violated_count: p.violated_count,
    last_evidence_at: p.last_evidence_at,
    confidence: p.confidence,
    confidence_value: p.confidence_value,
    pinned: p.pinned,
    tags: [...p.tags],
    ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
    ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
    ...(p.expiration_date !== undefined ? { expiration_date: p.expiration_date } : {}),
  };
}

export function serializeLogEntry(e: BrainLogEntry): Record<string, unknown> {
  // Preserve the structured payload verbatim (array values stay arrays).
  // JSON.stringify handles `ReadonlyArray<string>` and string values
  // identically. `Object.entries` widens the value type to `unknown` for
  // generic-keyed records under `verbatimModuleSyntax`; narrow explicitly.
  const body: Record<string, string | ReadonlyArray<string>> = {};
  for (const [k, v] of Object.entries(e.body) as ReadonlyArray<
    readonly [string, string | ReadonlyArray<string>]
  >) {
    body[k] = Array.isArray(v) ? [...v] : v;
  }
  return {
    timestamp: e.timestamp,
    event_type: e.eventType,
    body,
  };
}

// ----- Misc ----------------------------------------------------------------
