/**
 * Operator-readable session handoff notes (Agent Surface Suite,
 * t_28afa4d2).
 *
 * A handoff answers four questions a session leaves behind: what was
 * asked, what got done, what was learned, and what the next session
 * should pick up first. Extraction is deterministic regex over the
 * normalised turns - no LLM - so the note is reproducible and cheap;
 * the source session file remains the lossless record.
 */

import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { computeSourceStamp } from "./freshness.ts";
import { isoDate, isoSecond } from "./time.ts";
import { resolveSessionScope } from "./session-scope.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import type { SessionTurn } from "./sessions/types.ts";

export interface HandoffNoteOptions {
  /** Raw session id or workstream label; normalised to a scope slug. */
  readonly sessionId: string;
  readonly agent: string;
  readonly now?: Date;
}

export interface WriteHandoffNoteInput extends HandoffNoteOptions {
  readonly turns: ReadonlyArray<SessionTurn>;
  /**
   * On-disk artifacts this note derives from (the recorded transcript,
   * typically). When present, the source-freshness contract
   * (`source_paths` / `source_hashes`) is stamped into the frontmatter
   * so the note participates in stale/orphaned detection
   * (continuity-hygiene-freshness suite).
   */
  readonly sourcePaths?: ReadonlyArray<string>;
  /**
   * Exact page path to (over)write instead of the default
   * `Brain/handoffs/<date>-<scope>.md` - the targeted-recompile
   * executor re-derives a stale note IN PLACE so its identity and
   * backlinks survive.
   */
  readonly targetPath?: string;
}

export interface HandoffNoteResult {
  readonly path: string;
  readonly scope: string;
  readonly content: string;
}

const MAX_LINES_PER_SECTION = 5;
const MAX_REQUEST_CHARS = 500;

const COMPLETED_RE = /\b(done|completed|shipped|merged|fixed|implemented|created|added)\b/iu;
const LEARNED_RE = /\b(learned|discovered|turns out|note that|important|gotcha)\b/iu;
const NEXT_RE = /\b(next step|next session|todo|remaining|follow-up|later|pick up)\b/iu;

/** Tool names whose input.file_path marks a changed file. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch", "NotebookEdit"]);

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectMatching(
  turns: ReadonlyArray<SessionTurn>,
  roles: ReadonlySet<SessionTurn["role"]>,
  re: RegExp,
): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (!roles.has(turn.role) || !turn.text) continue;
    for (const line of lines(turn.text)) {
      if (!re.test(line)) continue;
      if (!out.includes(line)) out.push(line);
      if (out.length >= MAX_LINES_PER_SECTION) return out;
    }
  }
  return out;
}

function collectChangedFiles(turns: ReadonlyArray<SessionTurn>): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      if (!WRITE_TOOLS.has(call.name)) continue;
      const filePath = call.input["file_path"] ?? call.input["path"];
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (!out.includes(filePath)) out.push(filePath);
    }
  }
  return out;
}

function section(title: string, entries: ReadonlyArray<string>): string {
  const body =
    entries.length === 0 ? "(none captured)" : entries.map((entry) => `- ${entry}`).join("\n");
  return `## ${title}\n\n${body}`;
}

/** Render the handoff note body (without frontmatter). Pure. */
export function buildHandoffNote(
  turns: ReadonlyArray<SessionTurn>,
  opts: HandoffNoteOptions,
): string {
  const firstUser = turns.find((turn) => turn.role === "user" && turn.text);
  const request = firstUser?.text?.trim().slice(0, MAX_REQUEST_CHARS) ?? "(none captured)";
  const assistantRoles = new Set<SessionTurn["role"]>(["assistant"]);
  const anyRoles = new Set<SessionTurn["role"]>(["user", "assistant"]);

  const completed = collectMatching(turns, assistantRoles, COMPLETED_RE);
  const learned = collectMatching(turns, anyRoles, LEARNED_RE);
  const nextSteps = collectMatching(turns, anyRoles, NEXT_RE);
  const files = collectChangedFiles(turns);

  return [
    `# Handoff - ${opts.sessionId}`,
    "",
    `Agent ${opts.agent}, ${turns.length} turn(s).`,
    "",
    `## Request\n\n${request}`,
    "",
    section("Completed work", completed),
    "",
    section("Files changed", files),
    "",
    section("Learned context", learned),
    "",
    section("Next steps", nextSteps),
    "",
  ].join("\n");
}

/** Build and persist the note at `Brain/handoffs/<date>-<scope>.md`. */
export function writeHandoffNote(vault: string, input: WriteHandoffNoteInput): HandoffNoteResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const now = input.now ?? new Date();
  const scope = resolveSessionScope(input.sessionId);
  const dir = join(vault, "Brain", "handoffs");
  const path = input.targetPath ?? join(dir, `${isoDate(now)}-${scope}.md`);
  const body = buildHandoffNote(input.turns, input);
  // The frontmatter is a MAP handed to the shared emitter, not a string
  // assembled here. The hand-rolled version quoted the caller-supplied
  // scalars with `JSON.stringify` to stop a YAML-significant character
  // or a newline in a session id breaking the block; `formatFrontmatter`
  // already owns that rule, and owns it more completely - it quotes on
  // the same structural test the PARSER uses and escapes the backslash
  // and control characters `JSON.stringify` alone left to chance. One
  // emitter, so a note this module writes and a note the vault reader
  // parses cannot disagree about quoting.
  const metadata: FrontmatterMap = {
    session_id: input.sessionId,
    scope,
    agent: input.agent,
    created_at: isoSecond(now),
    turns: input.turns.length,
    ...(input.sourcePaths !== undefined && input.sourcePaths.length > 0
      ? computeSourceStamp(vault, input.sourcePaths)
      : {}),
  };
  // `overwrite` because both callers re-derive in place: the SessionEnd
  // hook rewrites the day's note and the targeted-recompile executor
  // refreshes an existing one by path. The atomic writer creates the
  // parent directory, so the note is never observed half-written and no
  // `mkdirSync` is needed ahead of it.
  writeFrontmatterAtomic(path, metadata, body, { overwrite: true });
  return Object.freeze({ path, scope, content: formatFrontmatter(metadata, body) });
}
