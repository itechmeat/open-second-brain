/**
 * Surface-parity census over the maintenance lane (what-the-machine-
 * already-has, unit 5).
 *
 * The lane has two front doors - `o2b brain maintenance` and
 * `brain_maintenance` - and they have drifted apart twice in two
 * releases. The second drift is the one that made this file: the lane's
 * own streak refusal tells the caller to re-run with `--retry <task>`,
 * a CLI flag an MCP caller has no way to reach, so half the callers were
 * handed a remedy that did not exist on their surface.
 *
 * Neither population is written down here. The CLI flags are read out of
 * the verb's own `parse()` table and the MCP properties out of the
 * registered tool definition's `inputSchema`, because a census whose
 * population is a hand-kept list is a list that drifts beside the thing
 * it was supposed to watch - which is precisely what happened to the two
 * lane-task lists this unit also collapsed.
 *
 * A flag or a property may sit outside the mapping only through
 * {@link CLI_ONLY} / {@link MCP_ONLY}, each entry carrying a written
 * reason. Both directions are asserted: a missing counterpart fails, and
 * so does an exclusion that outlives the flag it excuses, so the map
 * cannot quietly become a graveyard.
 *
 * The last rule is cheaper and catches the root cause rather than its
 * symptom: neither module may spell a lane task name by hand any more.
 * Both build their task list from `LANE_TASK`, so a fifth task is added
 * in one place or not at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isLaneTask, LANE_TASK, LANE_TASKS } from "../../src/core/brain/maintenance/lane.ts";
import { isOperation } from "../../src/core/brain/safeguard.ts";
import { ADMIN_TOOLS } from "../../src/mcp/brain/admin-tools.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import { runCli } from "../helpers/run-cli.ts";
import { lexSource } from "../helpers/source-lexer.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI_VERB = join(ROOT, "src", "cli", "brain", "verbs", "maintenance.ts");
const MCP_MODULE = join(ROOT, "src", "mcp", "brain", "admin-tools.ts");

/** The tool whose schema is the MCP half of the population. */
const TOOL_NAME = "brain_maintenance";

/** An exclusion reason has to be an argument; forty characters is the floor. */
const MIN_REASON_LENGTH = 40;

/**
 * CLI flags whose MCP counterpart is not simply the same name.
 *
 * One flag may answer to more than one property: `--window H-H` is two
 * integers on a surface that has no dashes to parse.
 */
const CLI_TO_MCP: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  retry: ["retry_tasks"],
  window: ["window_start_hour", "window_end_hour"],
});

/** CLI flags with no MCP property, and why. */
const CLI_ONLY: Readonly<Record<string, string>> = Object.freeze({
  vault:
    "the vault is a property of the MCP SESSION, not of a call: the server resolves it once at " +
    "construction and brain_switch_vault is the surface that changes it.",
  json:
    "every MCP answer is structured by construction - the tool returns an object and the " +
    "transport serializes it - so there is no rendering for a flag to switch.",
  progress:
    "a client asks for progress with a _meta progressToken on the request, which the transport " +
    "turns into the handler's onProgress sink; a boolean argument would be a second way to ask.",
});

/** MCP properties with no CLI flag, and why. */
const MCP_ONLY: Readonly<Record<string, string>> = Object.freeze({
  operation:
    "run|status arrives as a POSITIONAL on the CLI, which has no flag table entry to enumerate; " +
    "the verb reads it out of positional[0] and refuses anything else with its usage line.",
});

/**
 * One module with its comments blanked and every offset preserved.
 *
 * `withoutComments` rather than `code`, because the rule below is about
 * string LITERALS and the `code` view blanks exactly those contents. A
 * task name discussed in a docblock is prose, not a hand-written list.
 */
function sourceWithoutComments(file: string): string {
  return lexSource(readFileSync(file, "utf8")).withoutComments;
}

/**
 * Every flag the verb declares, read between its `parse()` call and the
 * `});` that terminates the table. Bounded on both ends so an unrelated
 * object literal elsewhere in the module cannot leak into the census.
 */
function cliFlagNames(): ReadonlyArray<string> {
  const text = sourceWithoutComments(CLI_VERB);
  const marker = "parse(argv, {";
  const start = text.indexOf(marker);
  expect(`the verb declares a flag table: ${start >= 0}`).toBe(
    "the verb declares a flag table: true",
  );
  const end = text.indexOf("});", start);
  expect(`the flag table is terminated: ${end > start}`).toBe("the flag table is terminated: true");
  return [...text.slice(start, end).matchAll(/^ {4}"?([a-z][a-z0-9-]*)"?:\s*\{\s*type:/gm)].map(
    (m) => m[1]!,
  );
}

/** Every property the registered tool definition declares. */
function mcpPropertyNames(): ReadonlyArray<string> {
  const tool = ADMIN_TOOLS.find((t) => t.name === TOOL_NAME);
  expect(`${TOOL_NAME} is registered: ${tool !== undefined}`).toBe(
    `${TOOL_NAME} is registered: true`,
  );
  const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
}

/** The properties a CLI flag maps to: its declared aliases, else its snake form. */
function propertiesFor(flag: string): ReadonlyArray<string> {
  return CLI_TO_MCP[flag] ?? [flag.replaceAll("-", "_")];
}

/** The flag a property maps back to: the inverse of {@link propertiesFor}. */
function flagFor(property: string, flags: ReadonlyArray<string>): string | undefined {
  return flags.find((flag) => propertiesFor(flag).includes(property));
}

/** Lane-task names spelled as a bare string literal, with their module. */
function bareLaneTaskLiterals(file: string): ReadonlyArray<string> {
  const literal = new RegExp(`(["'\`])(${LANE_TASKS.join("|")})\\1`, "g");
  const label = file.slice(ROOT.length + 1);
  return [...sourceWithoutComments(file).matchAll(literal)].map((m) => `${label}: ${m[0]}`);
}

describe("the lane task vocabulary", () => {
  // `verdict-vocabulary-census.test.ts` scans `src/` for the four-piece
  // shape and audits every vocabulary it finds, but it reads the VALUES
  // out of the object literal, and this one's values are `OPERATION`
  // members rather than fresh strings - deliberately, so a lane task is
  // by construction an operation with a budget. That keeps LANE_TASK out
  // of that scan's population, so the same audit is run here instead of
  // left undone.
  test("object, membership list and guard agree, and every value is an operation", () => {
    expect(Object.isFrozen(LANE_TASK)).toBe(true);
    const values = Object.values(LANE_TASK);
    expect(values.toSorted()).toEqual([...LANE_TASKS].toSorted());
    expect(new Set(values).size).toBe(values.length);
    for (const task of LANE_TASKS) {
      expect(`${task} is a lane task: ${isLaneTask(task)}`).toBe(`${task} is a lane task: true`);
      // The linkage the values encode: each surface resolves a safeguard
      // budget from the task name, and a name that is not an operation
      // would resolve a key nothing reads.
      expect(`${task} is an operation: ${isOperation(task)}`).toBe(`${task} is an operation: true`);
    }
    for (const outsider of ["", "dreams", "maintenance", "scan"]) {
      expect(`${outsider} is a lane task: ${isLaneTask(outsider)}`).toBe(
        `${outsider} is a lane task: false`,
      );
    }
  });
});

describe("maintenance surface parity", () => {
  test("every CLI flag reaches the MCP tool or is excluded with a written reason", () => {
    // One folded comparison so the failure names every flag to act on;
    // asserting per flag would stop at the first and hide the rest.
    const properties = new Set(mcpPropertyNames());
    const unreachable = cliFlagNames()
      .filter((flag) => CLI_ONLY[flag] === undefined)
      .filter((flag) => !propertiesFor(flag).every((property) => properties.has(property)))
      .map((flag) => `--${flag} -> ${propertiesFor(flag).join(" + ")}`);
    expect(unreachable.toSorted().join("\n")).toBe("");
  });

  test("every MCP property reaches the CLI verb or is excluded with a written reason", () => {
    const flags = cliFlagNames();
    const unreachable = mcpPropertyNames()
      .filter((property) => MCP_ONLY[property] === undefined)
      .filter((property) => flagFor(property, flags) === undefined)
      .map((property) => `${TOOL_NAME}.${property}`);
    expect(unreachable.toSorted().join("\n")).toBe("");
  });

  test("no exclusion outlives what it excuses, and every reason says something", () => {
    const flags = new Set(cliFlagNames());
    const properties = new Set(mcpPropertyNames());
    for (const [flag, reason] of Object.entries(CLI_ONLY)) {
      expect(`--${flag} is still declared: ${flags.has(flag)}`).toBe(
        `--${flag} is still declared: true`,
      );
      expect(`--${flag} has a reason: ${reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `--${flag} has a reason: true`,
      );
    }
    for (const [property, reason] of Object.entries(MCP_ONLY)) {
      expect(`${property} is still declared: ${properties.has(property)}`).toBe(
        `${property} is still declared: true`,
      );
      expect(`${property} has a reason: ${reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `${property} has a reason: true`,
      );
    }
    // An alias that names a property nobody declares is a mapping that
    // silently excuses the flag it points at.
    const dangling = Object.entries(CLI_TO_MCP)
      .flatMap(([flag, names]) => names.map((name) => `${flag} -> ${name}`))
      .filter((pair) => !properties.has(pair.split(" -> ")[1]!));
    expect(dangling.toSorted().join("\n")).toBe("");
  });

  test("the census is not vacuous", () => {
    // A extraction that silently stopped matching would report a clean
    // sweep over an empty set. Pin the measurement, not only its verdict.
    expect(cliFlagNames().length).toBeGreaterThan(8);
    expect(mcpPropertyNames().length).toBeGreaterThan(8);
    expect(LANE_TASKS.length).toBeGreaterThan(3);
  });

  test("neither surface spells a lane task by hand any more", () => {
    // The root cause, not the symptom: two hand-written task lists are
    // what let the surfaces disagree in the first place.
    expect(
      [...bareLaneTaskLiterals(CLI_VERB), ...bareLaneTaskLiterals(MCP_MODULE)].join("\n"),
    ).toBe("");
  });
});

describe("an unknown retry name is refused by name on both surfaces", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-maint-parity-"));
    vault = join(tmp, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the CLI and the tool both name the typo and list the known tasks", async () => {
    const init = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(init.returncode).toBe(0);

    const cli = await runCli(
      ["brain", "maintenance", "run", "--retry", "dreams", "--vault", vault],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
      },
    );
    expect(cli.stderr).toContain("dreams");
    for (const task of LANE_TASKS) expect(cli.stderr).toContain(task);

    const server = new MCPServer({ vault, configPath });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: {
        name: TOOL_NAME,
        arguments: { operation: "run", retry_tasks: ["dreams"] },
      },
    })) as { error?: { code: number; message: string } };
    // A bad argument, so it comes back as INVALID_PARAMS rather than as a
    // tool result carrying isError - the same shape the CLI's usage exit
    // has: the request was understood and refused, nothing was attempted.
    const message = res.error?.message ?? "";
    expect(res.error?.code).toBe(INVALID_PARAMS);
    expect(message).toContain("dreams");
    for (const task of LANE_TASKS) expect(message).toContain(task);
  });
});
