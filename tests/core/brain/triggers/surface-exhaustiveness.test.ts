/**
 * Trigger surface exhaustiveness (t_00e9de6a).
 *
 * The action vocabulary is mirrored by hand on every surface - the CLI
 * verb map and usage line, both help-text blocks, the command manifest,
 * the MCP transition list and the probe catalogue - and none of those
 * mirrors is compile-checked against the store's union: TRIGGER_ACTIONS
 * is a runtime list, TRIGGER_TRANSITIONS a plain array, the CLI map is
 * keyed by strings. A missed copy surfaces as a usage error or an
 * unhandled operation, never as a build failure, so this file is the
 * guard: every mirror must name every action.
 */

import { expect, test } from "bun:test";

import { BRAIN_HELP, VERB_HELP } from "../../../../src/cli/brain/help-text.ts";
import { CLI_COMMAND_MANIFEST } from "../../../../src/cli/command-manifest.ts";
import { TRIGGER_ACTIONS } from "../../../../src/core/brain/triggers/store.ts";
import { buildToolTable, findTool } from "../../../../src/mcp/tools.ts";
import { PROBE_ENTRIES, PROBE_RECIPE_COUNT } from "../../../helpers/tool-probe-catalogue.ts";

/** CLI verbs that deliberately differ from their action name. */
const VERB_ALIAS: Partial<Record<(typeof TRIGGER_ACTIONS)[number], string>> = {
  acknowledge: "ack",
};

const TRIGGER_VERBS = TRIGGER_ACTIONS.map((action) => VERB_ALIAS[action] ?? action);

/**
 * A regex matching the verb as a whole word. Prose mirrors that match
 * substrings pass vacuously - "unsnooze" contains "snooze", "unsuppress"
 * contains "suppress", "defers" contains "defer" - so deleting a verb from a
 * surface while a neighbour or a prose sentence still spells it goes
 * unnoticed. Whole-word matching on the specific expected line closes that.
 */
function wholeWord(verb: string): RegExp {
  return new RegExp(`\\b${verb}\\b`);
}

test("the brain_trigger operation enum covers every TriggerAction exactly", () => {
  // The enum spreads TRIGGER_OPERATIONS, which spreads
  // TRIGGER_TRANSITIONS - a plain array a missing arm never breaks at
  // compile time.
  const schema = findTool(buildToolTable("full"), "brain_trigger").inputSchema as {
    properties: { operation: { enum: string[] } };
  };
  const transitions = schema.properties.operation.enum.filter(
    (op) => !["scan", "list", "history"].includes(op),
  );
  expect([...transitions].toSorted()).toEqual([...TRIGGER_ACTIONS].toSorted());
});

test("the brain help one-liner names every trigger verb as a whole word", () => {
  const line = BRAIN_HELP.split("\n").find((l) => l.trimStart().startsWith("trigger"));
  expect(line).toBeDefined();
  for (const verb of TRIGGER_VERBS) {
    expect(line!).toMatch(wholeWord(verb));
  }
});

test("the brain trigger help usage line names every trigger verb as a whole word", () => {
  const usage = VERB_HELP["trigger"];
  expect(usage).toBeDefined();
  // The verb list lives on the `usage:` header line specifically. The prose
  // below it mentions the verbs too ("snooze defers a trigger ...",
  // "unsnooze wakes it by hand"), so a substring check over the whole block
  // passed vacuously - deleting snooze|unsnooze from the header stayed green.
  const header = usage!.split("\n").find((l) => l.startsWith("usage:"));
  expect(header).toBeDefined();
  for (const verb of [...TRIGGER_VERBS, "scan", "list", "history"]) {
    expect(header!).toMatch(wholeWord(verb));
  }
});

test("the command manifest names every trigger verb in the trigger summary", () => {
  const brain = CLI_COMMAND_MANIFEST.commands.find((c) => c.name === "brain");
  const trigger = brain?.commands?.find((c) => c.name === "trigger");
  expect(trigger).toBeDefined();
  for (const verb of TRIGGER_VERBS) {
    expect(trigger!.summary).toMatch(wholeWord(verb));
  }
});

test("the probe catalogue exercises every trigger transition", () => {
  const entry = PROBE_ENTRIES.find((e) => e.name === "brain_trigger");
  expect(entry).toBeDefined();
  const operations = entry!.calls.map((call) => (call.args as { operation: string }).operation);
  for (const action of TRIGGER_ACTIONS) {
    expect(operations).toContain(action);
  }
  // The catalogue's own census reads this constant; adding probes without
  // bumping it would fail tests/mcp/agent-scope-matrix.test.ts, but the
  // failure would name a number nobody connects to the new verbs.
  expect(PROBE_ENTRIES.flatMap((e) => e.calls).length).toBe(PROBE_RECIPE_COUNT);
});
