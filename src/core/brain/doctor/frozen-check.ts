/**
 * Is this vault frozen? (who-wrote-what, Task C)
 *
 * The freeze refuses every content write on every device that syncs the
 * vault, which makes it the condition that explains the widest range of
 * other symptoms: a dream pass that recorded nothing, a note write that
 * came back as an error, an agent that keeps reporting it cannot save.
 * An operator chasing any of those runs the doctor, so the doctor has to
 * say it first.
 *
 * ## A warning, not an error, and never in `uncertain`
 *
 * The three streams mean different things and this finding belongs to
 * exactly one of them. It is not an ERROR: nothing is broken, and an
 * operator asked for this state deliberately. It is not UNCERTAIN: the
 * marker was read and the answer is known. It is a WARNING - a standing
 * condition worth stating every time until it is lifted - and it carries
 * `o2b brain unfreeze` as its exit, so the finding is never a dead end
 * for whoever is reading it, including the operator who set it and has
 * since forgotten.
 *
 * A marker nobody can parse reports here exactly as a well-formed one
 * does, because it freezes the vault exactly as a well-formed one does.
 * The reason field says which it was.
 */

import { readFreezeMarker, FREEZE_NEXT_COMMAND, frozenMarkerPath } from "../freeze-marker.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** The vault carries a freeze marker, so every content write is refused. */
export const VAULT_FROZEN_CODE = "vault-frozen";

export const frozenVaultCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const marker = readFreezeMarker(ctx.vault);
    if (marker === null) return;
    const who = marker.by === "" ? "an unnamed agent" : marker.by;
    const when = marker.frozen_at === "" ? "an unrecorded time" : marker.frozen_at;
    const why = marker.reason === "" ? "no reason given" : marker.reason;
    out.issues.push({
      severity: "warning",
      code: VAULT_FROZEN_CODE,
      path: frozenMarkerPath(ctx.vault),
      message:
        `this vault is frozen: set at ${when} by ${who} (${why}). Every content write is ` +
        "refused here and on every device that syncs this vault; the Brain log keeps " +
        `recording, so the refusals are auditable. Run \`${FREEZE_NEXT_COMMAND}\` to lift it`,
    } satisfies DoctorIssue);
  },
};
