/**
 * Model-mined session signals (salience-lifecycle-enrichment, unit 2,
 * t_1dace26d).
 *
 * `fact-extract.ts` mines a session turn with regexes, which is why it can
 * run inside the live capture hook: it costs nothing and knows no language.
 * The price is that it only ever recognises structure - a URL, an address,
 * a unit-bound number - so every stated preference in a transcript is
 * invisible to it. This module is the batch counterpart: it hands the
 * calling agent the user turns of an ALREADY-IMPORTED session and asks for
 * the taste signals in them. OSB still calls no model; it owns the turns it
 * offers, the limits the answer must satisfy, and the write.
 *
 * Two phases, diarization-shaped:
 *
 *   1. {@link planExtractSignals} - read-only. Resolves the session's
 *      imported turns, keeps the USER ones (the import path's rule at
 *      `sessions/import.ts`: bare assistant output is never auto-extracted),
 *      and returns a report carrying exactly one needs-llm-step envelope.
 *   2. {@link commitExtractedSignals} - validates the returned payload
 *      structurally ({@link EXTRACTED_SIGNALS_SHAPE}) and semantically (the
 *      per-session cap and the per-item confidence floor, registered on the
 *      semantic-check registry because neither is expressible in a
 *      descriptor), then routes the accepted items through the same helper
 *      chain the deterministic extractor uses.
 *
 * Everything written here is SPECULATIVE. The items land in `Brain/inbox/`
 * as `source_type: auto_extract` signals - a member of its own so a
 * model-authored signal is distinguishable from a regex-authored one
 * forever - and the inbox trial lane plus the dream pass remains the only
 * route to a confirmed preference. Nothing here writes a preference.
 *
 * Precision beats recall, as it does in `fact-extract.ts`: the cap and the
 * floor are refusals, not filters. A payload over either limit is rejected
 * whole and named, because an over-eager mine that silently kept its best
 * twelve would teach the caller nothing about what it asked for.
 */

import { posix } from "node:path";

import { buildReconciliationReport, type ReconciliationReport } from "../reconciliation-report.ts";
import { buildCaptureBoundary, type SessionCaptureDecision } from "./capture-boundary.ts";
import { tryRecordDeadLetter, type DeadLetterLane, type DeadLetterOutcome } from "./dead-letter.ts";
import { buildDedupIndex, computeDedupHash, type DedupIndexEntry } from "./dedup-hash.ts";
import { classifyDurability, resolveDurabilityDenylist } from "./gates/durability.ts";
import { buildNeedsLlmStep, type NeedsLlmStep } from "./llm-step.ts";
import { brainDirsForWrite } from "./paths.ts";
import { resolveWriteApprovalEnabled } from "./pending.ts";
import {
  assertResponseCheck,
  registerResponseCheck,
  SEMANTIC_VIOLATION_CODES,
  semanticViolation,
  type SemanticViolation,
} from "./response-checks.ts";
import {
  assertResponseShape,
  EXTRACTED_SIGNALS_SHAPE,
  EXTRACTED_SIGNALS_SURFACE,
  SHAPE_ROOT_PATH,
} from "./response-shape.ts";
import { listSessionRawTurns } from "./session-recall.ts";
import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE, type BrainSignalSign } from "./types.ts";

/** Vault-relative directory an accepted auto-extracted signal lands in. */
export const AUTO_EXTRACT_TARGET_DIR_REL = "Brain/inbox";

/** The needs-llm-step step name for the deferred signal mining. */
export const EXTRACT_SIGNALS_STEP = "extract-signals";

/**
 * This lane's dead-letter name. It is the ONE multi-artifact commit lane
 * in the tree - one file per mined item from one validated payload - and
 * so the only one that can leave a partial write behind.
 */
const EXTRACT_SIGNALS_LANE: DeadLetterLane = "extract-signals";

/**
 * Most signals one session may yield. A transcript that genuinely states
 * more than this many durable preferences is a transcript worth reading by
 * hand; past the cap the mine is guessing, and guesses at inbox scale cost
 * more to retire than they ever pay back.
 */
export const AUTO_EXTRACT_PER_SESSION_CAP = 12;

/**
 * Lowest confidence an item may carry. The floor sits above a coin flip on
 * purpose: an item the caller is not clearly sure of is exactly the item
 * whose retirement will cost an operator a review.
 */
export const AUTO_EXTRACT_CONFIDENCE_FLOOR = 0.6;

/** The role whose turns are mining material - the import path's rule. */
const MINED_TURN_ROLE = "user";

/** Per-turn text budget in the prompt, so one huge turn cannot crowd out the rest. */
const PROMPT_TURN_TEXT_MAX = 2000;

/** A signal extraction could not proceed, and the reason is in the message. */
export class ExtractSignalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractSignalsError";
  }
}

/**
 * A write failed PART WAY through the accepted items.
 *
 * The commit writes one file per item, so a failure on the fourth leaves
 * three signals on disk. The house precedent for that state is
 * `ArchWriteError` (`architect/generate.ts`): a partial write reports how
 * far it got rather than throwing a bare cause and leaving the caller to
 * guess. This is that error for this lane - the ids already written are
 * ON it, so an operator can find them, and re-running the same payload is
 * safe because the dedup index recognises every one of them.
 *
 * Since nothing-writes-silently it carries two further things. The first
 * is {@link reconciliation}: the same `attempted` / `found` / `missing`
 * report shape the import read-back census and the embedder audit use, so
 * this lane's accounting is not a fourth dialect of the same three
 * numbers. The second is {@link deadLetter}: this error's own accounting
 * lives exactly as long as the response carrying it, and a caller that
 * drops the response must not be the only record that a partial write
 * happened - so the accounting is ALSO on disk, and this field says
 * where, or why it could not be.
 *
 * Not an {@link ExtractSignalsError}: that class is the caller's fault
 * and the surfaces report it as such. A filesystem that refused a write
 * is not.
 */
export class ExtractSignalsWriteError extends Error {
  /** The item whose write failed. */
  readonly topic: string;
  /** Signals whose bytes are already on disk, in write order. */
  readonly written: ReadonlyArray<ExtractedSignalWrite>;
  /** Payload items this call never reached, the failing one included. */
  readonly remaining: number;
  /** Attempted / found / missing for this commit, missing keys named. */
  readonly reconciliation: ReconciliationReport;
  /** The error that stopped the commit, kept as thrown. */
  readonly firstError: unknown;
  /** Where the durable record of this partial write landed, or why not. */
  readonly deadLetter: DeadLetterOutcome;

  constructor(params: {
    readonly topic: string;
    readonly written: ReadonlyArray<ExtractedSignalWrite>;
    readonly remaining: number;
    readonly reconciliation: ReconciliationReport;
    readonly cause: unknown;
    readonly deadLetter: DeadLetterOutcome;
  }) {
    const { topic, written, remaining, reconciliation, cause, deadLetter } = params;
    super(
      `failed to write extracted signal ${JSON.stringify(topic)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)} - ` +
        `attempted ${reconciliation.attempted}, written ${reconciliation.found}, ` +
        `failed ${reconciliation.missing.length} (${reconciliation.missing.join(", ")}); ` +
        `${written.length} signal(s) are already on disk ` +
        `(${written.length === 0 ? "none" : written.map((w) => w.id).join(", ")}) and ` +
        `${remaining} payload item(s) were not reached; ${describeDeadLetter(deadLetter)}; ` +
        "fix the cause and re-run the same payload, which dedups what is already there",
      { cause },
    );
    this.name = "ExtractSignalsWriteError";
    this.topic = topic;
    this.written = Object.freeze([...written]);
    this.remaining = remaining;
    this.reconciliation = reconciliation;
    this.firstError = cause;
    this.deadLetter = deadLetter;
  }
}

/** The dead-letter half of the message above, either way it went. */
function describeDeadLetter(outcome: DeadLetterOutcome): string {
  return outcome.recorded
    ? `a dead letter recording this is at ${outcome.path} (${outcome.id})`
    : `NO dead letter could be recorded for it (${outcome.reason})`;
}

/** One user turn offered to the caller as mining material. */
export interface MinedTurn {
  readonly turnId: string;
  readonly text: string;
}

/** Phase-one report: what will be mined, and the one envelope that mines it. */
export interface SignalExtractionPlan {
  readonly sessionId: string;
  readonly generatedAt: string;
  /** Capture-boundary verdict for the session; always `capture` here. */
  readonly boundaryDecision: SessionCaptureDecision;
  /** Imported turns of every role, before the user filter. */
  readonly turnsScanned: number;
  /** The user turns the prompt embeds, in record order. */
  readonly turnsMined: ReadonlyArray<MinedTurn>;
  /** The limits the payload will be held to, echoed so the caller can read them. */
  readonly cap: number;
  readonly confidenceFloor: number;
  readonly llmStep: NeedsLlmStep;
}

/** One mined taste signal, as the calling agent returns it. */
export interface ExtractedSignalItem {
  readonly topic: string;
  readonly signal: BrainSignalSign;
  readonly principle: string;
  readonly confidence: number;
  readonly scope?: string;
}

/** One item the durability gate refused, named rather than dropped. */
export interface ExtractedSignalRejection {
  readonly topic: string;
  readonly reason: string;
}

/** One item that reached disk, with the coordinates it landed at. */
export interface ExtractedSignalWrite {
  readonly id: string;
  readonly path: string;
  readonly topic: string;
}

export interface CommitExtractedSignalsResult {
  readonly sessionId: string;
  readonly written: ReadonlyArray<ExtractedSignalWrite>;
  /**
   * How many of {@link written} were STAGED into `Brain/pending/` rather
   * than written straight to the inbox. Zero when write approval is off.
   */
  readonly staged: number;
  readonly deduped: number;
  /** Items the durability gate refused; each is named in {@link rejected}. */
  readonly durabilityRejected: number;
  readonly rejected: ReadonlyArray<ExtractedSignalRejection>;
  /**
   * Write accounting in the wave's shared vocabulary: `attempted` is the
   * items that reached the write call, `found` the ones whose bytes
   * landed, `missing` the keys of the rest. On this path `missing` is
   * always empty - a failure throws {@link ExtractSignalsWriteError},
   * which carries the same shape with the gap named.
   *
   * A deduped or durability-rejected item is NOT attempted: both are
   * deliberate refusals this result already names in {@link deduped} and
   * {@link rejected}, and counting a refusal the lane made as a write it
   * lost would misreport the one number an operator reads first.
   */
  readonly reconciliation: ReconciliationReport;
}

export interface PlanExtractSignalsOptions {
  readonly now: Date;
}

export interface CommitExtractedSignalsOptions {
  readonly agent: string;
  readonly now: Date;
  /**
   * Pre-compiled durability denylist. When omitted it is resolved from the
   * plugin config, mirroring `routeExtractedFacts`; tests inject it so the
   * gate is exercised without the default config path.
   */
  readonly durabilityDenylist?: ReadonlyArray<RegExp>;
  /** Write-approval toggle; resolved from config when omitted. */
  readonly writeApprovalEnabled?: boolean;
  /** Shared dedup index; built from the vault when omitted. */
  readonly dedup?: Map<string, DedupIndexEntry>;
}

// ----- Semantic rules the descriptor language cannot express ---------------

/**
 * Cap and floor, registered once at module scope. Both read across the
 * payload rather than one value at a time - the cap counts the whole list,
 * and the floor compares a number to a limit the descriptor cannot name -
 * so they belong here rather than in {@link EXTRACTED_SIGNALS_SHAPE}.
 *
 * Registration is a module side effect on purpose: the registry is
 * fail-closed, so a lane that forgot to register refuses its own writes
 * instead of performing them unchecked.
 */
registerResponseCheck(EXTRACTED_SIGNALS_SURFACE, (payload) => {
  const violations: SemanticViolation[] = [];
  const items = readItems(payload);
  if (items === null) return violations;
  if (items.length > AUTO_EXTRACT_PER_SESSION_CAP) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.threshold,
        `${SHAPE_ROOT_PATH}.items`,
        `at most ${AUTO_EXTRACT_PER_SESSION_CAP} signals may be mined from one session; got ${items.length}`,
      ),
    );
  }
  items.forEach((item, index) => {
    const confidence = (item as { confidence?: unknown }).confidence;
    if (typeof confidence !== "number") return;
    if (confidence < AUTO_EXTRACT_CONFIDENCE_FLOOR) {
      violations.push(
        semanticViolation(
          SEMANTIC_VIOLATION_CODES.threshold,
          `${SHAPE_ROOT_PATH}.items[${index}].confidence`,
          `confidence must be at least ${AUTO_EXTRACT_CONFIDENCE_FLOOR}; got ${confidence}`,
        ),
      );
    }
  });
  return violations;
});

/**
 * The item list, or null when the payload is not shaped like one. The
 * shape layer has already refused that case by the time the check runs;
 * returning null keeps the check pure and total rather than throwing from
 * inside a validator whose contract says it never throws.
 */
function readItems(payload: unknown): ReadonlyArray<unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items : null;
}

// ----- Phase one: what to mine ---------------------------------------------

/**
 * Assemble the mining plan for one imported session. Read-only; writes
 * nothing and calls no model.
 *
 * Three conditions are refusals rather than empty reports, because each
 * one means the caller asked for something this vault cannot answer:
 * a session the capture boundary ignores, a session with no imported turns
 * at all, and a session whose turns are all non-user. Reporting any of them
 * as "mined nothing" would read as a clean run over a barren transcript.
 */
export function planExtractSignals(
  vault: string,
  sessionId: string,
  opts: PlanExtractSignalsOptions,
): SignalExtractionPlan {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    throw new ExtractSignalsError("extract-signals needs a session reference");
  }
  const boundary = buildCaptureBoundary(vault);
  const boundaryDecision = boundary.sessionDecision(trimmed);
  if (boundaryDecision !== "capture") {
    throw new ExtractSignalsError(
      `session ${trimmed} is classified '${boundaryDecision}' by the capture boundary; it may not produce signals`,
    );
  }
  const turns = listSessionRawTurns(vault, trimmed);
  if (turns.length === 0) {
    throw new ExtractSignalsError(
      `session ${trimmed} has no imported turns; import it first with 'o2b brain import-session --recall'`,
    );
  }
  const mined: MinedTurn[] = [];
  for (const turn of turns) {
    if (turn.role !== MINED_TURN_ROLE) continue;
    // Message-level boundary, mirroring the import path: suppressed text
    // never reaches extraction, so it never reaches the prompt either.
    if (boundary.suppressMessage(turn.text)) continue;
    const text = turn.text.trim();
    if (text.length === 0) continue;
    mined.push(Object.freeze({ turnId: turn.turn_id, text }));
  }
  if (mined.length === 0) {
    throw new ExtractSignalsError(
      `session ${trimmed} has ${turns.length} imported turn(s) but none authored by the user; there is nothing to mine`,
    );
  }
  return Object.freeze({
    sessionId: trimmed,
    generatedAt: opts.now.toISOString(),
    boundaryDecision,
    turnsScanned: turns.length,
    turnsMined: Object.freeze(mined),
    cap: AUTO_EXTRACT_PER_SESSION_CAP,
    confidenceFloor: AUTO_EXTRACT_CONFIDENCE_FLOOR,
    llmStep: buildMiningStep(trimmed, mined),
  });
}

/**
 * The one envelope. The turns ride inside the prompt rather than beside it
 * because the receiving agent is answering a question about exactly these
 * turns and nothing else; a prompt that named a session id would invite the
 * caller to go and read more of it.
 */
function buildMiningStep(sessionId: string, mined: ReadonlyArray<MinedTurn>): NeedsLlmStep {
  const transcript = mined
    .map((turn) => `[${turn.turnId}] ${turn.text.slice(0, PROMPT_TURN_TEXT_MAX)}`)
    .join("\n");
  return buildNeedsLlmStep({
    step: EXTRACT_SIGNALS_STEP,
    prompt:
      `Mine durable taste signals from the ${mined.length} user turn(s) of session ${sessionId} below. ` +
      "A taste signal is a rule the operator stated about how work should be done - a preference, a " +
      "correction, a prohibition - not a fact, a task, or a one-off instruction about this session. " +
      `Return at most ${AUTO_EXTRACT_PER_SESSION_CAP} items, each with a confidence of at least ` +
      `${AUTO_EXTRACT_CONFIDENCE_FLOOR}; omit anything you are less sure of rather than lowering the ` +
      "number, because an item below the floor refuses the whole payload.\n\n" +
      transcript,
    schema_hints: [
      'payload: { "items": [ { "topic", "signal", "principle", "confidence", "scope"? } ] }',
      "topic: stable kebab-slug naming the rule",
      "signal: 'positive' when the principle is the rule to follow, 'negative' when it is what to avoid",
      "principle: one imperative line, in the language the operator used",
      `confidence: number in [${AUTO_EXTRACT_CONFIDENCE_FLOOR}, 1]`,
      `items: at most ${AUTO_EXTRACT_PER_SESSION_CAP} entries`,
    ],
    target_path: posix.normalize(AUTO_EXTRACT_TARGET_DIR_REL),
  });
}

// ----- Phase two: what the caller mined ------------------------------------

/**
 * Validate the returned payload and write the accepted items.
 *
 * Order is the deterministic extractor's, kept deliberately identical so
 * the two lanes cannot diverge on what reaches the inbox: capture boundary,
 * then per item dedup, then the durability gate, then staging, then the
 * write. A deduped item never reaches the durability gate, and a
 * durability-rejected item is counted and NAMED in
 * {@link CommitExtractedSignalsResult.rejected} - never a silent drop.
 */
export function commitExtractedSignals(
  vault: string,
  sessionId: string,
  payload: unknown,
  opts: CommitExtractedSignalsOptions,
): CommitExtractedSignalsResult {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    throw new ExtractSignalsError("extract-signals needs a session reference");
  }
  const boundaryDecision = buildCaptureBoundary(vault).sessionDecision(trimmed);
  if (boundaryDecision !== "capture") {
    throw new ExtractSignalsError(
      `session ${trimmed} is classified '${boundaryDecision}' by the capture boundary; it may not produce signals`,
    );
  }
  // Structure first, then the cross-item rules. Nothing is written until
  // both gates pass, so a payload with one bad item lands nothing.
  assertResponseShape(EXTRACTED_SIGNALS_SURFACE, EXTRACTED_SIGNALS_SHAPE, payload);
  assertResponseCheck(EXTRACTED_SIGNALS_SURFACE, payload);

  const items = (payload as { items: ReadonlyArray<ExtractedSignalItem> }).items;
  const dedup = opts.dedup ?? buildDedupIndex(vault);
  const denylist = opts.durabilityDenylist ?? resolveDurabilityDenylist();
  const writeApprovalEnabled = opts.writeApprovalEnabled ?? resolveWriteApprovalEnabled();
  const targetDir = writeApprovalEnabled ? brainDirsForWrite(vault).pending : undefined;

  const written: ExtractedSignalWrite[] = [];
  const rejected: ExtractedSignalRejection[] = [];
  let deduped = 0;

  for (const [index, item] of items.entries()) {
    const scope = item.scope?.trim();
    const hash = computeDedupHash({
      topic: item.topic,
      signal: item.signal,
      principle: item.principle,
      ...(scope ? { scope } : {}),
    });
    if (dedup.has(hash)) {
      deduped++;
      continue;
    }
    const verdict = classifyDurability(item.principle, { denylist });
    if (!verdict.durable) {
      rejected.push(Object.freeze({ topic: item.topic, reason: verdict.reason! }));
      continue;
    }
    // Per-item writes, so a failure here is a PARTIAL write: everything
    // before this item is on disk and stays there. It is reported as such
    // rather than propagating a bare cause with no accounting - the same
    // choice `ArchWriteError` makes for the architect tree.
    let res;
    try {
      res = writeSignal(
        vault,
        {
          topic: item.topic,
          signal: item.signal,
          agent: opts.agent,
          principle: item.principle,
          created_at: isoSecond(opts.now),
          date: isoDate(opts.now),
          slug: item.topic,
          ...(scope ? { scope } : {}),
          source: [`[[${trimmed}]]`],
          source_type: BRAIN_SIGNAL_SOURCE_TYPE.autoExtract,
          dedup_hash: hash,
          session_ref: trimmed,
          // The confidence the caller claimed rides onto the file: it is the
          // one thing separating two auto-extracted signals whose text reads
          // equally plausible, and the dream pass has no other way to see it.
          raw: `confidence: ${item.confidence}`,
        },
        targetDir !== undefined ? { targetDir } : {},
      );
    } catch (err) {
      // Everything from the failing item onward is unwritten. Some of the
      // items this call never reached might have deduped away had it got
      // to them - unknowable from here, and "not written" is true of all
      // of them either way, so they are NAMED rather than guessed at.
      const remaining = items.slice(index);
      const reconciliation = buildReconciliationReport({
        attempted: written.length + remaining.length,
        found: written.length,
        missing: remaining.map((unwritten, offset) =>
          unwrittenKey(index + offset, unwritten.topic),
        ),
      });
      throw new ExtractSignalsWriteError({
        topic: item.topic,
        written,
        remaining: remaining.length,
        reconciliation,
        cause: err,
        deadLetter: tryRecordDeadLetter(vault, {
          envelope: {
            lane: EXTRACT_SIGNALS_LANE,
            step: EXTRACT_SIGNALS_STEP,
            reference: trimmed,
            target: AUTO_EXTRACT_TARGET_DIR_REL,
          },
          report: reconciliation,
          firstError: err,
          now: opts.now,
        }),
      });
    }
    dedup.set(hash, { id: res.id, path: res.path });
    written.push(Object.freeze({ id: res.id, path: res.path, topic: item.topic }));
  }

  return Object.freeze({
    sessionId: trimmed,
    written: Object.freeze(written),
    staged: writeApprovalEnabled ? written.length : 0,
    deduped,
    durabilityRejected: rejected.length,
    rejected: Object.freeze(rejected),
    reconciliation: buildReconciliationReport({
      attempted: written.length,
      found: written.length,
      missing: [],
    }),
  });
}

/**
 * The key a missing item is NAMED by: its payload index and its topic.
 * The index carries the uniqueness (two items may share a topic) and the
 * topic carries the meaning, which is what an operator matches against
 * the payload they are about to re-run.
 */
function unwrittenKey(index: number, topic: string): string {
  return `items[${index}]:${topic}`;
}
