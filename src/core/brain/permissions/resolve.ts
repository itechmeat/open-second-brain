/**
 * The one resolver over the permissions document (write-side-trust,
 * Task 1).
 *
 * Every gate consults the document through {@link resolvePermission}, so
 * "which rule decided this" has exactly one answer and the decision ledger
 * can record it. The precedence table is fixed:
 *
 *   1. a target-scoped entry (`entry:<id>`)
 *   2. any other matching entry, most specific first
 *   3. the agent's per-action override (`agent:<name>`)
 *   4. the agent's role mapping (`role:<name>`)
 *   5. `default_action` (`default`)
 *
 * and among rules of equal specificity deny beats ask beats allow - deny
 * wins every tie, so an operator composing a strict document from several
 * angles never has one lenient line open what the rest closed.
 *
 * PURE LEAF: no I/O, no clock, no config. The `via` half of the subject
 * never changes a verdict - it rides the decision into the ledger row the
 * calling gate appends.
 */

import type {
  PermissionAction,
  PermissionEntry,
  PermissionVerdict,
  PermissionsDocument,
} from "./document.ts";

/** Who is asking. The credential path is carried, never inspected. */
export interface PermissionSubject {
  agent: string;
  via: "token" | "config" | "operator";
}

/** One resolved answer, ready for a ledger row. */
export interface PermissionDecision {
  verdict: PermissionVerdict;
  /** `entry:<id>` | `agent:<name>` | `role:<name>` | `default`. */
  source: string;
  reason: string;
}

/** Deny sorts before ask before allow at equal specificity. */
const VERDICT_TIGHTNESS: Record<PermissionVerdict, number> = { deny: 0, ask: 1, allow: 2 };

function roleOf(doc: PermissionsDocument, agent: string): string | undefined {
  return doc.agents[agent]?.role;
}

/**
 * Whether `entry` reaches this subject at this target. An entry naming an
 * agent reaches that agent; an entry naming a role reaches every agent
 * holding it; an entry naming neither reaches everyone. A target-scoped
 * entry reaches only its exact target and never a target-less query.
 */
function entryMatches(
  doc: PermissionsDocument,
  entry: PermissionEntry,
  subject: PermissionSubject,
  action: PermissionAction,
  target: string | undefined,
): boolean {
  if (entry.action !== action) return false;
  if (entry.agent !== undefined) {
    if (entry.agent !== subject.agent) return false;
  } else if (entry.role !== undefined) {
    if (entry.role !== roleOf(doc, subject.agent)) return false;
  }
  if (entry.target !== undefined && (target === undefined || entry.target !== target)) {
    return false;
  }
  return true;
}

function entryDecision(entry: PermissionEntry): PermissionDecision {
  return {
    verdict: entry.verdict,
    source: `entry:${entry.id}`,
    reason: entry.target === undefined ? `entry ${entry.id}` : `target-scoped entry ${entry.id}`,
  };
}

/**
 * Resolve one permission. Never throws on a well-formed document: an
 * unmentioned subject and action resolve to `default_action`.
 */
export function resolvePermission(
  doc: PermissionsDocument,
  subject: PermissionSubject,
  action: PermissionAction,
  target?: string,
): PermissionDecision {
  // Entries first, most specific matching entry wins: target-scoped above
  // blanket, then the tightest verdict, then document order for stability.
  const matching = doc.entries
    .filter((entry) => entryMatches(doc, entry, subject, action, target))
    .map((entry, order) => ({
      entry,
      order,
      scoped: entry.target !== undefined ? 0 : 1,
      tightness: VERDICT_TIGHTNESS[entry.verdict],
    }))
    .toSorted((a, b) => a.scoped - b.scoped || a.tightness - b.tightness || a.order - b.order);
  if (matching.length > 0) return entryDecision(matching[0]!.entry);

  const override = doc.agents[subject.agent]?.[action];
  if (override !== undefined) {
    return { verdict: override, source: `agent:${subject.agent}`, reason: "agent override" };
  }

  const role = roleOf(doc, subject.agent);
  if (role !== undefined) {
    const mapped = doc.roles[role]?.[action];
    if (mapped !== undefined) {
      return { verdict: mapped, source: `role:${role}`, reason: "role mapping" };
    }
  }

  return { verdict: doc.default_action, source: "default", reason: "default_action" };
}
