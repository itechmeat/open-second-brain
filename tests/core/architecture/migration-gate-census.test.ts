/**
 * The migration-gate census (`migration-gate-census/table.ts`), the
 * mechanism: every CLI verb, MCP tool, hook and background worker has
 * exactly one row, in both directions, so a writer added later without a
 * row fails here and names itself. The rows are driven by the
 * `migration-gate-census-*.test.ts` files; the background workers that no
 * other entry drives are driven below.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  CLI_COMMAND_MANIFEST,
  type CliCommandManifest,
} from "../../../src/cli/command-manifest.ts";
import { runSelfHealUpgrade } from "../../../src/core/maintenance/self-heal-upgrade.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { lexSource } from "../../helpers/source-lexer.ts";
import { driveCli } from "./migration-gate-census/drive.ts";
import {
  GATE_CONDITION,
  makeCensusTemplate,
  type CensusTemplate,
} from "./migration-gate-census/fixture.ts";
import {
  ALLOWED_REASON,
  CLI_CENSUS,
  DESTINATION_ARGV,
  HOOK_CENSUS,
  MCP_CENSUS,
  OUTSIDE,
  PROCESS_ENTRIES,
  UNDRIVEN,
  WORKER_CENSUS,
  WORKER_SPAWN_SITES,
} from "./migration-gate-census/table.ts";

// The worker drive below runs a migration-gate fixture; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Every leaf verb of a manifest, space-joined. */
/**
 * Every verb that runs: each leaf, and each command with subcommands the
 * manifest marks `runnable` (it also runs by itself, as `o2b doctor` and
 * `o2b dream queue` do), so a writer is never hidden behind a subcommand.
 */
function leafVerbs(commands: ReadonlyArray<CliCommandManifest>, prefix: string[] = []): string[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    if (command.commands === undefined || command.commands.length === 0) return [path.join(" ")];
    const own = command.runnable === true ? [path.join(" ")] : [];
    return [...own, ...leafVerbs(command.commands, path)];
  });
}

/** The leaves a census table does not classify, and its rows nothing answers to. */
function drift(live: ReadonlyArray<string>, table: Readonly<Record<string, unknown>>) {
  const rows = new Set(Object.keys(table));
  const subjects = new Set(live);
  return {
    unclassified: [...subjects].filter((name) => !rows.has(name)).toSorted(),
    stale: [...rows].filter((name) => !subjects.has(name)).toSorted(),
  };
}

/** Every `event:hook` pair `hooks/hooks.json` runs. */
function hookPairs(): string[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const out = new Set<string>();
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const name = /o2b-hook ([\w-]+)/.exec(hook.command)?.[1];
        if (name !== undefined) out.add(`${event}:${name}`);
      }
    }
  }
  return [...out];
}

/**
 * The files that start a background worker: a child process or a thread
 * that is detached or unref'ed. Timers are unref'ed too and start nothing,
 * so an `unref()` counts only on a name that holds a process or a worker.
 */
const SPAWN_RE =
  /detached:\s*(?:true|process\.platform|platform\s*!==)|\b(?:child|proc|worker)\.unref\(\)|\bspawnSelfDetached\(/;

/**
 * A file that runs the CLI's `main()` as a process of its own: it exits
 * with `main()`'s code, straight (`process.exit(await main(`), by setting
 * the exit code (`process.exitCode = await main(`), or through the final
 * flush every entry point exits by (`exitWhenFlushed(`, any call but the
 * definition in `src/cli/stdout-guard.ts`), or it is a module run as the
 * program (`import.meta.main`). Matched on code only: a comment or a
 * string that names one is no entry point.
 */
const ENTRY_RE =
  /process\.exit\(\s*(?:await\s+)?main\(|process\.exitCode\s*=\s*(?:await\s+)?main\(|(?<!function\s)\bexitWhenFlushed\(|import\.meta\.main\b/;

/** Whether a source text is a process entry point (see {@link ENTRY_RE}). */
function isProcessEntry(text: string): boolean {
  return ENTRY_RE.test(lexSource(text).code);
}

function entryFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts") && isProcessEntry(readFileSync(abs, "utf8"))) {
        out.push(relative(REPO_ROOT, abs).split("\\").join("/"));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return out.toSorted();
}

/** The spawn call sites in a file's code (comments and string contents blanked). */
function spawnCalls(text: string): number {
  const { code } = lexSource(text);
  return (code.match(new RegExp(SPAWN_RE.source, "g")) ?? []).length;
}

function spawnSites(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts") && SPAWN_RE.test(readFileSync(abs, "utf8"))) {
        out.push(relative(REPO_ROOT, abs).split("\\").join("/"));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  walk(join(REPO_ROOT, "hooks"));
  return out.toSorted();
}

describe("the census covers every writer, in both directions", () => {
  test("every CLI leaf verb has exactly one row", () => {
    expect(drift(leafVerbs(CLI_COMMAND_MANIFEST.commands), CLI_CENSUS)).toEqual({
      unclassified: [],
      stale: [],
    });
  });

  test("every MCP tool has exactly one row, of the kind the tool declares", () => {
    const tools = buildToolTable("full");
    expect(
      drift(
        tools.map((t) => t.name),
        MCP_CENSUS,
      ),
    ).toEqual({ unclassified: [], stale: [] });
    const mismatched = tools
      .filter((tool) => {
        const row = MCP_CENSUS[tool.name];
        if (row === undefined || row.kind === "outside") return false;
        return (row.kind === "writer") !== (tool.kind === "write");
      })
      .map((tool) => tool.name);
    expect(mismatched).toEqual([]);
  });

  test("every hook of hooks.json has exactly one row", () => {
    expect(drift(hookPairs(), HOOK_CENSUS)).toEqual({ unclassified: [], stale: [] });
  });

  test("every file that starts a background worker is listed, with the workers it starts", () => {
    expect(drift(spawnSites(), WORKER_SPAWN_SITES)).toEqual({ unclassified: [], stale: [] });
    // Per file, the number of spawn call sites: a second worker added to a
    // file already listed needs its row too.
    const counted = Object.keys(WORKER_SPAWN_SITES).map((path) => [
      path,
      spawnCalls(readFileSync(join(REPO_ROOT, path), "utf8")),
    ]);
    const expected = Object.entries(WORKER_SPAWN_SITES).map(([path, site]) => [path, site.calls]);
    expect(counted).toEqual(expected);
    const started = Object.values(WORKER_SPAWN_SITES).flatMap((site) => site.starts);
    expect(drift(started, WORKER_CENSUS)).toEqual({ unclassified: [], stale: [] });
  });

  test("every process entry point besides the hooks is listed with its row", () => {
    expect(drift(entryFiles(), PROCESS_ENTRIES)).toEqual({ unclassified: [], stale: [] });
    const missing = Object.values(PROCESS_ENTRIES).filter(
      (row) => row !== "cli" && WORKER_CENSUS[row] === undefined,
    );
    expect(missing).toEqual([]);
  });

  test("a worker that runs the code of another entry names an entry that exists", () => {
    const missing = Object.values(WORKER_CENSUS).flatMap((row) => {
      if (row.kind !== "same-as") return [];
      const [section, name] = row.entry.split(/:(.*)/s) as [string, string];
      const table: Readonly<Record<string, unknown>> = section === "cli" ? CLI_CENSUS : HOOK_CENSUS;
      return table[name] === undefined ? [row.entry] : [];
    });
    expect(missing).toEqual([]);
  });
});

describe("what may write during a migration is listed, never left out", () => {
  test("the only rows allowed to write are the migration's own", () => {
    const allowed = [
      ...Object.entries(CLI_CENSUS).map(([name, row]) => [`cli:${name}`, row] as const),
      ...Object.entries(WORKER_CENSUS).map(([name, row]) => [`worker:${name}`, row] as const),
    ]
      .filter(([, row]) => row.kind === "allowed")
      .map(([name]) => name);
    expect(allowed.toSorted()).toEqual([
      "cli:brain migrate-store",
      "worker:automatic store migration (migrate-store --auto)",
    ]);
  });

  test("every reason is an argument, not a label", () => {
    const reasons = [
      ...Object.values(UNDRIVEN),
      ...Object.values(OUTSIDE),
      ...Object.values(ALLOWED_REASON),
    ];
    expect(reasons.filter((reason) => reason.length < 80)).toEqual([]);
  });
});

describe("the census can fail", () => {
  test("an entry point is found by its code, not by a comment or a string", () => {
    expect([
      isProcessEntry("process.exitCode = await main(process.argv.slice(2));"),
      isProcessEntry("process.exitCode = main(argv);"),
      isProcessEntry("guard.exitWhenFlushed(await main(argv));"),
      isProcessEntry("/** calls exitWhenFlushed(0) once import.meta.main is true */\nexport {};"),
      isProcessEntry('const note = "process.exit(await main(argv))";'),
      isProcessEntry("export function exitWhenFlushed(code: number): void {}"),
    ]).toEqual([true, true, true, false, false, false]);
  });

  test("a verb added without a row is named", () => {
    const live = [...leafVerbs(CLI_COMMAND_MANIFEST.commands), "brain census-intruder"];
    expect(drift(live, CLI_CENSUS).unclassified).toEqual(["brain census-intruder"]);
  });

  test("a row whose verb is gone is named", () => {
    const live = leafVerbs(CLI_COMMAND_MANIFEST.commands).filter((name) => name !== "brain note");
    expect(drift(live, CLI_CENSUS).stale).toEqual(["brain note"]);
  });

  test("a second spawn call in a listed file is counted", () => {
    const one = "spawnSelfDetached(argv);\n";
    const two = "spawnSelfDetached(argv);\nspawnSelfDetached(other);\n";
    expect(spawnCalls(one)).toBe(1);
    expect(spawnCalls(two)).toBe(2);
    // A call that is only mentioned in a comment is not one.
    expect(spawnCalls("// spawnSelfDetached(argv)\n")).toBe(0);
  });

  test("every row that writes to a caller-named destination is driven with one", () => {
    const named = Object.entries(CLI_CENSUS)
      .filter(([, row]) => row.kind === "outside" && row.reason === "outPath")
      .map(([name]) => name);
    expect(drift(named, DESTINATION_ARGV)).toEqual({ unclassified: [], stale: [] });
  });

  test("a new spawn site is found by the scan's pattern", () => {
    expect(SPAWN_RE.test("const child = spawn(cmd, args, { detached: true });")).toBe(true);
    expect(SPAWN_RE.test("spawn(cmd, args, { detached: platform !== other });")).toBe(true);
    expect(SPAWN_RE.test("proc.unref();")).toBe(true);
    expect(SPAWN_RE.test("spawnSelfDetached([...argv]);")).toBe(true);
    // A timer is not a worker.
    expect(SPAWN_RE.test("timer.unref();")).toBe(false);
  });
});

describe("a census case whose preparation fails", () => {
  let template: CensusTemplate;
  beforeAll(() => {
    template = makeCensusTemplate("osb-gate-census-prep-", { inProcess: false });
  });
  afterAll(() => template.cleanup());

  test("fails, naming the command that failed", async () => {
    let caught: unknown = null;
    try {
      await driveCli(template, GATE_CONDITION.thisVault, ["brain", "note", "x"], {
        prepare: [["brain", "census-no-such-verb"]],
        subprocess: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("o2b brain census-no-such-verb");
  });
});

describe("the self-heal upgrade worker under the gate", () => {
  let template: CensusTemplate;
  beforeAll(() => {
    template = makeCensusTemplate("osb-gate-census-worker-");
  });
  afterAll(() => template.cleanup());

  test("writes without a gate, and leaves the vault as it was under this vault's gate", async () => {
    const none = await template.run(GATE_CONDITION.none, (run) => runSelfHealUpgrade(run.vault));
    expect(none.changed.length).toBeGreaterThan(0);
    const gated = await template.run(GATE_CONDITION.thisVault, (run) =>
      runSelfHealUpgrade(run.vault),
    );
    expect(gated.changed).toEqual([]);
    // A run that stopped with the gate closed refuses it the same way: no
    // lock claimed, no failure marker recorded.
    const stopped = await template.run(GATE_CONDITION.stoppedHolder, (run) =>
      runSelfHealUpgrade(run.vault),
    );
    expect(stopped.changed).toEqual([]);
    const other = await template.run(GATE_CONDITION.otherVault, (run) =>
      runSelfHealUpgrade(run.vault),
    );
    expect(other.changed.length).toBeGreaterThan(0);
  });
});
