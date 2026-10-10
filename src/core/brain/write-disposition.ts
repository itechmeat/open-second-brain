/**
 * The write disposition resolver (write-side trust, Tasks 9 and 12).
 *
 * One leaf module owns the answer to "how does this write proceed": with
 * no permissions document the `write_approval.*` lane keys decide (on =
 * stage, off = publish); with one, the document is the only gate - its
 * rules decide through the permissions substrate, a deny refuses as a
 * typed {@link WriteRefusedError}, an ask stages, and every stage or
 * refuse lands exactly one decision-ledger row naming the rule.
 *
 * A LEAF below the pending queue on purpose. The queue's engine
 * (`pending/pending-lanes.ts`) re-exports everything here so the
 * historical import surface holds, and the signals chokepoint
 * (`signal.ts`) imports this module directly: the queue reads the signal
 * parser back when it lists its lane, so a disposition that lived in the
 * queue could not be consulted from the parser without closing an import
 * cycle. The disposition layer reads no queue state, so it sits below
 * both.
 *
 * LEAF MODULE: imports the config reader, the lane registry, and the
 * permissions substrate - and nothing that reaches back into the gates
 * or the queue.
 */

import { discoverConfig, resolveAgentName } from "../config.ts";
import type { PermissionAction } from "./permissions/document.ts";
import { loadPermissionsDocument } from "./permissions/document.ts";
import { appendDecisionLedger } from "./permissions/ledger.ts";
import type { PermissionDecision, PermissionSubject } from "./permissions/resolve.ts";
import { resolvePermission } from "./permissions/resolve.ts";
import { WRITE_REFUSAL_NEXT_COMMAND } from "./write-refusal-exit.ts";
import {
  WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  WRITE_APPROVAL_ENABLED_ENV_KEY,
  WRITE_APPROVAL_INGEST_CONFIG_KEY,
  WRITE_APPROVAL_INGEST_ENV_KEY,
  WRITE_APPROVAL_NOTES_CONFIG_KEY,
  WRITE_APPROVAL_NOTES_ENV_KEY,
  REVIEW_LANE,
  type ReviewLane,
  resolveWriteApprovalLane,
} from "./write-gate.ts";

// ----- Typed refusals -------------------------------------------------------

/**
 * The closed vocabulary of write-side trust refusals (Task 12). Both are
 * registered in `./diagnostics.ts`, so every surface that carries one
 * resolves the same next command; the census pins the trio.
 */
export const WRITE_REFUSAL_CODES = Object.freeze({
  /** A permissions document rule denied the write itself. */
  documentDeny: "write-refused",
  /** `force_confirmed` requires an allow verdict; the document said ask or deny. */
  forceConfirmedRequiresAllow: "force-confirmed-requires-allow",
} as const);

/** Closed union over {@link WRITE_REFUSAL_CODES}. */
export type WriteRefusalCode = (typeof WRITE_REFUSAL_CODES)[keyof typeof WRITE_REFUSAL_CODES];

/** Membership list, in the order the checks are made. */
export const WRITE_REFUSAL_CODE_LIST: ReadonlyArray<WriteRefusalCode> = Object.freeze([
  WRITE_REFUSAL_CODES.documentDeny,
  WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow,
]);

/** Narrow a refusal token read back off a wire or out of an error payload. */
export function isWriteRefusalCode(value: unknown): value is WriteRefusalCode {
  return (
    typeof value === "string" && (WRITE_REFUSAL_CODE_LIST as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The registered exit a document-deny refusal names, read straight from
 * the leaf the diagnostics registry builds its own entries from: this
 * module sits inside the diagnostics import cycle (`next-step.ts` reads
 * `diagnostics.ts`, which reaches the doctor checks that reach the
 * signals parser and this module back), so resolving through
 * `requireNextStep` - at module scope OR on first refusal - would either
 * crash on the registry's initialization order or paper over the cycle
 * the graph ratchet refuses. The leaf keeps the string at one
 * definition; the census pins the codes against it.
 */
const WRITE_REFUSED_EXIT = WRITE_REFUSAL_NEXT_COMMAND;

/** The fields a document-deny refusal carries beside its message. */
export interface WriteRefusedFields {
  readonly agent: string;
  readonly via: WriteSubject["via"];
  readonly action: PermissionAction;
  /** The deciding rule: `entry:<id>` | `agent:<name>` | `role:<name>` | `default`. */
  readonly rule: string;
  readonly target: string;
}

/**
 * A permissions document rule DENIED one write (write-side trust,
 * Task 12). Names the principal, the action, the rule that decided and
 * the registered exit, so a refused agent can tell its operator exactly
 * what to review instead of guessing at a policy it cannot read.
 */
export class WriteRefusedError extends Error {
  /** Always {@link WRITE_REFUSAL_CODES.documentDeny}. */
  readonly code: WriteRefusalCode;
  readonly agent: string;
  readonly via: WriteSubject["via"];
  readonly action: PermissionAction;
  readonly rule: string;
  readonly target: string;
  /** The registered exit: the operator command that inspects the policy. */
  readonly nextCommand: string;

  constructor(fields: WriteRefusedFields) {
    super(
      `write refused (${WRITE_REFUSAL_CODES.documentDeny}): agent ` +
        `${JSON.stringify(fields.agent)} (via ${fields.via}) may not ${fields.action} ` +
        `${JSON.stringify(fields.target)} - rule ${fields.rule} denied it. ` +
        `The operator can review the policy: ${WRITE_REFUSED_EXIT}`,
    );
    this.name = "WriteRefusedError";
    this.code = WRITE_REFUSAL_CODES.documentDeny;
    this.agent = fields.agent;
    this.via = fields.via;
    this.action = fields.action;
    this.rule = fields.rule;
    this.target = fields.target;
    this.nextCommand = WRITE_REFUSED_EXIT;
  }
}

// ----- Dispositions ---------------------------------------------------------

/**
 * The subject one write answers for. The permissions substrate's subject
 * with the transport's shared-key credential spelling added: the
 * substrate never reads `via` (no verdict depends on it - it only rides
 * the decision into the ledger row), so the credential path a request
 * arrived by is carried verbatim rather than flattened at the boundary.
 * Narrow back to the substrate's own type with
 * {@link substrateSubject}, the one conversion {@link resolvePermission}
 * needs.
 */
export type WriteSubject = {
  agent: string;
  via: PermissionSubject["via"] | "shared-key";
};

/**
 * The subject {@link resolvePermission} answers: {@link WriteSubject}
 * narrowed to the substrate's closed `via` vocabulary. A shared-key
 * credential IS the operator master credential, so that is the spelling
 * the substrate sees; the ledger row still records the request's own
 * `via` verbatim.
 */
export function substrateSubject(subject: WriteSubject): PermissionSubject {
  return {
    agent: subject.agent,
    via: subject.via === "shared-key" ? "operator" : subject.via,
  };
}

/** How one write should proceed, with the rule that decided it. */
export interface WriteDisposition {
  readonly verdict: "publish" | "stage" | "refuse";
  /** The config key, env twin, or document rule that decided. */
  readonly source: string;
  /** Why, when the disposition is not the plain publish path. */
  readonly reason?: string;
  /** The pending id a stage would use, when deterministic. */
  readonly pendingId?: string;
}

/** Optional context a caller hands the disposition resolver. */
export interface ResolveWriteDispositionOptions {
  /**
   * Vault-relative path the write would publish at, when known. Target
   * entries in the permissions document match on it exactly, and the
   * decision-ledger row records it.
   */
  readonly target?: string;
  /**
   * Path of the config file the caller resolved its identity against, when
   * it has one. The no-subject fallback resolves the ambient agent through
   * it, so a document consult on an explicit-configPath run answers the
   * SAME principal the owner gate does - a document rule naming that
   * agent refuses, and the ledger row names it - instead of answering for
   * whatever the ambient discovery finds.
   */
  readonly configPath?: string;
  /** Injected clock for the ledger row's `ts`. Defaults to now. */
  readonly now?: Date;
}

/** The disposition source names, kept next to the resolvers that read them. */
export const WRITE_APPROVAL_SOURCES = Object.freeze({
  masterConfig: WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  masterEnv: WRITE_APPROVAL_ENABLED_ENV_KEY,
  notesConfig: WRITE_APPROVAL_NOTES_CONFIG_KEY,
  notesEnv: WRITE_APPROVAL_NOTES_ENV_KEY,
  ingestConfig: WRITE_APPROVAL_INGEST_CONFIG_KEY,
  ingestEnv: WRITE_APPROVAL_INGEST_ENV_KEY,
});

/**
 * The config key or env twin that decided a lane's toggle, for the
 * disposition's `source`. Resolution is the gate's own (lane key, then
 * master, then off), re-read here so the source names the SAME link in
 * the chain the verdict came from.
 */
function decidingSource(lane: ReviewLane): string {
  const laneEnv =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_ENV_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_ENV_KEY
        : undefined;
  const laneKey =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_CONFIG_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_CONFIG_KEY
        : undefined;
  if (laneEnv !== undefined && process.env[laneEnv] !== undefined && process.env[laneEnv] !== "") {
    return laneEnv;
  }
  if (laneKey !== undefined) {
    const raw = discoverConfig().data[laneKey];
    if (typeof raw === "string" && raw.trim() !== "") return laneKey;
  }
  const masterEnv = process.env[WRITE_APPROVAL_ENABLED_ENV_KEY];
  if (masterEnv !== undefined && masterEnv !== "") return WRITE_APPROVAL_ENABLED_ENV_KEY;
  return WRITE_APPROVAL_ENABLED_CONFIG_KEY;
}

/** The document action a review lane's writes answer under. */
function documentActionFor(lane: ReviewLane): PermissionAction {
  return lane === REVIEW_LANE.ingest ? "ingest" : "write";
}

/**
 * Append the ONE decision-ledger row a stage or refuse disposition owes
 * (write-side trust, Task 12). Never throws: the append contract is the
 * substrate's, and a row that cannot be written comes back as an audit
 * reason rather than blocking the verdict it records.
 *
 * A failed append is never silent either: the reason is a named stderr
 * line, because a refusal whose accountability row was lost reads, in
 * every later audit, exactly like a write nobody ruled on.
 */
function recordDispositionRow(
  vault: string,
  subject: WriteSubject,
  action: PermissionAction,
  opts: ResolveWriteDispositionOptions,
  decision: PermissionDecision,
): void {
  const appended = appendDecisionLedger(vault, {
    ts: (opts.now ?? new Date()).toISOString(),
    actor: subject.agent,
    via: subject.via,
    action,
    target: opts.target ?? "",
    verdict: decision.verdict,
    source: decision.source,
    reason: decision.reason,
  });
  if (!appended.logged) {
    process.stderr.write(
      `warning: decision-ledger append failed for the ${decision.verdict} ` +
        `${action} row on ${JSON.stringify(opts.target ?? "")}: ` +
        `${appended.audit_reason ?? "unknown reason"}\n`,
    );
  }
}

/**
 * Resolve the write disposition for one lane.
 *
 * ABSENT document (write-side trust, Task 9): the `write_approval.*`
 * lane keys decide - on = stage, off = publish. No ledger row is written.
 *
 * PRESENT document (Task 12): the document is the ONLY gate - the lane
 * keys cannot bypass it in either direction. Exactly one substrate rule
 * decides (target entry > agent override > role > default, deny > ask >
 * allow at equal specificity): `deny` records one ledger row and throws
 * {@link WriteRefusedError} naming the principal, action, rule and next
 * command; `ask` records one row and stages; `allow` publishes, with a
 * row only when the document's `ledger.record_allows` asks for it. An
 * unreadable document fails closed through the loader's own error.
 */
export function resolveWriteDisposition(
  vault: string,
  lane: ReviewLane,
  subject?: WriteSubject,
  opts: ResolveWriteDispositionOptions = {},
): WriteDisposition {
  const { document } = loadPermissionsDocument(vault);
  if (document === null) {
    const on = resolveWriteApprovalLane(lane);
    return Object.freeze({
      verdict: on ? "stage" : "publish",
      source: decidingSource(lane),
    });
  }
  const effectiveSubject: WriteSubject = subject ?? {
    agent: resolveAgentName(opts.configPath),
    via: "config",
  };
  const action = documentActionFor(lane);
  const decision = resolvePermission(
    document,
    substrateSubject(effectiveSubject),
    action,
    opts.target,
  );
  if (decision.verdict === "deny") {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
    throw new WriteRefusedError({
      agent: effectiveSubject.agent,
      via: effectiveSubject.via,
      action,
      rule: decision.source,
      target: opts.target ?? "",
    });
  }
  if (decision.verdict === "ask") {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
    return Object.freeze({
      verdict: "stage",
      source: decision.source,
      reason: decision.reason,
    });
  }
  if (document.ledger?.record_allows === true) {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
  }
  return Object.freeze({
    verdict: "publish",
    source: decision.source,
    reason: decision.reason,
  });
}

/**
 * The deny-only consult for a lane with no entry boundary.
 *
 * The review gate stages at ENTRY: a first publish can be parked in the
 * queue, which is what an `ask` verdict means. Mutation of an already
 * published note has no such boundary - an update or an append cannot be
 * staged, and the disposition it owes is only ever "may this caller
 * rewrite what the operator already admitted". This consult answers
 * exactly that: a deny refuses with the SAME typed error and the SAME
 * one ledger row {@link resolveWriteDisposition} produces, while an ask
 * and an allow change nothing at all - no row, no stage, the mutation
 * proceeds exactly as it did before this consult existed.
 *
 * With no permissions document it is a no-op, so the document-absent
 * behavior is byte-identical.
 */
export function refuseDocumentDeny(
  vault: string,
  lane: ReviewLane,
  subject?: WriteSubject,
  opts: ResolveWriteDispositionOptions = {},
): void {
  const { document } = loadPermissionsDocument(vault);
  if (document === null) return;
  const effectiveSubject: WriteSubject = subject ?? {
    agent: resolveAgentName(opts.configPath),
    via: "config",
  };
  const action = documentActionFor(lane);
  const decision = resolvePermission(
    document,
    substrateSubject(effectiveSubject),
    action,
    opts.target,
  );
  if (decision.verdict !== "deny") return;
  recordDispositionRow(vault, effectiveSubject, action, opts, decision);
  throw new WriteRefusedError({
    agent: effectiveSubject.agent,
    via: effectiveSubject.via,
    action,
    rule: decision.source,
    target: opts.target ?? "",
  });
}
