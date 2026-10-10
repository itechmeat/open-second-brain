/**
 * Is the permissions document readable, and does it leave this machine's
 * agent a write?
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
 *
 * A readable document gets one more question, the design's foot-gun note
 * on `default_action: deny`: does the document deny the LOCALLY
 * configured agent the write action? The policy is in force and may be
 * working exactly as written - a deliberately read-only agent - but the
 * one-agent document that denies everything else by construction lands
 * here too, and `show`'s dry-run decision table is where the operator
 * sees which of the two it is before the first refusal tells them.
 * The resolution is the gate's own: the same subject the write
 * disposition falls back to (`via: "config"`), the blanket (target-less)
 * `write` action, the same precedence table - so the finding fires only
 * when a real write from this machine would actually be refused.
 */

import { join } from "node:path";

import { resolveAgentName } from "../../config.ts";
import {
  loadPermissionsDocument,
  PERMISSIONS_DOCUMENT_REL,
  PermissionsDocumentError,
  type PermissionsDocument,
} from "../permissions/document.ts";
import { resolvePermission } from "../permissions/resolve.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

export const PERMISSIONS_UNREADABLE_CODE = "permissions-unreadable";

/** A readable document that denies the locally configured agent's write. */
export const PERMISSIONS_AGENT_DENIED_CODE = "permissions-agent-denied";

export const permissionsDocumentCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let document: PermissionsDocument;
    try {
      const loaded = loadPermissionsDocument(ctx.vault);
      if (loaded.document === null) return;
      document = loaded.document;
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
      return;
    }
    // The gate's own default subject, resolved the way the runtime resolves
    // it: an explicitly-invoked config path decides, otherwise the same
    // default discovery the write lanes fall back to.
    const agent = resolveAgentName(ctx.configPath);
    const decision = resolvePermission(document, { agent, via: "config" }, "write");
    if (decision.verdict !== "deny") return;
    out.issues.push({
      severity: "warning",
      code: PERMISSIONS_AGENT_DENIED_CODE,
      path: join(ctx.vault, ...PERMISSIONS_DOCUMENT_REL.split("/")),
      message:
        `Brain/_permissions.yaml denies the locally configured agent ${JSON.stringify(agent)} ` +
        `the write action (rule ${decision.source}), so every write this agent attempts is ` +
        `refused while the document stands. Deliberate for a read-only agent; a surprise if ` +
        `not. Review the effective decisions: o2b brain permissions show`,
    } satisfies DoctorIssue);
  },
};
