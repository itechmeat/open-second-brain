/**
 * Structural prompt-prefix stability (Hindsight brain-loop ops,
 * t_d8c1f7d9).
 *
 * Upstream Hindsight ships provider prompt-prefix caching for its
 * retain / consolidate / reflect operations - it caches the common
 * leading bytes across the repeated LLM calls those operations make.
 * Open Second Brain cannot port that verbatim: the kernel never calls
 * an LLM, the calling agent owns all generation. So there is no
 * outbound request for the kernel to attach a provider cache hint to.
 *
 * What the kernel CAN own is the other half of the contract a provider
 * prefix cache rewards: a byte-stable prompt prefix across the repeated
 * generation handoffs a single brain operation hands the agent (the
 * persona + synthesis steps of a decision panel, a context-pack
 * consume). `deterministicPrefix` makes that prefix explicit and
 * measurable; `summarizePrefixPass` reduces a pass of handoffs to the
 * run-level shape the `prompt_prefix` metric records.
 *
 * Honest scope: this measures prefix STABILITY (structural - whether
 * the kernel handed byte-identical prefixes across a pass), NOT the
 * provider's cache-hit rate, which the kernel never observes. The
 * metric is opt-in and fail-soft, exactly like every other surface in
 * `metrics.ts`; with the gate off no record is written and the pass
 * output is byte-identical to today.
 */

import { createHash } from "node:crypto";

import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendMetric } from "./metrics.ts";
import { type GenerationHandoffKind } from "./generation-reports.ts";

/** Metric surface name for the run-level prefix-stability record. */
export const PROMPT_PREFIX_SURFACE = "prompt_prefix";

export interface PrefixInput {
  /** Which generation handoff this prefix primes. */
  readonly kind: GenerationHandoffKind;
  /**
   * Ordered, stable text segments forming the cacheable preamble. The
   * determinism contract: every segment must be stable for identical
   * inputs - no `Date.now`, no random, no per-call-varying value. When
   * a segment is derived from a record, build it with `canonicalSegment`
   * so key order never perturbs the bytes.
   */
  readonly segments: ReadonlyArray<string>;
}

export interface PromptPrefix {
  readonly kind: GenerationHandoffKind;
  /** The exact stable preamble bytes the caller prepends to its prompt. */
  readonly prefix: string;
  /** Full sha-256 hex of `prefix`. */
  readonly hash: string;
  /** Code-point count of `prefix`. */
  readonly chars: number;
}

/**
 * Render a record of fields into a single stable segment: keys are
 * sorted so the same field set yields byte-identical bytes regardless
 * of insertion order. Values must themselves be stable.
 */
export function canonicalSegment(fields: Readonly<Record<string, string>>): string {
  return Object.keys(fields)
    .toSorted()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
}

/**
 * Certify a stable prompt prefix: the joined segment bytes plus their
 * sha-256 hash and code-point length. Pure and deterministic - identical
 * inputs always return byte-identical `prefix` and `hash`.
 */
export function deterministicPrefix(input: PrefixInput): PromptPrefix {
  const prefix = input.segments.join("");
  return Object.freeze({
    kind: input.kind,
    prefix,
    hash: createHash("sha256").update(prefix, "utf8").digest("hex"),
    chars: [...prefix].length,
  });
}

/** True when two prefixes are interchangeable: same handoff kind, same hash. */
export function isStable(current: PromptPrefix, prior: PromptPrefix): boolean {
  return current.kind === prior.kind && current.hash === prior.hash;
}

export interface PromptPrefixPass {
  readonly kind: GenerationHandoffKind;
  /** One prefix per generation call in the pass, in call order. */
  readonly prefixes: ReadonlyArray<PromptPrefix>;
}

export interface PromptPrefixSummary {
  readonly kind: GenerationHandoffKind;
  /** Hash of the pass's head prefix (the cacheable candidate); "" for an empty pass. */
  readonly prefix_hash: string;
  readonly prefix_chars: number;
  readonly call_count: number;
  /** How many calls reused the head prefix's bytes (the cache-eligible count). */
  readonly stable_count: number;
}

/**
 * Reduce a pass of generation handoffs to its run-level prefix-stability
 * shape. `stable_count` counts the calls whose prefix matches the head
 * call's - the bytes a provider prefix cache could reuse across the
 * pass. An empty pass reports zeros and an empty hash.
 */
export function summarizePrefixPass(pass: PromptPrefixPass): PromptPrefixSummary {
  const calls = pass.prefixes;
  const head = calls[0];
  return Object.freeze({
    kind: pass.kind,
    prefix_hash: head ? head.hash : "",
    prefix_chars: head ? head.chars : 0,
    call_count: calls.length,
    stable_count: head ? calls.filter((p) => isStable(p, head)).length : 0,
  });
}

/**
 * Append one run-level `prompt_prefix` metric record, gated and
 * fail-soft. With the gate off (`false | null | undefined`) nothing is
 * built or written; a throwing append never fails the primary operation.
 */
export function emitPromptPrefixMetric<G>(
  vault: string,
  input: { readonly runAt: string; readonly summary: PromptPrefixSummary },
  gate: G | false | null | undefined,
): void {
  emitGatedTelemetry(gate, () => {
    appendMetric(vault, {
      surface: PROMPT_PREFIX_SURFACE,
      runAt: input.runAt,
      payload: {
        kind: input.summary.kind,
        prefix_hash: input.summary.prefix_hash,
        prefix_chars: input.summary.prefix_chars,
        call_count: input.summary.call_count,
        stable_count: input.summary.stable_count,
      },
    });
  });
}
