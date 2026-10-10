/**
 * Is the permissions document readable?
 *
 * Absent raises nothing: no document is the default posture and every
 * gate proceeding as before is the CORRECT reading of a file the operator
 * never wrote. Present but unreadable is the opposite - a trust policy
 * that exists and is not in force, with every gate failing closed until
 * it is repaired. That asymmetry is the whole reason the loader refuses
 * instead of degrading, and this check is what makes the refusal visible
 * on the one surface an operator runs to find out what is wrong.
 *
 * The message carries the loader's field-named error verbatim: the
 * repair is an edit to the YAML at the field it names, and `show` re-
 * derives the same error after each edit - which is exactly why the
 * registered exit is `o2b brain permissions show`.
 */

import { join } from "node:path";

import {
  loadPermissionsDocument,
  PERMISSIONS_DOCUMENT_REL,
  PermissionsDocumentError,
} from "../permissions/document.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

export const PERMISSIONS_UNREADABLE_CODE = "permissions-unreadable";

export const permissionsDocumentCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    try {
      loadPermissionsDocument(ctx.vault);
    } catch (err) {
      // A non-document failure is not this check's finding; the pass's
      // fail-soft wrapper records those its own way.
      if (!(err instanceof PermissionsDocumentError)) throw err;
      out.issues.push({
        severity: "error",
        code: PERMISSIONS_UNREADABLE_CODE,
        path: join(ctx.vault, ...PERMISSIONS_DOCUMENT_REL.split("/")),
        message:
          `Brain/_permissions.yaml could not be read, so its policy is not in force and ` +
          `every gate fails closed until it is repaired (${err.message})`,
      } satisfies DoctorIssue);
    }
  },
};
