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
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildInstructions } from "../../src/mcp/instructions.ts";
import { WITHHELD_BLOCK_HEADING, segmentToolNames } from "../../src/mcp/instruction-segments.ts";
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
