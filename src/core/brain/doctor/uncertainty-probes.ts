/**
 * What the doctor attempted but cannot claim it verified.
 *
 * These four write into the `uncertain` stream rather than into
 * warnings or errors, and for one shared reason: each names a place
 * where the doctor's own reading of the store may be incomplete. A
 * frontmatter line the scanner dropped, a ledger that no longer hashes
 * to what was written, a root with no identity marker, a lock whose
 * owner cannot be established - none is a defect in the data, and every
 * one of them makes a clean report mean less than it says.
 */

import { existsSync } from "node:fs";

import type { DegradationNotice } from "../../integrity/degradation.ts";
import { listVaultPages } from "../../vault.ts";
import { verifyLineageLedger } from "../lineage/verify.ts";
import { brainDirs } from "../paths.ts";
import { scanStaleLocks } from "../sync-lockfile.ts";
import { vaultMarkerAbsentNotice } from "../vault-identity.ts";
import type { DoctorCheck } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** Site recorded on the notices the doctor's Brain-tree sweep collects. */
const DOCTOR_FRONTMATTER_SITE = "brain.doctor";

/**
 * Sweep every Markdown file under `Brain/` for frontmatter the line
 * scanner could not express, and fold each notice into the doctor's
 * `uncertain` stream.
 *
 * Unit F: reported as UNCERTAINTY, not as a warning or an error: the
 * note is still on disk and still indexes, but the doctor cannot claim
 * it verified every field it declared, because a field it could not read
 * is indistinguishable from a field that is absent. (That ambiguity is
 * exactly what produced the spurious `missing field: tags` errors fixed
 * in 426d06f8.)
 *
 * One walk, through the same shared helper every other converted site
 * uses ({@link listVaultPages} with its opt-in notice sink), so there is
 * no second definition of "what counts as a dropped line".
 *
 * Unlike an index run - which reads only the files whose mtime or size
 * moved - this sweep is unconditional, which is what makes the doctor
 * the complete view of the condition.
 */
export const frontmatterUncertaintyProbe: DoctorCheck = {
  failSoft: true,
  run({ vault }, { uncertain }) {
    const dirs = brainDirs(vault);
    if (!existsSync(dirs.brain)) return;
    const notices: DegradationNotice[] = [];
    listVaultPages(dirs.brain, { notices, site: DOCTOR_FRONTMATTER_SITE });
    for (const notice of notices) {
      // Through the shared stream, not straight onto the array: this
      // walk covers the same Brain/ subtrees the hand-written sweeps do,
      // so an unreadable directory is observed here AND by each of them.
      pushUncertain(uncertain, {
        code: notice.code,
        ...(notice.path !== undefined ? { path: notice.path } : {}),
        message: notice.detail,
      });
    }
  },
};

/**
 * Fold every session-lineage ledger finding into the doctor's
 * `uncertain` stream: a line edited after it was written, a line removed
 * from the middle, or an observation the writer could not append.
 *
 * Unit D: uncertainty rather than an error because continuity still
 * resolves from this ledger, but the doctor cannot claim the history it
 * read is the history that was written. The verifier is read-only and
 * never throws, so this needs no guard of its own beyond the pass's
 * blanket one.
 */
export const lineageLedgerProbe: DoctorCheck = {
  failSoft: true,
  run({ vault }, { uncertain }) {
    const report = verifyLineageLedger(vault);
    for (const notice of report.notices) {
      pushUncertain(uncertain, {
        code: notice.code,
        path: notice.path ?? report.path,
        message: notice.detail,
      });
    }
  },
};

/**
 * Report a resolved root that carries no vault identity marker.
 *
 * Unit J: an absent marker cannot tell an old vault from a wrong one, so
 * it is uncertainty rather than a warning - but it is the exact shape a
 * mis-resolved root takes, and the doctor reporting such a root clean is
 * what let one pass the single command an operator runs to check the
 * store.
 *
 * The producer is pure, throws nothing, and treats a corrupt marker as
 * absent - the same collapse `readVaultIdentity` performs, because a
 * truncated sync must not be reported as a wrong vault.
 */
export const vaultMarkerProbe: DoctorCheck = {
  failSoft: true,
  run({ vault }, { uncertain }) {
    const notice = vaultMarkerAbsentNotice(vault);
    if (notice === null) return;
    pushUncertain(uncertain, {
      code: notice.code,
      ...(notice.path !== undefined ? { path: notice.path } : {}),
      message: notice.detail,
    });
  },
};

/** Code for a `.lock` file the doctor found in one of OSB's vault directories. */
const STALE_LOCK_CODE = "stale-lock";

/**
 * Report every `.lock` file in the directories OSB writes into the vault.
 *
 * The scan takes the VAULT and enumerates its own roots
 * ({@link scanStaleLocks}). This probe used to pass `brainDirs(vault).brain`
 * and so walked `Brain/` alone, which silently missed the content manifest
 * and the ingest checkpoint in `.open-second-brain/` - the two locks a
 * crashed parallel ingest is most likely to leave behind, and the ones the
 * retry docblock points an operator here to find.
 *
 * Deliberately NOT age-filtered and deliberately not removed. The lock
 * primitive is a single-attempt exclusive create with no breaker, by
 * design: no timeout can distinguish a crashed writer from a slow live
 * one, and killing a live writer's lock corrupts what it protects. So
 * this reports the condition and leaves the judgment to the operator -
 * which is the whole reason a lock a crash left behind must be nameable
 * at all. A lock held by a healthy concurrent writer shows up here too,
 * and is uncertainty rather than a warning for exactly that reason.
 */
export const staleLockProbe: DoctorCheck = {
  failSoft: true,
  run({ vault }, { uncertain }) {
    for (const lockPath of scanStaleLocks(vault)) {
      pushUncertain(uncertain, {
        code: STALE_LOCK_CODE,
        path: lockPath,
        message:
          "a writer lock is present; while it is held every write it guards is refused. " +
          "If no process owns it (a crash leaves one behind) remove the file by hand - " +
          "nothing breaks it automatically, because a live writer cannot be told from a dead one",
      });
    }
  },
};
