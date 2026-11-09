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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentName } from "../../config.ts";
import { canonicalJson } from "../../integrity/digest.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import {
  loadPermissionsDocumentFor,
  PERMISSIONS_SETTING_LABEL,
  storedPermissionsText,
} from "../permissions/document-source.ts";
import {
  loadPermissionsDocument,
  parsePermissionsDocumentText,
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

/**
 * Whether the gates read the shared setting: it holds an operator value, or
 * its stream cannot be read (the gates then fail closed on the setting, and
 * the document check reports that as unreadable).
 */
function settingInForce(configPath: string | undefined): boolean {
  try {
    return storedPermissionsText(configPath) !== null;
  } catch (err) {
    if (!(err instanceof PermissionsDocumentError)) throw err;
    return true;
  }
}

export const permissionsDocumentCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    // Where the gates read the document on this machine: the shared
    // setting, or the legacy file on an unswitched machine that has none.
    const fromSetting = settingInForce(ctx.configPath);
    const where = fromSetting ? PERMISSIONS_SETTING_LABEL : PERMISSIONS_DOCUMENT_REL;
    const at = fromSetting
      ? PERMISSIONS_SETTING_LABEL
      : join(ctx.vault, ...PERMISSIONS_DOCUMENT_REL.split("/"));
    let document: PermissionsDocument;
    try {
      const loaded = loadPermissionsDocumentFor(ctx.vault, ctx.configPath);
      if (loaded.document === null) return;
      document = loaded.document;
    } catch (err) {
      // A non-document failure is not this check's finding; the pass's
      // fail-soft wrapper records those its own way.
      if (!(err instanceof PermissionsDocumentError)) throw err;
      out.issues.push({
        severity: "error",
        code: PERMISSIONS_UNREADABLE_CODE,
        path: at,
        message:
          `${where} could not be read, so its policy is not in force and ` +
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
      path: at,
      message:
        `${where} denies the locally configured agent ${JSON.stringify(agent)} ` +
        `the write action (rule ${decision.source}), so every write this agent attempts is ` +
        `refused while the document stands. Deliberate for a read-only agent; a surprise if ` +
        `not. Review the effective decisions: o2b brain permissions show`,
    } satisfies DoctorIssue);
  },
};

/** Deny rules that live only in a legacy file no reader of this machine sees. */
export const PERMISSIONS_LEGACY_ONLY_CODE = "permissions-legacy-only";

/** Whether one verdict table holds a deny. */
function denies(verdicts: Readonly<Record<string, unknown>>): boolean {
  return Object.values(verdicts).includes("deny");
}

/** Whether `document` denies anything: its default, a role, an agent, or one entry. */
function deniesAnything(document: PermissionsDocument): boolean {
  if (document.default_action === "deny") return true;
  if (Object.values(document.roles).some(denies)) return true;
  if (Object.values(document.agents).some(denies)) return true;
  return document.entries.some((e) => e.verdict === "deny");
}

/** The parsed document's rules, comparable across texts that differ only in layout. */
function sameRules(a: PermissionsDocument, b: PermissionsDocument): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Does a legacy `Brain/_permissions.yaml` hold deny rules that no gate of
 * this machine reads? The gates read the `permissions.document` shared
 * setting (the migration imports the file into it) and fall back to the
 * file only on an unswitched machine where the setting is not set. A file
 * with deny rules the gates do not read (never imported, or edited after
 * the import) is a policy the operator believes is in force and is not,
 * and it leaves with the legacy tree at removal. Silent when the gates
 * read the file, when the setting holds the same rules, and for a file
 * that cannot be parsed (`permissions show` names its fault).
 */
export const permissionsLegacyOnlyCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let legacy: PermissionsDocument | null;
    try {
      legacy = loadPermissionsDocument(ctx.vault).document;
    } catch (err) {
      if (!(err instanceof PermissionsDocumentError)) throw err;
      return;
    }
    let stored: string | null;
    try {
      stored = storedPermissionsText(ctx.configPath);
    } catch (err) {
      // An unreadable settings stream is the document check's finding.
      if (!(err instanceof PermissionsDocumentError)) throw err;
      return;
    }
    if (!denyRulesOutside(legacy, stored)) return;
    if (stored === null && !isStoreOnly({ vault: ctx.vault, configPath: ctx.configPath })) return;
    out.issues.push({
      severity: "warning",
      code: PERMISSIONS_LEGACY_ONLY_CODE,
      path: join(ctx.vault, ...PERMISSIONS_DOCUMENT_REL.split("/")),
      message:
        `${PERMISSIONS_DOCUMENT_REL} holds deny rules no gate of this machine reads: the gates ` +
        `read the ${PERMISSIONS_SETTING_LABEL}, which ` +
        `${stored === null ? "is not set" : "holds a different document"}. The file leaves ` +
        "with the legacy tree. To keep the rules in force, set them: o2b brain settings set " +
        `permissions.document "$(cat ${PERMISSIONS_DOCUMENT_REL})"`,
    } satisfies DoctorIssue);
  },
};

/** Whether `legacy` holds deny rules and `stored` is not a document of the same rules. */
function denyRulesOutside(legacy: PermissionsDocument | null, stored: string | null): boolean {
  if (legacy === null || !deniesAnything(legacy)) return false;
  return stored === null || !sameStored(stored, legacy);
}

/**
 * Whether the legacy `Brain/_permissions.yaml` of `vault` holds deny rules
 * the stored document (`stored`, the setting's text or null) does not
 * hold the same way: the conflict the transition import of a vault
 * configured after the switch refuses to bind over. A file that cannot be
 * parsed counts as a conflict unless the setting holds its exact text
 * (fail closed: its rules cannot be compared).
 */
export function legacyPermissionsConflict(vault: string, stored: string | null): boolean {
  const path = join(vault, ...PERMISSIONS_DOCUMENT_REL.split("/"));
  if (!existsSync(path)) return false;
  let legacy: PermissionsDocument | null;
  try {
    legacy = loadPermissionsDocument(vault).document;
  } catch (err) {
    if (!(err instanceof PermissionsDocumentError)) throw err;
    return stored === null || stored !== readText(path);
  }
  return denyRulesOutside(legacy, stored);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Whether the stored text parses to the same rules as `legacy`. */
function sameStored(stored: string, legacy: PermissionsDocument): boolean {
  try {
    return sameRules(parsePermissionsDocumentText(stored, PERMISSIONS_SETTING_LABEL), legacy);
  } catch (err) {
    if (!(err instanceof PermissionsDocumentError)) throw err;
    return false;
  }
}
