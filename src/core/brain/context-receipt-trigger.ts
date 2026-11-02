/**
 * The context-receipt trigger vocabulary, as a leaf module.
 *
 * Every emitter, reader and verifier of context receipts spells the
 * trigger names through this union. The module deliberately imports
 * nothing: the receipt verify kernel is reached from the doctor's pass
 * (through the receipt-content drift check), and a vocabulary import that
 * detoured through the emitter, `context-receipts.ts`, closed an
 * initialisation-order ring across page-lint, next-step, diagnostics and
 * the doctor registry. The emitter keeps its export surface by
 * re-exporting these three names, so no importer had to move.
 */

/**
 * What produced the injected context a receipt accounts for.
 *
 * `context_pack` and `pre_compress` are the two pack builders. Unit H of
 * the context-integrity-gates wave adds `session_inject`: the SessionStart
 * eager layer, which until now emitted context that nothing measured. The
 * vocabulary is closed - a reader switching over it can enumerate every
 * injection surface that exists.
 */
export type ContextReceiptTrigger = "context_pack" | "pre_compress" | "session_inject";

export function isContextReceiptTrigger(value: unknown): value is ContextReceiptTrigger {
  return value === "context_pack" || value === "pre_compress" || value === "session_inject";
}

/** Every trigger, in declaration order, for schemas and error messages. */
export const CONTEXT_RECEIPT_TRIGGERS: ReadonlyArray<ContextReceiptTrigger> = Object.freeze([
  "context_pack",
  "pre_compress",
  "session_inject",
]);
