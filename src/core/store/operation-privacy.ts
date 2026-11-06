/**
 * One privacy verdict per writer operation. A legacy write that dual-writes
 * several store records (a signal and its idempotency receipt, a
 * preference's human and derived records, an evidence event, its evidence
 * record and its receipt, a write batch's log events and its receipt)
 * judges its privacy ONCE, here, and hands the same verdict to every
 * record it writes. No record of the operation judges itself into a less
 * private partition, so the records of one write never land in different
 * partitions. The `<private>` region check of the dual-write entry point
 * (`dual-write.ts`) stays as a backstop that can only raise a record.
 * Each operation also runs its body inside its verdict's ambient scope
 * (`operation-scope.ts`), so a record written down the call chain by a
 * writer the operation never hands the verdict to (a permissions decision
 * row, a metric, an audit event) follows the operation too.
 *
 * An operation is private when any of these holds:
 *
 *  - its target page is private or cannot be judged (`target`);
 *  - any content-bearing value names a private page or one that cannot be
 *    judged, or carries a `<private>` region or the placeholder a stripped
 *    one leaves (`content`, judged by {@link rowNamesPrivatePage});
 *  - an enclosing or inner operation's verdict is private (`inherit`).
 *
 * Each `content` entry names its `opaque` fields: the record's own id,
 * hashes, timestamps and keys (a generated path is not passed as content
 * at all). Their values are not written to name a page, so they are never
 * judged as references (they are still checked for a `<private>` region).
 * The writer identities `agent` and `owner` are NOT opaque: a writer takes
 * them from its caller as free strings, so they are judged as content
 * like any other. A plain identity such as `@claude-devbox-agent` names no
 * page and leaves the operation shared.
 *
 * Every operation also judges its WHOLE caller-supplied input
 * ({@link callerInput}): every field the caller can set, not a list picked
 * by hand, so a field that reaches a record body (a writer identity, an
 * idempotency key, a batch request id) cannot carry a link or a region the
 * verdict did not see. A record body may still hold strings the writer
 * generated itself (allocated ids, timestamps, hashes, the origin channel,
 * vault-relative paths it derived); none of them is caller text, so none
 * can carry a region.
 *
 * The verdict is lazy and memoised: nothing is judged unless a record is
 * actually written (dual writes off judges nothing), and once judged it
 * never changes for the rest of the operation. A judge that throws counts
 * as private, the partition that leaks nothing.
 */

import { EXPIRATION_DATE_FIELD } from "../brain/expiration.ts";
import { ORIGIN_CHANNEL_FIELD } from "../origin-channel.ts";
import { rowNamesPrivatePage } from "./reference-privacy.ts";

/** A privacy verdict: a fixed answer, or one judged on first use. */
export type PrivacyVerdict = boolean | (() => boolean);

/** One content-bearing value of an operation, with its opaque fields. */
export interface JudgedContent {
  readonly value: unknown;
  readonly opaque?: ReadonlySet<string>;
}

/** What one operation's privacy is judged from. */
export interface OperationPrivacyParts {
  /** Whether the target page is private or cannot be judged. */
  readonly target?: PrivacyVerdict;
  /** The operation's content-bearing values. */
  readonly content?: ReadonlyArray<JudgedContent>;
  /** Verdicts of an enclosing operation or of the operation's parts. */
  readonly inherit?: ReadonlyArray<PrivacyVerdict | undefined>;
}

/** The operation's verdict, judged once on first call. */
export type OperationPrivacy = () => boolean;

/**
 * Opaque fields every record shares: its own coordinates and stamps. The
 * writer identities (`agent`, `owner`) are caller-supplied strings and
 * stay content.
 */
export const COMMON_OPAQUE_FIELDS: ReadonlyArray<string> = Object.freeze([
  "id",
  "kind",
  "created_at",
  "updated_at",
  "idempotency_key",
  EXPIRATION_DATE_FIELD,
  ORIGIN_CHANNEL_FIELD,
]);

/** {@link COMMON_OPAQUE_FIELDS} plus `extra`, as a set. */
export function opaqueFields(...extra: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set([...COMMON_OPAQUE_FIELDS, ...extra]);
}

/**
 * Opaque fields of a signal's frontmatter and caller input: dates,
 * event-time stamps, the slug its id is allocated from, the dedup hash,
 * the session and vault it came from. Everything else
 * (`principle`, `source`, `raw`, `scope`, tags, ...) is content.
 */
export const SIGNAL_OPAQUE_FIELDS: ReadonlySet<string> = opaqueFields(
  "date",
  "slug",
  "valid_from",
  "recorded_at",
  "authored_at",
  "dedup_hash",
  "session_ref",
  "origin_vault",
);

/**
 * Opaque fields of a preference's store fields and caller input:
 * timestamps, hashes, the slug its id is made of and the revision
 * counter. Everything else (`principle`, `evidenced_by`,
 * `supersedes` and other relationship fields, `scope`, ...) is content.
 */
export const PREFERENCE_OPAQUE_FIELDS: ReadonlySet<string> = opaqueFields(
  "slug",
  "confirmed_at",
  "unconfirmed_until",
  "last_evidence_at",
  "retired_at",
  "valid_from",
  "valid_until",
  "content_hash",
  "revision",
);

/**
 * The whole caller-supplied input of an operation as content. `opaque`
 * names its keys, hashes, timestamps, ids and local settings (a config
 * path, a clock): checked for a `<private>` region like every string, but
 * never judged as page references.
 */
export function callerInput(value: unknown, opaque: ReadonlySet<string>): JudgedContent {
  return { value, opaque };
}

function holds(verdict: PrivacyVerdict | undefined): boolean {
  return typeof verdict === "function" ? verdict() : verdict === true;
}

function judge(vault: string, parts: OperationPrivacyParts): boolean {
  if (holds(parts.target)) return true;
  if ((parts.inherit ?? []).some(holds)) return true;
  // The row judge checks every string, opaque or not, for a region, and
  // every non-opaque one as a page reference.
  return (parts.content ?? []).some(({ value, opaque }) =>
    rowNamesPrivatePage(vault, value, opaque),
  );
}

/** The single, memoised privacy verdict of one writer operation. */
export function operationPrivacy(vault: string, parts: OperationPrivacyParts): OperationPrivacy {
  let verdict: boolean | undefined;
  return () => {
    if (verdict === undefined) {
      try {
        verdict = judge(vault, parts);
      } catch {
        verdict = true;
      }
    }
    return verdict;
  };
}
