/**
 * Orphan-observation repair lane (t_6cc80627): detach dangling
 * `session_ref` values from observation signals, keeping the observation.
 *
 * The memory-graph repair lane (`repair-lane.ts`) writes ADDITIVE edges;
 * this lane's act looks destructive by contrast, which is exactly why it
 * inherits the whole discipline rather than part of it:
 *
 *   - dry-run is the DEFAULT and writes nothing - the report is the plan;
 *   - apply requires the exact confirmation phrase, checked before any
 *     scan runs, so a refused apply is a pure refusal;
 *   - a hard per-run write cap stops a run, because a repair loop that
 *     never stops is a bug with write access;
 *   - the vault-identity assertion fronts every write;
 *   - a rescan after apply converges to zero writes: the reference is
 *     gone from the frontmatter, so the second scan finds no finding.
 *
 * The one thing it does NOT do is delete. The detach removes the
 * `session_ref` key from the signal's frontmatter; the observation body,
 * its topic, and every other field are byte-identical, and the detached
 * value is quoted in the decision so the change is auditable and
 * recoverable by hand.
 *
 * ## Fail-closed on a partial store
 *
 * The lane resolves every candidate against the sessions/continuity
 * store first. A store that could not be read completely makes the id
 * set partial, and a partial set resolves nothing - so the lane REFUSES
 * rather than repair on a guess. The same holds for a signals subtree
 * the scan could not read. This is the narrower gate the design asks
 * for: an edge lane that mis-resolves writes a skip, a detach lane that
 * mis-resolves strips provenance.
 *
 * ## Never reachable from the doctor
 *
 * `runDoctor` reports orphans and carries the repair command on the
 * issue's `fix` field; this module is imported by the CLI verb only. A
 * scan-only pass and a write path share the detector
 * (`scanOrphanedSessionRefs`), never the invocation.
 */

import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { vaultRelative } from "../../path-safety.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { collectKnownSessionIds, scanOrphanedSessionRefs } from "../doctor/orphan-session-check.ts";
import type { DoctorUncertainEntry } from "../doctor/report.ts";
import type { SweptPath } from "../doctor/unreadable-path.ts";

/** Exact phrase an apply must supply as confirmation. */
export const ORPHAN_REPAIR_CONFIRM_PHRASE = "apply orphan repair";

/** Hard cap on signals detached in a single run. */
export const ORPHAN_REPAIR_WRITE_CAP = 25;

/** Raised when an apply is requested without the exact confirmation phrase. */
export class OrphanRepairConfirmationError extends Error {
  constructor() {
    super(
      `orphan repair requires the exact confirmation phrase: ${JSON.stringify(
        ORPHAN_REPAIR_CONFIRM_PHRASE,
      )}`,
    );
    this.name = "OrphanRepairConfirmationError";
  }
}

/** Raised when the store could not be read completely enough to act on. */
export class OrphanRepairStoreUnreadableError extends Error {
  constructor(detail: string) {
    super(
      `the session store could not be read completely, so no orphan statement is trustworthy: ` +
        `${detail}. Nothing was detached`,
    );
    this.name = "OrphanRepairStoreUnreadableError";
  }
}

/** What the lane decided about one finding. */
export type OrphanRepairAction = "detach" | "skip-cap";

export interface OrphanRepairDecision {
  /** Vault-relative path of the signal file. */
  readonly path: string;
  /** The dangling reference, verbatim, for audit and manual recovery. */
  readonly session_ref: string;
  readonly action: OrphanRepairAction;
}

export interface OrphanRepairReport {
  readonly mode: "dry-run" | "apply";
  /** Count of references detached (or, in dry-run, that would be). */
  readonly detached: number;
  readonly decisions: readonly OrphanRepairDecision[];
}

export interface OrphanRepairOptions {
  /** Apply the writes. Default false (dry-run). */
  readonly apply?: boolean;
  /** Exact confirmation phrase; required when `apply` is true. */
  readonly confirm?: string;
  /** Per-run cap override. Defaults to {@link ORPHAN_REPAIR_WRITE_CAP}. */
  readonly writeCap?: number;
}

/** What the repair's own signal sweep reports an unreadable path under. */
const REPAIR_SITE = "brain.orphan-repair";

/**
 * Run the lane over the vault's signals. Scans once, orders the findings
 * deterministically, and - only on a confirmed apply - detaches each one
 * until the cap stops the run.
 */
export function runOrphanRepair(vault: string, opts: OrphanRepairOptions = {}): OrphanRepairReport {
  const apply = opts.apply === true;
  if (apply && opts.confirm !== ORPHAN_REPAIR_CONFIRM_PHRASE) {
    throw new OrphanRepairConfirmationError();
  }
  // Vault-identity write guard (context-integrity-gates, Unit J).
  // A dry run reports decisions and writes nothing.
  if (apply) assertVaultIdentityForWrite(vault);

  const universe = collectKnownSessionIds(vault);
  if (!universe.complete) {
    throw new OrphanRepairStoreUnreadableError(
      universe.uncertain.map((entry) => entry.message).join("; ") ||
        "a resolution surface reported itself unreadable",
    );
  }

  const uncertain: DoctorUncertainEntry[] = [];
  const swept: SweptPath = {
    site: REPAIR_SITE,
    consequence:
      "signals in it were not scanned, so their session_ref values were not resolved and none " +
      "of them will be detached this run",
    uncertain,
  };
  const findings = [...scanOrphanedSessionRefs(vault, universe, swept)].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (uncertain.length > 0) {
    // A subtree the scan could not read makes the finding set partial in
    // exactly the way the docblock refuses to act on.
    throw new OrphanRepairStoreUnreadableError(uncertain.map((entry) => entry.message).join("; "));
  }

  const cap = Math.max(0, Math.floor(opts.writeCap ?? ORPHAN_REPAIR_WRITE_CAP));
  const decisions: OrphanRepairDecision[] = [];
  let detached = 0;
  for (const finding of findings) {
    const decision: Omit<OrphanRepairDecision, "action"> = {
      path: vaultRelative(finding.path, vault),
      session_ref: finding.session_ref,
    };
    if (detached >= cap) {
      decisions.push({ ...decision, action: "skip-cap" });
      continue;
    }
    if (apply) detachSessionRef(finding.path);
    detached += 1;
    decisions.push({ ...decision, action: "detach" });
  }

  return {
    mode: apply ? "apply" : "dry-run",
    detached,
    decisions: Object.freeze(decisions),
  };
}

/**
 * Remove the `session_ref` key from a signal's frontmatter, atomically,
 * keeping the body and every other field. The reference that was removed
 * is the caller's to report - the decision carries it verbatim.
 */
function detachSessionRef(absPath: string): void {
  const [meta, body] = parseFrontmatter(absPath);
  if (meta["session_ref"] === undefined) {
    // Gone between the scan and the write - a concurrent repair already
    // did the work. Removing a key that is not there is not a write.
    return;
  }
  const next: FrontmatterMap = { ...meta };
  delete next["session_ref"];
  writeFrontmatterAtomic(absPath, next, body, { overwrite: true });
}
