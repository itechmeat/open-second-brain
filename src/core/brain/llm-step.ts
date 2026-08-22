/**
 * The needs-llm-step envelope spine (salience-lifecycle-enrichment, unit 0).
 *
 * OSB never calls an LLM. Every lane that needs generated text hands the
 * calling agent one envelope describing exactly what to write and where it
 * lands, and OSB owns the sequencing, the validation, and the commit. Three
 * lanes already spoke that grammar with three independent declarations of
 * it - the durable write-session envelope, the diarization profile step,
 * the rollup ladder envelope - and a fourth divergence was one new lane
 * away. This module is the one declaration they share.
 *
 * The spine carries ONLY what all three carry: `status`, `step`, `prompt`,
 * `schema_hints`, `target_path`. A field two of them happen to share is not
 * spine - `tier`, `session_id`, `expires_at` and the rest stay on the
 * consumer's own type, which extends this one. Generalizing further would
 * make the spine a union of everybody's needs rather than the contract the
 * receiving agent can rely on.
 *
 * Adoption is additive and type-level. `WriteSessionEnvelope` is the
 * DURABLE superset: it is the only one of the three backed by a session
 * record, and its `status` widens to the whole session-status union, so it
 * shares {@link LlmStepFields} rather than {@link NeedsLlmStep}. It is not
 * rewritten - the session kernel's behavior is untouched by this module.
 */

/** The one status literal this grammar is named for. */
export const NEEDS_LLM_STEP = "needs-llm-step";

/**
 * What the receiving agent needs in order to generate: which step it is
 * answering, the instruction, the constraints the artifact must satisfy,
 * and the vault-relative path the result is destined for.
 */
export interface LlmStepFields {
  /** Step name the caller is answering, e.g. `profile-prose`, `rollup:fact`. */
  readonly step: string;
  /** Generation instruction for this step. */
  readonly prompt: string;
  /** Constraints on the artifact; empty when the step has none to declare. */
  readonly schema_hints: ReadonlyArray<string>;
  /** Vault-relative path the generated artifact is destined for. */
  readonly target_path: string;
}

/** One deferred generation step, awaiting the calling agent's text. */
export interface NeedsLlmStep extends LlmStepFields {
  readonly status: typeof NEEDS_LLM_STEP;
}

/**
 * The spine's key set, in the order {@link buildNeedsLlmStep} emits it.
 * Exported so a consumer can assert over the whole envelope at once rather
 * than field by field.
 */
export const NEEDS_LLM_STEP_KEYS: ReadonlyArray<keyof NeedsLlmStep> = Object.freeze([
  "status",
  "step",
  "prompt",
  "schema_hints",
  "target_path",
] as const);

/** An envelope was built with a field that tells the caller nothing. */
export class LlmStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmStepError";
  }
}

/**
 * Build one envelope. The status literal is stamped here, never by the
 * caller, and the hint list is copied so the envelope cannot change under a
 * reference the caller kept. Extra fields a lane declares on its own type
 * (the rollup's `tier` and `produces`) pass through and keep the position
 * they were written in - these envelopes are serialized across the CLI and
 * MCP boundaries, so their key order is observable.
 *
 * A blank `step`, `prompt`, or `target_path` throws {@link LlmStepError}:
 * an envelope missing any of the three cannot be answered, and it is worth
 * more to the caller as a refusal at the construction site than as an
 * unanswerable request downstream. An empty `schema_hints` is legal - a
 * step can genuinely have no constraint to declare.
 */
export function buildNeedsLlmStep<T extends LlmStepFields>(fields: T): NeedsLlmStep & T {
  requireContent("step", fields.step);
  requireContent("prompt", fields.prompt);
  requireContent("target_path", fields.target_path);
  return Object.freeze({
    status: NEEDS_LLM_STEP,
    ...fields,
    schema_hints: Object.freeze([...fields.schema_hints]),
  });
}

function requireContent(field: keyof LlmStepFields, value: string): void {
  if (value.trim().length === 0) {
    throw new LlmStepError(`needs-llm-step envelope: ${field} must be a non-empty string`);
  }
}
