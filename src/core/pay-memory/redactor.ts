/**
 * Pay Memory redactor — thin re-export of the shared `src/core/redactor.ts`.
 *
 * The implementation lives in `src/core/redactor.ts` so the Brain
 * writers (`writeSignal`, `appendApplyEvidence`) can share the same
 * secret-key list and assignment shapes without depending on the Pay
 * Memory subtree. This file remains as the import path Pay Memory
 * code historically used; new callers should import from
 * `src/core/redactor.ts` directly.
 */

export {
  MAX_REDACTOR_INPUT,
  SECRET_KEYS,
  redactRawOutput,
} from "../redactor.ts";
