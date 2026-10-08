/**
 * The correct-verb sweep core (truth-correctable-time-aware, Task 16).
 *
 * One entry, {@link correct}, sweeps one record's correction end to end:
 * discovery gathers the affected set within the caller's reach (the
 * claim-graph closure over `whatReplaced`/`whatContests`, a match-only
 * wikilink mention scan via `retargetWikilinks` with `apply: false`, and
 * the same-entity/aspect truth-ledger claims), the dry run - the DEFAULT
 * - writes nothing and returns that blast-radius report, and the applied
 * run executes a fail-recorded sequence:
 *
 *   1. per-target retirement through the correction end-state policy
 *      (contract item 2): `flatlyWrong` tombstones via the shared
 *      tombstone writer, every other correction closes validity at the
 *      window end or at the correction instant, leaving the record
 *      serveable inside its historical window;
 *   2. ledger correction events asserting the corrected value under the
 *      corrected record's own source - a same-source value change reads
 *      as self-correction in the fold, never a conflict - each opening
 *      its validity window at the correction instant;
 *   3. mention retargeting with `retargetWikilinks`' per-write failure
 *      carry, never rewriting Brain/log or the receipt lines;
 *   4. bundle-correlated receipts with `correction_bundle:<bundleId>`
 *      in `evidence_triggers`, the existing reason codes carried
 *      name-aligned (`supersede` for validity_close, `tombstone` for
 *      tombstone).
 *
 * Replay converges: an already-applied retirement is a no-op, a closed
 * window is never re-closed, the ledger is not re-appended, and the
 * receipts report `appended: false`. Every write passes the
 * vault-identity guard, and a target the caller may not read is refused
 * as a missing one before anything is written.
 */

import { join } from "node:path";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { appendDecisionChangeReceipt } from "../decisions/receipts.ts";
import {
  LIFECYCLE_STATUS_KEY,
  LIFECYCLE_STATUS_KEY_NORMALIZED,
  normalizeChainLink,
  readLifecycleState,
  SUPERSEDED_BY_KEY,
  SUPERSEDE_DEFAULT_REASON,
  tombstone,
} from "./tombstone.ts";
import { appendLogEvent } from "../log.ts";
import { resolveNotePath } from "../note-path.ts";
import { BRAIN_DECISIONS_REL, BRAIN_LOG_REL } from "../path-constants.ts";
import { isoSecond } from "../time.ts";
import { vaultRelative } from "../paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { retargetWikilinks } from "../page-dedup.ts";
import {
  buildClaimGraph,
  whatContests,
  whatReplaced,
  type ClaimGraph,
  type ClaimNode,
} from "../claim-graph.ts";
import { stripWikilinkDecoration } from "../wikilink.ts";
import { correctionEndState, type CorrectionEndState } from "../truth/correction-policy.ts";
import { appendClaimEvent, ClaimWindowRefusal, readClaimEvents } from "../truth/store.ts";
import { isValidityPoint } from "../truth/validity.ts";
import type { ClaimEvent } from "../truth/types.ts";

/** The receipt reason code a validity-close retirement is recorded under. */
const REASON_CODE_SUPERSEDE = "supersede" as const;
/** The receipt reason code a tombstone retirement is recorded under. */
const REASON_CODE_TOMBSTONE = "tombstone" as const;

/** Frontmatter key of a validity window end (the temporal-replace convention). */
const VALID_UNTIL_KEY = "valid_until";

/** The `evidence_triggers` prefix every bundle-correlated receipt carries. */
export const CORRECTION_BUNDLE_TRIGGER_PREFIX = "correction_bundle:";

/**
 * Cap on the rationale the tombstone-path receipt carries, mirroring the
 * shared tombstone writer's own reason cap (`REASON_MAX_LEN` in
 * tombstone.ts): the receipt this sweep mints must be writable under the
 * same limits the writer it stands in for would have met.
 */
const TOMBSTONE_RATIONALE_MAX_LEN = 512;

/** Raised when a correction target or input is refused. */
export class CorrectionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CorrectionError";
  }
}

export interface CorrectInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the record being corrected. */
  readonly target: string;
  /**
   * The corrected value the ledger events assert. Absent: the sweep
   * retires and retargets but appends nothing to the ledger.
   */
  readonly value?: string;
  /**
   * Successor id or wikilink stored as the target's `superseded_by`
   * pointer and used as the mention-retarget destination. Absent: no
   * pointer is written and mentions are only reported.
   */
  readonly successor?: string;
  /** The caller declares the prior claim was never true, not merely superseded. */
  readonly flatlyWrong?: boolean;
  /** Explicit window end for a time-scoped correction (canonical ISO-8601 UTC). */
  readonly windowEnd?: string;
  /** Operator-facing reason for the retirement. */
  readonly reason?: string;
  /**
   * False runs the applied sequence. Absent or true - the default - the
   * sweep only reports the blast radius and writes nothing.
   */
  readonly dryRun?: boolean;
  /** Identity override; resolver default used when omitted or blank. */
  readonly agent?: string;
  /** Wall clock for the correction instant. Defaults to `new Date()`. */
  readonly now?: Date;
  readonly configPath?: string;
  /**
   * The vault-relative paths the caller may read. A target it may not
   * read is refused as a missing one, before anything is written, and
   * every discovered row stays inside the same reach. Absent, every
   * path may be read.
   */
  readonly readable?: (rel: string) => boolean;
}

/** What one discovery found inside the caller's reach. */
export interface CorrectionBlastRadius {
  /** Vault-relative path of the target. */
  readonly target: string;
  /** Claim-graph chain tip that replaced the target, null when unresolved. */
  readonly replacedBy: string | null;
  /** Claim-graph ids contesting the target, sorted. */
  readonly contests: ReadonlyArray<string>;
  /** Files holding at least one mention of the target, sorted, reach-gated. */
  readonly mentions: ReadonlyArray<string>;
  /** Reach-gated ledger events in the target's slots, including the target's own. */
  readonly claims: ReadonlyArray<ClaimEvent>;
}

/** How one target retired. */
export interface CorrectionRetirement {
  readonly path: string;
  readonly endState: CorrectionEndState;
  readonly validUntil: string | null;
  /** The existing receipt reason code the choice is recorded under. */
  readonly reasonCode: typeof REASON_CODE_SUPERSEDE | typeof REASON_CODE_TOMBSTONE;
  /** False when the retirement was already in place (replay). */
  readonly changed: boolean;
}

/** One bundle-correlated receipt the sweep asked for. */
export interface CorrectionReceiptRecord {
  readonly subject: string;
  readonly appended: boolean;
}

/** The outcome of one sweep, dry or applied. */
export interface CorrectResult {
  readonly bundleId: string;
  readonly dryRun: boolean;
  readonly blastRadius: CorrectionBlastRadius;
  /** Empty on a dry run. */
  readonly retirements: ReadonlyArray<CorrectionRetirement>;
  readonly retarget: {
    readonly matched: ReadonlyArray<string>;
    readonly rewritten: ReadonlyArray<string>;
    readonly failed: ReadonlyArray<Readonly<{ path: string; reason: string }>>;
  };
  /** Empty on a dry run. */
  readonly ledger: ReadonlyArray<{
    readonly entity: string;
    readonly aspect: string;
    readonly value: string;
    readonly source: string;
  }>;
  /** Empty on a dry run. */
  readonly receipts: ReadonlyArray<CorrectionReceiptRecord>;
}

/** Resolve the target to a vault-relative path, refusing it as missing. */
function resolveTarget(
  vault: string,
  target: string,
  readable: ((rel: string) => boolean) | undefined,
): string {
  let abs: string;
  try {
    abs = resolveNotePath(vault, target, {
      mustExist: true,
      ...(readable !== undefined ? { readable } : {}),
    });
  } catch (err) {
    throw new CorrectionError(
      `correct: target does not resolve inside the vault: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return vaultRelative(abs, vault);
}

/** The id a record is mentioned and chained under: basename, no extension. */
function idOfRel(rel: string): string {
  return normalizeChainLink(rel);
}

/**
 * The pre-retirement status exactly as the shared tombstone writer reads
 * it before its write (the `scalar()` chain in tombstone.ts): a
 * non-string or empty value reads as "unknown". The sweep's retirement
 * receipt must be spelled with the writer's own key material so the
 * writer's ask dedupes against it - a divergent edge-case spelling here
 * would silently turn one retirement into two receipts.
 */
function priorStatusOf(meta: Readonly<Record<string, unknown>>): string {
  for (const key of [LIFECYCLE_STATUS_KEY, LIFECYCLE_STATUS_KEY_NORMALIZED]) {
    const value = meta[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "unknown";
}

/**
 * The vault-relative path a claim's source spelling names, or null when
 * it names nothing - a source that names no page is provenance text and
 * cannot be reach-gated, so it reads as within reach.
 *
 * The fence comes off (unlike {@link stripWikilinkDecoration}, which
 * keeps it) and the extension stays on, so the gate is asked over the
 * same extension-bearing vault-relative path every other caller hands
 * the readable predicate: claim-graph node paths and mention-scan paths.
 * The previous spelling failed on both ends - a fenced source gated on
 * its `[[...]]` wrapper, an unfenced one on the stripped extension - and
 * an existing, readable source page answered unreadable at remote reach,
 * dropping its claim out of the blast radius. A source that names no
 * page under its literal spelling gates on that spelling - withheld,
 * which is the safe direction.
 */
function sourceRel(source: string): string | null {
  const stripped = stripWikilinkDecoration(source);
  const fenced = /^\[\[([^\]]+)\]\]$/.exec(stripped);
  const body = fenced !== null ? fenced[1]!.trim() : stripped;
  if (body === "") return null;
  return body;
}

/** True when the caller may read the record a claim's source names. */
function claimWithinReach(
  event: ClaimEvent,
  readable: ((rel: string) => boolean) | undefined,
): boolean {
  if (readable === undefined) return true;
  const rel = sourceRel(event.source);
  if (rel === null) return true;
  return readable(rel);
}

function nodeWithinReach(
  node: ClaimNode,
  readable: ((rel: string) => boolean) | undefined,
): boolean {
  return readable === undefined ? true : readable(node.path);
}

/** True when a vault-relative path sits inside the caller's readable set. */
function withinReach(rel: string, readable: ((rel: string) => boolean) | undefined): boolean {
  return readable === undefined || readable(rel);
}

/**
 * Run the correct-verb sweep for one record. Dry by default: the applied
 * sequence runs only under `dryRun: false`.
 */
export function correct(input: CorrectInput): CorrectResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). The
  // counting passes below write nothing and assert nothing themselves;
  // this guard refuses a foreign vault before any of the work runs.
  assertVaultIdentityForWrite(input.vault);
  const target = input.target.trim();
  if (target === "") throw new CorrectionError("correct: target is required");
  const value = input.value?.trim();
  if (input.value !== undefined && value === "") {
    throw new CorrectionError("correct: value must not be empty when given");
  }
  // Same input shape as the value refusal: a successor that normalizes
  // to empty - `|||`, a fence carrying only an alias - would otherwise
  // flow into the `superseded_by` pointer and the mention retarget as a
  // malformed `[[]]`. Refused before anything is written, dry or applied.
  const successorId = input.successor === undefined ? undefined : idOfRel(input.successor);
  if (input.successor !== undefined && successorId === "") {
    throw new CorrectionError("correct: successor must not be empty when given");
  }
  // The window end lands in frontmatter as `valid_until` even when no
  // ledger append runs (no corrected value supplied), so it is validated
  // here with the SAME check the ledger append boundary applies, before
  // anything is written - otherwise a malformed bound would sit in the
  // record unread until a window parse found it.
  if (input.windowEnd !== undefined && !isValidityPoint(input.windowEnd)) {
    throw new CorrectionError(
      `correct: window_end must be a bare ISO date or canonical ISO-8601 UTC instant: ` +
        `${JSON.stringify(input.windowEnd)}`,
    );
  }
  const dryRun = input.dryRun !== false;
  const now = input.now ?? new Date();
  const correctionTs = isoSecond(now);
  const agent = normalizeAgentArgument(input.agent ?? null) ?? resolveAgentName(input.configPath);

  const targetRel = resolveTarget(input.vault, target, input.readable);
  const targetId = idOfRel(targetRel);

  // ----- Discovery (within the caller's reach) -----------------------------
  const graph: ClaimGraph = buildClaimGraph(input.vault, { now });
  const replacedNode = whatReplaced(graph, targetId);
  // A record with no successor pointer is its own chain tip; only a
  // genuine successor counts as what replaced the target.
  const replacedBy =
    replacedNode !== null &&
    replacedNode.id !== targetId &&
    nodeWithinReach(replacedNode, input.readable)
      ? replacedNode.id
      : null;
  const contests = whatContests(graph, targetId)
    .filter((n) => nodeWithinReach(n, input.readable))
    .map((n) => n.id)
    .toSorted();

  // The counting pass of the mention scan: it writes nothing and asserts
  // no vault identity, so the blast radius stays available to a caller
  // that is only deciding whether to write at all. The readable
  // predicate is threaded in so a file outside the caller's reach is
  // never opened, matched or named - the scan's report is filtered
  // through reach again below, as a second gate on the response shape.
  const mentionScan = retargetWikilinks(
    input.vault,
    [{ from: targetId, ...(successorId !== undefined ? { to: successorId } : {}) }],
    {
      apply: false,
      ...(input.readable !== undefined ? { readable: input.readable } : {}),
    },
  );
  const mentions = mentionScan.matched.filter((rel) => withinReach(rel, input.readable));

  const allEvents = readClaimEvents(input.vault).events;
  // The target's own events name the resolved target path - the full
  // vault-relative spelling or its extensionless form - never a bare
  // basename: a basename fold also matched a same-named page in another
  // folder, letting its claims bypass the reach gate below and its
  // source spelling stand in for the target's on an applied correction.
  const namesTarget = (e: ClaimEvent): boolean => {
    const rel = sourceRel(e.source);
    return rel !== null && (rel === targetRel || rel === targetRel.replace(/\.md$/i, ""));
  };
  const targetEvents = allEvents.filter(namesTarget);
  const slots = new Set(targetEvents.map((e) => `${e.entity}\u0000${e.aspect}`));
  const claims = allEvents.filter(
    (e) =>
      slots.has(`${e.entity}\u0000${e.aspect}`) &&
      (namesTarget(e) || claimWithinReach(e, input.readable)),
  );

  const blastRadius: CorrectionBlastRadius = Object.freeze({
    target: targetRel,
    replacedBy,
    contests: Object.freeze(contests),
    mentions: Object.freeze(mentions),
    claims: Object.freeze(claims),
  });

  const stem = targetId.replace(/[^A-Za-z0-9._-]/g, "-");
  const bundleId = `correct-${stem}-${correctionTs.replace(/[-:]/g, "")}`;
  const trigger = `${CORRECTION_BUNDLE_TRIGGER_PREFIX}${bundleId}`;

  if (dryRun) {
    return {
      bundleId,
      dryRun: true,
      blastRadius,
      retirements: Object.freeze([]),
      retarget: {
        // Reach-filtered: the raw scan names every file on disk that
        // matches, which beside the gated blast_radius.mentions would be
        // a one-field disclosure of exactly the withheld paths.
        matched: mentionScan.matched.filter((rel) => withinReach(rel, input.readable)),
        rewritten: Object.freeze([]),
        failed: mentionScan.failed.filter((f) => withinReach(f.path, input.readable)),
      },
      ledger: Object.freeze([]),
      receipts: Object.freeze([]),
    };
  }

  // ----- Applied: ledger, retirement, retargeting, receipts ---------------
  const policy = correctionEndState(
    {
      flatlyWrong: input.flatlyWrong === true,
      ...(input.windowEnd !== undefined ? { windowEnd: input.windowEnd } : {}),
    },
    correctionTs,
  );
  const reasonCode =
    policy.endState === "tombstone" ? REASON_CODE_TOMBSTONE : REASON_CODE_SUPERSEDE;
  const reason = input.reason?.trim() || SUPERSEDE_DEFAULT_REASON;

  // Replay detection FIRST, off the target's frontmatter as it stands:
  // an already-applied retirement makes the sequence a recorded no-op -
  // no double tombstone, no re-closed window, no re-appended event.
  const [rawMeta, body] = parseFrontmatter(join(input.vault, targetRel));
  const meta = rawMeta as FrontmatterMap;
  const storedUntil = meta[VALID_UNTIL_KEY];
  const alreadyRetired =
    policy.endState === "tombstone"
      ? readLifecycleState(meta).tombstoned
      : typeof storedUntil === "string" && storedUntil !== "";

  // Ledger correction events, appended BEFORE the retirement write so the
  // append's open-bound resolution never reads the window this sweep is
  // about to close, and skipped entirely on a replay. Each event keeps
  // the corrected record's own source spelling, so the fold reads the
  // change as self-correction, never a conflict, and opens its validity
  // window at the correction instant - where the predecessor's closed
  // window ends.
  const ledger: Array<CorrectResult["ledger"][number]> = [];
  if (value !== undefined && !alreadyRetired) {
    const sourceBySlot = new Map<string, string>();
    for (const e of targetEvents) {
      const key = `${e.entity}\u0000${e.aspect}`;
      if (!sourceBySlot.has(key)) sourceBySlot.set(key, e.source);
    }
    for (const [key, source] of sourceBySlot) {
      const [entity, aspect] = key.split("\u0000");
      // A record already validity-closed carries a stored window end
      // BEFORE this correction instant, and the append below resolves
      // its open until-bound from that very frontmatter - the close a
      // previous sweep wrote - so the store refuses the inverted window.
      // That is the replay having CONVERGED, not an internal fault: it
      // surfaces as the verb's named refusal class, strict (nothing was
      // written), naming the record and the close that blocks it.
      try {
        appendClaimEvent(
          input.vault,
          {
            ts: correctionTs,
            agent,
            entity: entity!,
            aspect: aspect!,
            value,
            source,
            validFrom: correctionTs,
          },
          input.configPath !== undefined ? { configPath: input.configPath } : undefined,
        );
      } catch (err) {
        if (err instanceof ClaimWindowRefusal) {
          throw new CorrectionError(
            `correct: ${targetRel} is already validity-closed` +
              (typeof storedUntil === "string" && storedUntil !== "" ? ` at ${storedUntil}` : "") +
              `, before this correction; the replay has converged, so the ledger ` +
              `correction is refused rather than written with an inverted window`,
            { cause: err },
          );
        }
        throw err;
      }
      ledger.push(Object.freeze({ entity: entity!, aspect: aspect!, value, source }));
    }
  }

  const retirements: CorrectionRetirement[] = [];
  // Bundle-correlated receipts: one for the retirement decision and one
  // per corrected slot. Asking is idempotent, so a replay reports
  // appended: false instead of doubling the record.
  const receipts: CorrectionReceiptRecord[] = [];
  const askReceipt = (subject: string, before: string, after: string): void => {
    // Fail-soft, the same discipline the tombstone pre-receipt below
    // applies: an accountability-log hiccup must never abort an applied
    // sweep whose writes have already landed. A failed ask is reported
    // (it reads as not appended), never fatal.
    let appended = false;
    try {
      const res = appendDecisionChangeReceipt(input.vault, {
        subject,
        before,
        after,
        actor: agent,
        reasonCode,
        rationale: reason,
        evidenceTriggers: [trigger],
        ts: correctionTs,
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
      appended = res.appended;
    } catch {
      // The retirement and the ledger events are already on disk; the
      // missing receipt surfaces through the response's appended: false.
    }
    receipts.push(Object.freeze({ subject, appended }));
  };
  if (alreadyRetired) {
    retirements.push(
      Object.freeze({
        path: targetRel,
        endState: policy.endState,
        validUntil: policy.endState === "tombstone" ? null : (storedUntil as string),
        reasonCode,
        changed: false,
      }),
    );
    if (policy.endState === "tombstone") {
      // Replay of a tombstone retirement: the first run's pre-retirement
      // status is gone from the frontmatter THIS run re-read (the first
      // run stamped `_status: tombstoned` over it), so the sweep cannot
      // re-derive the idempotency key its first receipt was written
      // under - asking again would mint a fresh no-change receipt under
      // a mutated key. The receipt already stands on disk; report it as
      // not appended.
      receipts.push(Object.freeze({ subject: targetRel, appended: false }));
    } else {
      // The receipt describes the state on disk, so a replay names the
      // SAME close instant the first run recorded and its idempotency
      // key matches.
      askReceipt(
        targetRel,
        `status:${priorStatusOf(meta)}`,
        `validity_close until ${storedUntil as string}`,
      );
    }
  } else if (policy.endState === "tombstone") {
    // Bundle-trigger carry. The shared tombstone writer appends its OWN
    // decision-change receipt after the write, keyed on
    // (subject, before, after) with no evidence triggers. This sweep's
    // ask goes FIRST, spelled with the writer's exact key material and
    // carrying correction_bundle:<bundleId>, so the writer's own ask
    // dedupes against it and exactly ONE receipt records the retirement
    // - the sweep's, naming the bundle. The spelling mirrors
    // tombstone.ts's receipt block; the tombstone-receipt tests in
    // correction.test.ts pin the coupling. Fail-soft, mirroring the
    // writer's own receipt discipline: an accountability-log hiccup must
    // never fail the retirement itself.
    const pointer = successorId ? `[[${successorId}]]` : null;
    let receiptAppended = false;
    try {
      const pre = appendDecisionChangeReceipt(input.vault, {
        subject: targetRel,
        before: `status:${priorStatusOf(meta)}`,
        after:
          pointer !== null ? `status:tombstoned superseded_by:${pointer}` : "status:tombstoned",
        actor: agent,
        reasonCode: REASON_CODE_TOMBSTONE,
        rationale: sanitiseTextField(reason, {
          maxLen: TOMBSTONE_RATIONALE_MAX_LEN,
          singleLine: true,
        }).trim(),
        evidenceTriggers: [trigger],
        ts: correctionTs,
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
      receiptAppended = pre.appended;
    } catch {
      // The writer's own receipt below still records the retirement,
      // without the bundle trigger.
    }
    receipts.push(Object.freeze({ subject: targetRel, appended: receiptAppended }));
    const res = tombstone({
      vault: input.vault,
      path: targetRel,
      reason,
      ...(successorId !== undefined ? { supersededBy: successorId } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      ...(input.readable !== undefined ? { readable: input.readable } : {}),
    });
    retirements.push(
      Object.freeze({
        path: res.path,
        endState: "tombstone",
        validUntil: null,
        reasonCode: REASON_CODE_TOMBSTONE,
        changed: res.changed,
      }),
    );
  } else {
    // Validity close (the temporal-replace frontmatter convention): the
    // record stays on disk and serveable inside its historical window,
    // pointing at its successor when one is named.
    const nextMeta: FrontmatterMap = { ...meta };
    nextMeta[VALID_UNTIL_KEY] = policy.validUntil ?? correctionTs;
    if (successorId !== undefined) {
      nextMeta[SUPERSEDED_BY_KEY] = `[[${successorId}]]`;
    }
    try {
      writeFrontmatterAtomic(join(input.vault, targetRel), nextMeta, body, { overwrite: true });
    } catch (err) {
      throw new CorrectionError(
        `correct: failed to close validity on ${targetRel}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    appendLogEvent(input.vault, {
      timestamp: correctionTs,
      eventType: BRAIN_LOG_EVENT_KIND.temporalReplace,
      body: {
        predecessor: targetRel,
        ...(successorId !== undefined ? { successor: successorId } : {}),
        at: policy.validUntil ?? correctionTs,
        agent,
      },
    });
    retirements.push(
      Object.freeze({
        path: targetRel,
        endState: "validity_close",
        validUntil: policy.validUntil ?? correctionTs,
        reasonCode: REASON_CODE_SUPERSEDE,
        changed: true,
      }),
    );
    askReceipt(
      targetRel,
      `status:${priorStatusOf(meta)}`,
      `validity_close until ${policy.validUntil ?? correctionTs}`,
    );
  }

  // Mention retargeting reuses the counting scan's own matcher with
  // writes on; the applied pass is idempotent (a rewritten spelling no
  // longer matches), and Brain/log and the receipt lines are testimony
  // that is never rewritten. Failures are carried, not thrown. The
  // caller's readable predicate is threaded in: a page outside the
  // caller's reach is never opened, never rewritten, never named - the
  // applied pass may not write into files its caller cannot read.
  const appliedRetarget = retargetWikilinks(
    input.vault,
    [{ from: targetId, ...(successorId !== undefined ? { to: successorId } : {}) }],
    {
      neverRewrite: [BRAIN_LOG_REL, BRAIN_DECISIONS_REL],
      ...(input.readable !== undefined ? { readable: input.readable } : {}),
    },
  );

  // Bundle-correlated receipts for the corrected slots: one per slot the
  // ledger appended to, under the same bundle trigger as the retirement.
  for (const entry of ledger) {
    askReceipt(`${entry.entity}/${entry.aspect}`, `value:${entry.source}`, `value:${entry.value}`);
  }

  return {
    bundleId,
    dryRun: false,
    blastRadius,
    retirements: Object.freeze(retirements),
    retarget: {
      // Reach-filtered, like the dry run: only in-reach paths are disclosed.
      matched: appliedRetarget.matched.filter((rel) => withinReach(rel, input.readable)),
      rewritten: appliedRetarget.rewritten.filter((rel) => withinReach(rel, input.readable)),
      failed: appliedRetarget.failed.filter((f) => withinReach(f.path, input.readable)),
    },
    ledger: Object.freeze(ledger),
    receipts: Object.freeze(receipts),
  };
}
