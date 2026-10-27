/**
 * One-command recovery for dead extraction writes (t_50794f57).
 *
 * A dead letter used to be a fact without an exit: the record named what
 * failed and what it was writing, and every reader - operator or agent -
 * had to work out alone what to do next. This module is the exit. It
 * reads a letter against the vault's CURRENT state and answers one of
 * five questions, each with its exact copy-paste command where one
 * exists:
 *
 *   - {@link DEAD_LETTER_RECOVERY_CATEGORY.recover} - the letter carries
 *     its frozen schema-2 payload, the session is still
 *     capture-classified, and at least one missing item is still not on
 *     disk: re-run the recorded payload.
 *   - {@link DEAD_LETTER_RECOVERY_CATEGORY.pending} - the session's
 *     landed items sit staged in the write-approval queue: the exit is
 *     the queue, not a re-run.
 *   - {@link DEAD_LETTER_RECOVERY_CATEGORY.reExtract} - nothing to
 *     re-run (a payload-less v1 letter, a payload that no longer passes
 *     the lane's own validation): mine the session again.
 *   - {@link DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable} - an unknown
 *     lane, a session the import ledger does not know, or a session the
 *     capture boundary now refuses: no command, the reason is the
 *     answer.
 *   - {@link DEAD_LETTER_RECOVERY_CATEGORY.resolved} - every missing key
 *     now exists on disk: nothing to do. This fifth state exists because
 *     the retention rule keeps reconciled letters on disk forever, and a
 *     reconciled row must not read as still-broken.
 *
 * ## Re-admission means re-run at current state, never at a recorded
 *    revision
 *
 * The extraction-signal lane carries no revision counter - its
 * concurrency story is the content-derived dedup hash plus atomic
 * per-file writes - so {@link applyRecovery} hands the recorded payload
 * straight back to `commitExtractedSignals`, which re-derives the
 * capture boundary, the dedup index and the staging lane at call time.
 * Already-written items dedup away; nothing stale is ever replayed.
 *
 * ## Nothing here deletes a letter
 *
 * The retention rule stands: no tool removes a dead letter. Recovery
 * writes signals, never record files; a reconciled letter is an
 * operator's hand-deletion decision on a named file, exactly as before.
 */

import { readFileSync } from "node:fs";

import { buildCaptureBoundary } from "./capture-boundary.ts";
import { buildDedupIndex, computeDedupHash } from "./dedup-hash.ts";
import { type DeadLetterPayload, type DeadLetterRecord, isDeadLetterLane } from "./dead-letter.ts";
import {
  commitExtractedSignals,
  type CommitExtractedSignalsResult,
  type ExtractedSignalItem,
} from "./extract-signals.ts";
import { classifyDurability, resolveDurabilityDenylist } from "./gates/durability.ts";
import { listPending, resolveWriteApprovalEnabled } from "./pending.ts";
import { assertResponseCheck } from "./response-checks.ts";
import {
  EXTRACTED_SIGNALS_SHAPE,
  EXTRACTED_SIGNALS_SURFACE,
  assertResponseShape,
} from "./response-shape.ts";
import { listSessionRawTurns } from "./session-recall.ts";
import { parseFrontmatterText } from "../vault.ts";

// ----- Vocabulary -----------------------------------------------------------

/** The five honest states a dead letter can be in, named once. */
export const DEAD_LETTER_RECOVERY_CATEGORY = Object.freeze({
  recover: "recover",
  pending: "pending",
  reExtract: "re-extract",
  notRecoverable: "not_recoverable",
  resolved: "resolved",
} as const);

export type DeadLetterRecoveryCategory =
  (typeof DEAD_LETTER_RECOVERY_CATEGORY)[keyof typeof DEAD_LETTER_RECOVERY_CATEGORY];

/** What one recorded payload item will do when the recovery re-runs it. */
export const DEAD_LETTER_ITEM_VERDICT = Object.freeze({
  /** The item writes fresh. */
  write: "write",
  /** The item writes, into the write-approval queue. */
  staged: "staged",
  /** The item is already on disk; the commit's dedup recognizes it. */
  dedup: "dedup",
  /** The item fails the durability gate; the commit refuses it by name. */
  refused: "refused",
} as const);

export type DeadLetterRecoveryItemVerdict =
  (typeof DEAD_LETTER_ITEM_VERDICT)[keyof typeof DEAD_LETTER_ITEM_VERDICT];

/** One classification: the state, why, and the command that resolves it. */
export interface DeadLetterClassification {
  readonly category: DeadLetterRecoveryCategory;
  /** Why this letter is in this state, for the row rendering. */
  readonly reason: string;
  /**
   * The exact copy-paste command, or `null` when no command resolves the
   * state - `not_recoverable` and `resolved` rows carry their reason
   * instead of inventing an exit.
   */
  readonly command: string | null;
}

/** One payload item's forecast for the dry run. */
export interface DeadLetterRecoveryItemPlan {
  readonly topic: string;
  readonly verdict: DeadLetterRecoveryItemVerdict;
  /** The durability gate's refusal, for a {@link DEAD_LETTER_ITEM_VERDICT.refused} item. */
  readonly reason?: string;
}

/** The dry-run view of one recoverable letter: its state plus per-item verdicts. */
export interface DeadLetterRecoveryPlan {
  readonly classification: DeadLetterClassification;
  readonly items: ReadonlyArray<DeadLetterRecoveryItemPlan>;
}

/** A recovery was asked for a letter that cannot carry one. */
export class DeadLetterRecoveryError extends Error {
  readonly category: DeadLetterRecoveryCategory;
  constructor(message: string, category: DeadLetterRecoveryCategory) {
    super(message);
    this.name = "DeadLetterRecoveryError";
    this.category = category;
  }
}

/**
 * The classification's copy-paste command, appended to a refusal that
 * names the classification: the operator (or agent) holding the error
 * alone gets the same exit the listing would have rendered, instead of
 * having to re-derive it. Null for the states that carry no command.
 */
function nextCommandSuffix(command: string | null): string {
  return command !== null ? ` (next: ${command})` : "";
}

// ----- Command spelling -----------------------------------------------------

/**
 * The copy-paste command shapes, composed from the verb spellings their
 * surfaces own. The recovery command is the HEADLESS spelling -
 * dry-run-default verbs refuse `--apply` without `--yes` under `--json`
 * or a non-TTY stdin, and a copy-paste command must work in exactly
 * those contexts.
 */
const RECOVER_COMMAND_PREFIX = "o2b brain dead-letters recover";
const PENDING_APPLY_COMMAND = "o2b brain pending apply";
const EXTRACT_SIGNALS_COMMAND = "o2b brain extract-signals";

// ----- Payload identity -----------------------------------------------------

/**
 * The extraction lane's payload, validated with the SAME gates the commit
 * applies, or `null` when the letter carries nothing this build may
 * re-run. A payload that fails the shape or the semantic checks cannot be
 * re-committed verbatim - handing it to the commit would only re-refuse
 * it - so the classifier reads that state as `re-extract` rather than as
 * `recover`.
 */
function recoverablePayload(record: DeadLetterRecord): {
  readonly items: ReadonlyArray<ExtractedSignalItem>;
} | null {
  const payload: DeadLetterPayload | undefined = record.payload;
  if (payload === undefined) return null;
  const items = payload["items"];
  if (!Array.isArray(items) || items.length === 0) return null;
  try {
    assertResponseShape(EXTRACTED_SIGNALS_SURFACE, EXTRACTED_SIGNALS_SHAPE, payload);
    assertResponseCheck(EXTRACTED_SIGNALS_SURFACE, payload);
  } catch {
    return null;
  }
  return { items: (payload as { items: ReadonlyArray<ExtractedSignalItem> }).items };
}

/** The `items[<index>]:<topic>` key the commit names every unwritten item by. */
const MISSING_KEY_RE = /^items\[(\d+)\]:(.+)$/;

/**
 * The payload indices the letter's `missing` keys name - the only items
 * a recovery plans or re-runs. Keys this build cannot parse name no
 * item and contribute nothing.
 */
function missingItemIndices(missing: ReadonlyArray<string>): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const key of missing) {
    const match = MISSING_KEY_RE.exec(key);
    if (match !== null) indices.add(Number(match[1]));
  }
  return indices;
}

/**
 * The dedup hash one recorded item will dedup against, composed exactly
 * as `commitExtractedSignals` composes it - the same fields, the same
 * scope trim - so the classifier's forecast and the commit's decision
 * cannot disagree.
 */
function itemDedupHash(item: ExtractedSignalItem): string {
  const scope = item.scope?.trim();
  return computeDedupHash({
    topic: item.topic,
    signal: item.signal,
    principle: item.principle,
    ...(scope ? { scope } : {}),
  });
}

/**
 * Every delivered missing key, measured against the dedup index - the
 * project's own definition of "this signal content exists". A missing
 * key whose index or topic does not resolve to a recorded item is
 * undelivered: a key this letter's payload cannot vouch for is not
 * confirmed by a guess.
 */
function countDeliveredByHash(
  missing: ReadonlyArray<string>,
  items: ReadonlyArray<ExtractedSignalItem>,
  dedup: ReadonlyMap<string, unknown>,
): number {
  let delivered = 0;
  for (const key of missing) {
    const match = MISSING_KEY_RE.exec(key);
    if (match === null) continue;
    const item = items[Number(match[1])];
    if (item === undefined) continue;
    if (dedup.has(itemDedupHash(item))) delivered += 1;
  }
  return delivered;
}

/**
 * The inbox topics a payload-less (schema-1) letter can be re-measured
 * against: the `topic` frontmatter of the session's OWN signal pages -
 * the pages the dedup index walks whose `session_ref` names this
 * letter's session. A signal from another session confirms nothing
 * about what THIS session's commit delivered, and counting it would
 * read a real partial write as resolved. A page that carries no
 * readable topic confirms nothing either.
 */
function inboxSignalTopics(
  dedup: ReturnType<typeof buildDedupIndex>,
  sessionRef: string,
): ReadonlySet<string> {
  const topics = new Set<string>();
  for (const entry of dedup.values()) {
    try {
      const meta = parseFrontmatterText(readFileSync(entry.path, "utf8"))[0];
      if (meta["session_ref"] !== sessionRef) continue;
      const topic = meta["topic"];
      if (typeof topic === "string") topics.add(topic);
    } catch {
      // A signal page that cannot be read cannot confirm a topic. That
      // is the conservative direction: the row stays actionable.
    }
  }
  return topics;
}

function countDeliveredByTopic(
  missing: ReadonlyArray<string>,
  topics: ReadonlySet<string>,
): number {
  let delivered = 0;
  for (const key of missing) {
    const match = MISSING_KEY_RE.exec(key);
    if (match === null) continue;
    if (topics.has(match[2] ?? "")) delivered += 1;
  }
  return delivered;
}

// ----- Classification -------------------------------------------------------

/**
 * Classify one dead letter against the vault's current state. Total: the
 * five categories cover every letter this build can read, and the checks
 * run in the order the states are decided in - a fully delivered row is
 * `resolved` whatever else changed, a refused or unknown session is
 * `not_recoverable` whatever the payload promises, and only a live
 * session with undelivered items and a re-runnable payload is
 * `recover`.
 */
export function classifyDeadLetter(
  vault: string,
  record: DeadLetterRecord,
): DeadLetterClassification {
  if (!isDeadLetterLane(record.lane)) {
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable,
      reason:
        `dead-letter lane ${JSON.stringify(record.lane)} is unknown to this build; the lane ` +
        "union is closed on purpose",
      command: null,
    });
  }

  // The resolved re-measure needs no session state: it answers whether
  // the letter's subject - its missing items - exists on disk, which is
  // true even if the session has since been ignored or forgotten.
  const payload = recoverablePayload(record);
  const dedup = buildDedupIndex(vault);
  const delivered =
    payload !== null
      ? countDeliveredByHash(record.missing, payload.items, dedup)
      : countDeliveredByTopic(record.missing, inboxSignalTopics(dedup, record.reference));
  if (record.missing.length > 0 && delivered === record.missing.length) {
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.resolved,
      reason: `all ${record.missing.length} missing item(s) are now on disk`,
      command: null,
    });
  }

  const boundary = buildCaptureBoundary(vault);
  const decision = boundary.sessionDecision(record.reference);
  if (decision !== "capture") {
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable,
      reason:
        `session ${record.reference} is classified '${decision}' by the capture boundary; ` +
        "it may not produce signals",
      command: null,
    });
  }
  if (listSessionRawTurns(vault, record.reference).length === 0) {
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable,
      reason:
        `session ${record.reference} has no imported turns; the import ledger does not know it. ` +
        "Import it first with 'o2b brain import-session --recall'",
      command: null,
    });
  }

  const staged = listPending(vault).filter(
    (entry) => entry.signal.session_ref === record.reference,
  );
  if (staged.length > 0 && staged[0] !== undefined) {
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.pending,
      reason:
        `${staged.length} staged signal(s) for this session sit in the write-approval queue; ` +
        "review the queue instead of re-running the payload",
      command: `${PENDING_APPLY_COMMAND} ${staged[0].id}`,
    });
  }

  if (payload !== null) {
    const undelivered = record.missing.length - delivered;
    return Object.freeze({
      category: DEAD_LETTER_RECOVERY_CATEGORY.recover,
      reason:
        `${undelivered} of ${record.missing.length} missing item(s) are not yet on disk; ` +
        "the frozen payload can be re-run at current vault state",
      command: `${RECOVER_COMMAND_PREFIX} ${record.id} --apply --yes`,
    });
  }

  return Object.freeze({
    category: DEAD_LETTER_RECOVERY_CATEGORY.reExtract,
    reason: "the letter carries no frozen payload to re-run; mine the session again",
    command: `${EXTRACT_SIGNALS_COMMAND} ${record.reference}`,
  });
}

// ----- Plan and apply -------------------------------------------------------

/** Test and caller seams for {@link planRecovery}, mirroring the commit's own options. */
export interface PlanRecoveryOptions {
  /** Pre-compiled durability denylist; resolved from config when omitted. */
  readonly durabilityDenylist?: ReadonlyArray<RegExp>;
  /** Write-approval toggle; resolved from config when omitted. */
  readonly writeApprovalEnabled?: boolean;
}

/**
 * The dry-run forecast: the letter's classification plus one verdict per
 * recorded payload item, computed with the same gates in the same order
 * the commit applies them - dedup, then the durability gate, then the
 * staging lane. A forecast is a reading of current state, not a promise:
 * the apply re-derives every gate at call time.
 */
export function planRecovery(
  vault: string,
  record: DeadLetterRecord,
  opts: PlanRecoveryOptions = {},
): DeadLetterRecoveryPlan {
  const classification = classifyDeadLetter(vault, record);
  if (classification.category !== DEAD_LETTER_RECOVERY_CATEGORY.recover) {
    // Worded without assuming why: a resolved or not_recoverable v2
    // letter still carries its frozen payload, so "carries no payload"
    // would be false exactly where the classification is the point.
    throw new DeadLetterRecoveryError(
      `dead letter ${record.id} cannot be planned as a payload re-run: classified ` +
        `'${classification.category}' (${classification.reason})` +
        nextCommandSuffix(classification.command),
      classification.category,
    );
  }
  const payload = recoverablePayload(record);
  if (payload === null) {
    throw new DeadLetterRecoveryError(
      `dead letter ${record.id} classified recover but carries no readable payload`,
      DEAD_LETTER_RECOVERY_CATEGORY.recover,
    );
  }
  const dedup = buildDedupIndex(vault);
  const denylist = opts.durabilityDenylist ?? resolveDurabilityDenylist();
  const staged = opts.writeApprovalEnabled ?? resolveWriteApprovalEnabled();
  // The plan previews exactly what the apply would re-run: the MISSING
  // items, never the whole payload. The items that landed before the
  // failure are not recovery's input - replaying them would resurrect
  // any one an operator removed afterwards (a deleted signal, a
  // rejected queue row the dedup index never walked).
  const missingIndices = missingItemIndices(record.missing);
  return Object.freeze({
    classification,
    items: Object.freeze(
      payload.items
        .map((item, index) => ({ item, index }))
        .filter(({ index }) => missingIndices.has(index))
        .map(({ item }) => {
          if (dedup.has(itemDedupHash(item))) {
            return Object.freeze({ topic: item.topic, verdict: DEAD_LETTER_ITEM_VERDICT.dedup });
          }
          const verdict = classifyDurability(item.principle, { denylist });
          if (!verdict.durable) {
            return Object.freeze({
              topic: item.topic,
              verdict: DEAD_LETTER_ITEM_VERDICT.refused,
              ...(verdict.reason !== null ? { reason: verdict.reason } : {}),
            });
          }
          return Object.freeze({
            topic: item.topic,
            verdict: staged ? DEAD_LETTER_ITEM_VERDICT.staged : DEAD_LETTER_ITEM_VERDICT.write,
          });
        }),
    ),
  });
}

export interface ApplyRecoveryOptions {
  /** Acting agent name for the re-run commit. */
  readonly agent: string;
  readonly now: Date;
  /** Write-approval toggle; resolved from config when omitted. */
  readonly writeApprovalEnabled?: boolean;
}

/**
 * Re-run a letter's frozen payload through the extraction commit, at
 * CURRENT vault state. Refuses by name when the letter is not classified
 * `recover` - a v1 letter, a staged row or a resolved row is not this
 * verb's input - and never touches the letter itself: the retention rule
 * keeps every record on disk.
 */
export function applyRecovery(
  vault: string,
  record: DeadLetterRecord,
  opts: ApplyRecoveryOptions,
): CommitExtractedSignalsResult {
  const classification = classifyDeadLetter(vault, record);
  if (classification.category !== DEAD_LETTER_RECOVERY_CATEGORY.recover) {
    throw new DeadLetterRecoveryError(
      `dead letter ${record.id} cannot be recovered by re-running a payload: classified ` +
        `'${classification.category}' (${classification.reason})` +
        nextCommandSuffix(classification.command),
      classification.category,
    );
  }
  const payload = recoverablePayload(record);
  if (payload === null) {
    throw new DeadLetterRecoveryError(
      `dead letter ${record.id} classified recover but carries no readable payload`,
      DEAD_LETTER_RECOVERY_CATEGORY.recover,
    );
  }
  // The re-run commits exactly the MISSING items, never the whole
  // payload: the items that landed before the failure are not recovery's
  // input, and replaying them would resurrect any one an operator
  // removed afterwards - a deleted signal, or a rejected queue row,
  // neither of which the dedup index walks. "Nothing stale is replayed"
  // is the module's own promise.
  const missingIndices = missingItemIndices(record.missing);
  const toReplay = payload.items.filter((_, index) => missingIndices.has(index));
  return commitExtractedSignals(
    vault,
    record.reference,
    { items: toReplay },
    {
      agent: opts.agent,
      now: opts.now,
      ...(opts.writeApprovalEnabled !== undefined
        ? { writeApprovalEnabled: opts.writeApprovalEnabled }
        : {}),
    },
  );
}
