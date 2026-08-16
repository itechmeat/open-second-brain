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
 * cannot quietly become a graveyard. {@link CLI_TO_MCP} is checked on
 * BOTH sides for the same reason - its values were validated against the
 * declared properties and its keys against nothing, so renaming `--retry`
 * would have left a dead entry silently excusing a flag that no longer
 * exists.
 *
 * ## Three things a name-only census cannot see
 *
 * Names matching is necessary and not sufficient, so three further rules
 * sit beside it:
 *
 *   - **Same name, different contract.** `--busy-minutes`, `--busy-
 *     threshold` and `--limit` each took any positive integer on the CLI
 *     while the tool bounded them, so one lane accepted through one door
 *     what it refused at the other. Both surfaces now read the same
 *     ceilings, and "the two refuse the same out-of-range value" is
 *     asserted by DRIVING both rather than by comparing two numbers.
 *   - **Declared and never read.** The populations come from the flag
 *     table and the `inputSchema`, both of which are declarations. A
 *     property nobody consumes would pass a name census cleanly, so each
 *     name must also appear where its surface actually reads it.
 *   - **The root cause, not the symptom:** neither module may spell a
 *     lane task name by hand any more. Both build their task list from
 *     `LANE_TASK`, so a fifth task is added in one place or not at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLaneTask,
  LANE_TASK,
  LANE_TASKS,
  MAINTENANCE_BUSY_MINUTES_MAX,
  MAINTENANCE_BUSY_THRESHOLD_MAX,
} from "../../src/core/brain/maintenance/lane.ts";
import { MAINTENANCE_JOURNAL_CAP } from "../../src/core/brain/maintenance/journal.ts";
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

/**
 * CLI flags the verb reads through a shared helper rather than by name,
 * mapped to the helper that reads them.
 *
 * `flags["<name>"]` is how every other flag is consumed, so the absence
 * of that spelling normally means nobody reads it. These are the
 * exceptions, and each names the reader so the waiver dies with it.
 */
const CLI_INDIRECT: Readonly<Record<string, string>> = Object.freeze({
  vault: "brainVerbContext(flags)",
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

/**
 * The tool's handler, as source: everything between its declaration and
 * the tool table that declares the schema.
 *
 * Bounded that way on purpose. Every property name appears in the schema
 * literal by construction, so a census that searched the whole module
 * would find each one and prove nothing; the handler region is where a
 * name has to appear for the argument to actually do something.
 */
function mcpHandlerSource(): string {
  const text = sourceWithoutComments(MCP_MODULE);
  const start = text.indexOf("function toolBrainMaintenance(");
  expect(`the handler is present: ${start >= 0}`).toBe("the handler is present: true");
  const end = text.indexOf("export const ADMIN_TOOLS", start);
  expect(`the handler precedes the tool table: ${end > start}`).toBe(
    "the handler precedes the tool table: true",
  );
  return text.slice(start, end);
}

/** The properties a CLI flag maps to: its declared aliases, else its snake form. */
function propertiesFor(flag: string): ReadonlyArray<string> {
  return CLI_TO_MCP[flag] ?? [flag.replaceAll("-", "_")];
}

/** The flag a property maps back to: the inverse of {@link propertiesFor}. */
function flagFor(property: string, flags: ReadonlyArray<string>): string | undefined {
  return flags.find((flag) => propertiesFor(flag).includes(property));
}

/**
 * Lane-task names spelled as a bare string literal, with their module.
 *
 * Known imprecision, left in deliberately: this matches a quoted task
 * name ANYWHERE outside a comment, so a user-facing message that happens
 * to quote one - `"dream is already running"` - would be reported as a
 * hand-written list. That is a false positive, not a bug to work around
 * silently: if you hit it, the fix is to build the sentence from
 * `LANE_TASK.dream` rather than to loosen this pattern, because the whole
 * point is that the name has exactly one source. A pattern that tried to
 * tell a list from a sentence would need a parser and would still guess.
 */
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
    // ...and the other side of the same arrow. A key naming a flag the
    // verb no longer declares excuses nothing and hides that it excuses
    // nothing: rename `--retry` and the two name-parity tests above stay
    // green while this entry rots.
    const orphanedKeys = Object.keys(CLI_TO_MCP).filter((flag) => !flags.has(flag));
    expect(orphanedKeys.toSorted().join("\n")).toBe("");
  });

  test("every declared name is read by the surface that declares it", () => {
    // Both populations are DECLARATIONS. A flag in the table that the
    // verb never reads, or a schema property the handler never consumes,
    // is a promise on the surface with nothing behind it - and it passes
    // a name census cleanly, because the name is right there.
    const cli = sourceWithoutComments(CLI_VERB);
    const unreadFlags = cliFlagNames()
      .filter((flag) => CLI_INDIRECT[flag] === undefined)
      .filter((flag) => !cli.includes(`flags["${flag}"]`))
      .map((flag) => `--${flag}`);
    expect(unreadFlags.toSorted().join("\n")).toBe("");

    // The indirect readers are named rather than waived: the helper that
    // consumes the flag has to still be called here.
    for (const [flag, helper] of Object.entries(CLI_INDIRECT)) {
      expect(`--${flag} is read via ${helper}: ${cli.includes(helper)}`).toBe(
        `--${flag} is read via ${helper}: true`,
      );
    }

    const handler = mcpHandlerSource();
    const unreadProperties = mcpPropertyNames()
      .filter((property) => !handler.includes(`"${property}"`))
      .map((property) => `${TOOL_NAME}.${property}`);
    expect(unreadProperties.toSorted().join("\n")).toBe("");
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

/**
 * One out-of-range value per bounded knob, in both spellings.
 *
 * The ceilings are imported, never retyped, and each case sits one past
 * its own ceiling - so raising a bound moves these cases with it and a
 * bound that disappears from one surface fails here rather than in a
 * user's vault.
 */
interface OutOfRangeCase {
  readonly label: string;
  readonly operation: "run" | "status";
  readonly cli: ReadonlyArray<string>;
  readonly mcp: Record<string, number>;
}

// Annotated before freezing rather than inside it: `Object.freeze` is
// generic, so its argument gets no contextual type, and TypeScript then
// widens these three literals into a union in which each one carries the
// other two's keys as `?: undefined` - which no `Record<string, number>`
// accepts.
const OUT_OF_RANGE_CASES: ReadonlyArray<OutOfRangeCase> = [
  {
    label: "busy-minutes past a day",
    operation: "run",
    cli: ["--busy-minutes", String(MAINTENANCE_BUSY_MINUTES_MAX + 1)],
    mcp: { busy_minutes: MAINTENANCE_BUSY_MINUTES_MAX + 1 },
  },
  {
    label: "busy-threshold past any real traffic",
    operation: "run",
    cli: ["--busy-threshold", String(MAINTENANCE_BUSY_THRESHOLD_MAX + 1)],
    mcp: { busy_threshold: MAINTENANCE_BUSY_THRESHOLD_MAX + 1 },
  },
  {
    label: "limit past the journal's ring size",
    operation: "status",
    cli: ["--limit", String(MAINTENANCE_JOURNAL_CAP + 1)],
    mcp: { limit: MAINTENANCE_JOURNAL_CAP + 1 },
  },
];

const OUT_OF_RANGE = Object.freeze(OUT_OF_RANGE_CASES);

describe("the two surfaces refuse the same values, not only the same names", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-maint-bounds-"));
    vault = join(tmp, "vault");
    mkdirSync(vault, { recursive: true });
    configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
    const init = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(init.returncode).toBe(0);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const casing of OUT_OF_RANGE) {
    test(`${casing.label}: refused by the verb and by the tool`, async () => {
      const cli = await runCli(
        ["brain", "maintenance", casing.operation, ...casing.cli, "--vault", vault],
        { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
      );
      // Understood and declined: a usage exit, nothing attempted. The
      // lane must never START on a number the other door refuses.
      expect(cli.returncode).toBe(2);

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
          arguments: { operation: casing.operation, ...casing.mcp },
        },
      })) as { error?: { code: number } };
      expect(res.error?.code).toBe(INVALID_PARAMS);
    });
  }

  test("retry_tasks longer than the lane has tasks is refused, not merely advertised", async () => {
    // `maxItems` on the schema is advertisement: no JSON-Schema validator
    // runs on the request path, and the unknown-argument guard checks
    // names rather than shapes. So the handler owes the check itself -
    // without it a thousand-entry array was accepted while the schema
    // said it could not be.
    const server = new MCPServer({ vault, configPath });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    const tool = ADMIN_TOOLS.find((t) => t.name === TOOL_NAME)!;
    const schema = tool.inputSchema as {
      properties: { retry_tasks: { maxItems?: number } };
    };
    const advertised = schema.properties.retry_tasks.maxItems;
    expect(advertised).toBe(LANE_TASKS.length);
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: {
        name: TOOL_NAME,
        arguments: {
          operation: "run",
          // Every entry a REAL lane task, so the only thing wrong with
          // the request is its length.
          retry_tasks: Array.from({ length: advertised! + 1 }, () => LANE_TASK.dream),
        },
      },
    })) as { error?: { code: number; message: string } };
    expect(res.error?.code).toBe(INVALID_PARAMS);
    expect(res.error?.message).toContain(String(advertised));
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
