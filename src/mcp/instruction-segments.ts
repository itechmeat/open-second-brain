/**
 * The scope bodies of `initialize.instructions`, as tool-tagged segments.
 *
 * ## Why the text is not a constant any more
 *
 * The instruction block is the first thing every agent reads, and it used
 * to be one frozen string per scope. This server already evaluates a
 * runtime capability window and knows, per tool, whether it is available
 * or withheld and why (`evaluateToolCapabilities`) - so a host that
 * disables `brain_note` produced a handshake whose opening paragraph
 * instructed the agent to call it. The agent then calls, reads the
 * refusal, and learns that the first text it was given was wrong.
 *
 * Appending a "…except these" block beneath the same prose does not fix
 * that. An instruction and its retraction in one document leave the
 * reader deciding which half is true, and the half printed first is the
 * one that shapes the plan. So the guidance is REMOVED, and the removal
 * is NAMED with the reason the evaluator already produced. No second
 * vocabulary is invented here: every reason in the withheld block is a
 * string {@link evaluateToolCapabilities} wrote.
 *
 * ## The model
 *
 * A scope body is an ordered list of {@link InstructionParagraph}s
 * joined by a blank line. A paragraph is an ordered list of
 * {@link InstructionSegment}s, each declaring the tool names its text
 * instructs the reader to call.
 *
 *   - A segment renders when EVERY tool it names is available. A segment
 *     naming none is unconditional text.
 *   - Between two rendered segments goes the `separator` of the earlier
 *     one, so a dropped clause takes its own punctuation with it and the
 *     survivors still read as one sentence.
 *   - A paragraph whose every tool-bearing segment was dropped renders
 *     NOTHING, its unconditional text included. A lead-in with nothing
 *     left to lead into is not guidance, and a sentence such as "Five
 *     tools live here" is a claim that stops being true the moment one
 *     of them is withheld.
 *
 * The fully-available render is byte-identical to the strings this model
 * replaces; `tests/mcp/instruction-segments.test.ts` pins that against a
 * captured fixture so a reshaping cannot quietly become a rewrite.
 *
 * ## What the withheld block does and does not list
 *
 * It lists the tools THIS TEXT would have instructed and cannot - the
 * intersection of the report's `withheld` entries with the names the
 * scope's segments declare. Not the whole withheld set: a `max_tools`
 * window on the full scope withholds over a hundred tools, and pasting
 * that list into the handshake would spend more tokens explaining an
 * absence than the removed guidance ever cost. The block says where the
 * complete report is, and {@link CAPABILITY_DIAGNOSTIC_TOOL} is never
 * itself withheld, so that pointer always leads somewhere.
 */

import { CAPABILITY_DIAGNOSTIC_TOOL } from "./capabilities.ts";
import { TOOL_SCOPE, type ToolCapabilityReport, type ToolScope } from "./tool-contract.ts";

/** One run of instruction text and the tools whose availability it assumes. */
export interface InstructionSegment {
  /**
   * Tool names the text instructs the reader to call. Empty means the
   * text stands whatever the runtime withholds.
   */
  readonly tools: ReadonlyArray<string>;
  /** The text, carrying no leading or trailing separator of its own. */
  readonly text: string;
  /**
   * Placed before the next rendered segment of the same paragraph.
   * Absent on the last segment, and on any segment whose successor
   * begins a new sentence of its own.
   */
  readonly separator?: string;
}

/** Segments that render as one paragraph. */
export interface InstructionParagraph {
  readonly segments: ReadonlyArray<InstructionSegment>;
  /** Appended once after the last rendered segment, when any rendered. */
  readonly end?: string;
}

/** Between two paragraphs, and between the body and the withheld block. */
const PARAGRAPH_BREAK = "\n\n";

/** Between the lines of a bulleted paragraph. */
const LINE_BREAK = "\n";

/** Between two clauses of one sentence. */
const CLAUSE = "; ";

/** Between two sentences of one paragraph. */
const SENTENCE = ". ";

/** Between two items of an inline list. */
const ITEM = ", ";

/** Indent of a bullet, matching the shipped writer body. */
const BULLET = "  - ";

/** Heading of the block that names what this runtime withheld. */
export const WITHHELD_BLOCK_HEADING =
  "Withheld in this runtime, so the guidance naming them is not in the text above:";

/** Closing line of the withheld block: where the complete report is. */
const WITHHELD_BLOCK_POINTER =
  `Call ${CAPABILITY_DIAGNOSTIC_TOOL} for the complete availability report; ` +
  "it lists tools this text never names.";

/**
 * Reason a segment's tool carries when the report knows nothing about it.
 *
 * Unreachable in a shipped build - the orphan census in
 * `tests/mcp/instruction-segments.test.ts` fails on a segment naming a
 * tool its scope does not register - and stated anyway, because the
 * alternative is a segment that disappears with no line saying so.
 */
const UNREGISTERED_REASON = "not registered in this server's tool table";

/** The always-loaded writer surface, in the order the writer body lists it. */
const WRITER_TOOLS = Object.freeze([
  "brain_feedback",
  "brain_apply_evidence",
  "brain_note",
  "brain_pinned_context",
  "brain_context",
]);

/** The deferred catalog's own entry point. */
const HYDRATE_TOOL = "tool_hydrate";

/** The consolidated read views the full body advertises. */
const VIEW_TOOLS = Object.freeze(["brain_brief", "brain_analytics", "schema_inspect"]);

/** The escape hatch for a truncated preview. */
const ARTIFACT_TOOL = "brain_artifact_get";

/** Text that stands whatever the runtime withholds. */
function unconditional(text: string, separator?: string): InstructionSegment {
  return { tools: [], text, ...(separator === undefined ? {} : { separator }) };
}

const FULL_BODY: ReadonlyArray<InstructionParagraph> = Object.freeze([
  {
    end: ".",
    segments: [
      {
        tools: ["brain_feedback"],
        text: "Memory contract: call brain_feedback once per taste signal the user expresses",
        separator: CLAUSE,
      },
      {
        tools: ["brain_apply_evidence"],
        text:
          "brain_apply_evidence right after producing a durable artifact a preference " +
          "in `Brain/preferences/` scopes to (result: applied | violated | outdated)",
        separator: CLAUSE,
      },
      {
        tools: ["brain_note"],
        text: "brain_note for narrative milestones that fit neither",
        separator: CLAUSE,
      },
      {
        tools: ["brain_pinned_context"],
        text: "brain_pinned_context for current-task facts that must survive context rotation",
        separator: SENTENCE,
      },
      {
        tools: ["brain_context"],
        text: "brain_context bootstraps a session when the host injects no active.md hook",
        separator: SENTENCE,
      },
      unconditional(
        "Skip Brain calls for casual chat, exploration, and trivial edits - " +
          "a misrecorded signal is worse than a missed one",
      ),
    ],
  },
  {
    end: ".",
    segments: [
      {
        tools: ["brain_brief"],
        text:
          "Consolidated read views: brain_brief (view: morning | daily | weekly | " +
          "monthly | operator | digest)",
        separator: ITEM,
      },
      {
        tools: ["brain_analytics"],
        text:
          "brain_analytics (view: timeline | attention_flows | belief_evolution | " +
          "concept_synthesis)",
        separator: ITEM,
      },
      {
        tools: ["schema_inspect"],
        text:
          "schema_inspect (view: graph | lint | stats | orphans | explain_type | " +
          "active_pack | packs)",
        separator: SENTENCE,
      },
      {
        // The sentence is about the aliases of those three views, so it
        // stands or falls with them rather than dangling on its own.
        tools: VIEW_TOOLS,
        text: "The per-view predecessor names still resolve via tools/call as deprecated aliases",
      },
    ],
  },
  {
    segments: [
      {
        tools: [ARTIFACT_TOOL],
        text:
          "Preview budget: a large result may arrive as a JSON envelope with " +
          "`preview_truncated: true` and an `artifact_id`; fetch the full payload " +
          "with brain_artifact_get only when the preview is not enough.",
      },
    ],
  },
]);

const WRITER_BODY: ReadonlyArray<InstructionParagraph> = Object.freeze([
  { segments: [unconditional("Open Second Brain — always-loaded MCP surface.")] },
  {
    segments: [
      {
        // The count is a claim about the whole set, so it goes when any
        // member does; the bullets that survive still say what is here.
        tools: WRITER_TOOLS,
        text:
          "Five tools live here (four writers + one reader; the server's name is\n" +
          "preserved for backward compatibility with existing client configs):",
        separator: LINE_BREAK,
      },
      {
        tools: ["brain_feedback"],
        text: `${BULLET}brain_feedback        — record one new taste signal the user just expressed.`,
        separator: LINE_BREAK,
      },
      {
        tools: ["brain_apply_evidence"],
        text:
          `${BULLET}brain_apply_evidence  — record applied | violated | outdated against an\n` +
          "                            active preference for an artifact this turn produced.",
        separator: LINE_BREAK,
      },
      {
        tools: ["brain_note"],
        text:
          `${BULLET}brain_note            — record one narrative milestone (release shipped,\n` +
          "                            PR merged, fact discovered) that fits neither\n" +
          "                            category.",
        separator: LINE_BREAK,
      },
      {
        tools: ["brain_pinned_context"],
        text:
          `${BULLET}brain_pinned_context  — read/write/append/clear Brain/pinned.md for\n` +
          "                            current-task facts that should survive context\n" +
          "                            rotation without becoming permanent preferences.",
        separator: LINE_BREAK,
      },
      {
        tools: ["brain_context"],
        text:
          `${BULLET}brain_context         — pull the current Brain/active.md body plus\n` +
          "                            pinned context and active-preference counts.\n" +
          "                            Read-only. Use at session\n" +
          "                            start when the host runtime lacks a SessionStart\n" +
          "                            hook (Cursor, Aider, raw Claude API). Runtimes that\n" +
          "                            already inject active.md via a hook can skip this.",
      },
    ],
  },
  {
    segments: [
      unconditional(
        'The remaining Brain surface lives on the sibling "open-second-brain"\n' +
          "MCP server (deferred), including additional read-only, analytics,\n" +
          "maintenance, and workflow tools beyond the always-loaded writer set.\n" +
          "Use ToolSearch to discover and reach it.",
      ),
    ],
  },
  {
    segments: [
      {
        tools: WRITER_TOOLS.filter((name) => name !== "brain_context"),
        text:
          "Prefer the writer-server copies of brain_feedback / brain_apply_evidence /\n" +
          "brain_note / brain_pinned_context over any duplicate exposed by the full server — both call the same\n" +
          "handler, but the writer copy is always available without ToolSearch.",
      },
    ],
  },
]);

const CATALOG_BODY: ReadonlyArray<InstructionParagraph> = Object.freeze([
  { segments: [unconditional("Open Second Brain — two-pass catalog MCP surface.")] },
  {
    segments: [
      {
        tools: [...WRITER_TOOLS, HYDRATE_TOOL],
        text:
          "This server advertises a compact first-pass tool set: the capability\n" +
          "diagnostic, the five always-loaded Brain writers/readers, and\n" +
          "tool_hydrate. Every other Open Second Brain tool stays CALLABLE via\n" +
          "tools/call — it is only omitted from tools/list to keep schema tokens\n" +
          "out of your prompt until needed.",
      },
    ],
  },
  {
    segments: [
      {
        tools: [HYDRATE_TOOL],
        text:
          "Second pass: call tool_hydrate with no arguments to get the compact\n" +
          "catalog (name, one-line description, group) of every tool in this\n" +
          "process, then call tool_hydrate with names: [...] to fetch the full\n" +
          "input/output schemas for the tools you actually need. After hydration,\n" +
          "invoke those tools directly by name through tools/call — no further\n" +
          "registration step exists or is needed.",
      },
    ],
  },
  {
    segments: [
      {
        tools: [HYDRATE_TOOL],
        text:
          "Do not invent substitute workflows for a capability you cannot see:\n" +
          "hydrate the catalog first; the tool is almost certainly already here.",
      },
    ],
  },
]);

/**
 * The body of each scope.
 *
 * A total map rather than a chain of `if`s: a scope added to
 * {@link TOOL_SCOPE} without a body here fails to compile.
 */
const SCOPE_BODIES: Readonly<Record<ToolScope, ReadonlyArray<InstructionParagraph>>> =
  Object.freeze({
    [TOOL_SCOPE.full]: FULL_BODY,
    [TOOL_SCOPE.writer]: WRITER_BODY,
    [TOOL_SCOPE.catalog]: CATALOG_BODY,
  });

/** Every tool name the segments of `scope` declare, in declaration order. */
export function segmentToolNames(scope: ToolScope): string[] {
  const seen = new Set<string>();
  for (const paragraph of SCOPE_BODIES[scope]) {
    for (const segment of paragraph.segments) {
      for (const name of segment.tools) seen.add(name);
    }
  }
  return [...seen];
}

/** One paragraph, or null when nothing in it survived the runtime. */
function renderParagraph(
  paragraph: InstructionParagraph,
  isAvailable: (name: string) => boolean,
): string | null {
  const rendered = paragraph.segments.filter((segment) => segment.tools.every(isAvailable));
  if (rendered.length === 0) return null;
  const conditional = paragraph.segments.some((segment) => segment.tools.length > 0);
  if (conditional && !rendered.some((segment) => segment.tools.length > 0)) return null;
  let out = "";
  let pending = "";
  for (const segment of rendered) {
    out += pending + segment.text;
    pending = segment.separator ?? "";
  }
  return out + (paragraph.end ?? "");
}

/** The withheld block, or null when this scope's guidance survived intact. */
function renderWithheldBlock(scope: ToolScope, report: ToolCapabilityReport): string | null {
  const reasons = new Map(report.withheld.map((entry) => [entry.name, entry.reason]));
  const available = new Set(report.available.map((entry) => entry.name));
  const lines: string[] = [];
  for (const name of segmentToolNames(scope)) {
    if (available.has(name)) continue;
    lines.push(`${BULLET}${name}: ${reasons.get(name) ?? UNREGISTERED_REASON}`);
  }
  if (lines.length === 0) return null;
  return [WITHHELD_BLOCK_HEADING, ...lines, "", WITHHELD_BLOCK_POINTER].join(LINE_BREAK);
}

/**
 * The instruction body for `scope` under the runtime `report` describes.
 *
 * The identity line is not part of it: that is the caller's, because it
 * answers a different question and refuses for a different reason.
 */
export function renderScopeBody(scope: ToolScope, report: ToolCapabilityReport): string {
  const available = new Set(report.available.map((entry) => entry.name));
  const isAvailable = (name: string): boolean => available.has(name);
  const blocks: string[] = [];
  for (const paragraph of SCOPE_BODIES[scope]) {
    const text = renderParagraph(paragraph, isAvailable);
    if (text !== null) blocks.push(text);
  }
  const withheld = renderWithheldBlock(scope, report);
  if (withheld !== null) blocks.push(withheld);
  return blocks.join(PARAGRAPH_BREAK);
}
