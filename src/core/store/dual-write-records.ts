/**
 * The store records each legacy writer produces under dual writes (task
 * 1.11). One builder per legacy surface, so the mapping from the legacy
 * tree to the store is written down in one place:
 *
 *  - a signal file             -> `signal` in `events`
 *  - a Brain log event         -> `log-event` in `log`
 *  - a preference write/retire -> `preference-set` in `events`
 *  - apply-evidence            -> `preference-evidence` in `events`
 *  - pinned context            -> `pinned-set` / `pinned-clear` in `events`
 *  - a per-device ledger row   -> `ledger-row` in `ledgers/<name>`
 *
 * Authority (FORMAT.md, "Authority") is never inferred here: the legacy
 * caller passes it, usually from `authorityFromOrigin()`.
 *
 * Bodies are plain JSON: values are passed through a JSON round trip so a
 * `Date` or an `undefined` in a legacy structure cannot make the checksum
 * depend on how a value happens to serialise.
 */

import { existsSync } from "node:fs";
import { relative, sep } from "node:path";

import { preferencePath, retiredPath } from "../brain/paths.ts";
import {
  AUTHORITY_FIELD,
  LEDGER_ROW_KIND,
  LOG_EVENT_KIND,
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  PREFERENCE_COUNTER_FIELDS,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
  type Authority,
  type EvidenceResult,
} from "./constants.ts";
import type { DualWriteRecord } from "./dual-write.ts";
import type { RecordBody } from "./envelope.ts";
import { PREFERENCE_FIELD_RE } from "./fold-preferences.ts";
import { isPrivatePageFile } from "./private-page.ts";
import { judgesFromStore, storePreferenceIdIsPrivate } from "./store-privacy.ts";

export { isPrivateFrontmatter, isPrivatePageFile } from "./private-page.ts";

const COUNTERS = new Set<string>(PREFERENCE_COUNTER_FIELDS);

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** `path` relative to `vault`; with no vault (`null`) it is already vault-relative. */
function vaultRel(vault: string | null, path: string): string {
  return (vault === null ? path : relative(vault, path)).split(sep).join("/");
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Whether the preference `pref-<slug>` (active or retired) is private, so
 * the log events and ledger rows that name it stay out of `shared`. A
 * preference with no file reads as not private. On a store-only machine,
 * or with no vault, the preference fold decides instead, and a preference
 * the fold does not hold is private (design D14 item 18).
 */
export function isPrivatePreference(vault: string | null, slug: string): boolean {
  if (vault === null || judgesFromStore(vault)) return storePreferenceIdIsPrivate(`pref-${slug}`);
  for (const path of [preferencePath(vault, slug), retiredPath(vault, slug)]) {
    if (existsSync(path) && isPrivatePageFile(path)) return true;
  }
  return false;
}

/**
 * A signal file the legacy writer created, in the partition of the write's
 * single privacy verdict (`operation-privacy.ts`).
 */
export function signalRecord(input: {
  readonly vault: string | null;
  readonly path: string;
  readonly id: string;
  readonly staged: boolean;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly raw: string | undefined;
  /** What `raw` holds (FORMAT.md, `signal`): the captured text (default) or an imported page body. */
  readonly rawShape?: SignalRawShape;
  readonly private: boolean;
}): DualWriteRecord {
  const frontmatter = plain(input.frontmatter) as Record<string, unknown>;
  return {
    stream: "events",
    kind: SIGNAL_KIND,
    agent: textOf(frontmatter["agent"]) ?? undefined,
    scope: textOf(frontmatter["scope"]),
    private: input.private,
    body: {
      id: input.id,
      path: vaultRel(input.vault, input.path),
      staged: input.staged,
      frontmatter,
      raw: input.raw ?? null,
      ...(input.raw !== undefined ? { [SIGNAL_RAW_SHAPE_FIELD]: input.rawShape ?? "bare" } : {}),
    },
  };
}

/** What a `signal` record's `raw` holds: the captured text, or an imported page's body. */
export type SignalRawShape = "bare" | "page";

/** Body field of a `signal` record naming its {@link SignalRawShape}. */
export const SIGNAL_RAW_SHAPE_FIELD = "raw_shape";

/**
 * The {@link SignalRawShape} of a `signal` record's body: its `raw_shape`,
 * or, for a record written before the field existed, `page` when one of
 * the first three lines of `raw` is the `## Raw` heading.
 */
export function signalRawShape(body: Readonly<Record<string, unknown>>): SignalRawShape {
  const marked = body[SIGNAL_RAW_SHAPE_FIELD];
  if (marked === "bare" || marked === "page") return marked;
  const raw = body["raw"];
  return typeof raw === "string" && /^\s*## Raw\s*$/m.test(raw.split("\n", 3).join("\n"))
    ? "page"
    : "bare";
}

/** One Brain log event, as the legacy appender wrote it. */
export function logEventRecord(
  event: {
    readonly timestamp: string;
    readonly eventType: string;
    readonly agent?: string;
    readonly body: Readonly<Record<string, unknown>>;
  },
  /** `true` when the event names a private item (a private preference). */
  isPrivate = false,
): DualWriteRecord {
  const body = plain(event.body) as Record<string, unknown>;
  return {
    stream: "log",
    kind: LOG_EVENT_KIND,
    agent: textOf(body["agent"]) ?? textOf(event.agent) ?? undefined,
    private: isPrivate,
    body: { timestamp: event.timestamp, event_type: event.eventType, body },
  };
}

/**
 * The fields a preference record carries: every frontmatter key that is a
 * valid field name, minus the counters (derived from evidence in the fold,
 * never written back). A `null` value is kept: it says the field is unset.
 */
export function preferenceFields(
  frontmatter: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(plain(frontmatter) as Record<string, unknown>)) {
    if (!PREFERENCE_FIELD_RE.test(name) || COUNTERS.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * A preference as the legacy writer just wrote (or retired) it, in the
 * partition of the write's single privacy verdict (`operation-privacy.ts`).
 */
export function preferenceSetRecord(input: {
  readonly id: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly authority: Authority;
  readonly agent?: string;
  readonly private: boolean;
}): DualWriteRecord | null {
  const fields = preferenceFields(input.frontmatter);
  if (Object.keys(fields).length === 0) return null;
  return {
    stream: "events",
    kind: PREFERENCE_SET_KIND,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    scope: textOf(fields["scope"]),
    private: input.private,
    body: { [AUTHORITY_FIELD]: input.authority, preference: input.id, fields },
  };
}

/** One application of a preference (`brain_apply_evidence`). */
export function preferenceEvidenceRecord(input: {
  readonly id: string;
  readonly result: EvidenceResult;
  readonly artifact: string;
  readonly agent: string;
  readonly private: boolean;
  /** The evidence record this one copies (a merge moving a drop's evidence to the keep). */
  readonly mergedFrom?: string;
}): DualWriteRecord {
  return {
    stream: "events",
    kind: PREFERENCE_EVIDENCE_KIND,
    agent: input.agent,
    private: input.private,
    body: {
      preference: input.id,
      result: input.result,
      artifact: input.artifact,
      ...(input.mergedFrom !== undefined ? { [MERGED_FROM_FIELD]: input.mergedFrom } : {}),
    },
  };
}

/**
 * Body field of a `preference-evidence` record a merge copied from the
 * dropped preference: the id of the record it copies, so a merge retried
 * after a partial run copies each record once.
 */
export const MERGED_FROM_FIELD = "merged_from";

/**
 * The pinned context after a legacy write: its full text, or `null` for a
 * clear. Pinned facts are often drawn from the notes an agent is working
 * on, so the record goes to `private` when this machine holds it and to
 * `shared` when it does not. A text that carries a `<private>` region or
 * names a private page (`namesPrivate`, `pinnedTextIsPrivate` in
 * `reference-privacy.ts`) goes to `private` only; a clear is judged by the
 * text it clears, so it lands where that text's set did.
 */
export function pinnedRecord(
  content: string | null,
  authority: Authority,
  namesPrivate: boolean,
): DualWriteRecord {
  const body: RecordBody =
    content === null ? { [AUTHORITY_FIELD]: authority } : { [AUTHORITY_FIELD]: authority, content };
  return {
    stream: "events",
    kind: content === null ? PINNED_CLEAR_KIND : PINNED_SET_KIND,
    ...partitionOf(namesPrivate ? "private" : "private-when-held"),
    body,
  };
}

/**
 * Where a ledger row goes. Every ledger site states it, so a new site
 * cannot fall into `shared` by default:
 *
 *  - `private`: the row names a private item (a private preference, a
 *    private page, a turn with a `<private>` region); on a machine without
 *    that partition the appender refuses it and the refusal is counted;
 *  - `private-when-held`: the row says what this machine or its user did
 *    (audit trails, session lineage, search terms) and names no private
 *    page; it goes to `private` when this machine holds it, else `shared`;
 *  - `shared`: the row carries nothing about the user's private notes.
 */
export type RowPartition = "shared" | "private" | "private-when-held";

function partitionOf(
  partition: RowPartition,
): Pick<DualWriteRecord, "private" | "privateWhenHeld"> {
  return {
    private: partition === "private",
    ...(partition === "private-when-held" ? { privateWhenHeld: true } : {}),
  };
}

/** One row of a per-device legacy ledger, under `ledgers/<name>`, in the partition its caller states. */
export function ledgerRowRecord(
  ledger: string,
  row: unknown,
  partition: RowPartition,
  agent?: string,
): DualWriteRecord {
  return {
    stream: "ledgers",
    ledger,
    kind: LEDGER_ROW_KIND,
    ...(agent !== undefined ? { agent } : {}),
    ...partitionOf(partition),
    body: { row: plain(row) },
  };
}

/**
 * One `truth-claims` ledger row. A claim taken from a private page
 * (`sourceIsPrivate`, `reference-privacy.ts`) goes to `private` only; any
 * other claim goes to `private` when this machine holds it and to
 * `shared` when it does not.
 */
export function truthClaimRowRecord(row: unknown, sourceIsPrivate: boolean): DualWriteRecord {
  return ledgerRowRecord(
    DUAL_WRITE_LEDGERS.truthClaims,
    row,
    sourceIsPrivate ? "private" : "private-when-held",
  );
}

/**
 * One row of an audit trail: the `preference-audit` ledger, or the
 * `reliability-audit` ledger that every `Brain/log/<trail>/` audit shares
 * (hygiene, secret custody, hook audit, watchdog, ...). Audit rows say who
 * did what to which item, so they go to `private` when this machine holds
 * it and to `shared` when it does not. A row about a private item passes
 * `isPrivate` and goes only to `private`: on a machine without that
 * partition the appender refuses it, as for any private record.
 */
export function auditRowRecord(
  ledger: typeof DUAL_WRITE_LEDGERS.preferenceAudit | typeof DUAL_WRITE_LEDGERS.reliabilityAudit,
  row: unknown,
  agent: string | undefined,
  isPrivate: boolean,
): DualWriteRecord {
  return ledgerRowRecord(ledger, row, isPrivate ? "private" : "private-when-held", agent);
}

/**
 * Store ledger names of the per-device legacy ledgers that dual-write
 * their rows (`ledgers/<name>/<device>/<YYYY-MM>.jsonl`).
 */
export const DUAL_WRITE_LEDGERS = Object.freeze({
  idempotency: "idempotency",
  continuity: "continuity",
  metrics: "metrics",
  lineage: "lineage",
  permissions: "permissions",
  gitCommits: "git-commits",
  reliabilityAudit: "reliability-audit",
  maintenanceJournal: "maintenance-journal",
  verifierRejections: "verifier-rejections",
  preferenceAudit: "preference-audit",
  editHistory: "edit-history",
  decisionReceipts: "decision-receipts",
  truthClaims: "truth-claims",
  queryDemand: "query-demand",
  recurrence: "recurrence",
} as const);
