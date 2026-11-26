/**
 * The census suites, each defined once and split across several test
 * files (a table that runs for minutes is split, CLAUDE.md "Windows test
 * shards"). A file calls one of these with its shard number.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { buildToolTable } from "../../../../src/mcp/tools.ts";
import { MCPServer } from "../../../../src/mcp/server.ts";
import { MIGRATION_IN_PROGRESS_REFUSAL } from "../../../../src/mcp/frozen-refusal.ts";
import {
  PROBE_ENTRIES,
  SCOPED_SURFACES,
  probeLabel,
  type ProbeCall,
} from "../../../helpers/tool-probe-catalogue.ts";
import type { TransportReach } from "../../../../src/core/graph/transport-reach.ts";
import { CLI_CHILD_LIMIT_MS } from "../../../helpers/cli-timeout.ts";
import { runCli, spawnWithLimit } from "../../../helpers/run-cli.ts";
import { argvFor, cliRefused, driveCli, REFUSAL_RE } from "./drive.ts";
import {
  type CensusRun,
  GATE_CONDITION,
  makeCensusTemplate,
  type CensusTemplate,
} from "./fixture.ts";
import {
  CLI_CENSUS,
  DESTINATION_ARGV,
  HEAVY_CALL_LIMIT_MS,
  HEAVY_CLI_ROWS,
  HEAVY_ROW_BUDGET_MS,
  HOOK_CENSUS,
  MCP_CENSUS,
} from "./table.ts";

/**
 * Whether the suites that drive child processes (the CLI writer, the CLI
 * rest, the destination and the hook rows) run every gate condition, or
 * only the live holder of this vault's gate. On Windows a CLI child costs
 * seconds, and four conditions per row put the census past the CI shard
 * limit, so there each row drives that one condition (refused or quiet, the
 * vault byte-identical); the stopped holder, another vault's gate, no gate
 * and the positive controls that need them run on the other platforms. The
 * gate rule is platform independent; the parts that are Windows specific,
 * the path comparison and the holder's identity, are covered by
 * tests/core/migration-gate-refusal.test.ts, which runs everywhere. The
 * in-process suites (MCP, the worker) stay full on every platform.
 */
export const FULL_SUBPROCESS_CONDITIONS = process.platform !== "win32";

/** The rows of `rows` that fall in shard `shard` of `shards`. */
function shardOf<T>(rows: ReadonlyArray<T>, shard: number, shards: number): T[] {
  return rows.filter((_, index) => index % shards === shard);
}

function withTemplate(prefix: string, inProcess: boolean): () => CensusTemplate {
  let template: CensusTemplate | null = null;
  beforeAll(() => {
    template = makeCensusTemplate(prefix, { inProcess });
  });
  afterAll(() => template?.cleanup());
  return () => template!;
}

/**
 * The driven CLI writers: changed without a gate and under another vault's
 * gate, refused and byte-identical under this vault's.
 */
export function cliWriterSuite(shard: number, shards: number): void {
  const template = withTemplate("osb-gate-census-cliw-", false);
  const rows = shardOf(
    Object.entries(CLI_CENSUS).flatMap(([name, row]) =>
      row.kind === "writer" && "argv" in row ? [{ name, row }] : [],
    ),
    shard,
    shards,
  );
  for (const { name, row } of rows) {
    const heavy = HEAVY_CLI_ROWS.has(name);
    const options = {
      ...(row.prepare === undefined ? {} : { prepare: row.prepare }),
      ...(heavy ? { limitMs: HEAVY_CALL_LIMIT_MS } : {}),
    };
    test(
      `cli writer: ${name}`,
      async () => {
        // One condition after another: on Windows the start of a CLI child
        // dominates, and four started at once for one row only make each
        // of them slower.
        const gated = await driveCli(template(), GATE_CONDITION.thisVault, row.argv, options);
        expect([name, "this vault's gate", gated.changed, cliRefused(gated.value)]).toEqual([
          name,
          "this vault's gate",
          [],
          true,
        ]);
        if (!FULL_SUBPROCESS_CONDITIONS) return;
        const none = await driveCli(template(), GATE_CONDITION.none, row.argv, options);
        const stopped = await driveCli(template(), GATE_CONDITION.stoppedHolder, row.argv, options);
        const other = await driveCli(template(), GATE_CONDITION.otherVault, row.argv, options);
        expect([name, "no gate", none.changed.length > 0, cliRefused(none.value)]).toEqual([
          name,
          "no gate",
          true,
          false,
        ]);
        expect([name, "a stopped run's gate", stopped.changed, cliRefused(stopped.value)]).toEqual([
          name,
          "a stopped run's gate",
          [],
          true,
        ]);
        expect([name, "another vault's gate", other.changed.length > 0]).toEqual([
          name,
          "another vault's gate",
          true,
        ]);
      },
      ...(heavy ? [HEAVY_ROW_BUDGET_MS] : []),
    );
  }
}

/**
 * The outside rows driven here: their writes land in the store, the
 * decision-model state, a path outside the vault or a throwaway vault in
 * the temp directory, so they run in this process with no host
 * configuration in reach.
 */
const DRIVEN_OUTSIDE: ReadonlySet<string> = new Set([
  "store",
  "view",
  "dmState",
  "outPath",
  "scratch",
]);

/** The CLI rows driven with their default argv: never a change under the gate. */
export function cliRestSuite(shard: number, shards: number): void {
  const template = withTemplate("osb-gate-census-clir-", false);
  const rows = shardOf(
    Object.entries(CLI_CENSUS).filter(
      ([, row]) =>
        row.kind === "reader" ||
        row.kind === "recorder" ||
        (row.kind === "outside" && DRIVEN_OUTSIDE.has(row.reason)) ||
        (row.kind === "writer" && "undriven" in row && row.undriven !== "host"),
    ),
    shard,
    shards,
  );
  for (const [name, row] of rows) {
    const argv =
      row.kind === "recorder" && row.argv !== undefined ? row.argv : [...name.split(" "), "--json"];
    // In this process: a reader writes no host configuration, and a writer
    // that would is classified `host` and not driven here.
    const options = {
      subprocess: false,
      ...(row.kind === "recorder" && row.prepare !== undefined ? { prepare: row.prepare } : {}),
    };
    test(`cli ${row.kind}: ${name}`, async () => {
      const gated = await driveCli(template(), GATE_CONDITION.thisVault, argv, options);
      expect([name, gated.changed]).toEqual([name, []]);
      const answers = row.kind === "reader" || row.kind === "recorder";
      if (!FULL_SUBPROCESS_CONDITIONS) {
        // One condition (see FULL_SUBPROCESS_CONDITIONS): a reader or a
        // recorder is not refused, and a recorder answers successfully.
        if (answers) expect([name, cliRefused(gated.value)]).toEqual([name, false]);
        if (row.kind === "recorder") expect([name, gated.value.code]).toEqual([name, 0]);
        return;
      }
      const stopped = await driveCli(template(), GATE_CONDITION.stoppedHolder, argv, options);
      expect([name, "a stopped run's gate", stopped.changed]).toEqual([
        name,
        "a stopped run's gate",
        [],
      ]);
      let open: Awaited<ReturnType<typeof driveCli>> | null = null;
      if (answers) {
        // A reader answers under both gates exactly as it answers with none
        // (its default invocation may be a usage error, the same one); a
        // recorder answers successfully.
        open = await driveCli(template(), GATE_CONDITION.none, argv, options);
        const expected = row.kind === "recorder" ? 0 : open.value.code;
        expect([name, open.value.code === expected, gated.value.code, stopped.value.code]).toEqual([
          name,
          true,
          expected,
          expected,
        ]);
      }
      if (row.kind === "writer" || row.kind === "outside") return;
      // A reader or a recorder answers under the gate: it is never refused.
      expect([name, cliRefused(gated.value)]).toEqual([name, false]);
      const none = open!;
      const unexpected =
        row.kind === "recorder" ? none.changed.filter((p) => !row.records.test(p)) : none.changed;
      expect([name, unexpected]).toEqual([name, []]);
      // A recorder given its real work records with no gate: the write path
      // the gate refused above was reached.
      if (row.kind === "recorder" && row.prepare !== undefined) {
        expect([name, none.changed.length > 0]).toEqual([name, true]);
      }
    });
  }
}

/** Every probe recipe of every tool, each a call of the MCP dispatch. */
function recipes(): Array<{ name: string; recipe: ProbeCall; index: number }> {
  const out: Array<{ name: string; recipe: ProbeCall; index: number }> = [];
  for (const entry of PROBE_ENTRIES) {
    entry.calls.forEach((recipe, index) => out.push({ name: entry.name, recipe, index }));
  }
  for (const surface of SCOPED_SURFACES) {
    out.push({ name: surface.name, recipe: { args: {}, reason: "scoped" }, index: 0 });
  }
  return out;
}

/** A recipe's arguments, computed from the run's vault when they are a function. */
function recipeArgs(recipe: ProbeCall, vault: string): Record<string, unknown> {
  return typeof recipe.args === "function" ? recipe.args(vault) : recipe.args;
}

/** What one MCP call answered: its refusal code, or null for any other answer. */
async function callTool(
  vault: string,
  configPath: string,
  name: string,
  args: Record<string, unknown>,
  reach: TransportReach | undefined,
): Promise<string | null> {
  // The reach the recipe declares: a local-only lifecycle is served only at it.
  const server = new MCPServer({ vault, configPath }, reach === undefined ? {} : { reach });
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { error?: { data?: Record<string, unknown> } };
  const code = response.error?.data?.["code"];
  return typeof code === "string" ? code : null;
}

/** Paths a preview artifact lands on: session scratch, allowed without a gate. */
const ARTIFACT_RE = /^Brain\/\.artifacts(\/|$)/;

/**
 * Every MCP recipe under this vault's gate leaves the vault byte-identical;
 * a writer recipe that changes it without a gate is refused with the
 * structured refusal under this vault's gate and changes it under another's.
 */
export function mcpSuite(shard: number, shards: number): void {
  const template = withTemplate("osb-gate-census-mcp-", true);
  const tools = new Map(buildToolTable("full").map((tool) => [tool.name, tool]));
  // Sharded by tool, so every recipe of a tool runs in one file and the
  // positive control below sees them all.
  // From the registered tools, not the recipes: a writer with no recipe
  // still lands in a shard, and the positive control below names it.
  const names = [...tools.keys()].toSorted();
  const mine = new Set(shardOf(names, shard, shards));
  /** Per writer tool: whether a recipe of it wrote with no gate, and was then refused. */
  const proven = new Set<string>();
  for (const { name, recipe, index } of recipes().filter((r) => mine.has(r.name))) {
    const row = MCP_CENSUS[name];
    test(`mcp ${row?.kind ?? "unclassified"}: ${probeLabel(name, recipe, index)}`, async () => {
      expect(row, `${name} has no census row`).toBeDefined();
      expect(tools.has(name)).toBe(true);
      const call = (condition: (typeof GATE_CONDITION)[keyof typeof GATE_CONDITION]) =>
        template().run(
          condition,
          (run, prepared: Record<string, unknown>) =>
            callTool(run.vault, run.configPath, name, prepared, recipe.reach),
          (run) => recipeArgs(recipe, run.vault),
        );
      const none = await call(GATE_CONDITION.none);
      const gated = await call(GATE_CONDITION.thisVault);
      expect([name, gated.changed]).toEqual([name, []]);
      const stopped = await call(GATE_CONDITION.stoppedHolder);
      expect([name, "a stopped run's gate", stopped.changed]).toEqual([
        name,
        "a stopped run's gate",
        [],
      ]);
      const wrote = none.changed.filter((p) => !ARTIFACT_RE.test(p));
      if (row!.kind !== "writer") {
        // A reader writes nothing (a preview artifact is session scratch)
        // and is never refused.
        expect([
          name,
          wrote,
          gated.value === MIGRATION_IN_PROGRESS_REFUSAL,
          stopped.value === MIGRATION_IN_PROGRESS_REFUSAL,
        ]).toEqual([name, [], false, false]);
        return;
      }
      // A writer marked undriven must not drive: a recipe that writes makes
      // the mark false.
      expect([name, row!.undriven === true && wrote.length > 0]).toEqual([name, false]);
      if (wrote.length === 0) return;
      expect([name, gated.value, stopped.value]).toEqual([
        name,
        MIGRATION_IN_PROGRESS_REFUSAL,
        MIGRATION_IN_PROGRESS_REFUSAL,
      ]);
      const other = await call(GATE_CONDITION.otherVault);
      // The requested write, not a preview artifact, has to happen there.
      const otherWrote = other.changed.filter((p) => !ARTIFACT_RE.test(p));
      expect([name, otherWrote.length > 0]).toEqual([name, true]);
      proven.add(name);
    });
  }
  // The positive control: a writer the table does not mark undriven has at
  // least one recipe that really writes with no gate (and so went through
  // the refusal and the other-vault checks above), or the row is a label.
  test("every driven MCP writer of this shard has a recipe that writes", () => {
    const unproven = [...mine].filter((name) => {
      const row = MCP_CENSUS[name];
      return row?.kind === "writer" && row.undriven !== true && !proven.has(name);
    });
    expect(unproven).toEqual([]);
  });
}

/** The hook payload: one turn that wrote a file, as every runtime sends it. */
function hookPayload(event: string, vault: string, transcript: string): Record<string, unknown> {
  const file = join(vault, "notes", "census-hook.md");
  return {
    session_id: "census-session",
    transcript_path: transcript,
    cwd: vault,
    hook_event_name: event,
    prompt: "lattice widgets please",
    tool_name: "Write",
    tool_input: { file_path: file },
    tool_response: {},
    source: "startup",
    stop_hook_active: false,
    reason: "exit",
  };
}

/** One hook run: exit code, stderr lines, stdout. */
interface HookResult {
  readonly code: number;
  readonly stderrLines: ReadonlyArray<string>;
}

async function runHook(
  template: CensusTemplate,
  condition: (typeof GATE_CONDITION)[keyof typeof GATE_CONDITION],
  event: string,
  hook: string,
) {
  return template.run(condition, async (run) => {
    const transcript = join(run.dir, "transcript.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "lattice" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "x.md" } }],
        },
      },
    ];
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    // Bounded, so a hook that hangs fails with its evidence instead of a
    // bare test timeout; the hook's exit decides, not its pipes
    // (`spawnWithLimit`).
    const { stderr, returncode: code } = await spawnWithLimit(
      [process.execPath, "run", join(HOOKS_DIR, `${hook}.ts`)],
      {
        env: { ...process.env, ...run.env } as Record<string, string>,
        // The hook's cwd outside the run's folder: a SessionStart hook leaves a
        // detached maintenance child behind (a self-heal reindex), which keeps
        // its cwd, and Windows cannot remove a folder some process stands in.
        cwd: run.dir.slice(0, run.dir.lastIndexOf(sep)),
        stdin: JSON.stringify(hookPayload(event, run.vault, transcript)),
        limitMs: CLI_CHILD_LIMIT_MS,
      },
    );
    const result: HookResult = {
      code,
      stderrLines: stderr.split("\n").filter((line) => line.trim() !== ""),
    };
    return result;
  });
}

const HOOKS_DIR = join(import.meta.dir, "..", "..", "..", "..", "hooks");

/**
 * Every hook under this vault's gate: exit 0, at most one notice line, the
 * vault byte-identical. A writer changes the vault without a gate and under
 * another vault's.
 */
export function hookSuite(shard: number, shards: number): void {
  const template = withTemplate("osb-gate-census-hook-", false);
  for (const [key, row] of shardOf(Object.entries(HOOK_CENSUS), shard, shards)) {
    const [event, hook] = key.split(":") as [string, string];
    test(`hook ${row.kind}: ${key}`, async () => {
      // One condition after another, for the reason the CLI writers give;
      // on Windows only this vault's gate (FULL_SUBPROCESS_CONDITIONS).
      const gated = await runHook(template(), GATE_CONDITION.thisVault, event, hook);
      expect([key, gated.value.code, gated.value.stderrLines.length <= 1, gated.changed]).toEqual([
        key,
        0,
        true,
        [],
      ]);
      if (!FULL_SUBPROCESS_CONDITIONS) return;
      const stopped = await runHook(template(), GATE_CONDITION.stoppedHolder, event, hook);
      const none = await runHook(template(), GATE_CONDITION.none, event, hook);
      const other = await runHook(template(), GATE_CONDITION.otherVault, event, hook);
      // A hook never fails a session, gated or not.
      expect([key, "open", none.value.code, other.value.code]).toEqual([key, "open", 0, 0]);
      for (const [label, held] of [["a stopped run's gate", stopped]] as const) {
        expect([
          key,
          label,
          held.value.code,
          held.value.stderrLines.length <= 1,
          held.changed,
        ]).toEqual([key, label, 0, true, []]);
      }
      const wrote = row.kind === "writer";
      expect([key, none.changed.length > 0, other.changed.length > 0]).toEqual([key, wrote, wrote]);
    });
  }
}

/**
 * Every row that writes to a destination the caller names: inside the
 * vault while its gate is held, refused with the vault byte-identical;
 * outside it, the write goes on there and the vault is untouched.
 */
/** The run's argv with `{dest}` as `dest`, and the output path the caller asked for. */
function destined(argv: ReadonlyArray<string>, run: CensusRun, dest: string) {
  const args = argvFor(argv, run).map((a) => a.replace("{dest}", dest));
  const requested = argv.find((a) => a.includes("{dest}"))!.replace("{dest}", dest);
  return { args, requested };
}

export function destinationSuite(): void {
  const template = withTemplate("osb-gate-census-dest-", false);
  for (const [name, argv] of Object.entries(DESTINATION_ARGV)) {
    test(`destination: ${name}`, async () => {
      // A child process, as an operator runs it: the refusal has to come back
      // through the verb's failure path (exit 1, one error line, a JSON
      // envelope under --json), not as an unhandled rejection with a stack.
      for (const json of FULL_SUBPROCESS_CONDITIONS ? [false, true] : [false]) {
        // oxlint-disable-next-line no-await-in-loop -- one child at a time, see SUBPROCESS_CONDITIONS
        const inside = await template().run(GATE_CONDITION.thisVault, async (run) => {
          const { args } = destined(argv, run, join(run.vault, "exports"));
          const result = await runCli(json ? [...args, "--json"] : args, {
            env: { ...run.env },
            subprocess: true,
          });
          return { code: result.returncode, stdout: result.stdout, stderr: result.stderr };
        });
        const output = `${inside.value.stdout}\n${inside.value.stderr}`;
        expect([
          name,
          json ? "inside the vault, --json" : "inside the vault",
          inside.changed,
          inside.value.code,
          REFUSAL_RE.test(output),
          STACK_RE.test(output),
        ]).toEqual([
          name,
          json ? "inside the vault, --json" : "inside the vault",
          [],
          1,
          true,
          false,
        ]);
        // Under --json, what stdout holds parses (the envelope, or the verb's
        // own JSON failure); a verb whose failure path prints no JSON for
        // any failure (graph-export, bank-export, knowledge-pack) leaves it
        // empty, as it does for every other write it cannot make.
        if (json && inside.value.stdout.trim() !== "") {
          expect(() => JSON.parse(inside.value.stdout)).not.toThrow();
        }
      }
      if (!FULL_SUBPROCESS_CONDITIONS) return;
      const outside = await template().run(GATE_CONDITION.thisVault, async (run) => {
        const { args, requested } = destined(argv, run, join(run.dir, "exports"));
        const result = await runCli(args, { env: { ...run.env }, subprocess: true });
        // The output the caller asked for, not just its parent folder.
        return { code: result.returncode, wrote: wroteOutput(requested) };
      });
      expect([name, "outside the vault", outside.value, outside.changed]).toEqual([
        name,
        "outside the vault",
        { code: 0, wrote: true },
        [],
      ]);
    });
  }
}

/** A stack trace's frame lines, which an operator's failure output never shows. */
const STACK_RE = /\n\s+at .+[:(]\d+/;

/** Whether `path` is a file, or a folder with something in it. */
function wroteOutput(path: string): boolean {
  if (!existsSync(path)) return false;
  return statSync(path).isFile() || readdirSync(path).length > 0;
}
