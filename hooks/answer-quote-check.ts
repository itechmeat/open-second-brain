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

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

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
import { appendLogEvent } from "../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../src/core/brain/types.ts";
import { isoSecond } from "../src/core/brain/time.ts";
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

/** Wall-clock budget for the whole check; past it, unchecked spans are dropped. */
export const ANSWER_QUOTE_BUDGET_MS = 1500;

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
 */
const PATH_POINTER_RE = /(?:[^\s:|[\]()#]+\/)+[^\s:|[\]()#]*\.md(?::L(\d+)-L(\d+))?/g;

/** A `.md` path token, for scanning ledger member strings that are prose. */
const PATH_TOKEN_RE = /(?:[^\s:|[\]()#]+\/)+[^\s:|[\]()#]*\.md/g;

// ----- transcript tail -----------------------------------------------------

/**
 * The last {@link ANSWER_QUOTE_TAIL_BYTES} of the transcript as text. One
 * bounded positional read; the caller drops the line the window may have
 * cut in half.
 */
function readTail(path: string): { readonly text: string; readonly cutStart: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - ANSWER_QUOTE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), cutStart: start > 0 };
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
 * otherwise. Every failure to read names itself as
 * `unavailable` / `not-text` evidence rather than throwing.
 */
function evidenceFor(vault: string, mark: CitationMark): AnswerQuoteEvidence {
  const absolute = resolveNotePath(vault, mark.path);
  if (absolute === null || !existsSync(absolute)) {
    return { kind: "unavailable" };
  }
  let whole: string;
  try {
    whole = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
  } catch {
    return { kind: "not-text" };
  }
  if (mark.startLine === undefined || mark.endLine === undefined) {
    return { kind: "text", text: whole, truncated: false };
  }
  const lines = whole.split("\n");
  const slice = lines.slice(mark.startLine - 1, mark.endLine).join("\n");
  return { kind: "text", text: slice, truncated: true };
}

// ----- the injection ledger's candidate notes ------------------------------

/** Note paths one recall ledger key names, with its line range. */
function recallKeyCandidate(
  key: string,
): { readonly path: string; readonly startLine: number; readonly endLine: number } | null {
  const hash = key.lastIndexOf("#L");
  if (hash === -1) return null;
  const range = /^L(\d+)-L(\d+)$/.exec(key.slice(hash + 1));
  if (range === null) return null;
  const body = key.slice(0, hash);
  const colon = body.indexOf(":");
  // `<origin>:<path>` with a slug origin; a vault-relative path always
  // carries a `/`, an origin never does.
  const path = colon !== -1 && !body.slice(0, colon).includes("/") ? body.slice(colon + 1) : body;
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
): ReadonlyArray<{
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}> {
  if (sessionId === null) return [];
  const candidates = new Map<string, { startLine?: number; endLine?: number }>();
  if (phase === "recall") {
    for (const key of readRecallInjected(vault, sessionId, nowMs)) {
      const parsed = recallKeyCandidate(key);
      if (parsed === null) continue;
      candidates.set(parsed.path, { startLine: parsed.startLine, endLine: parsed.endLine });
    }
  }
  if (phase === "active") {
    for (const path of readActiveEmittedPaths(vault, sessionId, nowMs)) {
      candidates.set(path, {});
    }
    const parts = readHookStamp(vault, sessionId, LEDGER_KEY_REGROUND, nowMs)?.data?.["parts"];
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part !== "string") continue;
        for (const path of pathTokens(part)) candidates.set(path, {});
      }
    }
  }
  if (phase === "subagent") {
    for (const path of readSubagentDeliveredPaths(vault, sessionId, nowMs)) {
      candidates.set(path, {});
    }
  }
  return [...candidates.entries()]
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, range]) => ({
      path,
      ...(range.startLine !== undefined ? { startLine: range.startLine } : {}),
      ...(range.endLine !== undefined ? { endLine: range.endLine } : {}),
    }));
}

// ----- the check ------------------------------------------------------------

/** One span's outcome under the resolved evidence, inside the budget. */
interface SpanOutcome {
  readonly verdict: AnswerQuoteVerdict;
  /**
   * The span as the check module previews it - length-capped, code-point
   * safe. Findings render only this form, never the raw span: a span is
   * answer text, and the annotation's line structure is the hook's voice.
   */
  readonly preview: string;
}

/** One span's verdict under the resolved evidence, inside the budget. */
function checkSpan(
  span: QuotedSpan,
  marks: ReadonlyArray<CitationMark>,
  candidates: ReadonlyArray<{
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
  }>,
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
    return { verdict: outcomes[0]!.verdict, preview: outcomes[0]!.span };
  }
  if (candidates.length === 0) {
    return {
      verdict: mergeAnswerQuoteVerdicts([]),
      preview: previewAnswerQuoteSpan(span.inner),
    };
  }
  const verdicts: AnswerQuoteVerdict[] = [];
  let preview = previewAnswerQuoteSpan(span.inner);
  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      // Budget spent with unread candidates left: the check did not
      // finish, so it never reports a readable-miss verdict.
      return { verdict: ANSWER_QUOTE_VERDICT.noteUnavailable, preview };
    }
    const mark: CitationMark = {
      at: -1,
      path: candidate.path,
      ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
      ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
    };
    const { outcomes } = checkAnswerQuotes({
      spans: [span.inner],
      evidence: evidenceFor(vault, mark),
    });
    const verdict = outcomes[0]!.verdict;
    preview = outcomes[0]!.span;
    verdicts.push(verdict);
    if (verdict === ANSWER_QUOTE_VERDICT.verified) break;
  }
  return { verdict: mergeAnswerQuoteVerdicts(verdicts), preview };
}

/**
 * One rendered finding line. The span renders flattened - CR/LF and
 * whitespace runs collapsed to single spaces, inside the check module's
 * preview cap - so answer text can never introduce annotation-shaped
 * lines of its own.
 */
function findingLine(span: string, verdict: AnswerQuoteVerdict): string {
  return `- [${verdict}] "${span.replace(/\s+/g, " ").trim()}"`;
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
 * findings cap.
 */
function annotation(findings: ReadonlyArray<AnswerQuoteSpanFinding>): string {
  const listed = listedFindings(findings);
  const lines = [
    `Open Second Brain quote check: ${findings.length} quoted span(s) were not found in the notes this turn had:`,
    ...listed.map((finding) => findingLine(finding.span, finding.verdict)),
  ];
  if (listed.length < findings.length) {
    lines.push(`... and ${findings.length - listed.length} more unverified span(s) not listed.`);
  }
  lines.push(
    "Advisory only; the answer is not blocked. Verify the quotes against the note, or reword.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
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
  const ledgerNotes: Readonly<Record<AnswerQuoteCheckPhase, ReturnType<typeof ledgerCandidates>>> =
    {
      recall: ledgerCandidates(vault, sessionId, "recall", now),
      active: ledgerCandidates(vault, sessionId, "active", now),
      subagent: ledgerCandidates(vault, sessionId, "subagent", now),
    };
  // A phase runs only when its injection is enabled AND its mode is more
  // than `off`; the injection gate of recall is the recall-inject flag,
  // active and subagent gate on a live ledger of their own.
  const gates: Readonly<Record<AnswerQuoteCheckPhase, boolean>> = {
    recall: resolveRecallInjectEnabled(),
    active: ledgerNotes.active.length > 0,
    subagent: ledgerNotes.subagent.length > 0,
  };
  const running = ANSWER_QUOTE_CHECK_PHASES.filter(
    (phase) => gates[phase] && modes[phase] !== "off",
  );
  if (running.length === 0) return;
  const candidateByPath = new Map<string, { path: string; startLine?: number; endLine?: number }>();
  for (const phase of running) {
    for (const candidate of ledgerNotes[phase]) candidateByPath.set(candidate.path, candidate);
  }
  const candidates = [...candidateByPath.values()].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const messages = lastAssistantMessages(transcriptPath);
  const findings: Array<AnswerQuoteSpanFinding> = [];
  let checked = 0;
  outer: for (const [messageIndex, message] of messages.entries()) {
    const scan = findQuoteSpans(message);
    if (scan.spans.length === 0) continue;
    const marks = citationMarks(message);
    for (const span of scan.spans) {
      if (Date.now() > deadline) break outer;
      checked++;
      const quoted: QuotedSpan = {
        message: messageIndex,
        inner: span.inner,
        open: span.open,
        close: span.close,
      };
      const outcome = checkSpan(quoted, marks, candidates, vault, deadline);
      if (outcome.verdict !== ANSWER_QUOTE_VERDICT.verified) {
        findings.push({ span: outcome.preview, verdict: outcome.verdict });
      }
    }
  }
  const unique = dedupeFindings(findings);
  if (unique.length === 0) return;

  const enforce = running.some((phase) => modes[phase] === "enforce");
  if (enforce) {
    // Exactly one Brain-log event per turn, best-effort: a failed append
    // names itself on the audit line and the annotation still goes out.
    // The findings ride the same capped, flattened lines the annotation
    // renders; the counter states the true total.
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.sessionLifecycle,
        agent: resolveAgentName(),
        body: {
          hook: "answer-quote-check",
          phases: running.join(","),
          checked: String(checked),
          unverified: String(unique.length),
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
