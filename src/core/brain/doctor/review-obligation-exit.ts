/**
 * The code of the doctor finding for review obligations written before the
 * reach rule (`review-obligation-check.ts`), and the reason it has no next
 * command (`doctor-exits.ts`). A leaf module: the exit table imports it
 * without pulling in the check's store reads.
 */

/** Review obligations held in `shared` for a decision held in `private`. */
export const REVIEW_OBLIGATION_SHARED_CODE = "review-obligation-shared";

/** Why no one command moves such an obligation (`DoctorExitExclusion`). */
export const REVIEW_OBLIGATION_SHARED_EXIT: { readonly code: string; readonly reason: string } = {
  code: REVIEW_OBLIGATION_SHARED_CODE,
  reason:
    "whether a review obligation should leave the shared partition is the user's choice, and " +
    "the move is two steps that restart its completion history: remove it and add it again " +
    "locally with its notes in a private region; the finding names the obligations and both steps",
};
