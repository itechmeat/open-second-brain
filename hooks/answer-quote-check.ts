#!/usr/bin/env -S bun
/**
 * Stop hook: answer-time quote verification (answer-trust wave, Lane A).
 *
 * At turn end this step reads the LAST assistant messages of the turn,
 * finds their quoted spans with the distill lane's own
 * `findQuoteSpans`, and checks each span against the evidence the turn
 * actually had:
 *
 *   - the note the span cites - a wikilink target or a vault-relative
 *     path in the message text, resolved against the vault; and
 *   - otherwise the notes the injection ledger says entered context this
 *     session, across the four phase keys (recall keys, the active
 *     digest's emitted paths plus its queued re-delivery parts, and the
 *     note paths the sub-agent carrier recorded with its deliveries).
 *
 * Each span gets one verdict from
 * `src/core/brain/answer-quotes/check.ts` - `verified`, `not-in-note`,
 * `source-truncated`, `note-unavailable` or `not-text` - and the
 * unverified ones are listed in exactly ONE
 * `hookSpecificOutput.additionalContext` annotation (the
 * `hooks/stop-log-guardrail.ts` precedent). The hook NEVER blocks and
 * NEVER edits the transcript: a verdict is reported, not enforced.
 *
 * Phases. A phase runs only when BOTH hold: the phase's injection is
 * enabled (recall requires `recall_inject_enabled`; active and subagent
 * require a live injection ledger for the session) and its
 * `quote_check.<phase>` resolver returns more than `off`.
 * `shadow` annotates only; `enforce` additionally appends exactly one
 * Brain-log event per turn with the unverified spans, so findings survive
 * the session - and never blocks.
 *
 * Channel. The annotation rides `hookSpecificOutput.additionalContext`
 * on the Stop event, which Claude Code renders into the turn. Codex and
 * grok accept the registration but render no Stop annotation - and grok
 * ships no `transcript_path` at all - so the check is silently inert on
 * them: fail-open silence, kept deliberately, with the `enforce`
 * Brain-log trail as the one finding surface that survives the session.
 *
 * Reply presence (t_f8510c55). Wherever a transcript exists - annotation
 * rendering or not - every checked turn also appends exactly one
 * `reply_presence` continuity record: per injected note, whether a
 * quoted span verified against it, its strongest miss verdict, `absent`
 * when no span was ever measured against it, or `note-unavailable` when
 * the budget cut the walk before the note could be measured. A span
 * that verified is measured against the note that carries it alone, so
 * the per-note verdicts hold whichever way the candidates sort. The
 * record is keyed by session id and joined to the session's context
 * receipts on read; identifiers and verdicts only, never answer text.
 * The presence record rides the same per-phase modes: every phase `off`
 * writes nothing.
 *
 * Bounded, fail-open. The step reads at most
 * {@link ANSWER_QUOTE_TAIL_BYTES} of the transcript, the last
 * {@link ANSWER_QUOTE_MAX_MESSAGES} assistant messages of the turn,
 * {@link ANSWER_QUOTE_MAX_CHARS} characters of each, and gives up by
 * checking nothing further once {@link ANSWER_QUOTE_BUDGET_MS} have
 * passed - unchecked spans are dropped rather than run long. Every error
 * path exits 0 with exactly one stderr audit line, producing nothing.
 * Fires at most once per turn: when the runtime reports
 * `stop_hook_active === true` (this turn was already continued by a Stop
 * hook) the hook exits 0 silently.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";

import {
  resolveAnswerQuoteCheckActive,
  resolveAnswerQuoteCheckRecall,
  resolveAnswerQuoteCheckSubagent,
  resolveAgentName,
  resolveRecallInjectEnabled,
  resolveVault,
  type AnswerQuoteCheckMode,
  type AnswerQuoteCheckPhase,
  ANSWER_QUOTE_CHECK_PHASES,
} from "../src/core/config.ts";
import {
  ANSWER_QUOTE_VERDICT,
  checkAnswerQuotes,
  mergeAnswerQuoteVerdicts,
  previewAnswerQuoteSpan,
  type AnswerQuoteEvidence,
  type AnswerQuoteVerdict,
} from "../src/core/brain/answer-quotes/check.ts";
import { findQuoteSpans } from "../src/core/brain/distill/quote-spans.ts";
import { brainConfigPath } from "../src/core/brain/paths.ts";
import {
  neutralizeUntrustedText,
  untrustedFramingHeader,
} from "../src/core/brain/untrusted-source.ts";
import { appendLogEvent } from "../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../src/core/brain/types.ts";
import { isoSecond } from "../src/core/brain/time.ts";
import { appendContinuityRecord } from "../src/core/brain/continuity/store.ts";
import { CONTINUITY_SESSION_ID_KEY } from "../src/core/brain/continuity/types.ts";
import { ensureInsideVault } from "../src/core/path-safety.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import {
  isRealSessionId,
  LEDGER_KEY_REGROUND,
  readActiveEmittedPaths,
  readRecallInjected,
  readSubagentDeliveredPaths,
} from "./lib/injection-ledger.ts";
import { readHookStamp } from "./lib/session-state.ts";

/**
 * The last assistant messages of the turn the check reads. Everything
 * older is another turn's answer.
 */
export const ANSWER_QUOTE_MAX_MESSAGES = 6;

/** Per-message character budget: the prefix of a message that is checked. */
export const ANSWER_QUOTE_MAX_CHARS = 4000;

/** The shipped wall-clock budget for the whole check. */
const ANSWER_QUOTE_DEFAULT_BUDGET_MS = 1500;

/**
 * The wall-clock budget, resolved ONCE at module load: a spawned hook
 * process honors an `ANSWER_QUOTE_BUDGET_MS` environment override - a
 * test seam for the budget-expiry arms, read a single time so a child's
 * whole run sees one budget; anything absent, blank or unparsable keeps
 * the shipped default.
 */
function resolveBudget(): number {
  const raw = process.env["ANSWER_QUOTE_BUDGET_MS"]?.trim();
  if (raw === undefined || raw.length === 0) return ANSWER_QUOTE_DEFAULT_BUDGET_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : ANSWER_QUOTE_DEFAULT_BUDGET_MS;
}

/** Wall-clock budget for the whole check; past it, unchecked spans are dropped. */
export const ANSWER_QUOTE_BUDGET_MS: number = resolveBudget();

/**
 * Ceiling on findings rendered in one annotation - and in one enforce
 * event: past it the tail of the list collapses into one "and N more"
 * line, so a pathological answer annotates its first spans instead of
 * flooding the context channel.
 */
export const ANSWER_QUOTE_MAX_FINDINGS = 20;

/**
 * Byte window of the bounded transcript tail read. Small enough that a
 * huge transcript cannot slow the Stop path, large enough to hold the
 * current turn's answers; the reader drops the one line the window may
 * have cut in half.
 */
export const ANSWER_QUOTE_TAIL_BYTES = 262_144;

/**
 * Ceiling on how much of one cited note the check reads, on the 1 MiB
 * scale of the ingest archive ceiling. Past it only the head of the file
 * is read and the evidence is named truncated - a miss against it is
 * `source-truncated`, never `not-in-note` - and a pointer that names a
 * line range is refused as `unavailable` rather than served a slice of
 * the prefix as if it were the named lines.
 */
export const ANSWER_QUOTE_NOTE_MAX_BYTES = 1_048_576;

/** Stderr audit prefix: every error arm prints exactly one line with it. */
const AUDIT_PREFIX = "answer-quote-check:";

/** One quoted span to check: its text and where it sits in its message. */
interface QuotedSpan {
  readonly message: number;
  readonly inner: string;
  readonly open: number;
  readonly close: number;
}

/** One citation mark found in a message: a note reference and its offset. */
interface CitationMark {
  readonly at: number;
  /** Vault-relative note path, `.md`-complete. */
  readonly path: string;
  /** 1-based inclusive line range, when the pointer names one. */
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * A vault-relative `.md` path pointer, optionally naming a line range the
 * way every recall pointer renders it (`Brain/notes/x.md:L3-L9`). Requires
 * at least one directory separator, so a bare word before `.md` is prose,
 * not a pointer.
 *
 * The repeated class MUST exclude `/`. A class that can match the
 * separator itself segments a run of N slashes 2^(N-1) ways, and the scan
 * a hook feeds it routinely fails (a base64 blob in an answer carries
 * hundreds of slashes and no `.md`), so the engine walks every
 * segmentation and the Stop hook stalls past its 10 s timeout - the
 * CodeQL high on this file. With `/` excluded the scan is linear in the
 * text; the one reading that changes is `a//b/c.md`, now `b/c.md`.
 */
const PATH_POINTER_RE = /(?:[^\s:|[\]()#/]+\/)+[^\s:|[\]()#/]*\.md(?::L(\d+)-L(\d+))?/g;

/**
 * A `.md` path token, for scanning ledger member strings that are prose.
 * Excludes `/` for the same reason as {@link PATH_POINTER_RE}.
 */
const PATH_TOKEN_RE = /(?:[^\s:|[\]()#/]+\/)+[^\s:|[\]()#/]*\.md/g;

// ----- transcript tail -----------------------------------------------------

/**
 * Fill `length` bytes of `fd` from `start`, looping on `readSync` until
 * the window is filled or EOF: a single positional read may return
 * short, and a short read would silently shrink the window.
 */
function readWindow(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < buffer.length) {
    const moved = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
    if (moved <= 0) break;
    filled += moved;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

/**
 * The last {@link ANSWER_QUOTE_TAIL_BYTES} of the transcript as text. One
 * bounded positional read; the caller drops the line the window may have
 * cut in half.
 */
function readTail(path: string): { readonly text: string; readonly cutStart: boolean } {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    // POSIX refuses to open a directory; Windows opens it and reports size
    // 0, which would read as an empty transcript - silence where every
    // platform must see one audit line. Name the failure identically
    // everywhere instead: only a regular file is a transcript.
    if (!stat.isFile()) throw new Error(`transcript is not a regular file: ${path}`);
    const start = Math.max(0, stat.size - ANSWER_QUOTE_TAIL_BYTES);
    return { text: readWindow(fd, start, stat.size - start).toString("utf8"), cutStart: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** First string `value`'s text blocks join to, or `""`. */
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { readonly text: string } =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** A real user turn boundary in either transcript shape (not a tool result). */
function isUserBoundary(record: Record<string, unknown>): boolean {
  const message = record["message"] as Record<string, unknown> | undefined;
  if (
    record["type"] === "user" &&
    message !== null &&
    typeof message === "object" &&
    message["role"] === "user"
  ) {
    const content = message["content"];
    // Tool results ride user-role records too; they are not a turn boundary.
    const toolResultsOnly =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (block) => typeof block === "object" && block !== null && block["type"] === "tool_result",
      );
    return !toolResultsOnly;
  }
  const payload = record["payload"] as Record<string, unknown> | undefined;
  if (record["type"] === "response_item" && payload !== null && typeof payload === "object") {
    if (payload["type"] !== "message" || payload["role"] !== "user") return false;
    const text = textBlocks(payload["content"]);
    // Codex prepends synthetic envelopes; they are not a user prompt.
    return !text.startsWith("<environment_context>") && !text.startsWith("<user_instructions>");
  }
  return false;
}

/** Assistant message text of one record, or `""` when the record has none. */
function assistantText(record: Record<string, unknown>): string {
  const message = record["message"] as Record<string, unknown> | undefined;
  if (record["type"] === "assistant" && message !== null && typeof message === "object") {
    return textBlocks(message["content"]);
  }
  const payload = record["payload"] as Record<string, unknown> | undefined;
  if (
    record["type"] === "response_item" &&
    payload !== null &&
    typeof payload === "object" &&
    payload["type"] === "message" &&
    payload["role"] === "assistant"
  ) {
    return textBlocks(payload["content"]);
  }
  return "";
}

/**
 * The last assistant messages of the turn, in answer order: the records
 * after the newest real user message inside the tail window, capped to
 * {@link ANSWER_QUOTE_MAX_MESSAGES} messages and
 * {@link ANSWER_QUOTE_MAX_CHARS} characters each. A window that holds no
 * user boundary contributes its newest assistant messages - the tail of
 * the current turn - which is what the check wants.
 */
function lastAssistantMessages(transcriptPath: string): ReadonlyArray<string> {
  const { text, cutStart } = readTail(transcriptPath);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  // The first line of a mid-file window is cut in half by the window, not
  // written broken by the host.
  const whole = cutStart ? lines.slice(1) : lines;
  const records: ReadonlyArray<Record<string, unknown>> = whole.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  const messages: string[] = [];
  for (let i = records.length - 1; i >= 0 && messages.length < ANSWER_QUOTE_MAX_MESSAGES; i--) {
    const record = records[i]!;
    if (isUserBoundary(record)) break;
    const body = assistantText(record);
    if (body.length === 0) continue;
    messages.push(
      body.length > ANSWER_QUOTE_MAX_CHARS ? body.slice(0, ANSWER_QUOTE_MAX_CHARS) : body,
    );
  }
  return messages.toReversed();
}

// ----- citations and evidence ----------------------------------------------

/** Wikilink targets of `text`, as citation marks at their offsets. */
function wikilinkMarks(text: string): CitationMark[] {
  const marks: CitationMark[] = [];
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target === undefined || target.length === 0) continue;
    marks.push({
      at: match.index!,
      path: target.endsWith(".md") ? target : `${target}.md`,
    });
  }
  return marks;
}

/** Vault-relative path pointers of `text`, with any line range they name. */
function pathPointerMarks(text: string): CitationMark[] {
  const marks: CitationMark[] = [];
  for (const match of text.matchAll(PATH_POINTER_RE)) {
    const startLine = match[1] === undefined ? undefined : Number(match[1]);
    const endLine = match[2] === undefined ? undefined : Number(match[2]);
    marks.push({
      at: match.index!,
      path:
        startLine === undefined || endLine === undefined
          ? match[0]
          : match[0].slice(0, match[0].lastIndexOf(":L")),
      ...(startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {}),
    });
  }
  return marks;
}

/** The citation marks of one message: offset-sorted, duplicate-free. */
function citationMarks(text: string): ReadonlyArray<CitationMark> {
  const byKey = new Map<string, CitationMark>();
  for (const mark of [...wikilinkMarks(text), ...pathPointerMarks(text)]) {
    const key = `${mark.path}\0${mark.startLine ?? ""}-${mark.endLine ?? ""}`;
    const existing = byKey.get(key);
    if (existing === undefined || mark.at < existing.at) byKey.set(key, mark);
  }
  return [...byKey.values()].toSorted((a, b) => a.at - b.at);
}

/**
 * Vault-absolute path of a cited note, or `null` when the reference
 * escapes the vault. Exists-checking is the caller's concern.
 */
function resolveNotePath(vault: string, relativePath: string): string | null {
  try {
    return ensureInsideVault(`${vault}/${relativePath}`, vault);
  } catch {
    return null;
  }
}

/**
 * The evidence one cited note offers: the exact bytes the context had -
 * the named line range when the pointer carries one (truncated: a
 * pointer that names a range names a partial view), the whole file
 * otherwise, and past `maxBytes` only the head of the file, decoded
 * non-fatally and named truncated. Every failure to read names itself as
 * `unavailable` / `not-text` evidence rather than throwing. Exported for
 * the bounded-read pins; the ceiling is injectable so a test needs no
 * multi-megabyte fixture.
 */
export function evidenceFor(
  vault: string,
  mark: CitationMark,
  maxBytes: number = ANSWER_QUOTE_NOTE_MAX_BYTES,
): AnswerQuoteEvidence {
  const absolute = resolveNotePath(vault, mark.path);
  if (absolute === null || !existsSync(absolute)) {
    return { kind: "unavailable" };
  }
  let limited: boolean;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return { kind: "unavailable" };
    limited = stat.size > maxBytes;
  } catch {
    return { kind: "unavailable" };
  }
  let whole: string;
  try {
    if (limited) {
      const fd = openSync(absolute, "r");
      try {
        // Non-fatal: a ceiling cut can split a multi-byte character, and
        // a valid UTF-8 note must not read as not-text for it.
        whole = new TextDecoder("utf-8").decode(readWindow(fd, 0, maxBytes));
      } finally {
        closeSync(fd);
      }
    } else {
      whole = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
    }
  } catch {
    return { kind: "not-text" };
  }
  if (mark.startLine === undefined || mark.endLine === undefined) {
    return { kind: "text", text: whole, truncated: limited };
  }
  // A pointer that names a line range past the ceiling names lines the
  // bounded read did not fetch: refuse the evidence rather than serve a
  // slice of the prefix as if it were the named range.
  if (limited) return { kind: "unavailable" };
  const lines = whole.split("\n");
  const slice = lines.slice(mark.startLine - 1, mark.endLine).join("\n");
  return { kind: "text", text: slice, truncated: true };
}

// ----- the injection ledger's candidate notes ------------------------------

/**
 * One candidate note view the ledger offers as evidence: the note path,
 * the lines the injection named when it delivered only a range, the
 * phase whose ledger offered it, and whether the injection delivered
 * that note truncated (a clipped body is evidence of the delivered
 * prefix only).
 */
interface LedgerCandidate {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly phase: AnswerQuoteCheckPhase;
  readonly truncated?: boolean;
}

/** Answer order for candidate views: by path, then by named range. */
function compareCandidates(
  a: { readonly path: string; readonly startLine?: number; readonly endLine?: number },
  b: { readonly path: string; readonly startLine?: number; readonly endLine?: number },
): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0);
}

/**
 * The dedup key of one candidate view: the path, plus any range it names.
 * Takes the shape both the ledger candidates and the merged views share,
 * so the reply-presence fold can key its measured verdicts by it too.
 */
function candidateKey(candidate: {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}): string {
  return candidate.startLine === undefined || candidate.endLine === undefined
    ? candidate.path
    : `${candidate.path}\0${candidate.startLine}-${candidate.endLine}`;
}

/**
 * One merged candidate in the turn's evidence pool: the note view plus
 * every phase whose ledger offered it. The phases are the finding's
 * attribution - a miss is reported only when a phase that offered the
 * deciding evidence is itself running, and enforced only when one of
 * those phases enforces.
 */
interface MergedCandidate {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly truncated?: boolean;
  readonly phases: ReadonlyArray<AnswerQuoteCheckPhase>;
}

/**
 * Merge candidate view groups, per note path: a whole-file view wins over
 * that path's line ranges (the whole note reached context through one of
 * the groups), and identical ranges collapse - but several DISTINCT
 * ranges of one note all stand, each its own evidence. Collapsing them to
 * one range (or to the path) would check a correct quote of an earlier
 * range against only the latest one and report a miss the turn's
 * evidence actually refutes. A merged view carries the union of the
 * offering phases and the union of their truncation flags. Sorted by
 * path, then range.
 */
function mergeCandidateViews(
  groups: ReadonlyArray<ReadonlyArray<LedgerCandidate>>,
): ReadonlyArray<MergedCandidate> {
  const whole = new Map<string, Set<AnswerQuoteCheckPhase>>();
  const wholeTruncated = new Set<string>();
  const ranges = new Map<
    string,
    { candidate: LedgerCandidate; phases: Set<AnswerQuoteCheckPhase> }
  >();
  for (const group of groups) {
    for (const candidate of group) {
      if (candidate.startLine === undefined || candidate.endLine === undefined) {
        const phases = whole.get(candidate.path) ?? new Set<AnswerQuoteCheckPhase>();
        phases.add(candidate.phase);
        whole.set(candidate.path, phases);
        if (candidate.truncated === true) wholeTruncated.add(candidate.path);
      } else {
        const key = candidateKey(candidate);
        const entry = ranges.get(key);
        if (entry === undefined) {
          ranges.set(key, { candidate, phases: new Set([candidate.phase]) });
        } else {
          entry.phases.add(candidate.phase);
          if (candidate.truncated === true)
            entry.candidate = { ...entry.candidate, truncated: true };
        }
      }
    }
  }
  const mergedRanges = [...ranges.values()]
    .filter(({ candidate }) => !whole.has(candidate.path))
    .map(({ candidate, phases }) => ({
      path: candidate.path,
      ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
      ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
      ...(candidate.truncated === true ? { truncated: true } : {}),
      phases: [...phases],
    }));
  const mergedWhole = [...whole.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, phases]) => ({
      path,
      ...(wholeTruncated.has(path) ? { truncated: true } : {}),
      phases: [...phases],
    }));
  return [...mergedRanges, ...mergedWhole].toSorted(compareCandidates);
}

/**
 * Note path + line range one recall ledger key names. Recall keys render
 * `<origin>:<vault-relative path>#L<start>-L<end>` (`recallInjectNoteKey`),
 * where the origin is a search-origin label
 * (`src/core/brain/portability/origins.ts`): the bare `local` of the
 * active vault, or a kind-namespaced origin whose label carries a slash -
 * `profile/<name>`, `source/<alias>` - for a note recalled from another
 * vault. Splitting on the LAST colon before the `#L` anchor puts the
 * whole label on the left, slash-bearing or not, and the path - always
 * carrying a `/` - on the right; the label is dropped. The cross-origin
 * note itself still cannot be read under the active vault - it is
 * evidence outside this vault - so its spans resolve as
 * `note-unavailable` deliberately, never as an all-clear.
 */
function recallKeyCandidate(
  key: string,
): { readonly path: string; readonly startLine: number; readonly endLine: number } | null {
  const hash = key.lastIndexOf("#L");
  if (hash === -1) return null;
  const range = /^L(\d+)-L(\d+)$/.exec(key.slice(hash + 1));
  if (range === null) return null;
  const body = key.slice(0, hash);
  const colon = body.lastIndexOf(":");
  const label = colon === -1 ? null : body.slice(0, colon);
  const rest = colon === -1 ? body : body.slice(colon + 1);
  // `<origin>:<path>`: the right side is a vault-relative path, whatever
  // the left side looks like. A colon with no slash on either side is
  // not a recognized key shape and the body stays whole.
  const path = rest.includes("/") || (label !== null && label.includes("/")) ? rest : body;
  return { path, startLine: Number(range[1]), endLine: Number(range[2]) };
}

/** `.md` path tokens in one ledger member string, without line ranges. */
function pathTokens(member: string): ReadonlyArray<string> {
  return [...member.matchAll(PATH_TOKEN_RE)].map((match) => match[0]);
}

/**
 * The candidate note paths of one phase's ledger: recall keys parse to
 * path + line range, the active ledger names paths directly, the queued
 * re-delivery parts are prose scanned for path tokens, and the sub-agent
 * delivery ledger names the paths the delivered payloads were built from
 * (a row recorded before that field existed contributes nothing - an old
 * ledger row is silence for this phase, never an error). Sorted,
 * deduplicated; empty when the session has no ledger (a sessionless host
 * has none at all).
 */
function ledgerCandidates(
  vault: string,
  sessionId: string | null,
  phase: AnswerQuoteCheckPhase,
  nowMs: number,
): ReadonlyArray<LedgerCandidate> {
  if (sessionId === null) return [];
  // Several DISTINCT line ranges of one note all stand: each names the
  // part of the note that actually reached context, and collapsing them
  // to the last range would check a correct quote of an earlier range
  // against the wrong lines. Whole-file views (no range) are deduped by
  // path; the merge across phases applies the whole-wins-over-ranges
  // rule (mergeCandidateViews).
  const seen = new Set<string>();
  const candidates: LedgerCandidate[] = [];
  const add = (candidate: Omit<LedgerCandidate, "phase">): void => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...candidate, phase });
  };
  if (phase === "recall") {
    for (const key of readRecallInjected(vault, sessionId, nowMs)) {
      const parsed = recallKeyCandidate(key);
      if (parsed === null) continue;
      add({ path: parsed.path, startLine: parsed.startLine, endLine: parsed.endLine });
    }
  }
  if (phase === "active") {
    for (const path of readActiveEmittedPaths(vault, sessionId, nowMs)) {
      add({ path });
    }
    const parts = readHookStamp(vault, sessionId, LEDGER_KEY_REGROUND, nowMs)?.data?.["parts"];
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part !== "string") continue;
        for (const path of pathTokens(part)) add({ path });
      }
    }
  }
  if (phase === "subagent") {
    for (const delivered of readSubagentDeliveredPaths(vault, sessionId, nowMs)) {
      add(
        typeof delivered === "string"
          ? { path: delivered }
          : { path: delivered.path, truncated: delivered.truncated },
      );
    }
  }
  return candidates.toSorted(compareCandidates);
}

// ----- the check ------------------------------------------------------------

/** One candidate's verdict for one span, kept for the reply-presence fold. */
interface SpanCandidateOutcome {
  readonly candidate: MergedCandidate;
  readonly verdict: AnswerQuoteVerdict;
}

/** One span's outcome under the resolved evidence, inside the budget. */
interface SpanOutcome {
  readonly verdict: AnswerQuoteVerdict;
  /**
   * The span as the check module previews it - length-capped, code-point
   * safe. Findings render only this form, never the raw span: a span is
   * answer text, and the annotation's line structure is the hook's voice.
   */
  readonly preview: string;
  /**
   * The phases of the candidates that decided this outcome - the verdict
   * source when the span verified, every candidate checked when it did
   * not. A finding is reported only when a running phase is among them,
   * and enforced only when one of those running phases enforces.
   */
  readonly decidingPhases: ReadonlyArray<AnswerQuoteCheckPhase>;
  /**
   * The verdicts the reply-presence fold records for this span, in check
   * order (t_f8510c55). A span that verified somewhere records ONLY the
   * verifying candidate's outcome - the span belongs to the note that
   * carries it, and a candidate that missed it before the walk reached
   * the verifier did not measure the span in any sense worth reporting.
   * A span that verified nowhere records every candidate's miss. A
   * candidate left unmeasured appears here for no span, which the fold
   * reads as `absent`; a candidate the budget cut reads
   * `note-unavailable`, never `absent`, so an unspent budget can never
   * masquerade as an untouched note.
   */
  readonly candidateOutcomes: ReadonlyArray<SpanCandidateOutcome>;
}

/** One span's verdict under the resolved evidence, inside the budget. */
function checkSpan(
  span: QuotedSpan,
  marks: ReadonlyArray<CitationMark>,
  candidates: ReadonlyArray<MergedCandidate>,
  vault: string,
  deadline: number,
): SpanOutcome {
  // The cited note: the nearest mark before the span, else the first one
  // after it. A mark inside the span is span content, never a citation.
  const before = marks.filter((mark) => mark.at < span.open);
  const after = marks.filter((mark) => mark.at > span.close);
  if (before.length > 0 || after.length > 0) {
    const mark = before.length > 0 ? before[before.length - 1]! : after[0]!;
    const { outcomes } = checkAnswerQuotes({
      spans: [span.inner],
      evidence: evidenceFor(vault, mark),
    });
    // The span was MEASURED against the cited note's evidence, so every
    // ledger candidate naming the cited note records the outcome -
    // citing an injected note is the most explicit way to surface it,
    // and an empty outcome list here would fold that note `absent`
    // ("injected, never surfaced") against what the reply just did.
    // A mark with a line range rides only on the candidate whose
    // delivered view is that same range; a whole-note candidate matches
    // any citation of its note.
    const cited = candidates.filter(
      (candidate) =>
        candidate.path === mark.path &&
        (mark.startLine === undefined ||
          // A whole-note candidate is the note itself: any citation of
          // its path names content it delivered. (The merge also folds
          // every range of a path away once the whole note was
          // delivered, so a range-only match would miss it.)
          candidate.startLine === undefined ||
          candidateKey(candidate) === candidateKey(mark)),
    );
    return {
      verdict: outcomes[0]!.verdict,
      preview: outcomes[0]!.span,
      decidingPhases: [],
      candidateOutcomes: cited.map((candidate) => ({
        candidate,
        verdict: outcomes[0]!.verdict,
      })),
    };
  }
  if (candidates.length === 0) {
    return {
      verdict: mergeAnswerQuoteVerdicts([]),
      preview: previewAnswerQuoteSpan(span.inner),
      decidingPhases: [],
      candidateOutcomes: [],
    };
  }
  const verdicts: AnswerQuoteVerdict[] = [];
  const decidingPhases: AnswerQuoteCheckPhase[] = [];
  const candidateOutcomes: SpanCandidateOutcome[] = [];
  let preview = previewAnswerQuoteSpan(span.inner);
  for (const [index, candidate] of candidates.entries()) {
    if (Date.now() > deadline) {
      // Budget spent with unread candidates left: the check did not
      // finish, so it never reports a readable-miss verdict. Every
      // unread candidate is recorded as `note-unavailable` for this
      // span - checked-and-unresolved, never silently untouched.
      return {
        verdict: ANSWER_QUOTE_VERDICT.noteUnavailable,
        preview,
        decidingPhases,
        candidateOutcomes: [
          ...candidateOutcomes,
          ...candidates.slice(index).map((unread) => ({
            candidate: unread,
            verdict: ANSWER_QUOTE_VERDICT.noteUnavailable,
          })),
        ],
      };
    }
    const mark: CitationMark = {
      at: -1,
      path: candidate.path,
      ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
      ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
    };
    let evidence = evidenceFor(vault, mark);
    // The injection delivered only a prefix of this note: evidence is the
    // delivered prefix, whatever the file holds today. A miss under
    // clipped evidence is `source-truncated`, never a readable miss - a
    // truncated source never acquits a span, and never convicts one the
    // delivered text cannot judge.
    if (candidate.truncated === true && evidence.kind === "text") {
      evidence = { ...evidence, truncated: true };
    }
    const { outcomes } = checkAnswerQuotes({
      spans: [span.inner],
      evidence,
    });
    const verdict = outcomes[0]!.verdict;
    preview = outcomes[0]!.span;
    verdicts.push(verdict);
    candidateOutcomes.push({ candidate, verdict });
    for (const phase of candidate.phases) decidingPhases.push(phase);
    if (verdict === ANSWER_QUOTE_VERDICT.verified) break;
  }
  const merged = mergeAnswerQuoteVerdicts(verdicts);
  // A span that verified somewhere belongs to the note it verified
  // against: only that candidate's outcome is recorded. The misses the
  // walk accumulated before reaching the verifier were measurements of
  // the span against evidence that could not carry it - recording them
  // would make an unrelated note's verdict depend on whether its path
  // sorts before or after the verifying one. Per-candidate misses stay
  // only for spans that verified nowhere, where every miss is the
  // span's own history.
  const recordedOutcomes =
    merged === ANSWER_QUOTE_VERDICT.verified
      ? candidateOutcomes.filter((outcome) => outcome.verdict === ANSWER_QUOTE_VERDICT.verified)
      : candidateOutcomes;
  return {
    verdict: merged,
    preview,
    decidingPhases,
    candidateOutcomes: recordedOutcomes,
  };
}

/**
 * The per-note presence verdicts of one checked turn (t_f8510c55), one
 * row per candidate the injection ledger offered: `verified` when at
 * least one quoted span of the reply checked out against the note;
 * otherwise the strongest miss verdict across the spans that measured
 * it - the check module's own merge ladder, so degradation still
 * outranks a readable miss per note exactly as it does per turn;
 * {@link ANSWER_QUOTE_VERDICT.absent} for a note no span was ever
 * measured against - injected into context, never surfaced in the
 * answer, the row this record exists to surface; and
 * {@link ANSWER_QUOTE_VERDICT.noteUnavailable} for a note no span
 * measured while the budget was exhausted - the transcript went unread
 * past the cut, which is not evidence the note went untouched, so the
 * fold refuses to spend `absent` on it. A span that verified somewhere
 * measured only the note that carries it ({@link checkSpan} records the
 * verifying candidate alone), so a note's verdict is a fact about the
 * reply, never about where its path sorts. Rows carry identifiers and
 * verdicts only; no answer text rides the record.
 */
function foldReplyPresence(
  candidates: ReadonlyArray<MergedCandidate>,
  outcomes: ReadonlyArray<SpanCandidateOutcome>,
  budgetExhausted: boolean,
  replyRead: boolean,
): ReadonlyArray<Record<string, unknown>> {
  const measured = new Map<string, AnswerQuoteVerdict[]>();
  for (const outcome of outcomes) {
    const key = candidateKey(outcome.candidate);
    const verdicts = measured.get(key);
    if (verdicts === undefined) measured.set(key, [outcome.verdict]);
    else verdicts.push(outcome.verdict);
  }
  return candidates.map((candidate) => {
    const verdicts = measured.get(candidateKey(candidate));
    return {
      path: candidate.path,
      ...(candidate.startLine !== undefined ? { start_line: candidate.startLine } : {}),
      ...(candidate.endLine !== undefined ? { end_line: candidate.endLine } : {}),
      verdict:
        verdicts === undefined
          ? unmeasuredPresenceVerdict(budgetExhausted, replyRead)
          : mergeAnswerQuoteVerdicts(verdicts),
    };
  });
}

/**
 * The verdict for a note no span ever measured. When the walk's budget
 * ran out, or the reply text was never readable in the first place,
 * nothing was measured FOR A REASON - `note-unavailable`, the
 * checked-and-unresolved answer - never `absent`, which claims the reply
 * had every chance to touch the note and did not.
 */
function unmeasuredPresenceVerdict(
  budgetExhausted: boolean,
  replyRead: boolean,
): AnswerQuoteVerdict {
  if (budgetExhausted || !replyRead) return ANSWER_QUOTE_VERDICT.noteUnavailable;
  return ANSWER_QUOTE_VERDICT.absent;
}

/** `origin` label of the annotation's framing line for the quoted spans. */
const QUOTE_CHECK_FRAMING_ORIGIN = "quoted-answer-spans";

/**
 * One rendered finding line. The span renders neutralized first - the
 * structural strip (control/bidi/zero-width, delimiter escape) shared
 * with every other untrusted lane, so a span's invisible machinery can
 * never ride into the annotation - then flattened - CR/LF and whitespace
 * runs collapsed to single spaces, inside the check module's preview cap
 * - so answer text can never introduce annotation-shaped lines of its own.
 */
function findingLine(span: string, verdict: AnswerQuoteVerdict): string {
  return `- [${verdict}] "${neutralizeUntrustedText(span).replace(/\s+/g, " ").trim()}"`;
}

/** One unverified span, as the annotation and the enforce trail name it. */
interface AnswerQuoteSpanFinding {
  readonly span: string;
  readonly verdict: AnswerQuoteVerdict;
}

/** Duplicate findings collapse to their first occurrence, answer order kept. */
function dedupeFindings(
  findings: ReadonlyArray<AnswerQuoteSpanFinding>,
): ReadonlyArray<AnswerQuoteSpanFinding> {
  const seen = new Set<string>();
  const unique: AnswerQuoteSpanFinding[] = [];
  for (const finding of findings) {
    const key = findingLine(finding.span, finding.verdict);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

/**
 * The findings one annotation - and one enforce event - render: the
 * first {@link ANSWER_QUOTE_MAX_FINDINGS}, answer order kept. The header
 * and the enforce counters still state the true total.
 */
function listedFindings(
  findings: ReadonlyArray<AnswerQuoteSpanFinding>,
): ReadonlyArray<AnswerQuoteSpanFinding> {
  return findings.slice(0, ANSWER_QUOTE_MAX_FINDINGS);
}

/**
 * The annotation: exactly one line block listing the unverified spans
 * with their verdicts, duplicate-free, in answer order, under the
 * findings cap. The hook's own trusted lines - the count header, the
 * overflow line and the advisory footer - come FIRST, because the
 * records-not-instructions framing line hands everything FOLLOWING it
 * to the reader as data: the frame is the last trusted line the
 * annotation emits, and the spans beneath it are answer text.
 */
function annotation(findings: ReadonlyArray<AnswerQuoteSpanFinding>): string {
  const listed = listedFindings(findings);
  const lines = [
    `Open Second Brain quote check: ${findings.length} quoted span(s) were not found in the notes this turn had:`,
  ];
  if (listed.length < findings.length) {
    lines.push(`... and ${findings.length - listed.length} more unverified span(s) not listed.`);
  }
  lines.push(
    "Advisory only; the answer is not blocked. Verify the quotes against the note, or reword.",
    untrustedFramingHeader(QUOTE_CHECK_FRAMING_ORIGIN),
  );
  for (const finding of listed) lines.push(findingLine(finding.span, finding.verdict));
  return lines.join("\n");
}

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch (err) {
    // An unparseable payload is a host fault: one audit line, the same
    // prefix as every other error arm, and never a block.
    process.stderr.write(`${AUDIT_PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  // Once per turn: the runtime already continued this turn on a Stop
  // hook's output, so re-annotating would loop.
  if (payload.stop_hook_active === true) return;
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return;
  // A transcript the host has not created yet is a fresh session, not an
  // error: silence, like every other empty-handed arm.
  if (!existsSync(transcriptPath)) return;
  const vault = resolveVault();
  if (vault === null) return;
  const sessionId = isRealSessionId(payload.session_id) ? payload.session_id : null;
  const started = Date.now();
  const deadline = started + ANSWER_QUOTE_BUDGET_MS;
  const now = started;

  const configPath = brainConfigPath(vault);
  const modes: Readonly<Record<AnswerQuoteCheckPhase, AnswerQuoteCheckMode>> = {
    recall: resolveAnswerQuoteCheckRecall(configPath),
    active: resolveAnswerQuoteCheckActive(configPath),
    subagent: resolveAnswerQuoteCheckSubagent(configPath),
  };
  // Every phase `off` reports nothing and enforces nothing, so the run
  // pays no ledger read at all: the injection ledgers - whose member
  // strings are prose that gets path-scanned - stay unopened.
  if (ANSWER_QUOTE_CHECK_PHASES.every((phase) => modes[phase] === "off")) return;
  const ledgerNotes: Readonly<Record<AnswerQuoteCheckPhase, ReturnType<typeof ledgerCandidates>>> =
    {
      recall: ledgerCandidates(vault, sessionId, "recall", now),
      active: ledgerCandidates(vault, sessionId, "active", now),
      subagent: ledgerCandidates(vault, sessionId, "subagent", now),
    };
  // A phase contributes evidence when its injection happened (recall's
  // gate is the recall-inject flag; active and subagent have a live
  // ledger of their own); its MODE decides only whether a finding the
  // phase's evidence decided is reported - and enforced. Building the
  // pool from every injected ledger keeps a phase switched to `off` from
  // turning its delivered notes into false `[not-in-note]` findings for
  // spans another phase still checks.
  const gates: Readonly<Record<AnswerQuoteCheckPhase, boolean>> = {
    recall: resolveRecallInjectEnabled(),
    active: ledgerNotes.active.length > 0,
    subagent: ledgerNotes.subagent.length > 0,
  };
  const running = ANSWER_QUOTE_CHECK_PHASES.filter(
    (phase) => gates[phase] && modes[phase] !== "off",
  );
  if (running.length === 0) return;
  const candidates = mergeCandidateViews(
    ANSWER_QUOTE_CHECK_PHASES.filter((phase) => gates[phase]).map((phase) => ledgerNotes[phase]),
  );

  const messages = lastAssistantMessages(transcriptPath);
  const findings: Array<AnswerQuoteSpanFinding> = [];
  const presenceOutcomes: SpanCandidateOutcome[] = [];
  let checked = 0;
  let enforceable = 0;
  // Set when a deadline comparison cuts the walk: spans never started
  // contribute no candidate outcomes, so their candidates would otherwise
  // fold as `absent` - a verdict the fold reserves for a note the reply
  // had every chance to touch and did not.
  let budgetExhausted = false;
  outer: for (const [messageIndex, message] of messages.entries()) {
    // Before the scans of this message, not only before its spans: the
    // span and path scans themselves cost the budget they precede.
    if (Date.now() > deadline) {
      budgetExhausted = true;
      break outer;
    }
    const scan = findQuoteSpans(message);
    if (scan.spans.length === 0) continue;
    const marks = citationMarks(message);
    for (const span of scan.spans) {
      if (Date.now() > deadline) {
        budgetExhausted = true;
        break outer;
      }
      checked++;
      const quoted: QuotedSpan = {
        message: messageIndex,
        inner: span.inner,
        open: span.open,
        close: span.close,
      };
      const outcome = checkSpan(quoted, marks, candidates, vault, deadline);
      presenceOutcomes.push(...outcome.candidateOutcomes);
      if (outcome.verdict !== ANSWER_QUOTE_VERDICT.verified) {
        // Attribution: the phases whose candidates decided this miss. A
        // miss decided only by a phase switched to `off` is not this
        // turn's report - the operator disabled that phase's findings,
        // and its delivered notes are still evidence for the phases
        // that remain on. A span with an explicit citation mark (or no
        // candidate at all) is not ledger-attributable: every running
        // phase's check covers it, exactly as before the attribution.
        const deciding = outcome.decidingPhases.length > 0 ? outcome.decidingPhases : running;
        const contributing = deciding.filter((phase) => modes[phase] !== "off");
        if (contributing.length === 0) continue;
        if (contributing.some((phase) => modes[phase] === "enforce")) enforceable++;
        findings.push({ span: outcome.preview, verdict: outcome.verdict });
      }
    }
  }
  // The reply-presence record (t_f8510c55): exactly one per checked
  // turn, whatever the findings - a turn whose every span verified still
  // owes its per-note verdicts, and a note no span touched reads
  // `absent`, the row this record exists to surface - except when the
  // budget cut the walk or the reply text never arrived, where an
  // unmeasured note reads `note-unavailable` (the fold's own doc names
  // the distinction: an unmeasured note never reads as an unused one).
  // A turn with no injected candidate writes nothing: with no note to
  // report on, an empty verdict list would say nothing the absence of a
  // record does not say already - and the session id rides every record,
  // since the ledger candidates are unreachable without one. Fail-open
  // like every arm: a failed append names itself on the audit line and
  // the annotation still goes out.
  if (candidates.length > 0 && sessionId !== null) {
    try {
      appendContinuityRecord(vault, {
        kind: "reply_presence",
        createdAt: isoSecond(new Date()),
        payload: {
          [CONTINUITY_SESSION_ID_KEY]: sessionId,
          checked,
          per_note: foldReplyPresence(
            candidates,
            presenceOutcomes,
            budgetExhausted,
            messages.length > 0,
          ),
          // The hash binds the verdicts to the exact answer text checked;
          // it carries no answer text itself.
          ...(messages.length > 0
            ? {
                source_hash: createHash("sha256").update(messages.join("\n"), "utf8").digest("hex"),
              }
            : {}),
        },
      });
    } catch (err) {
      process.stderr.write(`${AUDIT_PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const unique = dedupeFindings(findings);
  if (unique.length === 0) return;

  if (enforceable > 0) {
    // Exactly one Brain-log event per turn, best-effort: a failed append
    // names itself on the audit line and the annotation still goes out.
    // The findings ride the same capped, flattened lines the annotation
    // renders; the counter states the true total of the enforceable
    // findings - the ones a running `enforce` phase's evidence decided.
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date()),
        // The `note` kind is the Brain log's designated audit-line home;
        // the pinned `session-lifecycle` shape belongs to the lifecycle
        // capture and is not this event's shape to borrow.
        eventType: BRAIN_LOG_EVENT_KIND.note,
        agent: resolveAgentName(),
        body: {
          hook: "answer-quote-check",
          phases: running.join(","),
          checked: String(checked),
          unverified: String(enforceable),
          findings: listedFindings(unique).map((finding) =>
            findingLine(finding.span, finding.verdict),
          ),
        },
      });
    } catch (err) {
      process.stderr.write(`${AUDIT_PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: annotation(unique) },
    })}\n`,
  );
}

// Run only as the hook process itself (the `o2b-hook` shim execs this
// file), not when the module is imported for its constants in tests.
if (import.meta.main) {
  main().catch((err: unknown) => {
    // Never deadlock on a hook crash: one stderr audit line, exit 0.
    process.stderr.write(`${AUDIT_PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
