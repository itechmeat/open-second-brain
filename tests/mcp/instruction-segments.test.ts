/**
 * `initialize.instructions` rendered from the live capability report.
 *
 * ## The defect
 *
 * The instruction block is the first text every agent reads, and it was
 * three frozen strings chosen by scope alone. A host that disables
 * `brain_note` - a supported runtime capability window this server
 * already evaluates and reports on - still received a paragraph telling
 * the agent to call it. The agent then calls a tool that is not there,
 * reads the refusal, and works out for itself that the first thing it
 * was told was wrong.
 *
 * Appending "…except these" beneath the same prose would not fix it: an
 * instruction and its retraction in one document leave the reader to
 * decide which half is true. So the guidance is REMOVED rather than
 * contradicted, and the removal is named with the reason the evaluator
 * already computed.
 *
 * ## What is pinned here
 *
 * The rewrite's own risk is that shaping three bodies into segments
 * changes their MEANING. The first test removes that risk by pinning the
 * fully-available render of each scope against a byte-for-byte fixture
 * captured from the frozen strings this change replaces. Only the
 * withheld cases may differ, and the rest of this file is those cases.
 *
 * One sentence in `catalog.txt` is a deliberate exception. The frozen
 * string said every tool omitted from `tools/list` stays callable
 * through `tools/call`, which was true of the catalog surface's hiding
 * and false of a capability window - the window removes the tool from
 * the table `tools/call` routes on. A window is exactly what this
 * module renders for, so the one paragraph that contradicted it was
 * rewritten rather than pinned, and the fixture carries the corrected
 * text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildInstructions } from "../../src/mcp/instructions.ts";
import {
  PARAGRAPH_BREAK,
  WITHHELD_BLOCK_HEADING,
  segmentToolNames,
} from "../../src/mcp/instruction-segments.ts";
import {
  CAPABILITY_DIAGNOSTIC_TOOL,
  evaluateToolCapabilities,
  type RuntimeCapabilityWindow,
} from "../../src/mcp/capabilities.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import {
  TOOL_SCOPE,
  TOOL_SCOPES,
  type ToolCapabilityReport,
  type ToolScope,
} from "../../src/mcp/tool-contract.ts";

/** Where the byte-identity fixtures captured from the frozen strings live. */
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "instruction-bodies");

/** Agent name the fixtures were captured under. */
const AGENT = "pin-agent";

/** The tool the withheld cases exercise, and the reason the evaluator gives it. */
const WITHHELD_TOOL = "brain_note";
const DISABLED_REASON = "disabled by runtime capability window";

/** Server name for reports built here; nothing under test reads it. */
const TEST_SERVER = "open-second-brain-test";

function reportFor(scope: ToolScope, window?: RuntimeCapabilityWindow): ToolCapabilityReport {
  return evaluateToolCapabilities(buildToolTable(scope), {
    scope,
    serverName: TEST_SERVER,
    window,
  }).report;
}

/** The pinned body for `scope`, without the trailing newline the file carries. */
function fixtureBody(scope: ToolScope): string {
  const text = readFileSync(join(FIXTURE_DIR, `${scope}.txt`), "utf8");
  expect(`${scope}.txt ends with a newline: ${text.endsWith("\n")}`).toBe(
    `${scope}.txt ends with a newline: true`,
  );
  return text.slice(0, -1);
}

/** The identity sentence every scope opens with, for the resolved case. */
const IDENTITY_LINE =
  `You are @${AGENT} on this Open Second Brain vault. ` +
  "Always log under this identity; do not invent or change the name.";

describe("a fully available runtime renders exactly what shipped before", () => {
  for (const scope of TOOL_SCOPES) {
    test(`${scope} scope is byte-identical to the pinned body`, () => {
      const text = buildInstructions({
        agent: AGENT,
        scope,
        capabilities: reportFor(scope),
      });
      expect(text).toBe(`${IDENTITY_LINE}\n\n${fixtureBody(scope)}`);
    });
  }
});

describe("a withheld tool loses its guidance rather than gaining a retraction", () => {
  const window: RuntimeCapabilityWindow = { disabledTools: [WITHHELD_TOOL] };

  test("the writer body carries no line instructing the withheld tool", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.writer,
      capabilities: reportFor(TOOL_SCOPE.writer, window),
    });
    const [body, withheldBlock] = text.split(WITHHELD_BLOCK_HEADING);
    expect(withheldBlock).toBeDefined();
    expect(body).not.toContain(WITHHELD_TOOL);
  });

  test("the tool is named once, in the withheld block, with the evaluator's reason", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.writer,
      capabilities: reportFor(TOOL_SCOPE.writer, window),
    });
    const occurrences = text.split(WITHHELD_TOOL).length - 1;
    expect(occurrences).toBe(1);
    expect(text).toContain(`${WITHHELD_TOOL}: ${DISABLED_REASON}`);
  });

  test("the guidance for the tools that remain is still there", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.writer,
      capabilities: reportFor(TOOL_SCOPE.writer, window),
    });
    expect(text).toContain("brain_feedback");
    expect(text).toContain("brain_pinned_context");
  });

  test("the full scope keeps the memory contract minus the withheld clause", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.full,
      capabilities: reportFor(TOOL_SCOPE.full, window),
    });
    const [body] = text.split(WITHHELD_BLOCK_HEADING);
    expect(body).toContain("Memory contract: call brain_feedback");
    expect(body).toContain("brain_pinned_context for current-task facts");
    expect(body).not.toContain(WITHHELD_TOOL);
  });
});

describe("a runtime that withholds everything instructs nothing", () => {
  // Only the always-available diagnostic survives the window.
  const window: RuntimeCapabilityWindow = { allowedTools: [CAPABILITY_DIAGNOSTIC_TOOL] };

  for (const scope of TOOL_SCOPES) {
    test(`${scope} scope names no withheld tool outside the withheld block`, () => {
      const report = reportFor(scope, window);
      const text = buildInstructions({ agent: AGENT, scope, capabilities: report });
      const [body] = text.split(WITHHELD_BLOCK_HEADING);
      // The loop below is vacuous over an empty set, and a window that
      // stopped being honoured would produce exactly that.
      expect(report.withheld.length).toBeGreaterThan(0);
      for (const entry of report.withheld) {
        expect(`${scope} body names ${entry.name}: ${body!.includes(entry.name)}`).toBe(
          `${scope} body names ${entry.name}: false`,
        );
      }
    });

    test(`${scope} scope still opens with the identity line`, () => {
      const text = buildInstructions({
        agent: AGENT,
        scope,
        capabilities: reportFor(scope, window),
      });
      expect(text.startsWith(IDENTITY_LINE)).toBe(true);
    });
  }

  test("the withheld block names the tools whose guidance was removed", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.writer,
      capabilities: reportFor(TOOL_SCOPE.writer, window),
    });
    expect(text).toContain(WITHHELD_BLOCK_HEADING);
    expect(text).toContain(`${WITHHELD_TOOL}: not allowed by runtime capability window`);
  });

  test("a paragraph whose every tool-bearing clause went renders nothing at all", () => {
    // The full body's memory-contract paragraph closes with an
    // unconditional caveat ("Skip Brain calls for casual chat..."). With
    // every writer withheld it has nothing left to caveat, and a
    // surviving orphan sentence is the shape this rule exists to
    // prevent.
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.full,
      capabilities: reportFor(TOOL_SCOPE.full, window),
    });
    const [body] = text.split(WITHHELD_BLOCK_HEADING);
    expect(body).not.toContain("Skip Brain calls");
    expect(body).not.toContain("Memory contract");
  });
});

describe("a dropped clause takes its punctuation and leaves its lead-in", () => {
  /** The paragraph `text` opens, as a whole and with nothing appended. */
  function paragraphOpening(text: string, prefix: string): string {
    const paragraph = text.split(PARAGRAPH_BREAK).find((block) => block.startsWith(prefix));
    expect(paragraph).toBeDefined();
    return paragraph!;
  }

  test("the memory contract keeps its lead-in when the first tool named goes", () => {
    // Exact text, not `toContain`: a doubled "; ", a stranded separator
    // or a heading welded to the dropped clause are all invisible to a
    // substring probe, and all of them are what this rule is about.
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.full,
      capabilities: reportFor(TOOL_SCOPE.full, { disabledTools: ["brain_feedback"] }),
    });
    expect(paragraphOpening(text, "Memory contract")).toBe(
      "Memory contract: call brain_apply_evidence right after producing a durable artifact " +
        "a preference in `Brain/preferences/` scopes to (result: applied | violated | " +
        "outdated); brain_note for narrative milestones that fit neither; " +
        "brain_pinned_context for current-task facts that must survive context rotation. " +
        "brain_context bootstraps a session when the host injects no active.md hook. " +
        "Skip Brain calls for casual chat, exploration, and trivial edits - " +
        "a misrecorded signal is worse than a missed one.",
    );
  });

  test("the view list keeps its lead-in when the first view named goes", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.full,
      capabilities: reportFor(TOOL_SCOPE.full, { disabledTools: ["brain_brief"] }),
    });
    expect(paragraphOpening(text, "Consolidated read views")).toBe(
      "Consolidated read views: brain_analytics (view: timeline | attention_flows | " +
        "belief_evolution | concept_synthesis), schema_inspect (view: graph | lint | stats " +
        "| orphans | explain_type | active_pack | packs).",
    );
  });

  test("the catalog keeps the fact its second pass depends on", () => {
    // The enumeration ("the five always-loaded Brain writers/readers")
    // stops being true and goes. The sentence beside it stays, because
    // without it the reader meets "Second pass:" with no first pass
    // described anywhere - and it stays TRUE under a window because it
    // separates the two reasons a tool can be missing from tools/list:
    // the catalog surface hides it (still callable) and the window
    // withholds it (not callable), which is exactly the case this test
    // stages.
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.catalog,
      capabilities: reportFor(TOOL_SCOPE.catalog, { disabledTools: [WITHHELD_TOOL] }),
    });
    const [body] = text.split(WITHHELD_BLOCK_HEADING);
    expect(body).not.toContain("compact first-pass tool set");
    expect(paragraphOpening(text, "A tool the catalog")).toBe(
      "A tool the catalog surface alone omits from\n" +
        "tools/list stays CALLABLE via tools/call — the omission keeps schema\n" +
        "tokens out of your prompt until needed. A tool a runtime capability\n" +
        "window withholds is not callable at all.",
    );
    expect(body).toContain("Second pass: call tool_hydrate");
  });
});

describe("the block points at a report only where there is one to read", () => {
  const window: RuntimeCapabilityWindow = { disabledTools: [WITHHELD_TOOL] };

  test("the full scope, which registers the diagnostic, names it", () => {
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.full,
      capabilities: reportFor(TOOL_SCOPE.full, window),
    });
    expect(text).toContain(CAPABILITY_DIAGNOSTIC_TOOL);
  });

  test("the writer scope, which does not register it, does not send an agent there", () => {
    // `buildToolTable("writer")` is the five always-loaded tools and
    // nothing else, so the pointer would have named a tool this server
    // answers `unknown tool` for - the defect the module removes,
    // reintroduced by the sentence explaining the removal.
    const registered = new Set(buildToolTable(TOOL_SCOPE.writer).map((tool) => tool.name));
    expect(registered.has(CAPABILITY_DIAGNOSTIC_TOOL)).toBe(false);
    const text = buildInstructions({
      agent: AGENT,
      scope: TOOL_SCOPE.writer,
      capabilities: reportFor(TOOL_SCOPE.writer, window),
    });
    expect(text).toContain(WITHHELD_BLOCK_HEADING);
    expect(text).not.toContain(CAPABILITY_DIAGNOSTIC_TOOL);
  });
});

describe("the unresolved-identity branch is unchanged", () => {
  for (const scope of TOOL_SCOPES) {
    test(`${scope} scope renders the reason in place of a name`, () => {
      const reason = new Error("config unreadable: /etc/open-second-brain/config.yaml");
      const text = buildInstructions({
        agent: reason,
        scope,
        capabilities: reportFor(scope),
      });
      expect(text).toContain("UNRESOLVED");
      expect(text).toContain(reason.message);
      expect(text).not.toContain("You are @");
      expect(text.endsWith(fixtureBody(scope))).toBe(true);
    });
  }
});

describe("two arguments that disagree are refused, not rendered", () => {
  test("a report built for another scope names the mismatch", () => {
    // Every segment is decided by the report's `available` set, so a
    // writer report under the full scope deletes the whole body and
    // then explains the deletion with reasons that are false of this
    // server. The caller passed two arguments that describe different
    // servers; that is the error, and it says so.
    expect(() =>
      buildInstructions({
        agent: AGENT,
        scope: TOOL_SCOPE.full,
        capabilities: reportFor(TOOL_SCOPE.writer),
      }),
    ).toThrow(/writer scope, not full/);
  });
});

describe("no segment can orphan its guidance on a renamed tool", () => {
  for (const scope of TOOL_SCOPES) {
    test(`every tool a ${scope} segment names is in the ${scope} tool table`, () => {
      const registered = new Set(buildToolTable(scope).map((tool) => tool.name));
      const orphans = segmentToolNames(scope).filter((name) => !registered.has(name));
      expect(orphans).toEqual([]);
    });

    test(`${scope} segments name at least one tool, so the census has a population`, () => {
      expect(segmentToolNames(scope).length).toBeGreaterThan(0);
    });
  }
});
